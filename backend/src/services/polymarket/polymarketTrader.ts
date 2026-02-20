/**
 * Polymarket CLOB trading service.
 *
 * Uses the official @polymarket/clob-client package for all auth, signing, and order placement.
 * The wallet private key is stored encrypted in DB; API credentials are derived automatically
 * and cached in memory.
 *
 * Proxy wallet (Magic.link): if a proxyAddress is configured, signatureType=POLY_PROXY and
 * funderAddress=proxyAddress are passed to ClobClient so all requests use the proxy account.
 */

import { ethers as ethers6 } from 'ethers'; // v6, used only for address validation
import { Wallet } from 'ethers5'; // v5 alias, required by @polymarket/clob-client
import {
  ClobClient,
  type ApiKeyCreds,
  type UserMarketOrder,
  AssetType,
  Side,
  OrderType,
} from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import type { PrismaClient } from '.prisma/client';
import { encryptApiKey, decryptApiKey } from '../../utils/crypto.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('polymarket-trader');

// ─── Constants ──────────────────────────────────────────────────────────────

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon

// USDC has 6 decimals on Polygon
const USDC_DECIMALS = 6;

// Maximum acceptable CLOB price (absolute cap).
// Buying above this has poor EV: paying 85¢ for $1 potential = 17.6% ROI max.
// Below this threshold, EV is reasonable for 5-min up/down markets.
const MAX_CLOB_PRICE = 0.85;

// Maximum divergence allowed between CLOB and Gamma prices.
// If CLOB is more than 50% above Gamma, something is likely wrong (stale Gamma, wrong market).
const MAX_GAMMA_DIVERGENCE_PCT = 0.50;

// ─── Settings keys ──────────────────────────────────────────────────────────

const SETTING_KEYS = {
  MODE: 'polymarket_mode',
  AMOUNT: 'polymarket_amount',
  PRIVATE_KEY: 'polymarket_private_key',
  PROXY_ADDRESS: 'polymarket_proxy_address', // proxy wallet shown in Polymarket UI (Magic.link)
  API_KEY: 'polymarket_api_key',
  API_SECRET: 'polymarket_api_secret',
  API_PASSPHRASE: 'polymarket_api_passphrase',
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PolymarketConfig {
  mode: 'virtual' | 'live';
  amount: number; // USDC per trade
  hasCredentials: boolean;
}

interface StoredCreds {
  privateKey: string;
  address: string; // EOA address derived from private key
  proxyAddress?: string; // Magic.link proxy wallet (holds USDC)
  apiCreds: ApiKeyCreds; // { key, secret, passphrase } for L2 HMAC auth
}

// ─── In-memory credential cache ──────────────────────────────────────────────

let _credCache: StoredCreds | null = null;

function clearCredCache(): void {
  _credCache = null;
}

// ─── In-memory balance cache ──────────────────────────────────────────────────
// Guard against cluster nodes that silently return $0 instead of proxy balance.

let _lastGoodBalance: number | null = null;
let _lastGoodBalanceAt = 0;
const BALANCE_CACHE_TTL_MS = 60_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  if (!key.startsWith('0x')) key = '0x' + key;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('Invalid private key format (expected 32-byte hex string)');
  }
  return key;
}

/**
 * Build a ClobClient instance for the given credentials.
 * The client handles L1 (EIP-712) and L2 (HMAC) auth internally.
 */
function buildClient(creds: StoredCreds, withApiKey = true): ClobClient {
  const wallet = new Wallet(creds.privateKey);
  const signatureType = creds.proxyAddress ? SignatureType.POLY_PROXY : SignatureType.EOA;
  return new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    wallet,
    withApiKey ? creds.apiCreds : undefined,
    signatureType,
    creds.proxyAddress,
  );
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Read polymarket trading config from SystemSetting.
 */
export async function getPolymarketConfig(
  prisma: PrismaClient,
): Promise<PolymarketConfig> {
  const settings = await prisma.systemSetting.findMany({
    where: { key: { in: [SETTING_KEYS.MODE, SETTING_KEYS.AMOUNT, SETTING_KEYS.API_KEY] } },
  });
  const map = new Map(settings.map((s) => [s.key, s.value]));
  return {
    mode: (map.get(SETTING_KEYS.MODE) as 'virtual' | 'live') || 'virtual',
    amount: parseFloat(map.get(SETTING_KEYS.AMOUNT) || '5'),
    hasCredentials: !!map.get(SETTING_KEYS.API_KEY),
  };
}

/**
 * Save polymarket trading config (mode + amount).
 */
export async function savePolymarketConfig(
  prisma: PrismaClient,
  mode: 'virtual' | 'live',
  amount: number,
): Promise<void> {
  await Promise.all([
    prisma.systemSetting.upsert({
      where: { key: SETTING_KEYS.MODE },
      create: { key: SETTING_KEYS.MODE, value: mode },
      update: { value: mode },
    }),
    prisma.systemSetting.upsert({
      where: { key: SETTING_KEYS.AMOUNT },
      create: { key: SETTING_KEYS.AMOUNT, value: amount.toString() },
      update: { value: amount.toString() },
    }),
  ]);
}

/**
 * Save private key and auto-derive API credentials from the CLOB API.
 * The user only provides the wallet private key — everything else is derived.
 */
export async function savePolymarketCredentials(
  prisma: PrismaClient,
  rawPrivateKey: string,
  rawProxyAddress?: string,
): Promise<{ address: string }> {
  const privateKey = normalizePrivateKey(rawPrivateKey);
  const wallet6 = new ethers6.Wallet(privateKey);

  // Validate proxy address format if provided
  let proxyAddress: string | undefined;
  if (rawProxyAddress?.trim()) {
    const p = rawProxyAddress.trim();
    if (!ethers6.isAddress(p)) throw new Error('Invalid proxy address format');
    proxyAddress = ethers6.getAddress(p); // checksum
  }

  // Derive API credentials via ClobClient (handles L1 EIP-712 auth internally)
  log.info(`Deriving API credentials for EOA: ${wallet6.address}...`);
  const signatureType = proxyAddress ? SignatureType.POLY_PROXY : SignatureType.EOA;
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, new Wallet(privateKey), undefined, signatureType, proxyAddress);
  const apiCreds = await tempClient.createOrDeriveApiKey();
  log.info(`API credentials derived successfully for ${wallet6.address}`);

  // Wait for key propagation across Polymarket's cluster (~3s)
  await new Promise((r) => setTimeout(r, 3500));

  // Encrypt sensitive values before storing
  const encryptedPk = encryptApiKey(privateKey);
  const encryptedApiKey = encryptApiKey(apiCreds.key);
  const encryptedSecret = encryptApiKey(apiCreds.secret);
  const encryptedPassphrase = encryptApiKey(apiCreds.passphrase);

  // Verify encryption round-trip
  const roundTrip = decryptApiKey(encryptedPk);
  if (roundTrip !== privateKey) {
    throw new Error('Encryption round-trip verification failed — check ENCRYPTION_SALT config');
  }

  const upserts: Promise<any>[] = [
    prisma.systemSetting.upsert({
      where: { key: SETTING_KEYS.PRIVATE_KEY },
      create: { key: SETTING_KEYS.PRIVATE_KEY, value: encryptedPk },
      update: { value: encryptedPk },
    }),
    prisma.systemSetting.upsert({
      where: { key: SETTING_KEYS.API_KEY },
      create: { key: SETTING_KEYS.API_KEY, value: encryptedApiKey },
      update: { value: encryptedApiKey },
    }),
    prisma.systemSetting.upsert({
      where: { key: SETTING_KEYS.API_SECRET },
      create: { key: SETTING_KEYS.API_SECRET, value: encryptedSecret },
      update: { value: encryptedSecret },
    }),
    prisma.systemSetting.upsert({
      where: { key: SETTING_KEYS.API_PASSPHRASE },
      create: { key: SETTING_KEYS.API_PASSPHRASE, value: encryptedPassphrase },
      update: { value: encryptedPassphrase },
    }),
  ];

  if (proxyAddress) {
    upserts.push(
      prisma.systemSetting.upsert({
        where: { key: SETTING_KEYS.PROXY_ADDRESS },
        create: { key: SETTING_KEYS.PROXY_ADDRESS, value: proxyAddress },
        update: { value: proxyAddress },
      }),
    );
  } else {
    upserts.push(prisma.systemSetting.deleteMany({ where: { key: SETTING_KEYS.PROXY_ADDRESS } }));
  }

  await Promise.all(upserts);

  clearCredCache();
  _lastGoodBalance = null;

  return { address: wallet6.address };
}

/**
 * Delete all Polymarket credentials and reset mode to virtual.
 */
export async function deletePolymarketCredentials(prisma: PrismaClient): Promise<void> {
  await prisma.systemSetting.deleteMany({
    where: {
      key: {
        in: [
          SETTING_KEYS.PRIVATE_KEY,
          SETTING_KEYS.PROXY_ADDRESS,
          SETTING_KEYS.API_KEY,
          SETTING_KEYS.API_SECRET,
          SETTING_KEYS.API_PASSPHRASE,
        ],
      },
    },
  });
  await prisma.systemSetting.upsert({
    where: { key: SETTING_KEYS.MODE },
    create: { key: SETTING_KEYS.MODE, value: 'virtual' },
    update: { value: 'virtual' },
  });
  clearCredCache();
  _lastGoodBalance = null;
}

/**
 * Load decrypted credentials from DB (with in-memory cache).
 */
async function loadCredentials(prisma: PrismaClient): Promise<StoredCreds | null> {
  if (_credCache) return _credCache;

  const settings = await prisma.systemSetting.findMany({
    where: {
      key: {
        in: [
          SETTING_KEYS.PRIVATE_KEY,
          SETTING_KEYS.PROXY_ADDRESS,
          SETTING_KEYS.API_KEY,
          SETTING_KEYS.API_SECRET,
          SETTING_KEYS.API_PASSPHRASE,
        ],
      },
    },
  });

  const map = new Map(settings.map((s) => [s.key, s.value]));
  const encPk = map.get(SETTING_KEYS.PRIVATE_KEY);
  const encKey = map.get(SETTING_KEYS.API_KEY);
  const encSecret = map.get(SETTING_KEYS.API_SECRET);
  const encPass = map.get(SETTING_KEYS.API_PASSPHRASE);

  if (!encPk || !encKey || !encSecret || !encPass) return null;

  try {
    const privateKey = normalizePrivateKey(decryptApiKey(encPk));
    const wallet = new ethers6.Wallet(privateKey);
    const proxyAddress = map.get(SETTING_KEYS.PROXY_ADDRESS) || undefined;

    log.debug(`Credentials loaded — address=${wallet.address}${proxyAddress ? ` proxy=${proxyAddress}` : ''}`);

    _credCache = {
      privateKey,
      address: wallet.address,
      proxyAddress,
      apiCreds: {
        key: decryptApiKey(encKey).trim(),
        secret: decryptApiKey(encSecret).trim(),
        passphrase: decryptApiKey(encPass).trim(),
      },
    };
    return _credCache;
  } catch (err) {
    log.error(`Failed to load Polymarket credentials: ${err}`);
    return null;
  }
}

/**
 * Validate credentials by calling a lightweight authenticated endpoint.
 * Retries up to 3x with 2s backoff for Polymarket's eventual consistency.
 */
export async function validatePolymarketCredentials(
  prisma: PrismaClient,
): Promise<{ valid: boolean; address?: string; error?: string }> {
  const creds = await loadCredentials(prisma);
  if (!creds) return { valid: false, error: 'No credentials configured' };

  const client = buildClient(creds);
  let lastError = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      if ((result as any)?.error) throw new Error(String((result as any).error));
      return { valid: true, address: creds.proxyAddress ?? creds.address };
    } catch (err: any) {
      lastError = err?.message ?? 'Validation failed';
      if (attempt < 3) {
        log.warn(`Credential validation attempt ${attempt}/3 failed — retrying in 2s (${lastError})`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  return { valid: false, error: lastError };
}

/**
 * Get USDC balance from Polymarket.
 * The client automatically uses the correct signature_type for proxy wallets.
 * Falls back to in-memory cache if the cluster returns $0 (eventual consistency).
 */
export async function getPolymarketBalance(
  prisma: PrismaClient,
): Promise<{ balance: number; cached?: boolean; error?: string }> {
  const creds = await loadCredentials(prisma);
  if (!creds) return { balance: 0, error: 'No credentials configured' };

  const client = buildClient(creds);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      if ((data as any)?.error) throw new Error(String((data as any).error));
      const balance = parseFloat(data?.balance ?? '0') / 10 ** USDC_DECIMALS;

      // If we get $0 but have a proxy configured AND previously had a non-zero balance,
      // the cluster node may have silently ignored signature_type=1 — retry
      if (balance === 0 && creds.proxyAddress && _lastGoodBalance !== null && _lastGoodBalance > 0 && attempt < 3) {
        log.warn(`Balance returned $0 with proxy configured (attempt ${attempt}/3) — retrying`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }

      if (balance > 0 || !creds.proxyAddress) {
        _lastGoodBalance = balance;
        _lastGoodBalanceAt = Date.now();
      }
      return { balance };
    } catch (err: any) {
      log.warn(`Balance fetch failed (attempt ${attempt}/3): ${err?.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // All attempts failed — return cached balance if recent enough
  if (_lastGoodBalance !== null && Date.now() - _lastGoodBalanceAt < BALANCE_CACHE_TTL_MS) {
    log.warn(`Returning cached balance $${_lastGoodBalance.toFixed(2)} (API temporarily inconsistent)`);
    return { balance: _lastGoodBalance, cached: true };
  }

  return { balance: 0, error: 'Failed to fetch balance (cluster inconsistency)' };
}

/**
 * Place a market buy order on Polymarket.
 * The official client handles EIP-712 order signing, HMAC auth, and salt generation.
 */
export async function placePolymarketBet(
  prisma: PrismaClient,
  direction: 'UP' | 'DOWN',
  tokenId: string,
  amount: number,
  price: number,
): Promise<{ success: boolean; orderId?: string; executionPrice?: number; error?: string }> {
  const creds = await loadCredentials(prisma);
  if (!creds) return { success: false, error: 'No credentials' };

  try {
    const client = buildClient(creds);

    // Price validation: use CLOB as the real price (Gamma API can be stale).
    const clobPriceData = await client.getPrice(tokenId, 'BUY');
    const clobAsk = parseFloat((clobPriceData as any)?.price ?? '0');

    if (clobAsk === 0) {
      return { success: false, error: 'CLOB price unavailable — skipping bet' };
    }

    // 1. Absolute EV cap: don't buy above MAX_CLOB_PRICE (poor risk/reward)
    if (clobAsk > MAX_CLOB_PRICE) {
      log.warn(`EV too low: CLOB ask=${clobAsk.toFixed(3)} > cap=${MAX_CLOB_PRICE} — skipping`);
      return { success: false, error: `EV too low (CLOB=${clobAsk.toFixed(3)} > cap=${MAX_CLOB_PRICE})` };
    }

    // 2. Gamma divergence warning: log if CLOB diverges significantly from Gamma (informational)
    const divergence = (clobAsk - price) / price;
    if (divergence > MAX_GAMMA_DIVERGENCE_PCT) {
      log.warn(`Gamma divergence: CLOB=${clobAsk.toFixed(3)} vs Gamma=${price.toFixed(3)} (${(divergence * 100).toFixed(0)}% above) — proceeding with CLOB price`);
    }

    log.info(`Price OK: CLOB ask=${clobAsk.toFixed(3)}, Gamma=${price.toFixed(3)}, cap=${MAX_CLOB_PRICE}`);

    // Pass the CLOB ask price as a limit so FOK fills at that price.
    const order: UserMarketOrder = {
      tokenID: tokenId,
      amount, // USDC amount to spend
      price: clobAsk,
      side: Side.BUY,
    };

    const result = await client.createAndPostMarketOrder(order, undefined, OrderType.FOK);

    // The clob-client does NOT throw on HTTP errors — it returns { error: "...", status: 4xx }.
    // Must check explicitly before treating as success.
    if (result?.error) {
      const errMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
      throw new Error(`Order rejected (${result.status ?? '?'}): ${errMsg}`);
    }

    const orderId = result?.orderID ?? result?.id ?? 'unknown';
    log.info(`Live bet placed: ${direction} $${amount} @ CLOB ${clobAsk.toFixed(3)} (Gamma ${price.toFixed(3)}) | orderId=${orderId}`);
    return { success: true, orderId, executionPrice: clobAsk };
  } catch (err: any) {
    log.error(`Failed to place bet: ${err?.message}`);
    return { success: false, error: err?.message };
  }
}

/**
 * Sell winning tokens on the CLOB to convert back to USDC.
 * Called after oracle confirms a WIN. Sells at market price (best bid).
 * Returns the USDC amount received, or null if sell failed.
 */
export async function sellWinningTokens(
  prisma: PrismaClient,
  tokenId: string,
  betAmount: number,
  executionPrice: number,
): Promise<{ success: boolean; usdcReceived?: number; error?: string }> {
  const creds = await loadCredentials(prisma);
  if (!creds) return { success: false, error: 'No credentials' };

  try {
    const client = buildClient(creds);

    // Check current bid price — only sell if price is good (>= 0.90)
    const clobPriceData = await client.getPrice(tokenId, 'SELL');
    const clobBid = parseFloat((clobPriceData as any)?.price ?? '0');

    if (clobBid < 0.90) {
      return { success: false, error: `Bid too low (${clobBid.toFixed(3)}) — wait for resolution or higher price` };
    }

    // Calculate token amount we hold: betAmount / executionPrice
    const tokenAmount = betAmount / executionPrice;
    const expectedUsdc = tokenAmount * clobBid;

    const order: UserMarketOrder = {
      tokenID: tokenId,
      amount: expectedUsdc, // USDC amount to receive
      price: clobBid,
      side: Side.SELL,
    };

    const result = await client.createAndPostMarketOrder(order, undefined, OrderType.FOK);

    if (result?.error) {
      const errMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
      throw new Error(`Sell rejected (${result.status ?? '?'}): ${errMsg}`);
    }

    log.info(`Auto-sell OK: ${tokenAmount.toFixed(2)} tokens @ ${clobBid.toFixed(3)} = $${expectedUsdc.toFixed(2)} USDC`);
    return { success: true, usdcReceived: expectedUsdc };
  } catch (err: any) {
    log.error(`Auto-sell failed: ${err?.message}`);
    return { success: false, error: err?.message };
  }
}

/**
 * Check if live mode is active and return config for the worker.
 */
export async function getLiveTradingConfig(
  prisma: PrismaClient,
): Promise<{ live: boolean; amount: number } | null> {
  const config = await getPolymarketConfig(prisma);
  if (config.mode !== 'live' || !config.hasCredentials) return null;
  return { live: true, amount: config.amount };
}
