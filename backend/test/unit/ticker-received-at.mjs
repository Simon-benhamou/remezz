import assert from 'node:assert/strict';

process.env.WS_MAX_TIMESTAMP_DRIFT_MS = '5000';
process.env.MARKET_STALE_THRESHOLD_MS = '12000';

const now = Date.now();
const frameTs = now - 9000; // 9s old frame to simulate cache retrieval

const { resolveTickerReceivedAt } = await import('../../dist/src/data/market.js');
const { evaluateTickerFrame } = await import('../../dist/src/data/tickerValidation.js');

const wsTicker = { receivedAt: frameTs + 200 }; // original validation occurred 200ms after event time
const receivedAt = resolveTickerReceivedAt(wsTicker, now);
assert.equal(receivedAt, wsTicker.receivedAt);
assert.equal(resolveTickerReceivedAt(null, now), now);

const validFrame = {
  symbol: 'XRP/USDT',
  last: 0.54,
  bid: 0.539,
  ask: 0.541,
  high: 0.6,
  low: 0.5,
  baseVolume: 1000000,
  quoteVolume: 540000,
  timestamp: frameTs,
};

const accepted = evaluateTickerFrame({
  symbol: 'XRP/USDT',
  frame: validFrame,
  source: 'WS',
  receivedAt,
  expectedSymbolId: 'XRPUSDT',
});

assert.equal(accepted.status, 'accepted', 'ticker should be accepted when validated with original receivedAt');

const rejected = evaluateTickerFrame({
  symbol: 'XRP/USDT',
  frame: validFrame,
  source: 'WS',
  receivedAt: now,
  expectedSymbolId: 'XRPUSDT',
});

assert.equal(rejected.status, 'rejected');
assert.equal(rejected.ruleId, 'timestamp_drift');

console.log('✅ resolveTickerReceivedAt preserves accepted ticker frames without timestamp drift regressions.');
