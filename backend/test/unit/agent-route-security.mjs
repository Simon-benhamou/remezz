import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const { prisma } = await import('../../dist/src/db/client.js');
await prisma.$reset();

const { router, createStopRouteHandler } = await import('../../dist/src/routes/agent.js');

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

// Prepare base session owned by user-1
const owner = await prisma.user.create({
  data: {
    id: 'user-1',
    username: 'owner',
    email: 'owner@example.com',
    passwordHash: 'hashed',
    role: 'trader',
  },
});

const otherUser = await prisma.user.create({
  data: {
    id: 'user-2',
    username: 'intruder',
    email: 'intruder@example.com',
    passwordHash: 'hashed',
    role: 'trader',
  },
});

const session = await prisma.agentSession.create({
  data: {
    id: 'sess-1',
    symbol: 'BTC/USDT:USDT',
    mode: 'paper',
    userId: owner.id,
    profileJson: { aggressiveness: 'reactive' },
  },
});

const stopSecurityHandler = createStopRouteHandler({
  prismaClient: {
    agentSession: {
      findUnique: async ({ where }) => {
        if (where.id !== 'secure-session') return null;
        return { id: 'secure-session', userId: owner.id, symbol: 'BTC/USDT:USDT', mode: 'paper' };
      },
      findFirst: async () => null,
    },
  },
  agentHub: {
    closeNow: async () => {},
    halt: async () => {},
  },
  stopSessionFn: async () => {},
  broadcastFn: () => {},
});

// stop route security: missing auth
{
  const req = { body: { sessionId: 'secure-session' } };
  const res = createMockRes();
  await stopSecurityHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body?.code, 'auth_required');
}

// stop route security: other user forbidden
{
  const req = { body: { sessionId: 'secure-session' }, user: { id: otherUser.id, role: 'trader', username: otherUser.username } };
  const res = createMockRes();
  await stopSecurityHandler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body?.code, 'session_forbidden');
}

// stop route security: owner allowed
{
  const req = { body: { sessionId: 'secure-session' }, user: { id: owner.id, role: 'trader', username: owner.username } };
  const res = createMockRes();
  await stopSecurityHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.ok, true);
}

const setSymbolHandler = findRoute('post', '/set-symbol');

// No token -> 401
{
  const req = { body: { sessionId: session.id, symbol: 'ETH/USDT:USDT' } };
  const res = createMockRes();
  await setSymbolHandler(req, res);
  assert.equal(res.statusCode, 401, 'Missing authentication should return 401');
  assert.equal(res.body?.code, 'auth_required');
}

// Wrong owner -> 403
{
  const req = {
    body: { sessionId: session.id, symbol: 'SOL/USDT:USDT' },
    user: { id: otherUser.id, role: 'trader', username: otherUser.username },
  };
  const res = createMockRes();
  await setSymbolHandler(req, res);
  assert.equal(res.statusCode, 403, 'Other user should receive forbidden');
  assert.equal(res.body?.code, 'session_forbidden');
}

// Owner -> ok and symbol updated
{
  const req = {
    body: { sessionId: session.id, symbol: 'SOL/USDT:USDT' },
    user: { id: owner.id, role: 'trader', username: owner.username },
  };
  const res = createMockRes();
  await setSymbolHandler(req, res);
  assert.equal(res.statusCode, 200, 'Owner should update symbol');
  assert.equal(res.body?.ok, true);
  const refreshed = await prisma.agentSession.findUnique({ where: { id: session.id } });
  assert.equal(refreshed.symbol, 'SOL/USDT:USDT');
}

const sessionsHandler = findRoute('get', '/sessions');

// sessions should filter to owner
{
  const req = { query: {}, user: { id: owner.id, role: 'trader', username: owner.username } };
  const res = createMockRes();
  await sessionsHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert(Array.isArray(res.body), 'Sessions handler returns array');
  assert.equal(res.body.length, 1, 'Owner sees only own session');
}

// admin can see everything
const adminHandlerReq = { query: {}, user: { id: 'admin', role: 'admin', username: 'root' } };
{
  const res = createMockRes();
  await sessionsHandler(adminHandlerReq, res);
  assert.equal(res.statusCode, 200);
  assert(res.body.length >= 1, 'Admin can list sessions');
}

const stateHandler = findRoute('get', '/state');

// state requires auth
{
  const req = { query: { sessionId: session.id } };
  const res = createMockRes();
  await stateHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body?.code, 'auth_required');
}

// state forbidden for other user
{
  const req = { query: { sessionId: session.id }, user: { id: otherUser.id, role: 'trader', username: otherUser.username } };
  const res = createMockRes();
  await stateHandler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body?.code, 'session_forbidden');
}

// owner can fetch state
{
  const req = { query: { sessionId: session.id }, user: { id: owner.id, role: 'trader', username: owner.username } };
  const res = createMockRes();
  await stateHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.ok, true);
  assert.equal(res.body?.sessionId, session.id);
}

console.log('✅ agent-route-security tests passed');
