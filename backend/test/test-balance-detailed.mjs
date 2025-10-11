import assert from 'node:assert/strict';
import {
  ccxt,
  fetchBalanceWithFallback,
  installCcxtStub,
  resetDatabase,
  seedUserWithApiKey,
} from './helpers/balanceTestUtils.mjs';

async function runDetailedBalanceScenarios() {
  await resetDatabase();
  const { userId } = await seedUserWithApiKey({ userId: 'detailed-user' });

  // Futures account should fallback to the most funded asset when stablecoins are empty
  const futuresStub = installCcxtStub(ccxt, () => ({
    total: { USDT: 0, USD: 0, BTC: 0.42, ETH: 1.1 },
    free: { BTC: 0.2, ETH: 0.9 },
    used: { BTC: 0.22, ETH: 0.2 },
  }));

  try {
    const futuresResult = await fetchBalanceWithFallback({
      userId,
      asset: 'USDT',
      websocketSnapshot: new Map(),
      marketType: 'future',
    });

    assert.equal(futuresResult.source, 'rest');
    assert.equal(futuresResult.balance.asset, 'ETH');
    assert.equal(futuresResult.balance.total, 1.1);
    assert.equal(futuresStub.calls[0].options.options.defaultType, 'future');
    console.log('✅ Futures account selects the highest funded asset when no stablecoins are available');
  } finally {
    futuresStub.restore();
  }

  // Portfolio margin account should pick USD fallback when present
  const marginStub = installCcxtStub(ccxt, () => ({
    total: { USDT: 0, USD: 580 },
    free: { USD: 180 },
    used: { USD: 400 },
  }));

  try {
    const marginResult = await fetchBalanceWithFallback({
      userId,
      asset: 'USDT',
      websocketSnapshot: {},
      marketType: 'margin',
    });

    assert.equal(marginResult.source, 'rest');
    assert.deepStrictEqual(marginResult.balance, {
      asset: 'USD',
      free: 180,
      locked: 400,
      total: 580,
    });
    assert.equal(marginStub.calls[0].options.options.defaultType, 'margin');
    console.log('✅ Portfolio margin account returns USD balances when USDT is empty');
  } finally {
    marginStub.restore();
  }

  // Spot account should gracefully handle empty balances
  const spotStub = installCcxtStub(ccxt, () => ({ total: {}, free: {}, used: {} }));

  try {
    const spotResult = await fetchBalanceWithFallback({
      userId,
      asset: 'USDT',
      websocketSnapshot: new Map(),
      marketType: 'spot',
    });

    assert.equal(spotResult.source, 'rest');
    assert.deepStrictEqual(spotResult.balance, {
      asset: 'USDT',
      free: 0,
      locked: 0,
      total: 0,
    });
    assert.equal(spotStub.calls[0].options.options.defaultType, 'spot');
    console.log('✅ Spot account gracefully reports empty balances');
  } finally {
    spotStub.restore();
  }
}

async function run() {
  try {
    await runDetailedBalanceScenarios();
    console.log('\n🎯 Detailed balance scenarios succeeded');
  } catch (error) {
    console.error('❌ Detailed balance scenarios failed');
    console.error(error);
    process.exitCode = 1;
  }
}

run();
