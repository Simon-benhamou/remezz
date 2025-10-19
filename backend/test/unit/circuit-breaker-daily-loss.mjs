import assert from 'node:assert/strict';
const { CircuitBreaker } = await import('../../dist/src/quantai/index.js');

const riskConfig = {
  maxConsecutiveLosses: 3,
  cooldownMinutes: 60,
  dailyLossLimitPct: 3.5,
  dailyTradeLimit: 20,
  reduceSizeAfterLosses: false,
  sizeReductionAfterLosses: 2,
  sizeReductionFactor: 0.5,
  baseRiskPerTradePct: 0.5,
  winStreakForIncrease: 0,
  sizeIncreaseFactor: 1,
  sizeIncreaseMaxMultiplier: 1,
  dailyLossRiskReductionMultiplier: 0.25,
  dailyLossCooldownMinutes: 30,
  dailyLossRecoveryWins: 2,
};

const circuit = new CircuitBreaker(riskConfig);
const start = new Date('2024-01-01T00:00:00Z');

// Prime day start equity baseline
let decision = circuit.canOpenTrade(start, 10_000);
assert.equal(decision.allowed, true, 'First trade should be permitted');

// Big drawdown triggers daily loss limit and cooldown
const afterDrawdown = new Date(start.getTime() + 60_000);
decision = circuit.canOpenTrade(afterDrawdown, 7_500);
assert.equal(decision.allowed, false, 'Daily loss limit should block new trades');
assert.ok(decision.reason?.includes('Daily loss limit hit'));
assert.ok(decision.cooldownUntil instanceof Date, 'Cooldown timestamp should be provided');

let state = circuit.getState();
assert.equal(state.dailyLossActive, true, 'Daily loss risk mode should be active after trigger');
assert.equal(state.dailyLossRecoveryWinsRemaining, 2);

// After cooldown expires the circuit should allow trades but with reduced size
const postCooldown = new Date((decision.cooldownUntil ?? new Date(afterDrawdown.getTime() + 30 * 60 * 1000)).getTime() + 1);
const resumed = circuit.canOpenTrade(postCooldown, 7_400);
assert.equal(resumed.allowed, true, 'Trades should resume in risk-reduced mode');
const reducedSize = circuit.sizeMultiplier();
assert.ok(reducedSize < 1 && reducedSize > 0, 'Size should be reduced while in risk-off mode');

// Register recovery wins to exit risk-off mode
circuit.onTradeResult(postCooldown, 0.02, 7_600);
circuit.onTradeResult(new Date(postCooldown.getTime() + 60_000), 0.03, 7_800);
state = circuit.getState();
assert.equal(state.dailyLossActive, false, 'Risk mode should clear after recovery wins');
assert.equal(state.dailyLossRecoveryWinsRemaining, 0);
assert.ok(circuit.sizeMultiplier() >= 0.99, 'Size reduction should lift after recovery wins');

console.log('✅ Circuit breaker daily loss adaptation test passed');
