import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { classifyRegime } = await import('../../dist/src/ai/regime.js');

function makeSnap(overrides = {}) {
  const last = overrides.last ?? 100;
  return {
    symbol: overrides.symbol ?? 'BTC/USDT:USDT',
    last,
    ema20: overrides.ema20 ?? last * 1.01,
    ema50: overrides.ema50 ?? last * 0.99,
    ema20Slope: overrides.ema20Slope ?? last * 0.0015,
    adx14: overrides.adx14 ?? 28,
    adxSlope: overrides.adxSlope ?? 0.6,
    hurst: overrides.hurst ?? 0.55,
    realizedVol: overrides.realizedVol ?? 2.4,
    trendStrength: overrides.trendStrength ?? 0.45,
  };
}

const moderateTrend = classifyRegime(makeSnap({
  realizedVol: 2.6,
  trendStrength: 0.5,
  adx14: 30,
  adxSlope: 0.8,
  hurst: 0.62,
}));

assert.equal(moderateTrend.volatility, 'medium', 'moderate realized vol should stay medium');
assert.equal(moderateTrend.shouldTrade, true, 'agent should keep trading under moderate trend regimes');
assert.equal(moderateTrend.playbook === 'momentum_breakout' || moderateTrend.playbook === 'mean_reversion', true);
assert.equal(moderateTrend.riskModifier, undefined, 'moderate conditions should not force risk modifier');

const elevatedVolStructured = classifyRegime(makeSnap({
  realizedVol: 3.2,
  trendStrength: 0.42,
  adx14: 24,
  adxSlope: 0.2,
  hurst: 0.58,
}));

assert.equal(elevatedVolStructured.volatility, 'high', 'realized vol around 3% should be tagged high');
assert.equal(elevatedVolStructured.shouldTrade, true, 'structured high vol should allow trading');
assert.ok(elevatedVolStructured.riskModifier?.level === 'caution', 'should emit caution risk modifier when structure intact');
assert.ok(
  elevatedVolStructured.riskModifier && elevatedVolStructured.riskModifier.sizingMultiplier <= 0.75,
  'caution should reduce sizing'
);
assert.ok(
  elevatedVolStructured.riskModifier && elevatedVolStructured.riskModifier.stopMultiplier <= 0.9,
  'caution should tighten stops'
);

const disorderlySpike = classifyRegime(makeSnap({
  realizedVol: 4.5,
  trendStrength: 0.12,
  adx14: 11,
  adxSlope: -1.9,
  hurst: 0.4,
}));

assert.equal(disorderlySpike.volatility, 'high', 'extreme vol spike should be high volatility');
assert.equal(disorderlySpike.playbook, 'standby', 'disorderly spikes should flip to standby');
assert.equal(disorderlySpike.shouldTrade, false, 'disorderly spikes must block trading');

console.log('✅ regime-classification.mjs passed');
