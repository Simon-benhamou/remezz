import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.MARKET_TYPE = 'futures';
const prevLimit = process.env.BINANCE_MAX_KLINE_STREAMS;
const prevTtl = process.env.BINANCE_KLINE_SUBSCRIPTION_TTL_MS;

process.env.BINANCE_MAX_KLINE_STREAMS = '5';
process.env.BINANCE_KLINE_SUBSCRIPTION_TTL_MS = '1000';

const { createTestBinanceWebSocketHarness } = await import('../../dist/src/services/binanceWebSocket.js');

const harness = createTestBinanceWebSocketHarness();
const { manager } = harness;

const originalNow = Date.now;
let now = 1_700_000_000_000;
Date.now = () => now;

try {
  const baseSymbols = ['ADA/USDT', 'ARB/USDT', 'DYDX/USDT', 'SNX/USDT', 'CRV/USDT'];
  for (const symbol of baseSymbols) {
    assert.equal(manager.subscribeToKline(symbol, '1m'), true, `${symbol} should subscribe while capacity remains`);
    now += 1;
  }

  const flattenStreams = () => harness.getShardStreams().flat().sort();
  const expectedInitial = baseSymbols
    .map(s => `${s.split('/')[0].toLowerCase()}usdt@kline_1m`)
    .sort();
  assert.deepEqual(flattenStreams(), expectedInitial, 'Initial shard snapshot should include the seed symbols');

  assert.equal(manager.subscribeToKline('LINK/USDT', '1m'), true, 'LINK should be accepted into a shard');
  now += 1;
  const afterLink = new Set(flattenStreams());
  assert(afterLink.has('linkusdt@kline_1m'), 'LINK stream should be scheduled after subscription');
  assert.equal(afterLink.size, 6, 'Adding LINK should expand the pool across shards without evicting history');

  const shardSizes = harness.getShardSizes().slice().sort((a, b) => a - b);
  assert.deepEqual(shardSizes, [1, 5], 'Shard layout should spill over once the per-shard limit is hit');

  now += 5_000; // Advance beyond TTL so old entries expire.
  assert.equal(manager.subscribeToKline('OP/USDT', '1m'), true, 'Fresh symbol should subscribe after TTL pruning');
  const postPruneStreams = flattenStreams();
  assert.deepEqual(postPruneStreams, ['opusdt@kline_1m'], 'Only the fresh stream should remain after TTL pruning');

  const desiredMap = (manager).desiredKlineStreams;
  assert.equal(desiredMap.size, 1, 'Desired map should retain only the active entry after pruning');

  console.log('✅ Binance WS kline shards handle spillover and TTL pruning as expected');
} finally {
  Date.now = originalNow;
  manager.close();
  if (prevLimit === undefined) {
    delete process.env.BINANCE_MAX_KLINE_STREAMS;
  } else {
    process.env.BINANCE_MAX_KLINE_STREAMS = prevLimit;
  }
  if (prevTtl === undefined) {
    delete process.env.BINANCE_KLINE_SUBSCRIPTION_TTL_MS;
  } else {
    process.env.BINANCE_KLINE_SUBSCRIPTION_TTL_MS = prevTtl;
  }
}
