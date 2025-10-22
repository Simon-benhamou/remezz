import assert from 'node:assert/strict';
import { aggregateCandles } from '../../dist/src/quantai/strategies/intradayDual/backtest.js';

const baseTs = Date.UTC(2024, 0, 1, 0, 0, 0);
const mk = (i, overrides = {}) => ({
  timestamp: baseTs + i * 60_000,
  open: 100 + i,
  high: 101 + i,
  low: 99 + i,
  close: 100.5 + i,
  volume: 10 + i,
  ...overrides,
});

const candles = Array.from({ length: 7 }, (_, i) => mk(i));

const aggregated = aggregateCandles(candles, 5);
assert.equal(aggregated.length, 1, 'drops incomplete trailing bucket');
const first = aggregated[0];
assert.equal(first.timestamp, candles[4].timestamp, 'timestamp uses last candle in bucket');
assert.equal(first.open, candles[0].open, 'open uses first candle in bucket');
assert.equal(first.close, candles[4].close, 'close uses last candle in bucket');
assert.equal(first.high, Math.max(...candles.slice(0, 5).map((c) => c.high)), 'high aggregates maximum');
assert.equal(first.low, Math.min(...candles.slice(0, 5).map((c) => c.low)), 'low aggregates minimum');
assert.equal(
  first.volume,
  candles.slice(0, 5).reduce((acc, c) => acc + c.volume, 0),
  'volume sums across bucket',
);

const withGap = [
  mk(0),
  mk(1),
  mk(2),
  mk(30, { open: 150, high: 155, low: 149, close: 152, volume: 50 }),
  mk(31, { open: 152, high: 156, low: 151, close: 155, volume: 45 }),
  mk(32, { open: 155, high: 158, low: 154, close: 157, volume: 40 }),
  mk(33, { open: 157, high: 159, low: 156, close: 158, volume: 38 }),
  mk(34, { open: 158, high: 160, low: 157, close: 159, volume: 37 }),
];

const gapAggregated = aggregateCandles(withGap, 5);
assert.equal(gapAggregated.length, 1, 'gap resets bucket without emitting partial data');
const gapBucket = gapAggregated[0];
assert.equal(gapBucket.open, 150, 'gap bucket starts after missing interval');
assert.equal(gapBucket.timestamp, withGap[withGap.length - 1].timestamp, 'gap bucket timestamp from last candle');

const passthrough = aggregateCandles(candles.slice(0, 2), 1);
assert.deepEqual(passthrough, candles.slice(0, 2), 'minutes <= 1 returns original candles');

console.log('✅ intraday-backtest-aggregation.mjs passed');
