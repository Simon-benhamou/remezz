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
  catastrophicTradeDrawdownPct: 15,
  catastrophicTradeConsecutiveLosses: 6,
};

// Daily loss triggered cooldown should persist reason
const circuit = new CircuitBreaker(riskConfig);
const start = new Date('2024-01-01T00:00:00Z');

let decision = circuit.canOpenTrade(start, 10_000);
assert.equal(decision.allowed, true, 'Initial trade should be allowed');

const lossEquityTs = new Date(start.getTime() + 120_000);
decision = circuit.canOpenTrade(lossEquityTs, 9_400);
assert.equal(decision.allowed, false, 'Daily loss drawdown should block trades');
assert.ok(decision.reason?.includes('Daily loss limit hit'));
assert.ok(decision.cooldownUntil instanceof Date);

const duringCooldown = circuit.canOpenTrade(new Date(lossEquityTs.getTime() + 60_000), 9_350);
assert.equal(duringCooldown.allowed, false, 'Cooldown should still be active');
assert.ok(duringCooldown.reason?.includes('Cooldown active until'));
assert.ok(duringCooldown.reason?.includes('Daily loss limit hit'));

let state = circuit.getState();
assert.ok(state.cooldownReason?.includes('Daily loss limit hit'));

// Consecutive losses should retain streak reason during cooldown
const streakCircuit = new CircuitBreaker(riskConfig);
streakCircuit.canOpenTrade(start, 10_000);
streakCircuit.onTradeResult(start, -0.02, 9_800);
streakCircuit.onTradeResult(new Date(start.getTime() + 60_000), -0.03, 9_600);
streakCircuit.onTradeResult(new Date(start.getTime() + 120_000), -0.04, 9_400);

const blocked = streakCircuit.canOpenTrade(new Date(start.getTime() + 180_000), 9_350);
assert.equal(blocked.allowed, false, 'Loss streak should block trades');
assert.ok(blocked.reason?.includes('Cooldown active until'));
assert.ok(blocked.reason?.includes('Consecutive losses threshold reached'));

state = streakCircuit.getState();
assert.ok(state.cooldownReason?.includes('Consecutive losses threshold reached'));

console.log('✅ Circuit breaker cooldown reason propagation test passed');
