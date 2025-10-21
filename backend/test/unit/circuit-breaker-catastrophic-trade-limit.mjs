import assert from 'node:assert/strict';

const { CircuitBreaker } = await import('../../dist/src/quantai/index.js');

const baseRisk = {
  maxConsecutiveLosses: 10,
  cooldownMinutes: 60,
  dailyLossLimitPct: 50,
  dailyTradeLimit: 2,
  catastrophicTradeDrawdownPct: 2,
  catastrophicTradeConsecutiveLosses: 3,
  reduceSizeAfterLosses: false,
  sizeReductionAfterLosses: 3,
  sizeReductionFactor: 0.5,
  baseRiskPerTradePct: 0.5,
  winStreakForIncrease: 0,
  sizeIncreaseFactor: 1,
  sizeIncreaseMaxMultiplier: 1,
  dailyLossRiskReductionMultiplier: 1,
  dailyLossCooldownMinutes: 0,
  dailyLossRecoveryWins: 0,
};

// Healthy performance should bypass the daily trade cap
const healthyCircuit = new CircuitBreaker(baseRisk);
const start = new Date('2024-05-01T00:00:00Z');
assert.equal(healthyCircuit.canOpenTrade(start, 10_000).allowed, true);
healthyCircuit.onBeforeOpen(start, 10_000);
healthyCircuit.onTradeResult(new Date(start.getTime() + 60_000), 0.02, 10_400);
healthyCircuit.onBeforeOpen(new Date(start.getTime() + 120_000), 10_400);
healthyCircuit.onTradeResult(new Date(start.getTime() + 180_000), 0.01, 10_600);
const healthyDecision = healthyCircuit.canOpenTrade(new Date(start.getTime() + 240_000), 10_650);
assert.equal(healthyDecision.allowed, true, 'Daily trade limit should be bypassed when performance is healthy');

// Catastrophic performance should enforce the cap once reached
const catastrophicCircuit = new CircuitBreaker({
  ...baseRisk,
  catastrophicTradeConsecutiveLosses: 1,
});
const catStart = new Date('2024-05-02T00:00:00Z');
assert.equal(catastrophicCircuit.canOpenTrade(catStart, 10_000).allowed, true);
catastrophicCircuit.onBeforeOpen(catStart, 10_000);
catastrophicCircuit.onTradeResult(new Date(catStart.getTime() + 60_000), -0.03, 9_700);
catastrophicCircuit.onBeforeOpen(new Date(catStart.getTime() + 120_000), 9_700);
catastrophicCircuit.onTradeResult(new Date(catStart.getTime() + 180_000), -0.04, 9_300);
const catastrophicDecision = catastrophicCircuit.canOpenTrade(new Date(catStart.getTime() + 240_000), 9_250);
assert.equal(catastrophicDecision.allowed, false, 'Catastrophic performance should engage the trade cap');
assert.ok(
  catastrophicDecision.reason?.includes('catastrophic'),
  'Decision reason should mention catastrophic conditions',
);

console.log('✅ Circuit breaker catastrophic trade limit test passed');
