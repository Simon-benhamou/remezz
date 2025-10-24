import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { createTestBinanceWebSocketHarness } = await import('../../dist/src/services/binanceWebSocket.js');

const harness = createTestBinanceWebSocketHarness();
const { manager } = harness;

const generatedSymbols = [];
for (let i = 0; i < 65; i += 1) {
  const suffix = String(i).padStart(2, '0');
  generatedSymbols.push(`COIN${suffix}USDT`);
}

harness.seedExchangeSymbols([
  'BTCUSDT',
  'ETHUSDT',
  ...generatedSymbols,
]);

const invalidAccepted = manager.subscribeToKline('币安人生/USDT', '15m');
assert.equal(invalidAccepted, false, 'expected invalid symbol subscription to be rejected');

const symbols = [];
for (const symbol of generatedSymbols) {
  const ok = manager.subscribeToKline(symbol, '15m');
  assert.equal(ok, true, `expected subscription for ${symbol} to succeed`);
  symbols.push(symbol);
}

const shardSizes = harness.getShardSizes().slice().sort((a, b) => a - b);
assert.deepEqual(shardSizes, [5, 30, 30], `unexpected shard sizes: ${JSON.stringify(shardSizes)}`);

const shardStreams = harness.getShardStreams();
const flattened = shardStreams.flat();
const unique = new Set(flattened);
assert.equal(unique.size, symbols.length, 'each kline stream should be assigned exactly once');

console.log('ws-kline-shards ✅');
