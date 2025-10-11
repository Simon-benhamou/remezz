import assert from 'node:assert/strict';

const { createStopRouteHandler } = await import('../../dist/src/routes/agent.js');

const capturedErrors = [];

const mockAgentHub = {
  closeCalls: 0,
  closeNow: async () => {
    mockAgentHub.closeCalls++;
    throw new Error('forced close failure');
  },
  halt: async () => {
    mockAgentHub.haltCalls++;
  },
  haltCalls: 0,
};

let stopCalls = 0;

const mockPrisma = {
  agentSession: {
    findUnique: async ({ where }) => {
      assert.equal(where.id, 'sess-123');
      return { id: 'sess-123', symbol: 'BTC/USDT:USDT' };
    },
  },
};

const mockStopSession = async (id) => {
  stopCalls++;
  assert.equal(id, 'sess-123');
};

const mockBroadcast = (...args) => {
  mockBroadcast.calls.push(args);
};
mockBroadcast.calls = [];

const handler = createStopRouteHandler({
  prismaClient: mockPrisma,
  agentHub: mockAgentHub,
  stopSessionFn: mockStopSession,
  activeSessionFn: async () => null,
  broadcastFn: mockBroadcast,
  logger: {
    error: (...args) => {
      capturedErrors.push(args);
    },
  },
});

const req = { body: { sessionId: 'sess-123', closePosition: true } };
const res = createMockResponse();

await handler(req, res);

assert.equal(res.statusCode, 500, 'Expected 500 status when closeNow fails');
assert.equal(res.body?.error, 'close_failed', 'Response should include close failure indicator');
assert.equal(res.body?.sessionId, 'sess-123', 'Response should echo failed session id');
assert.equal(stopCalls, 1, 'stopSession should still be invoked');
assert.equal(mockAgentHub.closeCalls, 1, 'AgentHub.closeNow should be attempted once');
assert.equal(mockAgentHub.haltCalls, 1, 'AgentHub.halt should be called once');
assert.ok(capturedErrors.length === 1, 'Failure should be logged exactly once');
assert.ok(String(capturedErrors[0][0]).includes('sess-123'), 'Log should mention the session id');
assert.ok(mockBroadcast.calls.length === 1, 'Broadcast should still be emitted');

console.log('✅ agent-stop-close-error unit test passed');

function createMockResponse() {
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
