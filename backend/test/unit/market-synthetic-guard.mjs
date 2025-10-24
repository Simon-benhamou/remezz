import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { isSyntheticSeries } = await import('../../dist/src/data/market.js');

const baseTs = 1_700_000_000_000;
function candle(tsOffset, price, volume, flat = true) {
  if (flat) {
    return [baseTs + tsOffset * 60_000, price, price, price, price, volume];
  }
  return [
    baseTs + tsOffset * 60_000,
    price,
    price * 1.002,
    price * 0.998,
    price * 1.001,
    volume,
  ];
}

const noisySeries = [
  candle(0, 100, 0),
  candle(1, 100.5, 0),
  candle(2, 101, 5, false),
  candle(3, 101.5, 0),
  candle(4, 102, 0),
];

assert.equal(isSyntheticSeries(noisySeries), false, 'Two zero-volume bars should not flag synthetic');

const syntheticSeries = [
  candle(0, 100, 0),
  candle(1, 100, 0),
  candle(2, 100, 0),
  candle(3, 101, 12),
];

assert.equal(isSyntheticSeries(syntheticSeries), true, 'Three consecutive zero-volume bars should trigger guard');

console.log('✅ market-synthetic-guard.mjs passed');
