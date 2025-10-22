import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { StrategyRouter } = await import('../../dist/src/quantai/strategies/intradayDual/router.js');

function makeFeatures(timestamp) {
  const base = {
    volatility: {
      atrPct: 0.004,
      trueRangePct: 0.003,
      bollingerWidthPct: 0.01,
      bollingerPercentB: 0.5,
      bollingerUpper: 101,
      bollingerLower: 99,
      bollingerMiddle: 100,
      bandZScore: 0.2,
      keltnerWidthPct: 0.01,
      squeezeRatio: 1.1,
      squeezeState: 'neutral',
    },
    momentum: {
      roc: { '1': 0.01, '3': 0.02 },
      emaSlope: {},
      emaValue: { '9': 100.5, '20': 100.2 },
      rsi: { '7': 55 },
      rsiSlope: {},
      macdHistogram: 0.05,
    },
    volume: { zScore: 1.1, obvDelta: 0.1, spike95: false, spike99: false },
    orderBook: { imbalance: 0.1, imbalanceDelta: 0.02, aggressionRatio: 0.5 },
  };
  return {
    '1m': { timeframe: '1m', timestamp, price: 100, ...base },
    '5m': { timeframe: '5m', timestamp, price: 100, ...base },
    '15m': { timeframe: '15m', timestamp, price: 100, ...base },
  };
}

const router = new StrategyRouter();
const start = 1_700_020_000_000;
const first = router.classify('BTCUSDT', makeFeatures(start));
assert.equal(first.biasAgeMs, 0, 'first classify should have zero age');

const second = router.classify('BTCUSDT', makeFeatures(start + 60_000));
assert.equal(second.biasAgeMs, 60_000);

const third = router.classify('BTCUSDT', makeFeatures(start + 180_000));
assert.equal(third.biasAgeMs, 120_000);

const freshSymbol = router.classify('ETHUSDT', makeFeatures(start + 30_000));
assert.equal(freshSymbol.biasAgeMs, 0, 'new symbol should not inherit bias age');

const rangeSeed = makeFeatures(start - 120_000);
for (const tf of ['1m', '5m', '15m']) {
  rangeSeed[tf].volatility.squeezeState = 'range';
  rangeSeed[tf].volatility.squeezeRatio = 0.7;
}
router.classify('RIVERUSDT', rangeSeed);

const breakoutCandidate = makeFeatures(start + 240_000);
for (const tf of ['1m', '5m', '15m']) {
  breakoutCandidate[tf].volatility.squeezeState = 'expansion';
  breakoutCandidate[tf].volatility.squeezeRatio = 1.35;
  breakoutCandidate[tf].volatility.bollingerPercentB = 1.1;
  breakoutCandidate[tf].orderBook.imbalance = 0.2;
  breakoutCandidate[tf].orderBook.imbalanceDelta = 0.05;
  breakoutCandidate[tf].orderBook.aggressionRatio = 0.6;
  breakoutCandidate[tf].volume.zScore = 1.4;
}
const neutralBreakout = router.classify('KGENUSDT', breakoutCandidate);
assert.notEqual(neutralBreakout.label, 'BOM', 'new symbol should not inherit breakout bias from prior symbol');

console.log('✅ router-bias-age.mjs passed');
