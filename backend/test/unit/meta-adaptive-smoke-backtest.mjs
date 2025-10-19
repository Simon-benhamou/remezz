import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const {
  evaluateRecognizedStrategies,
  registerAdaptiveTradeEntry,
  registerAdaptiveTradeOutcome,
} = await import('../../dist/src/quantai/strategy/recognizedStrategies.js');
const { PreciseDecimal } = await import('../../dist/src/quantai/strategy/metaAdaptiveAgent.js');

const sessionId = 'meta-backtest-session';

function decimal(value) {
  return new PreciseDecimal(value);
}

function buildSnapshot(config) {
  const last = config.last ?? 100;
  const bias4h = config.bias4h ?? 'bullish';
  const bias1h = config.bias1h ?? bias4h;
  const bias15m = config.bias15m ?? bias1h;
  return {
    symbol: config.symbol ?? 'ETH/USDT',
    last,
    ema20: config.ema20 ?? last * (1 + (config.emaBias ?? 0.01)),
    ema50: config.ema50 ?? last * (1 + (config.emaBias ?? 0.005)),
    ema100: config.ema100 ?? last * (1 + (config.emaBias ?? 0.002)),
    ema200: config.ema200 ?? last * (1 + (config.emaBias ?? 0.001)),
    rsi14: config.rsi14 ?? 55,
    atr14: config.atr14 ?? (last * (config.atrPct ?? 0.012)),
    atrPct: config.atrPct ?? 1.2,
    adx14: config.adx14 ?? 24,
    ema20Slope: config.ema20Slope ?? last * 0.0012,
    support: config.support ?? last * 0.97,
    resistance: config.resistance ?? last * 1.03,
    supports: config.supports ?? [{ price: last * 0.97, label: 'S1', touches: 3, strength: 2 }],
    resistances: config.resistances ?? [{ price: last * 1.03, label: 'R1', touches: 2, strength: 2 }],
    pivots: config.pivots ?? {
      P: last,
      S1: last * 0.99,
      S2: last * 0.98,
      R1: last * 1.01,
      R2: last * 1.02,
      refDay: new Date().toISOString().slice(0, 10),
    },
    trend: config.trend ?? 1.1,
    srBias: config.srBias ?? 'nearSupport',
    meta: { tf: '15m', windowBars: 120, recentBarsFor24h: 96 },
    realizedVol: config.realizedVol ?? 1.3,
    hurst: config.hurst ?? 0.55,
    trendStrength: config.trendStrength ?? 0.6,
    trendBias: config.trendBias ?? 'bullish',
    volume: config.volume ?? 800_000,
    volumeMA: config.volumeMA ?? 500_000,
    volume24h: config.volume24h ?? 60_000_000,
    cmf20: config.cmf20 ?? 0.18,
    multiTimeframe: config.multiTimeframe ?? {
      timeframes: {
        '4h': { tf: '4h', bias: bias4h, momentumPct: 0.4, rsi: 55 },
        '1h': { tf: '1h', bias: bias1h, momentumPct: 0.3, rsi: 53 },
        '15m': { tf: '15m', bias: bias15m, momentumPct: 0.2, rsi: 52 },
      },
      agreementScore: 3,
      divergenceScore: 0,
    },
  };
}

const scenarios = [
  { label: 'trend', snap: buildSnapshot({ adx14: 30, trendStrength: 0.95, cmf20: 0.4 }) , pnlPct: decimal('2.5') },
  { label: 'breakout', snap: buildSnapshot({ adx14: 26, trendStrength: 0.75, cmf20: 0.32, realizedVol: 1.6 }) , pnlPct: decimal('3.2') },
  { label: 'mean', snap: buildSnapshot({ adx14: 10, rsi14: 68, srBias: 'nearResistance', emaBias: -0.002 }) , pnlPct: decimal('1.1') },
  { label: 'momentum', snap: buildSnapshot({ adx14: 34, trendStrength: 1.1, cmf20: 0.45, volume: 1_500_000 }) , pnlPct: decimal('4.6') },
  { label: 'mean-loss', snap: buildSnapshot({ adx14: 8, rsi14: 35, srBias: 'nearSupport', emaBias: 0.0005 }) , pnlPct: decimal('-0.9') },
  { label: 'trend-loss', snap: buildSnapshot({ adx14: 22, trendStrength: 0.4, cmf20: -0.05, emaBias: -0.003 }) , pnlPct: decimal('-1.4') },
];

let equity = decimal('1');
let peak = equity;
const returns = [];

for (const scenario of scenarios) {
  const signals = evaluateRecognizedStrategies(scenario.snap, {
    sessionId,
    symbol: 'ETH/USDT',
    bias: 'long',
    regime: scenario.label === 'mean' || scenario.label === 'mean-loss' ? 'range' : 'trend_following',
    allowMomentumOverride: true,
    favorMeanReversion: scenario.label.startsWith('mean'),
  });

  const primary = signals.find(signal => signal.meta?.token) ?? signals[0];

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
    token: primary.meta?.token ?? null,
    realizedPnlUsd: Number(scenario.pnlPct.toNumber()),
  });

  const tradeReturn = scenario.pnlPct.dividedBy(decimal('100'));
  returns.push(tradeReturn.toNumber());
  const growth = decimal('1').plus(tradeReturn);
  equity = equity.times(growth);
  if (equity.gt(peak)) {
    peak = equity;
  }
}

const trades = returns.length;
assert(trades > 0, 'Smoke backtest should create trades');

const finalEquity = equity.toNumber();
const cagrPerTrade = Math.pow(finalEquity, 1 / trades) - 1;

let runningPeak = equity.toNumber();
let maxDrawdown = 0;
let equityCursor = 1;
for (const r of returns) {
  equityCursor *= (1 + r);
  if (equityCursor > runningPeak) runningPeak = equityCursor;
  const dd = (runningPeak - equityCursor) / runningPeak;
  if (dd > maxDrawdown) maxDrawdown = dd;
}

const meanReturn = returns.reduce((sum, r) => sum + r, 0) / trades;
const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / trades;
const stdev = Math.sqrt(variance);
const sharpe = stdev === 0 ? Infinity : meanReturn / stdev;

console.log('📈 Smoke backtest metrics');
console.log(`CAGR per trade: ${(cagrPerTrade * 100).toFixed(2)}%`);
console.log(`Max drawdown: ${(maxDrawdown * 100).toFixed(2)}%`);
console.log(`Sharpe-like: ${sharpe.toFixed(2)}`);

assert(Number.isFinite(cagrPerTrade), 'CAGR must be finite');
assert(Number.isFinite(maxDrawdown), 'Max drawdown must be finite');
assert(Number.isFinite(sharpe), 'Sharpe must be finite');

console.log('✅ meta-adaptive smoke backtest passed');
