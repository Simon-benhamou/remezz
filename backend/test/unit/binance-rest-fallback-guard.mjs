import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.BINANCE_REST_FALLBACK_COOLDOWN_MS = '30';
process.env.BINANCE_REST_FALLBACK_WINDOW_MS = '90';
process.env.BINANCE_REST_FALLBACK_GLOBAL_MAX = '2';

const { scheduleBinanceRestFallback } = await import('../../dist/src/services/binanceWebSocket.js');

let executions = 0;

const first = scheduleBinanceRestFallback('BTC/USDT', async () => {
  executions += 1;
  await new Promise(resolve => setTimeout(resolve, 10));
  return 'btc';
});

const pooled = scheduleBinanceRestFallback('BTC/USDT', async () => {
  executions += 1;
  return 'btc-second';
});

assert.equal(await first, 'btc', 'first fallback should resolve with task result');
assert.equal(await pooled, 'btc', 'parallel fallback should reuse in-flight promise');
assert.equal(executions, 1, 'pooled fallback must not execute task twice');

const throttled = await scheduleBinanceRestFallback('BTC/USDT', async () => {
  executions += 1;
  return 'cooldown';
});
assert.equal(throttled, null, 'cooldown should reject immediate retry for same symbol');

await new Promise(resolve => setTimeout(resolve, 35));

const secondSymbol = await scheduleBinanceRestFallback('ETH/USDT', async () => {
  executions += 1;
  return 'eth';
});
assert.equal(secondSymbol, 'eth', 'different symbol should execute while under quota');
assert.equal(executions, 2, 'only two executions should have occurred');

const quotaBlocked = await scheduleBinanceRestFallback('XRP/USDT', async () => {
  executions += 1;
  return 'xrp';
});
assert.equal(quotaBlocked, null, 'global quota should block third fallback in window');
assert.equal(executions, 2, 'quota-blocked call must not execute task');

console.log('✅ Binance REST fallback guard enforces pooling, cooldown, and quota');
