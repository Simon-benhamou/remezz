import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const { prisma } = await import('../../dist/src/db/client.js');
await prisma.$reset();

const { router } = await import('../../dist/src/routes/agent.js');
const { setPaperBalance } = await import('../../dist/src/services/capitalPool.js');

function findRoute(method, path) {
  const verb = method.toLowerCase();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path === path && layer.route.methods?.[verb]) {
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

await setPaperBalance('2500');

const overviewHandler = findRoute('get', '/overview');

const req = {
  query: { mode: 'paper' },
  user: { id: 'admin', role: 'admin', username: 'root' },
};
const res = createMockRes();

await overviewHandler(req, res);

assert.equal(res.statusCode, 200, 'overview route should respond 200');
const payload = res.body;
assert(payload, 'overview payload should be defined');

assert.equal(Math.round(payload?.equityUsd), 2500, 'equityUsd reflects paper pool balance');
assert.equal(Math.round(payload?.capitalPool?.paper?.totalUsd ?? -1), 2500);
assert.equal(Math.round(payload?.capitalPool?.paper?.freeUsd ?? -1), 2500);
assert.equal(Math.round(payload?.capitalPool?.paper?.reservedUsd ?? -1), 0);
assert.equal(Math.round(payload?.paperBalance?.equityUsd ?? -1), 2500);
assert.equal(Math.round(payload?.paperBalance?.freeUsd ?? -1), 2500);
assert.equal(Math.round(payload?.paperBalance?.committedUsd ?? -1), 0);

assert(payload?.capitalPool?.live, 'live capital snapshot should be present');
assert.equal(Math.round(payload.capitalPool.live.totalUsd ?? 0), 0);

console.log('✅ capital overview aligns with shared pool snapshot');


process.exit(0);
