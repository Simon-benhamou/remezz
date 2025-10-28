import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const {
  LiveBroker,
  __setLiveBrokerTestOverrides,
  __resetLiveBrokerTestOverrides,
} = await import('../../dist/src/broker/live.js');

const stubCredentials = {
  apiKey: 'key',
  apiSecret: 'secret',
  exchange: 'binance',
  passphrase: undefined,
  testnet: false,
};

const normalizeId = order => String(order?.id || order?.clientOrderId || '');

const makeOrder = ({ id, side, type, price, stopPrice, reduceOnly = true }) => ({
  id,
  side,
  type,
  price,
  stopPrice,
  triggerPrice: stopPrice,
  reduceOnly,
  info: {
    price,
    stopPrice,
    triggerPrice: stopPrice,
    reduceOnly,
  },
});

const createExchangeStub = (initialOrders = []) => {
  let openOrders = initialOrders.map(order => ({ ...order }));
  const cancelled = [];
  const created = [];
  let idCounter = 0;

  return {
    exchange: {
      id: 'binance',
      async fetchOpenOrders() {
        return openOrders.map(order => ({ ...order }));
      },
      async cancelOrder(id) {
        cancelled.push(String(id));
        openOrders = openOrders.filter(order => normalizeId(order) !== String(id));
      },
      async createOrder(symbol, type, side, qty, price, params = {}) {
        idCounter += 1;
        const nextId = `gen-${idCounter}`;
        const stopPrice = params.stopPrice ?? params.triggerPrice;
        const order = makeOrder({
          id: nextId,
          side,
          type,
          price,
          stopPrice,
          reduceOnly: params.reduceOnly !== false,
        });
        openOrders.push(order);
        created.push(order);
        return { ...order };
      },
    },
    getState() {
      return {
        openOrders: openOrders.map(order => ({ ...order })),
        cancelled: [...cancelled],
        created: [...created],
      };
    },
  };
};

const broker = new LiveBroker('user-protective');

try {
  // Scenario 1: disable protective orders should cancel existing stop
  {
    const stub = createExchangeStub([
      makeOrder({ id: 'stop-1', side: 'sell', type: 'stop_market', stopPrice: 101, reduceOnly: true }),
      makeOrder({ id: 'stop-2', side: 'sell', type: 'stop_market', stopPrice: 102, reduceOnly: true }),
    ]);
    __setLiveBrokerTestOverrides({
      async getUserCredentials() {
        return stubCredentials;
      },
      async getUserExchange() {
        return stub.exchange;
      },
      async resolveSymbol(symbol) {
        return symbol;
      },
    });

    const result = await broker.syncProtective({
      symbol: 'MELANIA/USDT',
      side: 'buy',
      qty: 0,
      stopLoss: undefined,
      takeProfit: undefined,
      slOrderId: 'stop-1',
      tpOrderId: null,
    });

    const state = stub.getState();
    assert.equal(result.slOrderId, null);
    assert.equal(state.openOrders.length, 0, 'all protective orders should be cancelled');
    assert.deepEqual(state.cancelled.sort(), ['stop-1', 'stop-2']);
  }

  // Scenario 2: reuse matching stop order when price unchanged
  {
    const stub = createExchangeStub([
      makeOrder({ id: 'keep-stop', side: 'sell', type: 'stop_market', stopPrice: 99, reduceOnly: true }),
    ]);
    __setLiveBrokerTestOverrides({
      async getUserCredentials() {
        return stubCredentials;
      },
      async getUserExchange() {
        return stub.exchange;
      },
      async resolveSymbol(symbol) {
        return symbol;
      },
    });

    const result = await broker.syncProtective({
      symbol: 'MELANIA/USDT',
      side: 'buy',
      qty: 5,
      stopLoss: 99,
      takeProfit: undefined,
      slOrderId: 'keep-stop',
      tpOrderId: null,
    });

    const state = stub.getState();
    assert.equal(result.slOrderId, 'keep-stop');
    assert.equal(state.openOrders.length, 1);
    assert.equal(state.cancelled.length, 0, 'no cancellation when stop reused');
    assert.equal(state.created.length, 0, 'no new order when stop reused');
  }

  // Scenario 3: replace stop when price changed
  {
    const stub = createExchangeStub([
      makeOrder({ id: 'old-stop', side: 'sell', type: 'stop_market', stopPrice: 95, reduceOnly: true }),
    ]);
    __setLiveBrokerTestOverrides({
      async getUserCredentials() {
        return stubCredentials;
      },
      async getUserExchange() {
        return stub.exchange;
      },
      async resolveSymbol(symbol) {
        return symbol;
      },
    });

    const result = await broker.syncProtective({
      symbol: 'MELANIA/USDT',
      side: 'buy',
      qty: 3,
      stopLoss: 90,
      takeProfit: undefined,
      slOrderId: 'old-stop',
      tpOrderId: null,
    });

    const state = stub.getState();
    assert(result.slOrderId && result.slOrderId.startsWith('gen-'), 'new stop id returned');
    assert.deepEqual(state.cancelled, ['old-stop']);
    assert.equal(state.created.length, 1, 'one new stop created');
    assert.equal(Number(state.openOrders[0].stopPrice), 90);
  }

  console.log('✅ live-broker-sync-protective.mjs passed');
} finally {
  __resetLiveBrokerTestOverrides();
}
