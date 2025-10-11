import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.APP_API_KEY = process.env.APP_API_KEY || 'test-app-key';

const { encryptApiKey } = await import('../../dist/src/utils/crypto.js');
const { prisma, prismaIsInMemory } = await import('../../dist/src/db/client.js');
const { getUserCredentials } = await import('../../dist/src/services/userCredentials.js');
const ccxtModule = await import('ccxt');
const ccxt = ccxtModule.default || ccxtModule;

if (!prismaIsInMemory) {
  console.warn('⚠️ Expected in-memory Prisma client for tests, but received persistent client. Tests may be slow.');
}

export { prisma, encryptApiKey, getUserCredentials, ccxt };

export async function resetDatabase() {
  if (typeof prisma.$reset === 'function') {
    await prisma.$reset();
    return;
  }
  if (typeof prisma.$disconnect === 'function') {
    await prisma.$disconnect();
  }
}

export async function seedUserWithApiKey({
  userId = 'test-user',
  exchange = 'binance',
  apiKey = 'api-key',
  apiSecret = 'api-secret',
  passphrase,
  testnet = false,
  isActive = true,
  updatedAt = new Date(),
} = {}) {
  const userEmail = `${userId}@example.test`;
  const passwordHash = 'hashed-password';

  await prisma.user.create({
    data: {
      id: userId,
      username: `${userId}-name`,
      email: userEmail,
      passwordHash,
    },
  });

  await prisma.userApiKey.create({
    data: {
      id: `${userId}-${exchange}-key`,
      userId,
      exchange,
      apiKey: encryptApiKey(apiKey),
      apiSecret: encryptApiKey(apiSecret),
      passphrase: passphrase ? encryptApiKey(passphrase) : null,
      testnet,
      isActive,
      updatedAt,
    },
  });

  return { userId, exchange, apiKey, apiSecret };
}

export function installCcxtStub(moduleRef = ccxt, responseFactory) {
  const original = moduleRef.binance;
  const calls = [];
  class StubBinance {
    constructor(options) {
      calls.push({ options });
      this.options = options;
    }
    async fetchBalance() {
      if (typeof responseFactory === 'function') {
        return await responseFactory();
      }
      return responseFactory;
    }
  }
  moduleRef.binance = StubBinance;
  return {
    calls,
    restore() {
      moduleRef.binance = original;
    },
  };
}

function readSnapshotEntry(snapshot, asset) {
  if (!snapshot) return null;
  if (snapshot instanceof Map) {
    return snapshot.get(asset) ?? null;
  }
  if (typeof snapshot === 'object') {
    return snapshot[asset] ?? null;
  }
  return null;
}

function normalizeWsBalance(asset, payload) {
  const free = Number(payload.free ?? 0);
  const locked = Number(payload.locked ?? 0);
  const total = Number(payload.total ?? free + locked);
  return { asset, free, locked, total };
}

function extractRestBalance(balance, asset) {
  const total = Number(balance?.total?.[asset] ?? 0);
  const free = Number(balance?.free?.[asset] ?? 0);
  const locked = Number(balance?.used?.[asset] ?? 0);
  return { asset, free, locked, total };
}

function selectBestRestAsset(balance, preferredAsset) {
  const primary = extractRestBalance(balance, preferredAsset);
  if (primary.total > 0) {
    return primary;
  }

  const usd = extractRestBalance(balance, 'USD');
  if (usd.total > 0) {
    return usd;
  }

  const entries = Object.entries(balance?.total ?? {})
    .filter(([, value]) => Number(value) > 0)
    .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0));

  if (entries.length > 0) {
    const [asset] = entries[0];
    return extractRestBalance(balance, asset);
  }

  return { asset: preferredAsset, free: 0, locked: 0, total: 0 };
}

export async function fetchBalanceWithFallback({
  userId,
  asset = 'USDT',
  websocketSnapshot,
  ccxtModule = ccxt,
  marketType = 'future',
  restBalanceOverride,
} = {}) {
  assert(userId, 'userId is required');
  const credentials = await getUserCredentials(userId, 'binance');
  if (!credentials) {
    throw new Error(`Missing credentials for user ${userId} on binance`);
  }

  const normalizedAsset = String(asset || 'USDT').toUpperCase();
  const wsEntry = readSnapshotEntry(websocketSnapshot, normalizedAsset);
  if (wsEntry && Number(wsEntry.total ?? 0) > 0) {
    return {
      source: 'websocket',
      balance: normalizeWsBalance(normalizedAsset, wsEntry),
    };
  }

  let exchange;
  try {
    exchange = new ccxtModule.binance({
      apiKey: credentials.apiKey,
      secret: credentials.apiSecret,
      enableRateLimit: true,
      options: { defaultType: marketType },
    });
  } catch (error) {
    throw new Error(`Failed to initialize ccxt client: ${error?.message || error}`);
  }

  let restBalance;
  try {
    restBalance = restBalanceOverride ?? (await exchange.fetchBalance());
  } catch (error) {
    throw new Error(`REST balance fetch failed: ${error?.message || error}`);
  }

  return {
    source: 'rest',
    balance: selectBestRestAsset(restBalance, normalizedAsset),
  };
}
