import { metaAdaptiveStrategyAgent, PreciseDecimal, type AdaptiveSignal } from '../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import type { StrategyFamily } from '../quantai/strategies/metaAdaptive/strategyTypes.js';
import type { TechnicalSnapshot } from '../ai/tech.js';
import { type CalibrationProfile } from '../quantai/strategies/metaAdaptive/metaAdaptiveCalibration.js';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export type CalibrationScenario = {
  label: string;
  snap: TechnicalSnapshot;
  symbol?: string;
  biasHint?: 'long' | 'short' | 'none';
  realizedPnlUsd: string | number | PreciseDecimal;
  qty?: number;
  entryPrice?: number;
  stopDistance?: number;
};

export type CalibrationDataset = {
  scenarios: CalibrationScenario[];
};

export type CalibrationOptions = {
  sessionId?: string;
  accountBalanceUsd?: string | number | PreciseDecimal;
  desiredProfitUsd?: string | number | PreciseDecimal;
  explorationEpsilon?: number;
  seed?: number;
};

export type CalibrationMetrics = {
  trades: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number;
  expectancy: number;
  winRate: number;
};

export type CalibrationResult = {
  profile: CalibrationProfile;
  metrics: CalibrationMetrics;
};

function ensureFinite(label: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Calibration metric ${label} is not finite`);
  }
}

function ensureSelection(signal: AdaptiveSignal | null, label: string): AdaptiveSignal {
  if (!signal) {
    throw new Error(`No adaptive selection available for scenario ${label}`);
  }
  if (!signal.plan) {
    throw new Error(`Adaptive selection missing plan for scenario ${label}`);
  }
  return signal;
}

export async function runMetaAdaptiveCalibration(dataset: CalibrationDataset, options?: CalibrationOptions): Promise<CalibrationResult> {
  if (!dataset.scenarios.length) {
    throw new Error('Calibration dataset is empty');
  }
  const agent = metaAdaptiveStrategyAgent;
  agent.reset();
  agent.setReentryCooldownMinutes(0);
  if (options?.seed != null) {
    agent.setRandomSeed(options.seed);
  }
  if (options?.explorationEpsilon != null) {
    agent.setExplorationEpsilon(options.explorationEpsilon);
  }
  const sessionId = options?.sessionId ?? 'meta-calibration-session';
  const capitalInput = options?.accountBalanceUsd ?? '1000';
  const desiredProfitInput = options?.desiredProfitUsd ?? '30';
  const capitalDecimal = new PreciseDecimal(capitalInput);
  const desiredProfitDecimal = new PreciseDecimal(desiredProfitInput);

  const returns: number[] = [];
  const familySum = new Map<StrategyFamily, PreciseDecimal>();
  const familyCount = new Map<StrategyFamily, number>();

  let equity = new PreciseDecimal('1');

  for (const [index, scenario] of dataset.scenarios.entries()) {
    const symbol = scenario.symbol ?? (scenario.snap.symbol || `CAL-${index}`);
    const evaluation = agent.evaluate({
      sessionId,
      symbol,
      snap: scenario.snap,
      biasHint: scenario.biasHint,
      accountBalanceUsd: capitalDecimal,
      desiredProfitUsd: desiredProfitDecimal,
    });
    const selection = ensureSelection(evaluation.selection ?? evaluation.signals[0] ?? null, scenario.label);
    const token = selection.token ?? `cal-${index}`;
    await agent.registerActiveTrade({
      sessionId,
      symbol,
      family: selection.family,
      id: selection.id,
      token,
      qty: scenario.qty ?? 1,
      entryPrice: scenario.entryPrice ?? (Number(scenario.snap.last ?? 0) || 0),
      stopDistance: scenario.stopDistance ?? 1,
      plan: selection.plan,
      side: selection.bias,
      predictorFeatures: selection.predictorFeatures ?? null,
    });
    const realizedDecimal = new PreciseDecimal(scenario.realizedPnlUsd);
    agent.registerOutcome({
      sessionId,
      symbol,
      token,
      realizedPnlUsd: realizedDecimal.toNumber(),
    });
    const tradeReturn = capitalDecimal.equals(0)
      ? new PreciseDecimal('0')
      : realizedDecimal.dividedBy(capitalDecimal);
    returns.push(tradeReturn.toNumber());
    const growth = new PreciseDecimal('1').plus(tradeReturn);
    equity = equity.times(growth);
    const riskUsd = selection.plan.riskUsd ?? new PreciseDecimal('0');
    const rMultiple = riskUsd.gt(0) ? realizedDecimal.dividedBy(riskUsd) : new PreciseDecimal('0');
    const currentFamily = selection.family;
    const aggregated = familySum.get(currentFamily) ?? new PreciseDecimal('0');
    familySum.set(currentFamily, aggregated.plus(rMultiple));
    familyCount.set(currentFamily, (familyCount.get(currentFamily) ?? 0) + 1);
  }

  const trades = returns.length;
  if (trades === 0) {
    throw new Error('Calibration produced no trades');
  }

  const finalEquity = equity.toNumber();
  const cagr = Math.pow(finalEquity, 1 / trades) - 1;

  let runningPeak = 1;
  let equityCursor = 1;
  let maxDrawdown = 0;
  for (const r of returns) {
    equityCursor *= 1 + r;
    if (equityCursor > runningPeak) {
      runningPeak = equityCursor;
    }
    const drawdown = runningPeak > 0 ? (runningPeak - equityCursor) / runningPeak : 0;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  const expectancy = returns.reduce((sum, r) => sum + r, 0) / trades;
  const winRate = returns.filter(r => r > 0).length / trades;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - expectancy, 2), 0) / trades;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev === 0 ? 0 : expectancy / stdev;

  ensureFinite('CAGR', cagr);
  ensureFinite('drawdown', maxDrawdown);
  ensureFinite('expectancy', expectancy);
  ensureFinite('sharpe', sharpe);

  const adjustments: Record<StrategyFamily, number> = {
    trend: 0,
    breakout: 0,
    mean_reversion: 0,
    momentum: 0,
  };

  for (const [family, sum] of familySum.entries()) {
    const count = familyCount.get(family) ?? 0;
    if (count === 0) continue;
    const avgR = sum.dividedBy(new PreciseDecimal(count.toString())).toNumber();
    const adj = clamp(avgR / 5, -0.15, 0.15);
    adjustments[family] = Number(adj.toFixed(4));
  }

  const profile: CalibrationProfile = {
    familyScoreAdjustments: adjustments,
    minConfidence: clamp(0.2 + winRate * 0.3, 0.2, 0.65),
    explorationFloor: clamp(0.02 + Math.max(0, 0.45 - winRate) * 0.05, 0.01, 0.08),
  };

  agent.loadCalibration(profile);

  const metrics: CalibrationMetrics = {
    trades,
    cagr,
    maxDrawdown,
    sharpe,
    expectancy,
    winRate,
  };

  return { profile, metrics };
}
