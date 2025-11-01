import assert from 'node:assert/strict';
import 'dotenv/config';

const { StrategyHealth } = await import('../../dist/src/quantai/services/strategyHealth.js');
const { ReboundRejectionAgent } = await import('../../dist/src/agent/state/index.js');
const { clearOpsEvents, recentOpsEvents } = await import('../../dist/src/monitor/ops.js');

const health = new StrategyHealth({ window: 5, minTradesForGuard: 3, refreshCooldownMs: 300_000 });
const baseTs = Date.now();
for (let i = 0; i < 3; i += 1) {
  health.recordTrade({ pnlR: -1, timestamp: baseTs + i * 60_000, regime: 'trend' });
}

const snapshot = health.snapshot('trend');
assert(snapshot.guardrail, 'StrategyHealth should emit a guardrail after consecutive losses');

clearOpsEvents();
const agent = new ReboundRejectionAgent();
agent.sessionId = 'strategy-health-test';
agent.profile = { symbol: 'ETH/USDT', mode: 'paper', riskPerTradePct: 1 };
agent.scheduleReactivation = () => {};
agent.applyStrategyHealth(snapshot.guardrail);

const events = recentOpsEvents(5, { sessionId: 'strategy-health-test' });
const riskScaled = events.find((evt) => evt.message === 'risk_scaled_by_strategy_health');
const cooldownApplied = events.find((evt) => evt.message === 'strategy_health_cooldown_applied');

assert(riskScaled, 'Risk scaling log should be emitted');
assert(cooldownApplied, 'Cooldown log should be emitted');

console.log('✅ meta-adaptive strategy health integration test passed');
