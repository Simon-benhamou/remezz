// Intraday removed - keeping minimal type stubs for comparison report
type IntradayTradeLog = { timestamp: number; pnl: number };
type Candle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };
type BacktestResult = { metrics: any; trades: IntradayTradeLog[] };

import type { TechnicalSnapshot } from '../../../ai/tech.js';
import { runMetaAdaptiveBacktest, buildMetaAdaptiveSyntheticCandles } from './backtest.js';
import {
  evaluateRecognizedStrategies,
  registerAdaptiveTradeEntry,
  registerAdaptiveTradeOutcome,
  metaAdaptiveConfidenceThreshold,
  type RecognizedStrategyId,
} from './recognizedStrategies.js';
import { PreciseDecimal, metaAdaptiveStrategyAgent } from './metaAdaptiveAgent.js';

export type StrategyComparisonReport = {
  intraday: {
    metrics: BacktestResult['metrics'];
    trades: IntradayTradeLog[];
  };
  metaAdaptive: {
    metrics: {
      totalReturnPct: number;
      cagr: number;
      sharpe: number;
      maxDrawdownPct: number;
      trades: number;
      hitRate: number;
      profitFactor: number;
      avgWin: number;
      avgLoss: number;
      confidenceGateThreshold: number;
      confidenceGateBlockedSignalsPct: number;
      confidenceGateBlockedPrimaryPct: number;
    };
    trades: MetaAdaptiveTradeLog[];
    sideBreakdown: MetaAdaptiveSideMetrics[];
    strategyBreakdown: StrategySideMetrics[];
  };
  metaAdaptiveBacktest: BacktestResult;
  metaAdaptiveWalkForward: { start: number; end: number; metrics: BacktestResult['metrics'] }[];
  summaryTable: StrategySummaryRow[];
};

export type StrategySummaryRow = {
  label: string;
  trades: number;
  hitRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  sharpe: number;
  maxDrawdownPct: number;
  cagr: number;
};

export type MetaAdaptiveTradeLog = {
  timestamp: number;
  label: string;
  side: 'long' | 'short';
  strategyId: RecognizedStrategyId;
  quantity: PreciseDecimal;
  entryPrice: PreciseDecimal;
  exitPrice: PreciseDecimal;
  pnlPct: PreciseDecimal;
  cumulativePnlPct: PreciseDecimal;
  confidence: number;
  qualityScore: number;
  confidenceGatePassed: boolean;
  confidenceThreshold: number;
  blockedReason: string | null;
  entryEligibilityScore: number | null;
  entryEligibilityGatePassed: boolean;
  entryEligibilityReasons: string[];
  predictorBlocked?: boolean;
};

export type MetaAdaptiveSideMetrics = {
  side: 'long' | 'short';
  attempts: number;
  trades: number;
  wins: number;
  losses: number;
  hitRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  predictorBlocked: number;
};

export type StrategySideMetrics = MetaAdaptiveSideMetrics & {
  strategyId: RecognizedStrategyId;
};

const ONE = new PreciseDecimal('1');
const HUNDRED = new PreciseDecimal('100');

type SideAccumulator = {
  attempts: number;
  trades: number;
  wins: number;
  losses: number;
  winSum: number;
  lossSum: number;
  predictorBlocked: number;
};

function makeAccumulator(): SideAccumulator {
  return {
    attempts: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    winSum: 0,
    lossSum: 0,
    predictorBlocked: 0,
  };
}

function updateAccumulator(acc: SideAccumulator, pnl: number): void {
  acc.trades += 1;
  if (pnl > 0) {
    acc.wins += 1;
    acc.winSum += pnl;
  } else if (pnl < 0) {
    acc.losses += 1;
    acc.lossSum += Math.abs(pnl);
  }
}

function buildSideMetrics(side: 'long' | 'short', acc: SideAccumulator): MetaAdaptiveSideMetrics {
  const hitRate = acc.trades > 0 ? acc.wins / acc.trades : 0;
  const profitFactor = acc.lossSum > 0 ? acc.winSum / acc.lossSum : (acc.winSum > 0 && acc.lossSum === 0 ? Number.POSITIVE_INFINITY : 0);
  const avgWin = acc.wins > 0 ? acc.winSum / acc.wins : 0;
  const avgLoss = acc.losses > 0 ? -(acc.lossSum / acc.losses) : 0;
  return {
    side,
    attempts: acc.attempts,
    trades: acc.trades,
    wins: acc.wins,
    losses: acc.losses,
    hitRate,
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : 0,
    avgWin,
    avgLoss,
    predictorBlocked: acc.predictorBlocked,
  };
}

function buildSummaryRow(label: string, metrics: {
  trades: number;
  hitRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  sharpe: number;
  maxDrawdownPct: number;
  cagr: number;
}): StrategySummaryRow {
  return {
    label,
    trades: Number(metrics.trades),
    hitRate: Number(metrics.hitRate),
    profitFactor: Number(metrics.profitFactor),
    avgWin: Number(metrics.avgWin),
    avgLoss: Number(metrics.avgLoss),
    sharpe: Number(metrics.sharpe),
    maxDrawdownPct: Number(metrics.maxDrawdownPct),
    cagr: Number(metrics.cagr),
  };
}

export function buildIntradayComparisonCandles(): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 240; i += 1) {
    const trend = i < 120 ? 0.2 : i < 180 ? -0.3 : 0.25;
    price += trend;
    const high = price + 0.5;
    const low = price - 0.8;
    candles.push({
      timestamp: 1_700_500_000_000 + i * 60_000,
      open: price - trend,
      high,
      low,
      close: price,
      volume: 200 + (i % 30) * 5,
    });
  }
  return candles;
}

type ScenarioDefinition = {
  label: string;
  strategyId: RecognizedStrategyId;
  side: 'long' | 'short';
  regime: 'trend_following' | 'range';
  snap: TechnicalSnapshot;
  pnlPct: PreciseDecimal;
};

type SnapshotOverrides = {
  symbol?: string;
  last?: number;
  bias4h?: 'bullish' | 'bearish' | 'neutral';
  bias1h?: 'bullish' | 'bearish' | 'neutral';
  bias15m?: 'bullish' | 'bearish' | 'neutral';
  emaBias?: number;
  atrPct?: number;
  rsi14?: number;
  trendStrength?: number;
  cmf20?: number;
  realizedVol?: number;
  adx14?: number;
  srBias?: TechnicalSnapshot['srBias'];
  trendBias?: TechnicalSnapshot['trendBias'];
};

function buildSnapshot(overrides: SnapshotOverrides = {}): TechnicalSnapshot {
  const last = overrides.last ?? 100;
  const emaBias = overrides.emaBias ?? 0.01;
  const atrPct = overrides.atrPct ?? 1.2;
  const bias4h = overrides.bias4h ?? 'bullish';
  const bias1h = overrides.bias1h ?? bias4h;
  const bias15m = overrides.bias15m ?? bias1h;
  const srBias = overrides.srBias ?? 'nearSupport';
  const trendBias = overrides.trendBias ?? (emaBias >= 0 ? 'bullish' : 'bearish');
  const trendStrength = overrides.trendStrength ?? 0.65;
  const cmf20 = overrides.cmf20 ?? 0.22;
  const adx14 = overrides.adx14 ?? 24;

  return {
    symbol: overrides.symbol ?? 'ETH/USDT',
    last,
    ema20: last * (1 + emaBias),
    ema50: last * (1 + emaBias / 2),
    ema100: last * (1 + emaBias / 3),
    ema200: last * (1 + emaBias / 4),
    rsi14: overrides.rsi14 ?? 55,
    atr14: last * (atrPct / 100),
    atrPct,
    adx14,
    ema20Slope: last * 0.0012,
    support: srBias === 'nearSupport' ? last * 0.97 : last * 0.99,
    resistance: srBias === 'nearResistance' ? last * 1.01 : last * 1.03,
    supports: [{ price: last * 0.97, label: 'S1', touches: 3, strength: 2 }],
    resistances: [{ price: last * 1.03, label: 'R1', touches: 2, strength: 2 }],
    pivots: {
      P: last,
      S1: last * 0.99,
      S2: last * 0.98,
      R1: last * 1.01,
      R2: last * 1.02,
      refDay: new Date(1_700_000_000_000).toISOString().slice(0, 10),
    },
    trend: trendStrength,
    srBias,
    meta: { tf: '15m', windowBars: 120, recentBarsFor24h: 96 },
    realizedVol: overrides.realizedVol ?? 1.3,
    hurst: 0.55,
    adxSlope: 0.02,
    trendStrength,
    trendBias,
    volume: 800_000,
    volumeMA: 500_000,
    volume24h: 60_000_000,
    cmf20,
    multiTimeframe: {
      timeframes: {
        '4h': { tf: '4h', bias: bias4h, momentumPct: bias4h === 'bullish' ? 0.4 : -0.38, rsi: bias4h === 'bullish' ? 55 : 45 },
        '1h': { tf: '1h', bias: bias1h, momentumPct: bias1h === 'bullish' ? 0.3 : -0.28, rsi: bias1h === 'bullish' ? 53 : 47 },
        '15m': { tf: '15m', bias: bias15m, momentumPct: bias15m === 'bullish' ? 0.2 : -0.2, rsi: bias15m === 'bullish' ? 52 : 48 },
      },
      agreementScore: [bias4h, bias1h, bias15m].filter((bias) => bias === 'bullish').length,
      divergenceScore: 0,
    },
  };
}

function buildBearishSnapshot(overrides: SnapshotOverrides = {}): TechnicalSnapshot {
  return buildSnapshot({
    emaBias: overrides.emaBias ?? -0.01,
    cmf20: overrides.cmf20 ?? -0.3,
    bias4h: overrides.bias4h ?? 'bearish',
    bias1h: overrides.bias1h ?? 'bearish',
    bias15m: overrides.bias15m ?? 'bearish',
    trendBias: overrides.trendBias ?? 'bearish',
    srBias: overrides.srBias ?? 'nearResistance',
    trendStrength: overrides.trendStrength ?? 0.8,
    ...overrides,
  });
}

function createMetaAdaptiveScenarios(): ScenarioDefinition[] {
  return [
    {
      label: 'trend-long',
      strategyId: 'classic_trend_following',
      side: 'long',
      regime: 'trend_following',
      snap: buildSnapshot({ bias4h: 'bullish', bias1h: 'bullish', bias15m: 'bullish', adx14: 32, trendStrength: 0.95, cmf20: 0.38 }),
      pnlPct: new PreciseDecimal('3.2'),
    },
    {
      label: 'trend-short',
      strategyId: 'classic_trend_following',
      side: 'short',
      regime: 'trend_following',
      snap: buildBearishSnapshot({ adx14: 30, trendStrength: 0.92, cmf20: -0.36 }),
      pnlPct: new PreciseDecimal('2.4'),
    },
    {
      label: 'momentum-long',
      strategyId: 'momentum_scanner_focus',
      side: 'long',
      regime: 'trend_following',
      snap: buildSnapshot({ adx14: 34, trendStrength: 1.05, cmf20: 0.45, bias4h: 'bullish', bias1h: 'bullish', realizedVol: 1.6 }),
      pnlPct: new PreciseDecimal('4.4'),
    },
    {
      label: 'momentum-short',
      strategyId: 'momentum_scanner_focus',
      side: 'short',
      regime: 'trend_following',
      snap: buildBearishSnapshot({ adx14: 33, trendStrength: 1.02, cmf20: -0.42, realizedVol: 1.7 }),
      pnlPct: new PreciseDecimal('3.1'),
    },
    {
      label: 'mean-long',
      strategyId: 'bollinger_mean_reversion',
      side: 'long',
      regime: 'range',
      snap: buildSnapshot({ adx14: 11, rsi14: 68, emaBias: -0.002, bias4h: 'neutral', bias1h: 'bearish', bias15m: 'neutral', srBias: 'nearSupport' }),
      pnlPct: new PreciseDecimal('1.1'),
    },
    {
      label: 'mean-short',
      strategyId: 'bollinger_mean_reversion',
      side: 'short',
      regime: 'range',
      snap: buildBearishSnapshot({ adx14: 10, rsi14: 32, srBias: 'nearResistance', emaBias: 0.002 }),
      pnlPct: new PreciseDecimal('0.9'),
    },
    {
      label: 'trend-loss-long',
      strategyId: 'classic_trend_following',
      side: 'long',
      regime: 'trend_following',
      snap: buildSnapshot({ adx14: 22, trendStrength: 0.4, cmf20: -0.05, emaBias: -0.003 }),
      pnlPct: new PreciseDecimal('-1.4'),
    },
    {
      label: 'trend-loss-short',
      strategyId: 'classic_trend_following',
      side: 'short',
      regime: 'trend_following',
      snap: buildBearishSnapshot({ adx14: 18, trendStrength: 0.38, cmf20: 0.04, emaBias: 0.002 }),
      pnlPct: new PreciseDecimal('-1.1'),
    },
  ];
}

async function runMetaAdaptiveComparison(): Promise<{
  metrics: {
    totalReturnPct: number;
    cagr: number;
    sharpe: number;
    maxDrawdownPct: number;
    trades: number;
    hitRate: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
    confidenceGateThreshold: number;
    confidenceGateBlockedSignalsPct: number;
    confidenceGateBlockedPrimaryPct: number;
  };
  trades: MetaAdaptiveTradeLog[];
  sideBreakdown: MetaAdaptiveSideMetrics[];
  strategyBreakdown: StrategySideMetrics[];
}> {
  process.env.UNIT_TEST_MODE = process.env.UNIT_TEST_MODE ?? 'true';
  process.env.USE_IN_MEMORY_DB = process.env.USE_IN_MEMORY_DB ?? 'true';
  process.env.MARKET_TYPE = process.env.MARKET_TYPE ?? 'futures';
  process.env.EXCHANGE_ID = process.env.EXCHANGE_ID ?? 'binanceusdm';

  const sessionId = 'strategy-comparison-session';
  metaAdaptiveStrategyAgent.reset(sessionId);
  metaAdaptiveStrategyAgent.setRandomSeed(42);

  const scenarios = createMetaAdaptiveScenarios();
  const returns: number[] = [];
  const tradeLogs: MetaAdaptiveTradeLog[] = [];
  let equity = ONE;
  let evaluatedSignals = 0;
  let blockedSignals = 0;
  let primaryEvaluations = 0;
  let primaryBlocked = 0;

  const perSideTotals: Record<'long' | 'short', SideAccumulator> = {
    long: makeAccumulator(),
    short: makeAccumulator(),
  };
  const perStrategyTotals = new Map<RecognizedStrategyId, Record<'long' | 'short', SideAccumulator>>();
  const ensureStrategyAccumulator = (strategyId: RecognizedStrategyId): Record<'long' | 'short', SideAccumulator> => {
    const existing = perStrategyTotals.get(strategyId);
    if (existing) return existing;
    const bucket: Record<'long' | 'short', SideAccumulator> = {
      long: makeAccumulator(),
      short: makeAccumulator(),
    };
    perStrategyTotals.set(strategyId, bucket);
    return bucket;
  };
  const zero = new PreciseDecimal('0');

  for (const scenario of scenarios) {
    const loopSessionId = `${sessionId}-${scenario.label}`;
    metaAdaptiveStrategyAgent.reset(loopSessionId);
    const sideAccumulator = perSideTotals[scenario.side];
    const strategyAccumulator = ensureStrategyAccumulator(scenario.strategyId)[scenario.side];
    sideAccumulator.attempts += 1;
    strategyAccumulator.attempts += 1;

    const signals = evaluateRecognizedStrategies(scenario.snap, {
      sessionId: loopSessionId,
      symbol: scenario.snap.symbol ?? 'ETH/USDT',
      bias: scenario.side,
      regime: scenario.regime === 'range' ? 'range' : 'trend_following',
      allowMomentumOverride: scenario.strategyId === 'momentum_scanner_focus',
      favorMeanReversion: scenario.strategyId === 'bollinger_mean_reversion',
    });

    evaluatedSignals += signals.length;
    blockedSignals += signals.filter(signal => !signal.confidenceGatePassed).length;

    const primary = signals.find((signal) => signal.meta?.token) ?? signals[0] ?? null;
    if (!primary) {
      metaAdaptiveStrategyAgent.reset(loopSessionId);
      continue;
    }
    primaryEvaluations += 1;

    if (!primary.confidenceGatePassed) {
      primaryBlocked += 1;
      const cumulativePct = equity.minus(ONE).times(HUNDRED);
      tradeLogs.push({
        timestamp: Date.now(),
        label: scenario.label,
        side: scenario.side,
        strategyId: scenario.strategyId,
        quantity: zero,
        entryPrice: zero,
        exitPrice: zero,
        pnlPct: zero,
        cumulativePnlPct: cumulativePct,
        confidence: Number(primary.confidence.toFixed(4)),
        qualityScore: primary.qualityScore,
        confidenceGatePassed: false,
        confidenceThreshold: metaAdaptiveConfidenceThreshold,
        blockedReason: primary.blockedReason ?? 'low_confidence',
        entryEligibilityScore: primary.entryEligibilityScore ?? null,
        entryEligibilityGatePassed: Boolean(primary.entryEligibilityGatePassed),
        entryEligibilityReasons: primary.entryEligibilityReasons ?? [],
        predictorBlocked: false,
      });
      metaAdaptiveStrategyAgent.reset(loopSessionId);
      continue;
    }
    if (!primary.entryEligibilityGatePassed) {
      primaryBlocked += 1;
      const cumulativePct = equity.minus(ONE).times(HUNDRED);
      tradeLogs.push({
        timestamp: Date.now(),
        label: scenario.label,
        side: scenario.side,
        strategyId: scenario.strategyId,
        quantity: zero,
        entryPrice: zero,
        exitPrice: zero,
        pnlPct: zero,
        cumulativePnlPct: cumulativePct,
        confidence: Number(primary.confidence.toFixed(4)),
        qualityScore: primary.qualityScore,
        confidenceGatePassed: true,
        confidenceThreshold: metaAdaptiveConfidenceThreshold,
        blockedReason: primary.blockedReason ?? 'weak_entry_context',
        entryEligibilityScore: primary.entryEligibilityScore ?? null,
        entryEligibilityGatePassed: false,
        entryEligibilityReasons: primary.entryEligibilityReasons ?? [],
        predictorBlocked: false,
      });
      metaAdaptiveStrategyAgent.reset(loopSessionId);
      continue;
    }

    const registrationResult = await registerAdaptiveTradeEntry({
      sessionId: loopSessionId,
      symbol: 'ETH/USDT',
      signal: primary,
      qty: 1,
      entryPrice: 100,
      stopDistance: 1,
    });

    if (registrationResult === 'predictor_blocked') {
      primaryBlocked += 1;
      sideAccumulator.predictorBlocked += 1;
      strategyAccumulator.predictorBlocked += 1;
      const cumulativePct = equity.minus(ONE).times(HUNDRED);
      tradeLogs.push({
        timestamp: Date.now(),
        label: scenario.label,
        side: scenario.side,
        strategyId: scenario.strategyId,
        quantity: zero,
        entryPrice: zero,
        exitPrice: zero,
        pnlPct: zero,
        cumulativePnlPct: cumulativePct,
        confidence: Number(primary.confidence.toFixed(4)),
        qualityScore: primary.qualityScore,
        confidenceGatePassed: true,
        confidenceThreshold: metaAdaptiveConfidenceThreshold,
        blockedReason: 'predictor_disagrees',
        entryEligibilityScore: primary.entryEligibilityScore ?? null,
        entryEligibilityGatePassed: true,
        entryEligibilityReasons: primary.entryEligibilityReasons ?? [],
        predictorBlocked: true,
      });
      metaAdaptiveStrategyAgent.reset(loopSessionId);
      continue;
    }

    registerAdaptiveTradeOutcome({
      sessionId: loopSessionId,
      symbol: 'ETH/USDT',
      token: primary?.meta?.token ?? null,
      realizedPnlUsd: scenario.pnlPct.toNumber(),
    });

    const tradeReturn = scenario.pnlPct.dividedBy(HUNDRED);
    returns.push(tradeReturn.toNumber());
    equity = equity.times(ONE.plus(tradeReturn));

    const pnlValue = scenario.pnlPct.toNumber();
    updateAccumulator(sideAccumulator, pnlValue);
    updateAccumulator(strategyAccumulator, pnlValue);

    const entryPrice = new PreciseDecimal('100');
    const exitPrice = entryPrice.times(ONE.plus(tradeReturn));
    const quantity = new PreciseDecimal('1');
    const cumulativePct = equity.minus(ONE).times(HUNDRED);
    tradeLogs.push({
      timestamp: Date.now(),
      label: scenario.label,
      side: scenario.side,
      strategyId: scenario.strategyId,
      quantity,
      entryPrice,
      exitPrice,
      pnlPct: scenario.pnlPct,
      cumulativePnlPct: cumulativePct,
      confidence: Number(primary.confidence.toFixed(4)),
      qualityScore: primary.qualityScore,
      confidenceGatePassed: true,
      confidenceThreshold: metaAdaptiveConfidenceThreshold,
      blockedReason: null,
      entryEligibilityScore: primary.entryEligibilityScore ?? null,
      entryEligibilityGatePassed: true,
      entryEligibilityReasons: primary.entryEligibilityReasons ?? [],
      predictorBlocked: false,
    });

    metaAdaptiveStrategyAgent.reset(loopSessionId);
  }

  const trades = returns.length;
  const finalEquity = equity.toNumber();
  const totalReturnPct = (finalEquity - 1) * 100;
  const cagr = trades > 0 ? Math.pow(finalEquity, 1 / Math.max(trades, 1)) - 1 : 0;

  let runningPeak = 1;
  let equityCursor = 1;
  let maxDrawdownPct = 0;
  for (const r of returns) {
    equityCursor *= (1 + r);
    if (equityCursor > runningPeak) runningPeak = equityCursor;
    const drawdown = runningPeak === 0 ? 0 : (runningPeak - equityCursor) / runningPeak;
    if (drawdown > maxDrawdownPct) {
      maxDrawdownPct = drawdown;
    }
  }
  maxDrawdownPct *= 100;

  const meanReturn = trades > 0 ? returns.reduce((sum, value) => sum + value, 0) / trades : 0;
  const variance = trades > 0
    ? returns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / trades
    : 0;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev === 0 ? 0 : meanReturn / stdev;
  const blockedSignalsPct = evaluatedSignals > 0 ? (blockedSignals / evaluatedSignals) * 100 : 0;
  const primaryBlockedPct = primaryEvaluations > 0 ? (primaryBlocked / primaryEvaluations) * 100 : 0;

  const sideBreakdown: MetaAdaptiveSideMetrics[] = (['long', 'short'] as const).map((side) =>
    buildSideMetrics(side, perSideTotals[side]),
  );
  const strategyBreakdown: StrategySideMetrics[] = Array.from(perStrategyTotals.entries()).flatMap(([strategyId, bucket]) =>
    (['long', 'short'] as const).map((side) => ({
      strategyId,
      ...buildSideMetrics(side, bucket[side]),
    })),
  );

  const executedStats = (['long', 'short'] as const).reduce(
    (acc, side) => {
      const bucket = perSideTotals[side];
      acc.trades += bucket.trades;
      acc.wins += bucket.wins;
      acc.losses += bucket.losses;
      acc.winSum += bucket.winSum;
      acc.lossSum += bucket.lossSum;
      return acc;
    },
    { trades: 0, wins: 0, losses: 0, winSum: 0, lossSum: 0 },
  );

  const hitRate = executedStats.trades > 0 ? executedStats.wins / executedStats.trades : 0;
  const profitFactor = executedStats.lossSum > 0 ? executedStats.winSum / executedStats.lossSum : 0;
  const avgWin = executedStats.wins > 0 ? executedStats.winSum / executedStats.wins : 0;
  const avgLoss = executedStats.losses > 0 ? -(executedStats.lossSum / executedStats.losses) : 0;

  if (
    !Number.isFinite(totalReturnPct)
    || !Number.isFinite(cagr)
    || !Number.isFinite(sharpe)
    || !Number.isFinite(maxDrawdownPct)
    || !Number.isFinite(hitRate)
    || !Number.isFinite(profitFactor)
    || !Number.isFinite(avgWin)
    || !Number.isFinite(avgLoss)
    || !Number.isFinite(blockedSignalsPct)
    || !Number.isFinite(primaryBlockedPct)
  ) {
    throw new Error('Meta-adaptive metrics must be finite');
  }

  metaAdaptiveStrategyAgent.reset(sessionId);

  return {
    metrics: {
      totalReturnPct,
      cagr,
      sharpe,
      maxDrawdownPct,
      trades,
      hitRate,
      profitFactor,
      avgWin,
      avgLoss,
      confidenceGateThreshold: metaAdaptiveConfidenceThreshold,
      confidenceGateBlockedSignalsPct: Number(blockedSignalsPct.toFixed(2)),
      confidenceGateBlockedPrimaryPct: Number(primaryBlockedPct.toFixed(2)),
    },
    trades: tradeLogs,
    sideBreakdown,
    strategyBreakdown,
  };
}

function runIntradayComparison(): { metrics: BacktestResult['metrics']; trades: IntradayTradeLog[] } {
  // Intraday strategy removed - return empty results
  return {
    metrics: {
      totalReturnPct: 0,
      cagr: 0,
      sharpe: 0,
      maxDrawdownPct: 0,
      trades: 0,
      hitRate: 0,
      profitFactor: 0,
      avgWin: 0,
      avgLoss: 0
    },
    trades: []
  };
}

export async function compareStrategies(): Promise<StrategyComparisonReport> {
  const intraday = runIntradayComparison();
  const metaAdaptive = await runMetaAdaptiveComparison();
  const metaAdaptiveBtCandles = buildMetaAdaptiveSyntheticCandles({ minutes: 60 * 24 * 3 });
  const metaAdaptiveBt = runMetaAdaptiveBacktest(metaAdaptiveBtCandles, {
    symbol: 'ETH/USDT',
    equityUsd: 50_000,
    slippageBps: 5,
    makerFeeBps: 1.8,
    takerFeeBps: 4.8,
    fundingAnnualPct: 6,
    latencyMs: 150,
    impactBpsPerMillion: 4,
  });
  const walkForward = metaAdaptiveBt.walkForward ?? [];
  for (const segment of walkForward) {
    const { metrics } = segment;
    if (
      !Number.isFinite(metrics.cagr)
      || !Number.isFinite(metrics.maxDrawdownPct)
      || !Number.isFinite(metrics.sharpe)
    ) {
      throw new Error('Meta-Adaptive walk-forward metrics must be finite');
    }
  }
  const summaryTable: StrategySummaryRow[] = [
    buildSummaryRow('Intraday Dual', {
      trades: intraday.trades.length,
      hitRate: intraday.metrics.hitRate,
      profitFactor: intraday.metrics.profitFactor,
      avgWin: intraday.metrics.avgWin,
      avgLoss: intraday.metrics.avgLoss,
      sharpe: intraday.metrics.sharpe,
      maxDrawdownPct: intraday.metrics.maxDrawdownPct,
      cagr: intraday.metrics.cagr,
    }),
    buildSummaryRow('Meta-Adaptive (Scenarios)', {
      trades: metaAdaptive.metrics.trades,
      hitRate: metaAdaptive.metrics.hitRate,
      profitFactor: metaAdaptive.metrics.profitFactor,
      avgWin: metaAdaptive.metrics.avgWin,
      avgLoss: metaAdaptive.metrics.avgLoss,
      sharpe: metaAdaptive.metrics.sharpe,
      maxDrawdownPct: metaAdaptive.metrics.maxDrawdownPct,
      cagr: metaAdaptive.metrics.cagr,
    }),
    buildSummaryRow('Meta-Adaptive (Backtest)', {
      trades: metaAdaptiveBt.trades.length,
      hitRate: metaAdaptiveBt.metrics.hitRate,
      profitFactor: metaAdaptiveBt.metrics.profitFactor,
      avgWin: metaAdaptiveBt.metrics.avgWin,
      avgLoss: metaAdaptiveBt.metrics.avgLoss,
      sharpe: metaAdaptiveBt.metrics.sharpe,
      maxDrawdownPct: metaAdaptiveBt.metrics.maxDrawdownPct,
      cagr: metaAdaptiveBt.metrics.cagr,
    }),
  ];
  return {
    intraday,
    metaAdaptive,
    metaAdaptiveBacktest: metaAdaptiveBt,
    metaAdaptiveWalkForward: walkForward,
    summaryTable,
  };
}
