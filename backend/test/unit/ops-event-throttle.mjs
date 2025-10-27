import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const { recordOpsEvent, recentOpsEvents, clearOpsEvents } = await import('../../dist/src/monitor/ops.js');

const originalNow = Date.now;

try {
  let now = 1_700_000_000_000;
  Date.now = () => now;

  clearOpsEvents();

  const payload = {
    level: 'info',
    source: 'entry_gate',
    message: 'bias_confirmation_failed',
    sessionId: 'sess-test',
    symbol: 'XRP/USDT',
    details: { reason: 'Price outside zone' },
  };

  recordOpsEvent(payload);
  let events = recentOpsEvents(10);
  assert.equal(events.length, 1, 'first event should be recorded');

  now += 5_000;
  recordOpsEvent(payload);
  events = recentOpsEvents(10);
  assert.equal(events.length, 1, 'duplicate within cooldown should be throttled');

  now += 61_000;
  recordOpsEvent(payload);
  events = recentOpsEvents(10);
  assert.equal(events.length, 2, 'event should pass once cooldown expires');
  const [latest, previous] = events;
  assert(latest.ts - previous.ts >= 60_000, 'cooldown duration should be respected');

  console.log('✅ ops-event-throttle.mjs passed');
} finally {
  Date.now = originalNow;
  clearOpsEvents();
}
