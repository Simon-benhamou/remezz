import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { __test_prepareOhlcvSeries } = await import('../../dist/src/data/market.js');

const now = 1_700_600_000_000;

const syntheticRows = Array.from({ length: 10 }, (_, i) => [
  now - (10 - i) * 60_000,
  100,
  100,
  100,
  100,
  0,
]);

const preparedSynthetic = __test_prepareOhlcvSeries(syntheticRows, '1m', 10, false);
assert.equal(preparedSynthetic.series.length, 10, 'Synthetic sample should preserve length');
assert.equal(preparedSynthetic.synthetic, true, 'Synthetic sample must be flagged');

const mixedRows = syntheticRows.map((row, idx) => {
  if (idx >= 5) {
    return [row[0], 100 + idx, 101 + idx, 99 + idx, 100.5 + idx, 250 + idx];
  }
  return row;
});

const preparedMixed = __test_prepareOhlcvSeries(mixedRows, '1m', 10, false);
assert.equal(preparedMixed.series.length, 10, 'Mixed sample should preserve length');
assert.equal(preparedMixed.synthetic, false, 'Mixed sample should not be flagged synthetic');

console.log('✅ ohlcv-synthetic-detection.mjs passed');
