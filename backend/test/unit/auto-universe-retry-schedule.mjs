import assert from 'node:assert/strict';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { prisma } = await import('../../dist/src/db/client.js');
const {
  restoreAutoUniverseRetrySchedule,
  getAutoUniverseStatusSnapshot,
  __autoUniverseSchedulerTesting,
} = await import('../../dist/src/services/intelligentAgent.js');

await prisma.$reset?.();
await __autoUniverseSchedulerTesting.clear();
await wait(5);

__autoUniverseSchedulerTesting.schedule('session-test', 80);
await wait(20);

const scheduleRow = await prisma.autoUniverseSchedule.findUnique({ where: { id: 'auto_universe_retry' } });
assert.ok(scheduleRow, 'persisted schedule should exist after scheduling retry');
assert.equal(scheduleRow.excludeSessionId, 'session-test');
assert.ok(scheduleRow.nextRetryAt instanceof Date, 'nextRetryAt should be persisted as a Date');

let snapshot = getAutoUniverseStatusSnapshot();
assert.equal(snapshot.pendingExcludeSessionId, 'session-test');
assert.equal(snapshot.persistedExcludeSessionId, 'session-test');
assert.ok(
  typeof snapshot.nextRetryAt === 'number' && snapshot.nextRetryAt > Date.now(),
  'in-memory nextRetryAt should reflect pending timer',
);
assert.ok(
  typeof snapshot.persistedNextRetryAt === 'number' && snapshot.persistedNextRetryAt >= snapshot.nextRetryAt - 50,
  'persisted timestamp should be included in status',
);

await __autoUniverseSchedulerTesting.simulateRestart();
await restoreAutoUniverseRetrySchedule();
await wait(10);

snapshot = getAutoUniverseStatusSnapshot();
assert.equal(snapshot.pendingExcludeSessionId, 'session-test', 'restart should restore exclude session id');
assert.ok(
  typeof snapshot.nextRetryAt === 'number' && snapshot.nextRetryAt > Date.now(),
  'restored timer should remain scheduled in the future',
);

await wait(160);

const postRunRow = await prisma.autoUniverseSchedule.findUnique({ where: { id: 'auto_universe_retry' } });
assert.ok(postRunRow, 'row should still exist after execution');
assert.equal(postRunRow.nextRetryAt, null, 'nextRetryAt should be cleared once retry fires');

snapshot = getAutoUniverseStatusSnapshot();
assert.equal(snapshot.pendingExcludeSessionId, undefined);
assert.equal(snapshot.persistedExcludeSessionId, null);
assert.equal(snapshot.nextRetryAt, null);
assert.equal(snapshot.persistedNextRetryAt, null);

await __autoUniverseSchedulerTesting.clear();

console.log('✅ auto-universe-retry-schedule.mjs passed');
