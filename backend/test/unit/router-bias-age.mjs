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
const first = router.classify(makeFeatures(start));
assert.equal(first.biasAgeMs, 0, 'first classify should have zero age');

const second = router.classify(makeFeatures(start + 60_000));
assert.equal(second.biasAgeMs, 60_000);

const third = router.classify(makeFeatures(start + 180_000));
assert.equal(third.biasAgeMs, 120_000);

console.log('✅ router-bias-age.mjs passed');
