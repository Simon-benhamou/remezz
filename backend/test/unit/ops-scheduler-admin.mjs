import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const { prisma } = await import('../../dist/src/db/client.js');
if (typeof prisma.$reset === 'function') {
  await prisma.$reset();
}

const { router } = await import('../../dist/src/routes/ops.js');
const { scheduleJob } = await import('../../dist/src/services/schedulerJobService.js');

function findRoute(method, path) {
  method = method.toLowerCase();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path === path && layer.route.methods?.[method]) {
      const handlers = layer.route.stack.map((stackLayer) => stackLayer.handle);
      return handlers[handlers.length - 1];
    }
  }
  throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
}

function createMockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const listHandler = findRoute('get', '/scheduler/jobs');
const replayHandler = findRoute('post', '/scheduler/jobs/:id/replay');

// list requires auth
{
  const req = { query: {} };
  const res = createMockRes();
  await listHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body?.code, 'auth_required');
}

// list forbids non-admin
{
  const req = { query: {}, user: { id: 'u1', role: 'trader', username: 'alice' } };
  const res = createMockRes();
  await listHandler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body?.code, 'forbidden');
}

// create a job and ensure admin can list it
const job = await scheduleJob('UNIVERSE_RETRY', new Date(Date.now() + 1000), { foo: 'bar' });
{
  const req = { query: {}, user: { id: 'admin', role: 'admin', username: 'root' } };
  const res = createMockRes();
  await listHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.ok, true);
  assert(Array.isArray(res.body?.jobs), 'jobs should be array');
  assert(res.body.jobs.some((row) => row.id === job.id), 'response should include scheduled job');
}

// replay requires auth
{
  const req = { params: { id: job.id } };
  const res = createMockRes();
  await replayHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body?.code, 'auth_required');
}

// replay forbidden for trader
{
  const req = { params: { id: job.id }, user: { id: 'u1', role: 'trader', username: 'alice' } };
  const res = createMockRes();
  await replayHandler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body?.code, 'forbidden');
}

// replay accepted for admin
{
  const req = { params: { id: job.id }, user: { id: 'admin', role: 'admin', username: 'root' } };
  const res = createMockRes();
  await replayHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.ok, true);
  assert.equal(res.body?.job?.id, job.id);
  const refreshed = await prisma.schedulerJob.findUnique({ where: { id: job.id } });
  assert(refreshed);
  assert.equal(refreshed.status, 'pending');
}

console.log('✅ ops-scheduler-admin tests passed');
