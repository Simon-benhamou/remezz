import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.MARKET_TYPE = 'futures';

const {
  createTestBinanceWebSocketHarness,
} = await import('../../dist/src/services/binanceWebSocket.js');

const harness = createTestBinanceWebSocketHarness();

const baseTs = 1_700_000_000_000;

const validTicker = {
  s: 'BTCUSDT',
  b: '60000',
  a: '60001',
  c: '60000',
  o: '59000',
  h: '61000',
  l: '58000',
  v: '1200',
  q: '72000000',
  P: '1.25',
  E: baseTs,
};

harness.feedBatch([validTicker], baseTs);

assert.equal(harness.isHealthyAt(baseTs + 1000), true, 'WS should be healthy right after accepted frames');

harness.feedBatch([], baseTs + 5000);

assert.equal(
  harness.isHealthyAt(baseTs + 6000),
  true,
  'Health should persist when frames are recent and within grace window',
);

harness.feedBatch([], baseTs + 14_000);

assert.equal(
  harness.isHealthyAt(baseTs + 15_000),
  true,
  'Grace window should keep WS healthy until expiry',
);

assert.equal(
  harness.isHealthyAt(baseTs + 16_001),
  false,
  'Health should drop once no accepted frames within grace window',
);

assert.equal(
  harness.isHealthyAt(baseTs + 25_000),
  false,
  'Stale cache must be considered unhealthy',
);

console.log('✅ Binance WS health grace window behaves as expected');
