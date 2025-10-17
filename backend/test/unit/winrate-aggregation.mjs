import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';

const { aggregateFillsToTrades } = await import('../../dist/src/services/performance/winrate.js');

const SCALE_FACTOR = 100_000_000n;

function toFixed(value) {
  return BigInt(Math.round(value * Number(SCALE_FACTOR)));
}

// ZEC partial exits should aggregate into a single trade
const zecFills = [
  { ts: new Date('2025-10-16T09:22:51.716Z'), qty: 5.24443226, side: 'sell', realizedPnl: 0 },
  { ts: new Date('2025-10-16T09:41:54.031Z'), qty: 0.78666484, side: 'buy', realizedPnl: 4.867741062 },
  { ts: new Date('2025-10-16T09:43:50.274Z'), qty: 0.66866511, side: 'buy', realizedPnl: 4.532328998 },
  { ts: new Date('2025-10-16T09:48:06.662Z'), qty: 3.78910231, side: 'buy', realizedPnl: 10.66934974 },
];

const zecTrades = aggregateFillsToTrades(zecFills);
assert.equal(zecTrades.length, 1, 'Partial exits should produce a single aggregated trade');
const expectedZecPnl = toFixed(4.867741062 + 4.532328998 + 10.66934974);
assert.equal(zecTrades[0].pnl, expectedZecPnl, 'Aggregated PnL should sum all exit fills');

// ETH round-trip with loss should remain a single losing trade
const ethFills = [
  { ts: new Date('2025-10-16T10:23:25.996Z'), qty: 0.394380084, side: 'buy', realizedPnl: 0 },
  { ts: new Date('2025-10-16T10:43:42.232Z'), qty: 0.394380084, side: 'sell', realizedPnl: -0.620443796 },
];
const ethTrades = aggregateFillsToTrades(ethFills);
assert.equal(ethTrades.length, 1, 'Round-trip should produce exactly one trade');
assert.equal(ethTrades[0].pnl, toFixed(-0.620443796), 'Losing trade should preserve negative PnL');

console.log('✅ winrate aggregation unit tests passed');
