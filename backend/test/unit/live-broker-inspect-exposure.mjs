import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
const originalMarketType = process.env.MARKET_TYPE;
process.env.MARKET_TYPE = 'swap';
process.env.EXCHANGE_ID = 'binance';

const {
  inspectExposure,
  __setLiveBrokerTestOverrides,
  __resetLiveBrokerTestOverrides,
} = await import('../../dist/src/broker/live.js');

process.env.MARKET_TYPE = 'spot';

try {
  __setLiveBrokerTestOverrides({
    async getUserCredentials() {
      return {
        apiKey: 'key',
        apiSecret: 'secret',
        exchange: 'binanceusdm',
        passphrase: undefined,
        testnet: false,
      };
    },
    async getUserExchange() {
      return {
        id: 'binance',
        fetchPositions: async () => [],
        fetchBalance: async () => ({
          total: { MELANI: 12.5 },
          free: { MELANI: 12.5 },
          used: { MELANI: 0 },
        }),
        markets: {},
      };
    },
    async resolveSymbol(requested) {
      return requested.includes('/') ? requested : 'MELANI/USDT:USDT';
    },
  });

  const exposure = await inspectExposure('MELANIUSDT', 'user-123');
  assert(exposure, 'Exposure should be detected for MELANI spot holdings');
  assert.equal(exposure?.side, 'buy');
  assert.equal(exposure?.qty, 12.5);

  console.log('✅ live-broker-inspect-exposure.mjs passed');
} finally {
  process.env.MARKET_TYPE = originalMarketType;
  __resetLiveBrokerTestOverrides();
}
