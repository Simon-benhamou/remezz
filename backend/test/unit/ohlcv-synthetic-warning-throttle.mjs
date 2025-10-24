import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const {
  __test_prepareOhlcvSeries,
  __test_resetSyntheticWarningThrottle,
} = await import('../../dist/src/data/market.js');

const baseTs = 1_700_600_000_000;
const syntheticRows = Array.from({ length: 10 }, (_, i) => [
  baseTs - (10 - i) * 60_000,
  100,
  100,
  100,
  100,
  0,
]);

const originalWarn = console.warn;
const originalNow = Date.now;

try {
  const loggedSamples = [];
  console.warn = (...args) => {
    loggedSamples.push(args);
  };

  let now = baseTs;
  Date.now = () => now;

  __test_resetSyntheticWarningThrottle();

  __test_prepareOhlcvSeries(syntheticRows, '1m', 10, false);
  assert.equal(loggedSamples.length, 1, 'First synthetic detection should warn once');

  __test_prepareOhlcvSeries(syntheticRows, '1m', 10, false);
  assert.equal(
    loggedSamples.length,
    1,
    'Repeated synthetic detection within cooldown must not warn again',
  );

  now += 61_000;
  __test_prepareOhlcvSeries(syntheticRows, '1m', 10, false);
  assert.equal(loggedSamples.length, 2, 'Warning should fire again after cooldown');
} finally {
  console.warn = originalWarn;
  Date.now = originalNow;
}

console.log('✅ ohlcv-synthetic-warning-throttle.mjs passed');
