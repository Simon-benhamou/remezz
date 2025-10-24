import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.MARKET_TYPE = 'futures';

const {
  createTestBinanceWebSocketHarness,
} = await import('../../dist/src/services/binanceWebSocket.js');
const { getMarketMetrics } = await import('../../dist/src/monitor/marketMetrics.js');

const harness = createTestBinanceWebSocketHarness();

const baseTs = 1_700_800_000_000;

function makeTicker(ageMs) {
  return {
    s: 'BTCUSDT',
    b: '60000',
    a: '60001',
    c: '60000',
    o: '59500',
    h: '60500',
    l: '59000',
    v: '1000',
    q: '60000000',
    P: '1.2',
    E: baseTs - ageMs,
  };
}

for (let i = 0; i < 3; i++) {
  harness.feedBatch([makeTicker(12_000)], baseTs + i * 800);
}

const metricsAfterDrift = getMarketMetrics();
const driftEntry = metricsAfterDrift.symbols.BTCUSDT;
assert(driftEntry, 'Metrics entry should exist for BTCUSDT');
assert.equal(driftEntry.fallbackActive, true, 'Fallback should activate after repeated drift');
assert.equal(driftEntry.fallbackReason, 'ws_timestamp_drift');

const freshTicker = makeTicker(0);
freshTicker.E = baseTs + 10_000;
freshTicker.b = '60010';
freshTicker.a = '60012';

harness.feedBatch([freshTicker], baseTs + 10_000);

const metricsAfterRecovery = getMarketMetrics();
const recoveryEntry = metricsAfterRecovery.symbols.BTCUSDT;
assert(recoveryEntry, 'Metrics entry should still exist for BTCUSDT');
assert.equal(recoveryEntry.fallbackActive, false, 'Fallback should clear after healthy frame');

console.log('✅ binance-ws-timestamp-drift.mjs passed');
