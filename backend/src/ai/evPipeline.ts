import { getConfig } from '../utils/env.js';
import { buildContext, DefaultMarketDataProvider } from './features/contextReader.js';
import type { ContextFeatures } from './features/featureBuilder.js';
import { validateContextFeatures, computeAtrPct } from './features/featureBuilder.js';
import { ProbModel } from './models/probModel.js';
import { Conformal } from './models/conformal.js';
import { ContextualBandit, selectBanditContext, type StrategyAction } from './routing/contextualBandit.js';
import { scoreStrategies } from './routing/strategyScorer.js';
import { expectedValue } from './ranking/evRanker.js';
import { buildExecutionPlan } from './execution/planBuilder.js';
import { passesHardGates, passesQuantile } from './kpi/perfGuards.js';
import { Telemetry } from './kpi/telemetry.js';
import type { LabeledRow } from './labeling/tripleBarrier.js';
import { PreciseDecimal } from '../quantai/strategy/metaAdaptiveAgent.js';

export interface OpportunityEvaluation {
  accepted: boolean;
  reason?: string;
  action?: StrategyAction['kind'];
  p_win?: number;
  p_interval?: [number, number];
  ev?: number;
  plan?: ReturnType<typeof buildExecutionPlan>;
  why?: string[];
}

const probModel = new ProbModel();
const conformal = new Conformal(probModel);
const bandit = new ContextualBandit(1337);
const telemetry = new Telemetry();
let modelReady = false;

class RollingPerformance {
  private wins = new PreciseDecimal('0');
  private losses = new PreciseDecimal('0');
  private history: PreciseDecimal[] = [];
  constructor(private readonly max = 30) {}
  push(pnl: PreciseDecimal): void {
    this.history.push(pnl);
    if (this.history.length > this.max) this.history.shift();
    this.recompute();
  }
  private recompute(): void {
    this.wins = new PreciseDecimal('0');
    this.losses = new PreciseDecimal('0');
    for (const pnl of this.history) {
      if (pnl.gt(0)) this.wins = this.wins.plus(pnl);
      else this.losses = this.losses.plus(pnl);
    }
  }
  value(): number {
    const win = this.wins.toNumber();
    const loss = Math.abs(this.losses.toNumber());
    if (loss === 0) return win > 0 ? 2 : 1;
    return win / loss;
  }
}

const rollingPf = new RollingPerformance();

export function fitProbabilityModel(dataset: LabeledRow[]): void {
  probModel.fit(dataset);
  conformal.calibrate(dataset);
  modelReady = true;
}

export async function evaluateOpportunity(symbol: string, notional: number, options?: { context?: ContextFeatures; playbooks?: StrategyAction['kind'][]; now?: number; ohlcv15m?: number[][] }): Promise<OpportunityEvaluation> {
  if (!modelReady) {
    throw new Error('Probability model not trained');
  }
  const cfg = getConfig();
  const provider = new DefaultMarketDataProvider();
  const features = options?.context ?? await buildContext(symbol, { now: options?.now });
  validateContextFeatures(features);
  const tf15m = options?.ohlcv15m ?? await provider.fetchOhlcv(symbol, '15m', 256);
  const atrPct = computeAtrPct(tf15m, 14);
  const hardGate = passesHardGates({
    features,
    atrPct,
    tpPct: atrPct * cfg.ML_TB_K_TP,
  }, {
    minVolumeUsd: cfg.EV_MIN_VOLUME_USD,
    maxSpreadBps: cfg.EV_MAX_SPREAD_BPS,
    minDepthUsd: cfg.EV_MIN_DEPTH_USD,
    minPassiveFillRate: cfg.EV_MIN_PASSIVE_FILL_RATE,
    atrToTpMin: cfg.EV_ATR_TP_MIN_RATIO,
    atrToTpMax: cfg.EV_ATR_TP_MAX_RATIO,
  });
  if (!hardGate.ok) {
    return { accepted: false, reason: `hard_gate:${hardGate.reason}` };
  }

  const { p_win_cal } = probModel.predictProba(features);
  const { p_low, p_high } = conformal.interval(features);
  const actions = options?.playbooks ?? ['PULLBACK', 'BREAKOUT', 'MR'];
  const banditCtx = selectBanditContext(features);
  const action = bandit.choose(banditCtx, actions);
  const strategyScores = scoreStrategies(features);
  const selected = strategyScores.find(s => s.kind === action.kind) ?? strategyScores[0];

  const slMult = action.kind === 'PULLBACK' ? cfg.EV_PULLBACK_K_SL : action.kind === 'BREAKOUT' ? cfg.EV_BREAKOUT_K_SL : cfg.EV_MR_K_SL;
  const tpMultipliers = action.kind === 'PULLBACK' ? cfg.EV_PULLBACK_TP_MULTS : action.kind === 'BREAKOUT' ? cfg.EV_BREAKOUT_TP_MULTS : cfg.EV_MR_TP_MULTS;
  const plan = buildExecutionPlan({
    side: features.tf4h.trendBias === 'bear' ? 'short' : 'long',
    price: tf15m[tf15m.length - 1][4],
    atrPct,
    slMult,
    tpMultipliers,
    conformalWidth: p_high - p_low,
    spreadBps: features.micro.spreadBps,
    config: {
      entryLimitSplit: cfg.ENTRY_SPLIT_LIMIT,
      entryPaSplit: cfg.ENTRY_SPLIT_PA,
      limitTimeoutMs: cfg.ENTRY_LIMIT_TIMEOUT_MS,
      twapTriggerSpreadBps: cfg.ENTRY_TWAP_TRIGGER_SPREAD_BPS,
      trailActivateR: cfg.TRAIL_ACTIVATE_R,
      trailPct: cfg.TRAIL_PCT,
    },
  });

  const tpUsd = notional * tpMultipliers[0] * atrPct;
  const slUsd = notional * slMult * atrPct;
  const pUse = (p_high - p_low > 0.2)
    ? Math.max(p_low, cfg.EV_MIN_CONSERVATIVE_PROB)
    : p_win_cal;
  const ev = expectedValue({
    p: pUse,
    tpUsd,
    slUsd,
    notional,
    spreadBps: features.micro.spreadBps,
    slipRecentBps: features.micro.spreadBps,
    passiveFillRate: features.micro.passiveFillRate,
    feesBps: cfg.FEES_BPS,
    alpha: cfg.SLIP_ALPHA,
    beta: cfg.SLIP_BETA,
    capBps: cfg.SLIP_CAP_BPS,
  });

  const regime = features.tf4h.trendBias;
  const accept = passesQuantile(regime, p_win_cal, rollingPf.value(), {
    trend: cfg.ACCEPT_Q_TREND,
    range: cfg.ACCEPT_Q_RANGE,
    volatile: cfg.ACCEPT_Q_VOL,
    pfLow: cfg.THROTTLE_PF_LOW,
    pfHigh: cfg.THROTTLE_PF_HIGH,
    step: cfg.THROTTLE_STEP,
  }) && ev.ev.gt(0);

  telemetry.record({
    symbol,
    regime,
    probability: p_win_cal,
    evEstimate: ev.ev.toNumber(),
  });

  if (!accept) {
    return {
      accepted: false,
      reason: 'policy',
      p_win: p_win_cal,
      p_interval: [p_low, p_high],
      ev: ev.ev.toNumber(),
    };
  }

  return {
    accepted: true,
    action: action.kind,
    p_win: p_win_cal,
    p_interval: [p_low, p_high],
    ev: ev.ev.toNumber(),
    plan,
    why: selected?.reasons ?? [],
  };
}

export function updateBandit(symbol: string, ctx: ContextFeatures, action: StrategyAction['kind'], reward: number): void {
  const banditCtx = selectBanditContext(ctx);
  bandit.update(banditCtx, action, reward);
}

export function recordOutcome(pnl: PreciseDecimal): void {
  rollingPf.push(pnl);
}

export function getTelemetrySummary() {
  return telemetry.summary();
}
