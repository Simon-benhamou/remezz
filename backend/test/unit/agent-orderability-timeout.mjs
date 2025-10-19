import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const { __agentCreationTestHooks } = await import('../../dist/src/services/agentCreationFlow.js');

const { fetchTickerWithTimeout, evaluateOrderability, isOrderabilityTickerTimeoutError } = __agentCreationTestHooks;

const baseConfig = {
  mode: 'paper',
  startBalanceUsd: 1_000,
  portfolioBalanceUsd: 1_000,
  isSmartAgent: true,
  smartConfig: {
    rescanInterval: 60_000,
    minHoldDuration: 0,
    volumeThreshold: 0,
    momentumThreshold: 0,
  },
  aggressiveness: 'conservative',
  riskPerTradePct: 1,
  maxLeverage: 1,
  requestedMaxLeverage: 1,
  dailyLossLimitPct: 5,
  budgetFraction: 1,
  rawPayload: {},
};

const slowTicker = async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  return { last: 100, quoteVolume: 750_000 };
};

let timeoutTriggered = false;
try {
  await fetchTickerWithTimeout('BTC/USDT:USDT', 20, slowTicker);
} catch (error) {
  assert.ok(isOrderabilityTickerTimeoutError(error), 'timeout should raise specialized error');
  timeoutTriggered = true;
}

assert.ok(timeoutTriggered, 'timeout branch must trigger');

const diagnostics = [];
const timedOut = await evaluateOrderability(
  'SOL/USDT:USDT',
  baseConfig,
  (level, message, meta) => diagnostics.push({ level, message, meta }),
  { timeoutMs: 25, tickerFetcher: slowTicker }
);

assert.equal(timedOut.orderable, false, 'timed out symbol must not be orderable');
assert.ok(
  diagnostics.some((entry) => entry.message === 'Orderability check timed out for symbol'),
  'timeout diagnostic must be emitted'
);

const fastTicker = async () => ({ last: 120, quoteVolume: 2_500_000 });
const available = await evaluateOrderability(
  'ETH/USDT:USDT',
  baseConfig,
  () => {},
  { timeoutMs: 25, tickerFetcher: fastTicker }
);

assert.equal(available.orderable, true, 'fast ticker result should be orderable');
console.log('✅ agent orderability timeout safeguards passed');
