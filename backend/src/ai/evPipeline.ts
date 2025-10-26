import { getConfig } from '../utils/env.js';
import { getEnv } from '../config/env.js';
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
import type { LabeledRow } from './labeling/tripleBarrier.js';
import { fetchPerformanceSnapshot, type PerformanceSnapshot } from './performance/memory.js';

type ContextWithMulti = ContextFeatures & {
  multiTimeframe?: {
    timeframes?: Record<string, { bias?: string | null }>;
  };
};

type PerformanceMemory = Pick<PerformanceSnapshot, 'sample' | 'winRate' | 'lastTradeAt'>;

export interface OpportunityEvaluation {
  accepted: boolean;
  reason?: string;
  action?: StrategyAction['kind'];
  p_win?: number;
  p_interval?: [number, number];
  ev?: number;
  plan?: ReturnType<typeof serializePlan>;
  why?: string[];
}

const probModel = new ProbModel();
const conformal = new Conformal(probModel);
const bandit = new ContextualBandit(1337);
let modelReady = false;


export function fitProbabilityModel(dataset: LabeledRow[]): void {
  probModel.fit(dataset);
  conformal.calibrate(dataset);
  modelReady = true;
}

type EvaluateOptions = {
  context?: ContextWithMulti;
  playbooks?: StrategyAction['kind'][];
  now?: number;
  ohlcv15m?: number[][];
  baseNotionalCapUsd?: number;
  performanceMemory?: {
    sample: number;
    winRate: number | null;
    lastTradeAt: number | null;
  };
  sizingMode?: 'risk' | 'budget';
  budgetUsd?: number;
};

export async function evaluateOpportunity(
  symbol: string,
  equityUsd: number,
  options?: EvaluateOptions,
): Promise<OpportunityEvaluation> {
  if (!modelReady) {
    throw new Error('Probability model not trained');
  }
  const cfg = getConfig();
  const envPolicy = getEnv();
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

  const bias4h = resolveBias('4h', features, options?.context);
  const bias15 = resolveBias('15m', features, options?.context);
  if ((bias4h === 'bullish' && bias15 === 'bearish') || (bias4h === 'bearish' && bias15 === 'bullish')) {
    return { accepted: false, reason: 'tf_conflict_4h_vs_15m' };
  }

  const { p_win_cal } = probModel.predictProba(features);
  const { p_low, p_high } = conformal.interval(features);
  const perfMemory = await resolvePerformanceMemory(symbol, options?.performanceMemory);
  if (perfMemory && Number.isFinite(perfMemory.sample) && perfMemory.sample >= cfg.EV_PERF_MIN_SAMPLE) {
    const winRate = typeof perfMemory.winRate === 'number' ? perfMemory.winRate : null;
    if (winRate != null && Number.isFinite(winRate) && winRate < cfg.EV_PERF_MIN_WINRATE) {
      const nowTs = options?.now ?? Date.now();
      const ageHours = perfMemory.lastTradeAt != null
        ? (nowTs - perfMemory.lastTradeAt) / 3_600_000
        : Infinity;
      const reason = ageHours < cfg.EV_PERF_COOLDOWN_HOURS
        ? 'perf_memory_cooldown'
        : 'perf_memory_reject';
      console.warn(`EV pipeline rejecting ${symbol} due to performance memory (${winRate.toFixed(1)}% win, sample=${perfMemory.sample}).`);
      return {
        accepted: false,
        reason,
        p_win: p_win_cal,
        p_interval: [p_low, p_high],
      };
    }
  }
  const actions = options?.playbooks ?? ['PULLBACK', 'BREAKOUT', 'MR'];
  const banditCtx = selectBanditContext(features);
  const action = bandit.choose(banditCtx, actions);
  const strategyScores = scoreStrategies(features);
  const selected = strategyScores.find((s) => s.kind === action.kind) ?? strategyScores[0];

  const slMult = action.kind === 'PULLBACK' ? cfg.EV_PULLBACK_K_SL : action.kind === 'BREAKOUT' ? cfg.EV_BREAKOUT_K_SL : cfg.EV_MR_K_SL;
  const tpMultipliers = action.kind === 'PULLBACK'
    ? cfg.EV_PULLBACK_TP_MULTS
    : action.kind === 'BREAKOUT'
      ? cfg.EV_BREAKOUT_TP_MULTS
      : cfg.EV_MR_TP_MULTS;

  const stopPct = atrPct * slMult;
  if (!Number.isFinite(stopPct) || stopPct <= 0) {
    return { accepted: false, reason: 'invalid_stop' };
  }

  const slipRecentBps = typeof (options?.context as any)?.micro?.slipRecentBps === 'number'
    ? Number((options?.context as any)?.micro?.slipRecentBps)
    : features.micro.spreadBps;
  const atrPctPercent = Number.isFinite(atrPct) ? atrPct * 100 : undefined;
  const rawDepthUsd = Math.min(Number(features.micro.bidDepthUsd ?? 0), Number(features.micro.askDepthUsd ?? 0));
  const depthForPlan = Number.isFinite(rawDepthUsd) && rawDepthUsd > 0 ? rawDepthUsd : undefined;
  const sizingMode = options?.sizingMode ?? 'risk';

  const plan = buildExecutionPlan({
    equityUsd,
    stopPct,
    baseNotionalCapUsd: options?.baseNotionalCapUsd,
    tpMultipliers,
    spreadBps: features.micro.spreadBps,
    passiveFillRate: features.micro.passiveFillRate,
    mode: sizingMode,
    budgetUsd: options?.budgetUsd,
    atrPct: atrPctPercent,
    depthUsd: depthForPlan,
    slipRecentBps,
  });
  if (!plan) {
    return { accepted: false, reason: 'low_reward', p_win: p_win_cal, p_interval: [p_low, p_high] };
  }

  const pUse = (p_high - p_low > 0.2)
    ? Math.max(p_low, cfg.EV_MIN_CONSERVATIVE_PROB)
    : (Number.isFinite(p_win_cal) ? p_win_cal : 0.55);

  const evEstimate = expectedValue({
    p: pUse,
    tpUsd: plan.precise.tpUsd,
    slUsd: plan.precise.riskUsd,
    notionalUsd: plan.precise.notionalUsd,
    spreadBps: features.micro.spreadBps,
    slipRecentBps,
    passiveFillRate: features.micro.passiveFillRate,
  });

  if (evEstimate.rawSlipBps > envPolicy.SLIP_CAP_BPS) {
    return {
      accepted: false,
      reason: 'slippage_cap',
      p_win: p_win_cal,
      p_interval: [p_low, p_high],
      ev: evEstimate.ev.toNumber(),
    };
  }

  if (!evEstimate.ev.gt(0)) {
    return {
      accepted: false,
      reason: 'ev_non_positive',
      p_win: p_win_cal,
      p_interval: [p_low, p_high],
      ev: evEstimate.ev.toNumber(),
    };
  }

  const regime = features.tf4h.trendBias as 'bull' | 'bear' | 'neutral';
  const passesPolicy = passesQuantile(regime, p_win_cal, 1, {
    trend: cfg.ACCEPT_Q_TREND,
    range: cfg.ACCEPT_Q_RANGE,
    volatile: cfg.ACCEPT_Q_VOL,
    pfLow: cfg.THROTTLE_PF_LOW,
    pfHigh: cfg.THROTTLE_PF_HIGH,
    step: cfg.THROTTLE_STEP,
  });

  if (!passesPolicy) {
    return {
      accepted: false,
      reason: 'policy',
      p_win: p_win_cal,
      p_interval: [p_low, p_high],
      ev: evEstimate.ev.toNumber(),
    };
  }

  return {
    accepted: true,
    action: action.kind,
    p_win: p_win_cal,
    p_interval: [p_low, p_high],
    ev: evEstimate.ev.toNumber(),
    plan: serializePlan(plan),
    why: selected?.reasons ?? [],
  };
}

export function updateBandit(symbol: string, ctx: ContextFeatures, action: StrategyAction['kind'], reward: number): void {
  const banditCtx = selectBanditContext(ctx);
  bandit.update(banditCtx, action, reward);
}

async function resolvePerformanceMemory(
  symbol: string,
  provided?: EvaluateOptions['performanceMemory'],
): Promise<PerformanceMemory | null> {
  if (provided) {
    return {
      sample: provided.sample,
      winRate: provided.winRate,
      lastTradeAt: provided.lastTradeAt ?? null,
    };
  }
  if (process.env.UNIT_TEST_MODE === 'true') {
    return null;
  }
  try {
    const snapshot = await fetchPerformanceSnapshot(symbol);
    return {
      sample: snapshot.sample,
      winRate: snapshot.winRate,
      lastTradeAt: snapshot.lastTradeAt,
    };
  } catch (error) {
    console.warn(`EV pipeline could not load performance memory for ${symbol}:`, error);
    return null;
  }
}

function serializePlan(plan: NonNullable<ReturnType<typeof buildExecutionPlan>>): {
  legs: typeof plan.legs;
  notionalUsd: number;
  riskUsd: number;
  slPct: number;
  tpPcts: number[];
  tpUsd: number;
  precise: typeof plan.precise;
  preciseDisplay: {
    notionalUsd: string;
    riskUsd: string;
    slPct: string;
    tpPcts: string[];
    tpUsd: string;
  };
} {
  return {
    legs: plan.legs,
    notionalUsd: plan.notionalUsd,
    riskUsd: plan.riskUsd,
    slPct: plan.slPct,
    tpPcts: plan.tpPcts,
    tpUsd: plan.tpUsd,
    precise: plan.precise,
    preciseDisplay: {
      notionalUsd: plan.precise.notionalUsd.toFixed(2),
      riskUsd: plan.precise.riskUsd.toFixed(2),
      slPct: plan.precise.slPct.toFixed(6),
      tpPcts: plan.precise.tpPcts.map((tp) => tp.toFixed(6)),
      tpUsd: plan.precise.tpUsd.toFixed(2),
    },
  };
}

type Bias = 'bullish' | 'bearish' | 'neutral';

function resolveBias(timeframe: '4h' | '15m', features: ContextFeatures, context?: ContextWithMulti): Bias {
  const multi = context?.multiTimeframe?.timeframes?.[timeframe]?.bias;
  if (multi) return normalizeBias(multi);
  if (timeframe === '4h') {
    return normalizeBias(features.tf4h.trendBias);
  }
  const slope = Number(features.tf15m.emaSlope20);
  const roc = Number(features.tf15m.roc12);
  if (slope > 0.0005 || roc > 0.0005) return 'bullish';
  if (slope < -0.0005 || roc < -0.0005) return 'bearish';
  return 'neutral';
}

function normalizeBias(value: unknown): Bias {
  const str = String(value ?? '').toLowerCase();
  if (['bull', 'bullish', 'long', 'up'].includes(str)) return 'bullish';
  if (['bear', 'bearish', 'short', 'down'].includes(str)) return 'bearish';
  return 'neutral';
}
