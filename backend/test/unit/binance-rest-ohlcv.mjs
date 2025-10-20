import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const sampleResponse = [
  [1729435200000, '67500.1', '67600.2', '67400.3', '67550.4', '123.456', 1729436099999, '0', 0, '0', '0', '0'],
  [1729436100000, '67550.4', '67620.5', '67510.6', '67580.7', '234.567', 1729436999999, '0', 0, '0', '0', '0'],
];

const calls = [];

const stubFetch = async (url, init) => {
  calls.push({ url: String(url), init });
  return {
    status: 200,
    ok: true,
    async json() {
      return sampleResponse;
    },
    async text() {
      return JSON.stringify(sampleResponse);
    },
  };
};

const module = await import('../../dist/src/services/binanceRest.js');

const result = await module.fetchBinanceOhlcv('BTC/USDT:USDT', '15m', 3, { fetchImpl: stubFetch });

assert.equal(calls.length, 1, 'fetch should be invoked exactly once');
assert(calls[0].url.includes('symbol=BTCUSDT'), 'symbol should be converted to Binance format');
assert(calls[0].url.includes('interval=15m'), 'timeframe should be forwarded');
assert(calls[0].url.includes('limit=3'), 'limit should be forwarded without clamp when below cap');

assert.equal(result.length, 2, 'response should include two rows');
assert.deepEqual(
  result[0],
  [
    1729435200000,
    67500.1,
    67600.2,
    67400.3,
    67550.4,
    123.456,
  ],
  'rows should be normalized to numbers',
);

let rejected = false;
const rateLimitedFetch = async () => ({
  status: 429,
  ok: false,
  async json() {
    return {};
  },
  async text() {
    return '';
  },
});

try {
  await module.fetchBinanceOhlcv('SOL/USDT:USDT', '15m', 100, { fetchImpl: rateLimitedFetch });
} catch (error) {
  rejected = true;
  assert(error.message.includes('rate_limited'), 'should reject with rate limited error');
}

assert(rejected, 'expected rate limited request to reject');

const cappedCalls = [];
const cappedFetch = async (url) => {
  cappedCalls.push(String(url));
  return {
    status: 200,
    ok: true,
    async json() {
      return sampleResponse;
    },
    async text() {
      return JSON.stringify(sampleResponse);
    },
  };
};
await module.fetchBinanceOhlcv('ETH/USDT:USDT', '1h', 5000, { fetchImpl: cappedFetch });
assert(cappedCalls[0].includes('limit=1500'), 'limit should be capped at Binance maximum');

console.log('✅ Binance OHLCV REST fetch normalizes data and enforces limits');
