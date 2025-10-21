import { runIntradayBacktest } from '../intraday/backtest.js';
import type { Candle, BacktestResult, TradeLog as IntradayTradeLog } from '../intraday/types.js';
import type { TechnicalSnapshot } from '../../ai/tech.js';
import {
  evaluateRecognizedStrategies,
  registerAdaptiveTradeEntry,
  registerAdaptiveTradeOutcome,
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
    };
    trades: MetaAdaptiveTradeLog[];
  };
};

export type MetaAdaptiveTradeLog = {
  timestamp: number;
  label: string;
  side: 'long' | 'short';
  quantity: PreciseDecimal;
  entryPrice: PreciseDecimal;
  exitPrice: PreciseDecimal;
  pnlPct: PreciseDecimal;
  cumulativePnlPct: PreciseDecimal;
};

const ONE = new PreciseDecimal('1');
const HUNDRED = new PreciseDecimal('100');

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

function buildSnapshot(config: {
  label: string;
  bias4h?: 'bullish' | 'bearish';
  bias1h?: 'bullish' | 'bearish';
  bias15m?: 'bullish' | 'bearish';
  emaBias?: number;
  atrPct?: number;
  rsi14?: number;
  trendStrength?: number;
  cmf20?: number;
  realizedVol?: number;
  adx14?: number;
  symbol?: string;
}): { snap: TechnicalSnapshot; pnlPct: PreciseDecimal; label: string } {
  const last = 100;
  const emaBias = config.emaBias ?? 0.01;
  const snap = {
    symbol: config.symbol ?? 'ETH/USDT',
    last,
    ema20: last * (1 + emaBias),
    ema50: last * (1 + emaBias / 2),
    ema100: last * (1 + emaBias / 3),
    ema200: last * (1 + emaBias / 4),
    rsi14: config.rsi14 ?? 55,
    atr14: last * (config.atrPct ?? 0.012),
    atrPct: config.atrPct ?? 1.2,
    adx14: config.adx14 ?? 24,
    ema20Slope: last * 0.0012,
    support: last * 0.97,
    resistance: last * 1.03,
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
    trend: 1.1,
    srBias: emaBias > 0 ? 'nearSupport' : 'nearResistance',
    meta: { tf: '15m', windowBars: 120, recentBarsFor24h: 96 },
    realizedVol: config.realizedVol ?? 1.3,
    hurst: 0.55,
    adxSlope: 0.02,
    trendStrength: config.trendStrength ?? 0.6,
    trendBias: emaBias >= 0 ? 'bullish' : 'bearish',
    volume: 800_000,
    volumeMA: 500_000,
    volume24h: 60_000_000,
    cmf20: config.cmf20 ?? 0.18,
    multiTimeframe: {
      timeframes: {
        '4h': { tf: '4h', bias: config.bias4h ?? 'bullish', momentumPct: 0.4, rsi: 55 },
        '1h': { tf: '1h', bias: config.bias1h ?? 'bullish', momentumPct: 0.3, rsi: 53 },
        '15m': { tf: '15m', bias: config.bias15m ?? 'bullish', momentumPct: 0.2, rsi: 52 },
      },
      agreementScore: 3,
      divergenceScore: 0,
    },
  } as TechnicalSnapshot;

  const pnlPct = config.label === 'mean-loss'
    ? new PreciseDecimal('-0.9')
    : config.label === 'trend-loss'
      ? new PreciseDecimal('-1.4')
      : config.label === 'mean'
        ? new PreciseDecimal('1.1')
        : config.label === 'breakout'
          ? new PreciseDecimal('3.2')
          : config.label === 'momentum'
            ? new PreciseDecimal('4.6')
            : new PreciseDecimal('2.5');

  return { snap, pnlPct, label: config.label };
}

function createMetaAdaptiveScenarios() {
  return [
    buildSnapshot({ label: 'trend', adx14: 30, trendStrength: 0.95, cmf20: 0.4 }),
    buildSnapshot({ label: 'breakout', adx14: 26, trendStrength: 0.75, cmf20: 0.32, realizedVol: 1.6 }),
    buildSnapshot({ label: 'mean', adx14: 10, rsi14: 68, emaBias: -0.002 }),
    buildSnapshot({ label: 'momentum', adx14: 34, trendStrength: 1.1, cmf20: 0.45 }),
    buildSnapshot({ label: 'mean-loss', adx14: 8, rsi14: 35, emaBias: 0.0005 }),
    buildSnapshot({ label: 'trend-loss', adx14: 22, trendStrength: 0.4, cmf20: -0.05, emaBias: -0.003 }),
  ];
}

async function runMetaAdaptiveComparison(): Promise<{
  metrics: { totalReturnPct: number; cagr: number; sharpe: number; maxDrawdownPct: number; trades: number };
  trades: MetaAdaptiveTradeLog[];
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

  for (let i = 0; i < scenarios.length; i += 1) {
    const scenario = scenarios[i];
    const signals = evaluateRecognizedStrategies(scenario.snap, {
      sessionId,
      symbol: 'ETH/USDT',
      bias: 'long',
      regime: scenario.snap.trendStrength > 0.7 ? 'trend_following' : 'range',
      allowMomentumOverride: true,
      favorMeanReversion: scenario.snap.trendStrength < 0.6,
    });

    const primary = signals.find((signal) => signal.meta?.token) ?? signals[0] ?? null;

    await registerAdaptiveTradeEntry({
      sessionId,
      symbol: 'ETH/USDT',
      signal: primary,
      qty: 1,
      entryPrice: 100,
      stopDistance: 1,
    });

    registerAdaptiveTradeOutcome({
      sessionId,
      symbol: 'ETH/USDT',
      token: primary?.meta?.token ?? null,
      realizedPnlUsd: scenario.pnlPct.toNumber(),
    });

    const tradeReturn = scenario.pnlPct.dividedBy(HUNDRED);
    returns.push(tradeReturn.toNumber());
    equity = equity.times(ONE.plus(tradeReturn));

    const exitMultiplier = ONE.plus(tradeReturn);
    const entryPrice = new PreciseDecimal('100');
    const quantity = new PreciseDecimal('1');
    const exitPrice = entryPrice.times(exitMultiplier);
    const cumulativePct = equity.minus(ONE).times(HUNDRED);
    tradeLogs.push({
      timestamp: 1_700_600_000_000 + i * 600_000,
      label: scenario.label,
      side: scenario.pnlPct.gt(0) ? 'long' : 'short',
      quantity,
      entryPrice,
      exitPrice,
      pnlPct: scenario.pnlPct,
      cumulativePnlPct: cumulativePct,
    });
  }

  const trades = returns.length;
  const finalEquity = equity.toNumber();
  const totalReturnPct = (finalEquity - 1) * 100;
  const cagr = trades > 0 ? Math.pow(finalEquity, 1 / trades) - 1 : 0;

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
    ? returns.reduce((sum, value) => sum + Math.pow(value - meanReturn, 2), 0) / trades
    : 0;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev === 0 ? 0 : meanReturn / stdev;

  if (!Number.isFinite(totalReturnPct) || !Number.isFinite(cagr) || !Number.isFinite(sharpe) || !Number.isFinite(maxDrawdownPct)) {
    throw new Error('Meta-adaptive metrics must be finite');
  }

  metaAdaptiveStrategyAgent.reset(sessionId);

  return {
    metrics: { totalReturnPct, cagr, sharpe, maxDrawdownPct, trades },
    trades: tradeLogs,
  };
}

function runIntradayComparison(): { metrics: BacktestResult['metrics']; trades: IntradayTradeLog[] } {
  const candles = buildIntradayComparisonCandles();
  const result = runIntradayBacktest(candles, { symbol: 'BTCUSDT', equityUsd: 50_000, slippageBps: 3 });
  if (!Number.isFinite(result.metrics.cagr) || !Number.isFinite(result.metrics.maxDrawdownPct) || !Number.isFinite(result.metrics.sharpe)) {
    throw new Error('Intraday metrics must be finite');
  }
  return { metrics: result.metrics, trades: result.trades };
}

export async function compareStrategies(): Promise<StrategyComparisonReport> {
  const intraday = runIntradayComparison();
  const metaAdaptive = await runMetaAdaptiveComparison();
  return {
    intraday,
    metaAdaptive,
  };
}
