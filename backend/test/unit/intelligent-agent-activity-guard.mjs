import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const { __intelligentAgentTestHooks } = await import('../../dist/src/services/intelligentAgent.js');

const { shouldDeferDueToRecentActivity } = __intelligentAgentTestHooks;

const windowMs = 3 * 60 * 60 * 1000;
const now = new Date('2024-01-01T12:00:00.000Z');

{
  const lastActivityAt = new Date('2024-01-01T10:30:00.000Z');
  const decision = shouldDeferDueToRecentActivity({ lastActivityAt, windowMs, now });
  assert.equal(decision.shouldDefer, true, 'Activity inside window should defer rotation');
  assert(decision.nextCheckAt, 'Decision should expose deferral timestamp');
  assert.equal(decision.nextCheckAt?.toISOString(), '2024-01-01T13:30:00.000Z', 'Deferral waits full window');
}

{
  const lastActivityAt = new Date('2024-01-01T09:00:00.000Z');
  const decision = shouldDeferDueToRecentActivity({ lastActivityAt, windowMs, now });
  assert.equal(decision.shouldDefer, false, 'Activity beyond window should not defer');
  assert.equal(decision.nextCheckAt, null, 'No deferral timestamp when outside window');
}

{
  const decision = shouldDeferDueToRecentActivity({ lastActivityAt: null, windowMs, now });
  assert.equal(decision.shouldDefer, false, 'Missing activity should not defer');
  assert.equal(decision.nextCheckAt, null, 'No deferral timestamp without activity');
}

{
  const lastActivityAt = new Date('2024-01-01T12:00:00.000Z');
  const decision = shouldDeferDueToRecentActivity({ lastActivityAt, windowMs, now });
  assert.equal(decision.shouldDefer, true, 'Immediate activity should defer');
  assert.equal(decision.nextCheckAt?.toISOString(), '2024-01-01T15:00:00.000Z', 'Deferral extends full window ahead');
}

console.log('✅ intelligent-agent activity guard logic passes');
