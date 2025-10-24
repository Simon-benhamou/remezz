import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.MARKET_TYPE = 'futures';

const { createTestBinanceWebSocketHarness } = await import('../../dist/src/services/binanceWebSocket.js');

const harness = createTestBinanceWebSocketHarness();
const { manager } = harness;

try {
  harness.seedExchangeSymbols(['BTCUSDT', 'ETHUSDT']);

  const btcResult = manager.subscribeToKline('BTC/USDT', '1m');
  assert.equal(btcResult.ok, true, 'BTC/USDT should be accepted when listed');

  const rejection = manager.subscribeToKline('FOOBAR/USDT', '1m');
  assert.equal(rejection.ok, false, 'Unknown symbol should be rejected and not subscribed');
  assert.equal(rejection.reason, 'unknown_symbol', 'Rejection reason should flag unknown symbols');

  const desiredMap = manager.desiredKlineStreams;
  assert(!desiredMap.has('foobarusdt@kline_1m'), 'Invalid stream should not be tracked');

  harness.seedExchangeSymbols(['BTCUSDT', 'ETHUSDT', 'FOOBARUSDT']);
  const refreshed = manager.subscribeToKline('FOOBAR/USDT', '1m');
  assert.equal(refreshed.ok, true, 'Previously rejected symbol should subscribe once exchangeInfo includes it');

  console.log('✅ Binance WS symbol validation rejects unknown pairs and accepts refreshed listings');
} finally {
  manager.close();
}
