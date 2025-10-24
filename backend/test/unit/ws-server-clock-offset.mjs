import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { createTestBinanceWebSocketHarness } = await import('../../dist/src/services/binanceWebSocket.js');

const harness = createTestBinanceWebSocketHarness();
const now = 1_700_000_500_000;

harness.setServerOffset(-11_200);

const payload = [
  {
    s: 'BTCUSDT',
    b: '100.0',
    a: '100.2',
    c: '100.1',
    o: '99.8',
    h: '101.5',
    l: '98.3',
    v: '12345',
    q: '23456',
    P: '0.8',
    E: now - 11_200,
  },
];

harness.feedBatch(payload, now);

const ticker = harness.manager.getTicker('BTCUSDT');
assert(ticker, 'expected cached ticker');
assert.equal(ticker.stale, false, 'ticker should not be marked stale when clock offset is accounted');
assert.ok(
  (ticker.dataAgeMs ?? Number.POSITIVE_INFINITY) < 1_500,
  `expected data age < 1500ms, got ${ticker.dataAgeMs}`,
);

assert.equal(harness.isHealthyAt(now + 1_000), true, 'manager should report healthy within offset window');

console.log('ws-server-clock-offset ✅');
