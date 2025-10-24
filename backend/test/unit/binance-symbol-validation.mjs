import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.MARKET_TYPE = 'futures';

const { createTestBinanceWebSocketHarness } = await import('../../dist/src/services/binanceWebSocket.js');

const harness = createTestBinanceWebSocketHarness();
const { manager } = harness;

try {
  harness.seedExchangeSymbols(['BTCUSDT', 'ETHUSDT']);

  assert.equal(manager.subscribeToKline('BTC/USDT', '1m'), true, 'BTC/USDT should be accepted when listed');
  assert.equal(
    manager.subscribeToKline('FOOBAR/USDT', '1m'),
    false,
    'Unknown symbol should be rejected and not subscribed',
  );

  const desiredMap = manager.desiredKlineStreams;
  assert(!desiredMap.has('foobarusdt@kline_1m'), 'Invalid stream should not be tracked');

  harness.seedExchangeSymbols(['BTCUSDT', 'ETHUSDT', 'FOOBARUSDT']);
  assert.equal(
    manager.subscribeToKline('FOOBAR/USDT', '1m'),
    true,
    'Previously rejected symbol should subscribe once exchangeInfo includes it',
  );

  console.log('✅ Binance WS symbol validation rejects unknown pairs and accepts refreshed listings');
} finally {
  manager.close();
}
