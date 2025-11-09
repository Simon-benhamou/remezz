import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.EXCHANGE_ID = 'binanceusdm';

const { __autoUniverseTestHooks } = await import('../../dist/src/services/intelligentAgent.js');

const cachedDynamic = {
  kind: 'dynamic',
  orderedPerformers: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT'],
  performanceSnapshot: [
    { base: 'BTC', change24h: 3.6 },
    { base: 'ETH', change24h: 1.2 },
    { base: 'SOL', change24h: 2.4 },
  ],
};

const dynamicResult = await __autoUniverseTestHooks.resolveCached(cachedDynamic, undefined, {
  getActiveSymbols: async () => ['BTC/USDT', 'ETH/USDT'],
  getActiveCount: async (symbol) => {
    if (symbol.startsWith('BTC')) return 1;
    if (symbol.startsWith('ETH')) return 2;
    return 0;
  },
});

assert.deepEqual(
  dynamicResult,
  ['BTC/USDT:USDT', 'SOL/USDT:USDT'],
  'priority assets should survive cache reuse while respecting active conflicts',
);

const cachedFallback = {
  kind: 'fallback',
  symbols: ['BTC/USDT:USDT', 'XRP/USDT:USDT', 'ADA/USDT:USDT'],
};

const fallbackResult = await __autoUniverseTestHooks.resolveCached(cachedFallback, undefined, {
  getActiveSymbols: async () => ['BTC/USDT', 'ADA/USDT'],
  getActiveCount: async () => 1,
});

assert.deepEqual(
  fallbackResult,
  ['XRP/USDT:USDT'],
  'fallback cache reuse must drop active symbols',
);

__autoUniverseTestHooks.clearCache();

process.exit(0);
