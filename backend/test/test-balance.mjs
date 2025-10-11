import assert from 'node:assert/strict';
import {
  ccxt,
  fetchBalanceWithFallback,
  getUserCredentials,
  installCcxtStub,
  resetDatabase,
  seedUserWithApiKey,
} from './helpers/balanceTestUtils.mjs';

async function testCredentialRetrieval() {
  await resetDatabase();
  const { userId, apiKey, apiSecret } = await seedUserWithApiKey({
    userId: 'balance-user',
    apiKey: 'live-api-key',
    apiSecret: 'live-api-secret',
  });

  const credentials = await getUserCredentials(userId, 'binance');
  assert(credentials, 'Expected credentials to be returned for active user');
  assert.equal(credentials.exchange, 'binance');
  assert.equal(credentials.apiKey, apiKey);
  assert.equal(credentials.apiSecret, apiSecret);
  assert.equal(credentials.testnet, false);

  console.log('✅ Retrieved active Binance credentials from Prisma fixture');
}

async function testMissingCredentials() {
  await resetDatabase();
  const missing = await getUserCredentials('unknown-user', 'binance');
  assert.strictEqual(missing, null, 'Expected null when no credentials exist');
  console.log('✅ Missing credentials returns null');
}

async function testWebSocketBalancePreferred() {
  await resetDatabase();
  const { userId } = await seedUserWithApiKey({ userId: 'ws-favored-user' });

  const stub = installCcxtStub(ccxt, () => {
    throw new Error('REST should not be called when WS balance exists');
  });

  try {
    const now = Date.now();
    const wsSnapshot = new Map([
      [
        'USDT',
        {
          asset: 'USDT',
          free: 150,
          locked: 50,
          total: 200,
          timestamp: now,
        },
      ],
    ]);

    const result = await fetchBalanceWithFallback({
      userId,
      asset: 'USDT',
      websocketSnapshot: wsSnapshot,
    });

    assert.equal(result.source, 'websocket');
    assert.deepStrictEqual(result.balance, {
      asset: 'USDT',
      free: 150,
      locked: 50,
      total: 200,
    });
    assert.equal(stub.calls.length, 0, 'REST client should not have been instantiated');
    console.log('✅ WebSocket balance is preferred when data is available');
  } finally {
    stub.restore();
  }
}

async function testRestFallbackUsesUsdWhenUsdtEmpty() {
  await resetDatabase();
  const { userId } = await seedUserWithApiKey({ userId: 'rest-usd-user' });

  const stub = installCcxtStub(ccxt, () => ({
    total: { USDT: 0, USD: 320 },
    free: { USD: 120 },
    used: { USD: 200 },
  }));

  try {
    const result = await fetchBalanceWithFallback({
      userId,
      asset: 'USDT',
      websocketSnapshot: new Map(),
    });

    assert.equal(result.source, 'rest');
    assert.deepStrictEqual(result.balance, {
      asset: 'USD',
      free: 120,
      locked: 200,
      total: 320,
    });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].options.options.defaultType, 'future');
    console.log('✅ REST fallback selects USD when USDT is unavailable');
  } finally {
    stub.restore();
  }
}

async function testRestFallbackSelectsTopAsset() {
  await resetDatabase();
  const { userId } = await seedUserWithApiKey({ userId: 'rest-top-asset-user' });

  const stub = installCcxtStub(ccxt, () => ({
    total: { USDT: 0, USD: 0, BTC: 0.75, ETH: 0.25 },
    free: { BTC: 0.5, ETH: 0.1 },
    used: { BTC: 0.25, ETH: 0.15 },
  }));

  try {
    const result = await fetchBalanceWithFallback({
      userId,
      asset: 'USDT',
      websocketSnapshot: {},
    });

    assert.equal(result.source, 'rest');
    assert.deepStrictEqual(result.balance, {
      asset: 'BTC',
      free: 0.5,
      locked: 0.25,
      total: 0.75,
    });
    console.log('✅ REST fallback chooses the highest balance asset when USD/USDT are empty');
  } finally {
    stub.restore();
  }
}

async function testRestFailurePropagatesAsError() {
  await resetDatabase();
  const { userId } = await seedUserWithApiKey({ userId: 'rest-error-user' });

  const stub = installCcxtStub(ccxt, async () => {
    throw new Error('binance REST unavailable');
  });

  try {
    await assert.rejects(
      () =>
        fetchBalanceWithFallback({
          userId,
          asset: 'USDT',
          websocketSnapshot: new Map(),
        }),
      /REST balance fetch failed: binance REST unavailable/,
    );
    console.log('✅ REST failures bubble up as descriptive errors');
  } finally {
    stub.restore();
  }
}

async function testMissingCredentialsError() {
  await resetDatabase();
  await assert.rejects(
    () =>
      fetchBalanceWithFallback({
        userId: 'no-creds-user',
        asset: 'USDT',
        websocketSnapshot: new Map(),
      }),
    /Missing credentials for user no-creds-user on binance/,
  );
  console.log('✅ Missing credentials trigger explicit error');
}

async function run() {
  try {
    await testCredentialRetrieval();
    await testMissingCredentials();
    await testWebSocketBalancePreferred();
    await testRestFallbackUsesUsdWhenUsdtEmpty();
    await testRestFallbackSelectsTopAsset();
    await testRestFailurePropagatesAsError();
    await testMissingCredentialsError();
    console.log('\n🎉 All balance retrieval scenarios passed');
  } catch (error) {
    console.error('❌ Balance retrieval tests failed');
    console.error(error);
    process.exitCode = 1;
  }
}

run();
