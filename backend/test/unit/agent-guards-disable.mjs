import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.DISABLE_AGENT_GUARDS = 'true';

const { GuardrailMonitor } = await import('../../dist/src/quantai/strategies/intradayDual/risk.js');
const { PreciseDecimal } = await import('../../dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
const { DisabledCircuitBreaker } = await import('../../dist/src/quantai/risk/circuitBreaker.js');

const monitor = new GuardrailMonitor();
const loss = new PreciseDecimal('-100');
const risk = new PreciseDecimal('50');
const equity = new PreciseDecimal('1000');

monitor.recordTrade('BTC/USDT:USDT', loss, risk, equity, Date.now());
const guardCheck = monitor.canEnter('BTC/USDT:USDT', Date.now(), 'MR');
assert.equal(guardCheck.allowed, true, 'GuardrailMonitor should allow entries when guards are disabled');

const breakerCfg = {
  maxConsecutiveLosses: 1,
  cooldownMinutes: 60,
  dailyLossLimitPct: 3,
  dailyTradeLimit: 1,
  catastrophicTradeDrawdownPct: 10,
  catastrophicTradeConsecutiveLosses: 1,
  reduceSizeAfterLosses: true,
  sizeReductionAfterLosses: 1,
  sizeReductionFactor: 0.5,
  baseRiskPerTradePct: 1,
  winStreakForIncrease: 2,
  sizeIncreaseFactor: 1.1,
  sizeIncreaseMaxMultiplier: 2,
  dailyLossRiskReductionMultiplier: 0.5,
  dailyLossCooldownMinutes: 30,
  dailyLossRecoveryWins: 2,
};

const circuitBreaker = new DisabledCircuitBreaker(breakerCfg);
const decision = circuitBreaker.canOpenTrade(new Date(), 1000);
assert.equal(decision.allowed, true, 'DisabledCircuitBreaker should always allow trades');
