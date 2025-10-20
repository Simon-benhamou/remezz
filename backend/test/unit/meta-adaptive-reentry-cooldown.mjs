import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.DISABLE_PYTHON_PREDICTOR = 'true';

const { metaAdaptiveStrategyAgent, PreciseDecimal } = await import('../../dist/src/quantai/strategy/metaAdaptiveAgent.js');

metaAdaptiveStrategyAgent.reset();
metaAdaptiveStrategyAgent.setRandomSeed(12345);
metaAdaptiveStrategyAgent.setReentryCooldownMinutes(10);

await metaAdaptiveStrategyAgent.registerActiveTrade({
  sessionId: 'unit-session',
  symbol: 'XRP/USDT',
  family: 'trend',
  id: 'classic_trend_following',
  token: 'unit-token',
  qty: 1,
  entryPrice: 2.4,
  stopDistance: 0.2,
  plan: {
    riskPct: new PreciseDecimal('1'),
    stopAtrMult: new PreciseDecimal('1.2'),
    takeProfitMultiples: [new PreciseDecimal('2')],
    executionMode: 'market',
    riskUsd: new PreciseDecimal('10'),
    targetProfitUsd: new PreciseDecimal('20'),
    medianTakeProfitR: new PreciseDecimal('2'),
    trailingPolicy: null,
  },
  side: 'long',
  predictorFeatures: null,
});

metaAdaptiveStrategyAgent.registerOutcome({
  sessionId: 'unit-session',
  symbol: 'XRP/USDT',
  token: 'unit-token',
  realizedPnlUsd: -5,
});

const eligibleImmediate = metaAdaptiveStrategyAgent.isSymbolEligibleForEntry('unit-session', 'XRP/USDT');
assert.equal(eligibleImmediate, false, 'Symbol should be on cooldown immediately after a loss');

const realNow = Date.now;
Date.now = () => realNow() + 11 * 60 * 1000;

const eligibleAfter = metaAdaptiveStrategyAgent.isSymbolEligibleForEntry('unit-session', 'XRP/USDT');
assert.equal(eligibleAfter, true, 'Cooldown should expire after configured minutes have passed');

Date.now = realNow;
metaAdaptiveStrategyAgent.reset('unit-session');

console.log('✅ meta-adaptive reentry cooldown test passed');
