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

// Test: Consecutive losses and cooldown should reset on new day
const circuit = new CircuitBreaker(riskConfig);
const day1 = new Date('2024-01-01T12:00:00Z');

// Simulate 3 consecutive losses on day 1
circuit.canOpenTrade(day1, 10_000);
circuit.onBeforeOpen(day1, 10_000);
circuit.onTradeResult(day1, -0.02, 9_800);

const time2 = new Date(day1.getTime() + 60_000);
circuit.onBeforeOpen(time2, 9_800);
circuit.onTradeResult(time2, -0.03, 9_700);

const time3 = new Date(day1.getTime() + 120_000);
circuit.onBeforeOpen(time3, 9_700);
circuit.onTradeResult(time3, -0.04, 9_600);

// After 3 losses, should be in cooldown
const state1 = circuit.getState();
assert.equal(state1.consecutiveLosses, 3, 'Should have 3 consecutive losses');
assert.equal(state1.tradesToday, 3, 'Should have 3 trades today');
assert.ok(state1.cooldownUntil instanceof Date, 'Should have cooldown active');

const stillDay1 = new Date(day1.getTime() + 180_000);
const blocked = circuit.canOpenTrade(stillDay1, 9_600);
assert.equal(blocked.allowed, false, 'Should be blocked by cooldown on same day');
assert.ok(blocked.reason?.includes('Cooldown active until'));

// Now move to next day
const day2 = new Date('2024-01-02T12:00:00Z');
const allowedDay2 = circuit.canOpenTrade(day2, 9_600);

// On new day, consecutive losses and cooldown should reset
const state2 = circuit.getState();
assert.equal(state2.consecutiveLosses, 0, 'Consecutive losses should reset on new day');
assert.equal(state2.consecutiveWins, 0, 'Consecutive wins should reset on new day');
assert.equal(state2.tradesToday, 0, 'Trades today should reset on new day');
assert.equal(state2.cooldownUntil, null, 'Cooldown should be cleared on new day');
assert.equal(state2.cooldownReason, null, 'Cooldown reason should be cleared on new day');
assert.equal(allowedDay2.allowed, true, 'Should allow trading on new day after reset');

// Verify trading can resume on day 2
circuit.onBeforeOpen(day2, 9_600);
circuit.onTradeResult(day2, 0.05, 10_080); // Win

const state3 = circuit.getState();
assert.equal(state3.tradesToday, 1, 'Should have 1 trade on new day');
assert.equal(state3.consecutiveLosses, 0, 'Should still have 0 consecutive losses after win');
assert.equal(state3.consecutiveWins, 1, 'Should have 1 consecutive win');

console.log('✅ Circuit breaker day reset test passed');
