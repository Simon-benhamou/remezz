import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.MARKET_TYPE = 'futures';
const prevMax = process.env.BINANCE_MAX_KLINE_STREAMS;
const prevTtl = process.env.BINANCE_KLINE_SUBSCRIPTION_TTL_MS;

process.env.BINANCE_MAX_KLINE_STREAMS = '5';
process.env.BINANCE_KLINE_SUBSCRIPTION_TTL_MS = '1000';

const {
  createTestBinanceWebSocketHarness,
} = await import('../../dist/src/services/binanceWebSocket.js');

const harness = createTestBinanceWebSocketHarness();
const manager = harness.manager;
const internal = manager;

const fakeWs = {
  sent: [],
  send(payload) {
    this.sent.push(JSON.parse(payload));
  },
  close() {
    this.closed = true;
  }
};

internal.ws = fakeWs;
internal.isConnected = true;

const originalNow = Date.now;
let now = 1_700_000_000_000;
Date.now = () => now;

try {
  const initialSymbols = ['ADA/USDT', 'ARB/USDT', 'DYDX/USDT', 'SNX/USDT', 'CRV/USDT'];
  for (const symbol of initialSymbols) {
    assert.equal(manager.subscribeToKline(symbol, '1m'), true, `${symbol} should subscribe while capacity remains`);
    now += 1;
  }

  let subscribeStreams = fakeWs.sent
    .filter(msg => msg.method === 'SUBSCRIBE')
    .map(msg => msg.params[0]);
  let unsubscribeStreams = fakeWs.sent
    .filter(msg => msg.method === 'UNSUBSCRIBE')
    .map(msg => msg.params[0]);

  assert.deepEqual(
    subscribeStreams,
    ['adausdt@kline_1m', 'arbusdt@kline_1m', 'dydxusdt@kline_1m', 'snxusdt@kline_1m', 'crvusdt@kline_1m'],
    'Initial wave must subscribe up to the configured limit',
  );
  assert.deepEqual(unsubscribeStreams, [], 'No unsubscription should happen before the limit is exceeded');

  fakeWs.sent.length = 0;
  assert.equal(manager.subscribeToKline('LINK/USDT', '1m'), true, 'LINK should rotate into the active set at limit');
  now += 1;

  subscribeStreams = fakeWs.sent
    .filter(msg => msg.method === 'SUBSCRIBE')
    .map(msg => msg.params[0]);
  unsubscribeStreams = fakeWs.sent
    .filter(msg => msg.method === 'UNSUBSCRIBE')
    .map(msg => msg.params[0]);

  assert.deepEqual(subscribeStreams, ['linkusdt@kline_1m'], 'Newest symbol must receive a subscription');
  assert.deepEqual(unsubscribeStreams, ['adausdt@kline_1m'], 'Oldest symbol should yield its slot under pressure');

  fakeWs.sent.length = 0;
  assert.equal(manager.subscribeToKline('ADA/USDT', '1m'), true, 'Re-requested ADA should reclaim a slot');
  now += 1;

  subscribeStreams = fakeWs.sent
    .filter(msg => msg.method === 'SUBSCRIBE')
    .map(msg => msg.params[0]);
  unsubscribeStreams = fakeWs.sent
    .filter(msg => msg.method === 'UNSUBSCRIBE')
    .map(msg => msg.params[0]);

  assert.deepEqual(subscribeStreams, ['adausdt@kline_1m'], 'ADA should resubscribe once it becomes hot again');
  assert.deepEqual(unsubscribeStreams, ['arbusdt@kline_1m'], 'Least-recent symbol should now be evicted');

  const desiredMap = internal.desiredKlineStreams;
  assert.equal(desiredMap.size, 6, 'Desired map should keep history entries before TTL pruning');

  fakeWs.sent.length = 0;
  now += 5_000; // beyond TTL => entries older than 1s should be pruned
  assert.equal(manager.subscribeToKline('OP/USDT', '1m'), true, 'Fresh symbol should subscribe after pruning');

  const postPruneDesired = internal.desiredKlineStreams;
  assert.equal(postPruneDesired.size, 1, 'Only the fresh subscription should remain after TTL pruning');

  unsubscribeStreams = fakeWs.sent
    .filter(msg => msg.method === 'UNSUBSCRIBE')
    .map(msg => msg.params[0])
    .sort();
  assert.deepEqual(
    unsubscribeStreams,
    ['adausdt@kline_1m', 'crvusdt@kline_1m', 'dydxusdt@kline_1m', 'linkusdt@kline_1m', 'snxusdt@kline_1m'].sort(),
    'TTL pruning should clean up all previously active streams',
  );

  subscribeStreams = fakeWs.sent
    .filter(msg => msg.method === 'SUBSCRIBE')
    .map(msg => msg.params[0]);
  assert.deepEqual(
    subscribeStreams,
    ['opusdt@kline_1m'],
    'OP must receive a live stream once stale entries are purged',
  );

  console.log('✅ Binance WS kline rotation + TTL pruning behaves as expected');
} finally {
  Date.now = originalNow;
  manager.close();
  if (prevMax === undefined) {
    delete process.env.BINANCE_MAX_KLINE_STREAMS;
  } else {
    process.env.BINANCE_MAX_KLINE_STREAMS = prevMax;
  }
  if (prevTtl === undefined) {
    delete process.env.BINANCE_KLINE_SUBSCRIPTION_TTL_MS;
  } else {
    process.env.BINANCE_KLINE_SUBSCRIPTION_TTL_MS = prevTtl;
  }
}
