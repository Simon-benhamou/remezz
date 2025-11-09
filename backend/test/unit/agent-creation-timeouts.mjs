import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';

const { __agentCreationTestHooks } = await import('../../dist/src/services/agentCreationFlow.js');
const { prisma } = await import('../../dist/src/db/client.js');

const { runWithTimeout } = __agentCreationTestHooks;

const fastOutcome = await runWithTimeout(async () => 'ok', 50);
assert.equal(fastOutcome.timedOut, false, 'fast outcome should not timeout');
assert.equal(fastOutcome.result, 'ok', 'fast outcome should resolve value');

const slowOutcome = await runWithTimeout(
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return 'late';
  },
  5,
);
assert.equal(slowOutcome.timedOut, true, 'slow outcome should report timeout');
assert.equal('result' in slowOutcome, false, 'timeout should not expose a result property');

const errorOutcome = await runWithTimeout(
  async () => {
    throw new Error('boom');
  },
  50,
);
assert.equal(errorOutcome.timedOut, false, 'errors should not be reported as timeout');
assert.ok(errorOutcome.error instanceof Error, 'error outcome should expose underlying error');

console.log('✅ agent-creation-timeouts.mjs passed');

await prisma.$disconnect();
process.exit(0);
