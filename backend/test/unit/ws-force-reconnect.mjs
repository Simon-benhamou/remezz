import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { createTestBinanceWebSocketHarness } = await import('../../dist/src/services/binanceWebSocket.js');

const harness = createTestBinanceWebSocketHarness();
const { manager } = harness;

(manager).scheduleBookTickerRefresh = () => {};

const forcedReasons = [];
(manager).forceReconnect = (reason) => {
  if (!forcedReasons.length) {
    forcedReasons.push(reason);
  }
};

const baseNow = 1_700_000_000_000;

const staleTicker = (symbol, now) => ({
  s: symbol,
  b: '100.0',
  a: '100.2',
  c: '100.1',
  o: '99.8',
  h: '101.5',
  l: '98.3',
  v: '12345',
  q: '23456',
  P: '0.8',
  E: now - 6_200,
});

for (let batch = 0; batch < 3; batch += 1) {
  const now = baseNow + batch * 1_000;
  const payload = [
    staleTicker('BTCUSDT', now),
    staleTicker('ETHUSDT', now),
    staleTicker('SOLUSDT', now),
    staleTicker('ADAUSDT', now),
  ];
  harness.feedBatch(payload, now);
}

assert.equal(forcedReasons.length, 1, `expected one forced reconnect, got ${forcedReasons.length}`);
assert.equal(forcedReasons[0], 'timestamp_drift');

const graceNow = baseNow + 10_000;
(manager).tickersCache.set('BTCUSDT', {
  symbol: 'BTCUSDT',
  last: 100,
  bid: 99,
  ask: 101,
  percentage: 0,
  baseVolume: 0,
  quoteVolume: 0,
  high: 101,
  low: 99,
  open: 100,
  timestamp: graceNow - 1_000,
  receivedAt: graceNow - 1_000,
});
harness.applyGrace(graceNow);

assert.equal(harness.isHealthyAt(graceNow + 1_000), true, 'expected grace period to report healthy');
assert.equal(harness.isHealthyAt(graceNow + 16_000), false, 'expected grace period to expire');

console.log('ws-force-reconnect ✅');
