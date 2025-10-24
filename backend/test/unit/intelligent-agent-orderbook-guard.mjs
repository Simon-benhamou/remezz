import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { __intelligentAgentTestHooks } = await import('../../dist/src/services/intelligentAgent.js');
const { resolveExchangeSymbol, shouldFetchOrderBook, isMissingSymbolError, resetOrderBookThrottle } = __intelligentAgentTestHooks;

resetOrderBookThrottle();

const mockExchange = {
  markets: {
    'ABC/USDT:USDT': { symbol: 'ABC/USDT:USDT' },
    'XYZ/USDT': { symbol: 'XYZ/USDT' },
  },
  market(requested) {
    if (requested === 'XYZ/USDT') {
      return { symbol: 'XYZ/USDT' };
    }
    throw Object.assign(new Error('symbol not found'), { message: 'symbol not found' });
  },
};

assert.equal(
  resolveExchangeSymbol(mockExchange, 'ABC/USDT:USDT'),
  'ABC/USDT:USDT',
  'should keep canonical perpetual symbol when present',
);

assert.equal(
  resolveExchangeSymbol(mockExchange, 'ABC/USDT'),
  'ABC/USDT:USDT',
  'should upgrade legacy symbols to perpetual format when markets contain alias',
);

assert.equal(
  resolveExchangeSymbol(mockExchange, 'XYZ/USDT'),
  'XYZ/USDT',
  'should resolve symbol via exchange.market fallback',
);

assert.equal(
  resolveExchangeSymbol(mockExchange, 'MISSING/USDT'),
  null,
  'should return null when exchange reports missing symbol',
);

assert.equal(shouldFetchOrderBook('ABC/USDT:USDT'), true, 'first fetch should be permitted');
assert.equal(shouldFetchOrderBook('ABC/USDT:USDT'), false, 'immediate repeat should be throttled');

await new Promise(resolve => setTimeout(resolve, 1_050));

assert.equal(shouldFetchOrderBook('ABC/USDT:USDT'), true, 'fetch should resume after throttle window');

assert.equal(
  isMissingSymbolError(new Error("Mandatory parameter 'symbol' was not sent")),
  true,
  'should detect ccxt missing symbol error',
);

assert.equal(
  isMissingSymbolError(new Error('rate limit exceeded')),
  false,
  'should not classify unrelated errors as missing symbol',
);

console.log('✅ Intelligent agent order book guard enforces symbol validation and throttling');
