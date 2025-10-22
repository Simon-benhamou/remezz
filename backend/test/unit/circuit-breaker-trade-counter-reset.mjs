import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.DISABLE_PYTHON_PREDICTOR = 'true';

const { ReboundRejectionAgent } = await import('../../dist/src/agent/state.js');

const agent = new ReboundRejectionAgent();
agent.tradesToday = 7;

const state = {
  consecutiveLosses: 0,
  consecutiveWins: 0,
  tradesToday: 0,
  equityStartDay: null,
  cooldownUntil: null,
  lastTradeDay: '2024-01-02',
  dayStartAt: new Date('2024-01-02T00:00:00Z'),
  dailyLossActive: false,
  dailyLossTriggeredAt: null,
  dailyLossRecoveryWinsRemaining: 0,
};

agent.handleCircuitBreakerStateChange(state);
assert.equal(agent.tradesToday, 0, 'tradesToday should reset when circuit breaker resets for new UTC day');

state.tradesToday = 3;
agent.handleCircuitBreakerStateChange(state);
assert.equal(agent.tradesToday, 3, 'tradesToday should sync with circuit breaker increments');

console.log('✅ circuit breaker trade counter reset test passed');
