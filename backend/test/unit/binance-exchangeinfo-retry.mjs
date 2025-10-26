import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.EXCHANGE_ID = 'binanceusdm';

const { __autoUniverseTestHooks } = await import('../../dist/src/services/intelligentAgent.js');

const plans = new Map([
  [
    'https://fapi.binance.com/fapi/v1/exchangeInfo',
    [
      { kind: 'error', message: 'RequestTimeout: binance GET fapi request timed out (10000 ms)' },
      { kind: 'error', message: 'RequestTimeout: binance GET fapi request timed out (10000 ms)' },
      { kind: 'error', message: 'RequestTimeout: binance GET fapi request timed out (10000 ms)' },
    ],
  ],
  [
    'https://dapi.binance.com/dapi/v1/exchangeInfo',
    [
      { kind: 'error', message: 'RequestTimeout: binance GET dapi request timed out (10000 ms)' },
      { kind: 'error', message: 'RequestTimeout: binance GET dapi request timed out (10000 ms)' },
      { kind: 'error', message: 'RequestTimeout: binance GET dapi request timed out (10000 ms)' },
    ],
  ],
  [
    'https://api.binance.com/api/v3/exchangeInfo',
    [
      {
        kind: 'ok',
        body: {
          symbols: [
            { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT' },
            { symbol: 'ETHUSDT', status: 'HALT', baseAsset: 'ETH', quoteAsset: 'USDT' },
          ],
        },
      },
    ],
  ],
]);

const fetchCalls = [];

const fetchStub = async (url) => {
  const key = url.toString();
  fetchCalls.push(key);
  const queue = plans.get(key);
  if (!queue || queue.length === 0) {
    throw new Error(`Unexpected fetch for ${key}`);
  }
  const next = queue.shift();
  if (next.kind === 'error') {
    throw new Error(next.message);
  }
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => next.body,
  };
};

const { fetchBinanceMarketsForTests } = __autoUniverseTestHooks;
const { markets, count, source } = await fetchBinanceMarketsForTests({
  fetchImpl: fetchStub,
  disableCache: true,
  cacheKey: 'binance_retry_unit',
});

assert.equal(source, 'spot_fallback', 'spot exchangeInfo fallback should be used after repeated futures timeouts');
assert.equal(count, 1, 'only trading USDT symbols should survive');
assert.ok(markets['BTC/USDT'], 'BTC/USDT should be available after fallback');
assert.deepEqual(fetchCalls, [
  'https://fapi.binance.com/fapi/v1/exchangeInfo',
  'https://fapi.binance.com/fapi/v1/exchangeInfo',
  'https://fapi.binance.com/fapi/v1/exchangeInfo',
  'https://dapi.binance.com/dapi/v1/exchangeInfo',
  'https://dapi.binance.com/dapi/v1/exchangeInfo',
  'https://dapi.binance.com/dapi/v1/exchangeInfo',
  'https://api.binance.com/api/v3/exchangeInfo',
]);
