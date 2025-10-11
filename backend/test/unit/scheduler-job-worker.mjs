import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const {
  scheduleJob,
  registerSchedulerJobHandler,
  processSchedulerJobsOnce,
} = await import('../../dist/src/services/schedulerJobService.js');
const { prisma } = await import('../../dist/src/db/client.js');

if (typeof prisma.$reset === 'function') {
  await prisma.$reset();
}

// Test 1: single job executes
{
  let executed = 0;
  registerSchedulerJobHandler('TEST_JOB_SINGLE', async () => {
    executed += 1;
  });

  await scheduleJob('TEST_JOB_SINGLE', new Date(), { foo: 'bar' });
  await processSchedulerJobsOnce();
  assert.equal(executed, 1, 'Job handler should have executed once');

  const jobs = await prisma.schedulerJob.findMany({ where: { type: 'TEST_JOB_SINGLE' } });
  assert.equal(jobs[0].status, 'done');
}

// Test 2: pending job survives restart simulation
{
  let executed = 0;
  registerSchedulerJobHandler('TEST_JOB_RESTART', async () => {
    executed += 1;
  });

  await scheduleJob('TEST_JOB_RESTART', new Date(Date.now() + 5));
  // First cycle (before due)
  await processSchedulerJobsOnce();
  assert.equal(executed, 0);
  // Second cycle after due
  await new Promise((resolve) => setTimeout(resolve, 10));
  await processSchedulerJobsOnce();
  assert.equal(executed, 1, 'Job should execute after restart cycle');
}

// Test 3: concurrency lock prevents double execution
{
  let executed = 0;
  registerSchedulerJobHandler('TEST_JOB_LOCK', async () => {
    executed += 1;
    // Simulate work
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  await scheduleJob('TEST_JOB_LOCK', new Date());
  await Promise.all([processSchedulerJobsOnce(), processSchedulerJobsOnce()]);
  assert.equal(executed, 1, 'Job should execute only once even with concurrent workers');
}

console.log('✅ scheduler-job-worker tests passed');
