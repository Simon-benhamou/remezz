import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { runMetaAdaptiveCalibration } = await import('../../dist/src/sim/metaAdaptiveCalibrator.js');
const { PreciseDecimal } = await import('../../dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');

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
  { label: 'trend', snap: buildSnapshot({ adx14: 30, trendStrength: 0.95, cmf20: 0.4 }), pnl: decimal('32') },
  { label: 'breakout', snap: buildSnapshot({ adx14: 26, trendStrength: 0.75, cmf20: 0.32, realizedVol: 1.6 }), pnl: decimal('38') },
  { label: 'mean', snap: buildSnapshot({ adx14: 10, rsi14: 68, srBias: 'nearResistance', emaBias: -0.002 }), pnl: decimal('18') },
  { label: 'momentum', snap: buildSnapshot({ adx14: 34, trendStrength: 1.1, cmf20: 0.45, volume: 1_500_000 }), pnl: decimal('46') },
  { label: 'mean-loss', snap: buildSnapshot({ adx14: 8, rsi14: 35, srBias: 'nearSupport', emaBias: 0.0005 }), pnl: decimal('-15') },
  { label: 'trend-loss', snap: buildSnapshot({ adx14: 22, trendStrength: 0.4, cmf20: -0.05, emaBias: -0.003 }), pnl: decimal('-20') },
];

const dataset = {
  scenarios: scenarios.map((scenario, index) => ({
    label: scenario.label,
    snap: scenario.snap,
    symbol: `ETH/USDT-${index}`,
    realizedPnlUsd: scenario.pnl,
    qty: 1,
    entryPrice: 100,
    stopDistance: 1,
  })),
};

const result = await runMetaAdaptiveCalibration(dataset, {
  accountBalanceUsd: '1000',
  desiredProfitUsd: '30',
  explorationEpsilon: 0.05,
  seed: 1337,
  sessionId: 'unit-calib',
});

assert.equal(result.metrics.trades, scenarios.length, 'Calibration should run for each scenario');
assert.ok(Number.isFinite(result.metrics.cagr), 'CAGR must be finite');
assert.ok(Number.isFinite(result.metrics.maxDrawdown), 'Drawdown must be finite');
assert.ok(Number.isFinite(result.metrics.sharpe), 'Sharpe must be finite');
assert.ok(result.profile.minConfidence >= 0.2 && result.profile.minConfidence <= 0.65, 'Confidence range enforced');
assert.ok(result.profile.explorationFloor >= 0.01 && result.profile.explorationFloor <= 0.08, 'Exploration floor range');

console.log('📊 Calibration metrics');
console.log(`CAGR: ${(result.metrics.cagr * 100).toFixed(2)}%`);
console.log(`Max drawdown: ${(result.metrics.maxDrawdown * 100).toFixed(2)}%`);
console.log(`Sharpe-like: ${result.metrics.sharpe.toFixed(2)}`);
console.log('Calibration adjustments', result.profile.familyScoreAdjustments);

assert.ok(Object.values(result.profile.familyScoreAdjustments).every(adj => Math.abs(adj) <= 0.15 + 1e-6), 'Adjustments bounded');

console.log('✅ meta-adaptive calibration pipeline passed');
