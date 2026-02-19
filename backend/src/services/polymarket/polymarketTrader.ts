/**
 * Polymarket CLOB trading service.
 *
 * Handles:
 *  - L1 auth (EIP-712 wallet signature) to derive API credentials
 *  - L2 auth (HMAC) for authenticated CLOB requests
 *  - EIP-712 order signing (CTF Exchange on Polygon)
 *  - Market buy order creation & submission
 *  - Balance checking
 *
 * User only provides their wallet private key — the API key, secret, and
 * passphrase are derived automatically via the CLOB /auth/derive-api-key
 * endpoint.
 *
 * Uses ethers v6 + native fetch — no @polymarket/clob-client dependency.
 */

import crypto from 'crypto';
import { ethers } from 'ethers';
import type { PrismaClient } from '.prisma/client';
import { encryptApiKey, decryptApiKey } from '../../utils/crypto.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('polymarket-trader');

// ─── Constants ──────────────────────────────────────────────────────────────

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon

// CTF Exchange contract (Neg-Risk variant used by 5-min crypto markets)
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

// EIP-712 domain for L1 authentication (derive API keys)
const L1_AUTH_DOMAIN = {
  name: 'ClobAuthDomain',
  version: '1',
  chainId: CHAIN_ID,
};

const L1_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};

// EIP-712 domain for order signing
const ORDER_DOMAIN = {
  name: 'ClobExchange',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: NEG_RISK_CTF_EXCHANGE,
};

// EIP-712 types for CTF Exchange orders
const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ],
};

// Side enum
const SIDE_BUY = 0;
// Signature type: EOA (0) or POLY_PROXY (1) or POLY_GNOSIS_SAFE (2)
const SIG_TYPE_EOA = 0;
const SIG_TYPE_POLY_PROXY = 1;

// Default fee rate (Polymarket standard: 0 bps for taker)
const FEE_RATE_BPS = 0;

// USDC has 6 decimals on Polygon
const USDC_DECIMALS = 6;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize a private key: trim whitespace, ensure 0x prefix, validate hex.
 * Throws if the result is not a valid 32-byte hex key.
 */
function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  if (!key.startsWith('0x')) key = '0x' + key;
  // Must be 0x + 64 hex chars
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('Invalid private key format (expected 32-byte hex string)');
  }
  return key;
}

// ─── Settings keys ──────────────────────────────────────────────────────────

const SETTING_KEYS = {
  MODE: 'polymarket_mode',
  AMOUNT: 'polymarket_amount',
  PRIVATE_KEY: 'polymarket_private_key',
  PROXY_ADDRESS: 'polymarket_proxy_address', // proxy wallet shown in Polymarket UI (Magic.link accounts)
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

interface ClobCredentials {
  privateKey: string;
  address: string; // EOA address (wallet.address derived from private key)
  proxyAddress?: string; // Proxy wallet address (Magic.link accounts) — funds held here
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}

// ─── L1 Authentication (wallet signature → derive API creds) ────────────────

async function buildL1Headers(wallet: ethers.Wallet): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = 0;
  const addr = wallet.address; // always EOA — proxy auth not supported via CLOB L1

  const signature = await wallet.signTypedData(L1_AUTH_DOMAIN, L1_AUTH_TYPES, {
    address: addr,
    timestamp,
    nonce,
    message: 'This message attests that I control the given wallet',
  });

  return {
    POLY_ADDRESS: addr,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: '0',
  };
}

/**
 * Derive API credentials (key, secret, passphrase) from wallet private key.
 * Calls the CLOB /auth/derive-api-key endpoint with L1 auth (EIP-712).
 */
async function deriveApiCredentials(
  privateKey: string,
): Promise<{ apiKey: string; secret: string; passphrase: string; authAddress: string }> {
  const wallet = new ethers.Wallet(privateKey);
  const headers = await buildL1Headers(wallet);

  const res = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to derive API key (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.apiKey || !data.secret || !data.passphrase) {
    throw new Error('Incomplete credentials returned from Polymarket');
  }

  return { apiKey: data.apiKey, secret: data.secret, passphrase: data.passphrase, authAddress: wallet.address };
}

// ─── L2 HMAC Authentication ────────────────────────────────────────────────

function buildHmacHeaders(
  creds: ClobCredentials,
  method: string,
  path: string,
  body?: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();

  // HMAC message: timestamp + method + path (no \n separators, matches py-clob-client)
  let message = `${timestamp}${method}${path}`;
  if (body) message += body.replace(/'/g, '"');

  // Standard base64 decode of secret (handles both standard and URL-safe chars)
  const secretBytes = Buffer.from(creds.apiSecret, 'base64');
  const hmac = crypto.createHmac('sha256', secretBytes);
  hmac.update(message);
  // Standard base64 output with padding — Polymarket server requires this
  const signature = hmac.digest('base64');

  return {
    POLY_ADDRESS: creds.address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: creds.apiKey,
    POLY_PASSPHRASE: creds.apiPassphrase,
  };
}

// ─── Order Signing ──────────────────────────────────────────────────────────

function generateSalt(): string {
  // 6 bytes = 48 bits, max value 281474976710655 which is < Number.MAX_SAFE_INTEGER (2^53-1).
  // Using 16 bytes (128 bits) caused parseInt() truncation when building the JSON payload,
  // making the CLOB-received salt differ from the EIP-712-signed salt → order rejected.
  const bytes = crypto.randomBytes(6);
  return (parseInt(bytes.toString('hex'), 16) + 1).toString();
}

interface SignedOrder {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: number;
  signatureType: number;
  signature: string;
}

async function createSignedOrder(
  wallet: ethers.Wallet,
  tokenId: string,
  usdcAmount: number,
  price: number, // price per outcome token (0-1)
  proxyAddress?: string, // if set, order is placed as proxy wallet (maker=proxy, signer=EOA, signatureType=1)
): Promise<SignedOrder> {
  const salt = generateSalt();
  // For proxy wallets: maker = proxy (holds USDC), signer = EOA (signs the order)
  const maker = proxyAddress ?? wallet.address;
  const signer = wallet.address;
  const taker = '0x0000000000000000000000000000000000000000';
  const expiration = '0'; // no expiration for market orders

  // makerAmount = USDC to spend (6 decimals)
  const makerAmount = Math.floor(usdcAmount * 10 ** USDC_DECIMALS).toString();
  // takerAmount = outcome tokens to receive (6 decimals, based on price)
  const tokensReceived = usdcAmount / price;
  const takerAmount = Math.floor(tokensReceived * 10 ** USDC_DECIMALS).toString();

  const orderValues = {
    salt,
    maker,
    signer,
    taker,
    tokenId,
    makerAmount,
    takerAmount,
    expiration,
    nonce: '0',
    feeRateBps: FEE_RATE_BPS.toString(),
    side: SIDE_BUY,
    // POLY_PROXY (1) when funds are in a proxy wallet (Magic.link accounts), EOA (0) otherwise
    signatureType: proxyAddress ? SIG_TYPE_POLY_PROXY : SIG_TYPE_EOA,
  };

  // Sign with EIP-712
  const signature = await wallet.signTypedData(ORDER_DOMAIN, ORDER_TYPES, orderValues);

  return { ...orderValues, signature };
}

// ─── CLOB API Calls ─────────────────────────────────────────────────────────

async function clobGet(
  path: string,
  creds: ClobCredentials,
): Promise<any> {
  // HMAC is computed on the base path WITHOUT query params (Polymarket server strips query params before verification)
  const hmacPath = path.split('?')[0];
  const headers = buildHmacHeaders(creds, 'GET', hmacPath);
  const res = await fetch(`${CLOB_HOST}${path}`, {
    method: 'GET',
    headers: { ...headers, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CLOB GET ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function clobPost(
  path: string,
  body: any,
  creds: ClobCredentials,
): Promise<any> {
  const bodyStr = JSON.stringify(body);
  const headers = buildHmacHeaders(creds, 'POST', path, bodyStr);
  const res = await fetch(`${CLOB_HOST}${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: bodyStr,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CLOB POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
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
  rawProxyAddress?: string, // optional: proxy wallet shown in Polymarket UI (Magic.link)
): Promise<{ address: string }> {
  // Normalize & validate private key
  const privateKey = normalizePrivateKey(rawPrivateKey);
  const wallet = new ethers.Wallet(privateKey);

  // Validate proxy address format if provided
  let proxyAddress: string | undefined;
  if (rawProxyAddress?.trim()) {
    const p = rawProxyAddress.trim();
    if (!ethers.isAddress(p)) throw new Error('Invalid proxy address format');
    proxyAddress = ethers.getAddress(p); // checksum
  }

  // Derive API creds from Polymarket CLOB (always uses EOA address)
  log.info(`Deriving API credentials for EOA: ${wallet.address}...`);
  const { apiKey, secret, passphrase, authAddress } = await deriveApiCredentials(privateKey);
  log.info(`API credentials derived successfully for ${authAddress}`);

  // Encrypt all 4 values (compute once so we can verify round-trip)
  const encryptedPk = encryptApiKey(privateKey);
  const encryptedApiKey = encryptApiKey(apiKey);
  const encryptedSecret = encryptApiKey(secret);
  const encryptedPassphrase = encryptApiKey(passphrase);

  // Verify encryption round-trip before storing
  const roundTrip = decryptApiKey(encryptedPk);
  if (roundTrip !== privateKey) {
    log.error(`Encryption round-trip FAILED: input length=${privateKey.length}, output length=${roundTrip.length}`);
    throw new Error('Encryption round-trip verification failed — check ENCRYPTION_SALT config');
  }

  // Store all values (proxy address stored in plain — it's a public address)
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

  // Store proxy address if provided (Magic.link accounts)
  if (proxyAddress) {
    upserts.push(
      prisma.systemSetting.upsert({
        where: { key: SETTING_KEYS.PROXY_ADDRESS },
        create: { key: SETTING_KEYS.PROXY_ADDRESS, value: proxyAddress },
        update: { value: proxyAddress },
      }),
    );
  } else {
    // Clean up any stale proxy address
    upserts.push(prisma.systemSetting.deleteMany({ where: { key: SETTING_KEYS.PROXY_ADDRESS } }));
  }

  await Promise.all(upserts);

  return { address: authAddress };
}

/**
 * Delete all Polymarket credentials and reset mode to virtual.
 */
export async function deletePolymarketCredentials(
  prisma: PrismaClient,
): Promise<void> {
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
  // Reset to virtual mode
  await prisma.systemSetting.upsert({
    where: { key: SETTING_KEYS.MODE },
    create: { key: SETTING_KEYS.MODE, value: 'virtual' },
    update: { value: 'virtual' },
  });
}

/**
 * Load decrypted credentials from DB. Returns null if not configured.
 */
async function loadCredentials(
  prisma: PrismaClient,
): Promise<ClobCredentials | null> {
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
    const decryptedPk = decryptApiKey(encPk);
    const pk = normalizePrivateKey(decryptedPk);

    const wallet = new ethers.Wallet(pk);
    const authAddress = wallet.address; // always EOA
    const proxyAddress = map.get(SETTING_KEYS.PROXY_ADDRESS) || undefined;
    log.debug(`Credentials loaded OK — address=${authAddress}${proxyAddress ? ` proxy=${proxyAddress}` : ''}`);

    return {
      privateKey: pk,
      address: authAddress,
      proxyAddress,
      apiKey: decryptApiKey(encKey).trim(),
      apiSecret: decryptApiKey(encSecret).trim(),
      apiPassphrase: decryptApiKey(encPass).trim(),
    };
  } catch (err) {
    log.error(`Failed to load Polymarket credentials: ${err}`);
    return null;
  }
}

/**
 * Validate Polymarket credentials by calling a lightweight authenticated endpoint.
 */
export async function validatePolymarketCredentials(
  prisma: PrismaClient,
): Promise<{ valid: boolean; address?: string; error?: string }> {
  const creds = await loadCredentials(prisma);
  if (!creds) return { valid: false, error: 'No credentials configured' };

  try {
    // Test API auth by fetching orders (empty for new accounts but auth must pass)
    await clobGet('/data/orders', creds);

    return { valid: true, address: creds.address };
  } catch (err: any) {
    return { valid: false, error: err.message || 'Validation failed' };
  }
}

/**
 * Get USDC balance from Polymarket.
 */
export async function getPolymarketBalance(
  prisma: PrismaClient,
): Promise<{ balance: number; error?: string }> {
  const creds = await loadCredentials(prisma);
  if (!creds) return { balance: 0, error: 'No credentials configured' };

  try {
    // asset_type=COLLATERAL, signature_type=1 (proxy wallet — maps EOA to its linked proxy account)
    const data = await clobGet('/balance-allowance?asset_type=COLLATERAL&signature_type=1', creds);
    const balance = parseFloat(data?.balance ?? '0') / 10 ** USDC_DECIMALS;
    return { balance };
  } catch (err: any) {
    return { balance: 0, error: err.message || 'Failed to fetch balance' };
  }
}

/**
 * Place a market buy order on Polymarket.
 *
 * @param direction - "UP" or "DOWN"
 * @param tokenId - The CLOB token ID for the chosen outcome
 * @param amount - USDC amount to wager
 * @param price - Current price of the outcome token (0-1)
 */
export async function placePolymarketBet(
  prisma: PrismaClient,
  direction: 'UP' | 'DOWN',
  tokenId: string,
  amount: number,
  price: number,
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  const creds = await loadCredentials(prisma);
  if (!creds) return { success: false, error: 'No credentials' };

  try {
    // Wallet needed for EIP-712 order signing — already validated in loadCredentials
    const signingWallet = new ethers.Wallet(creds.privateKey);
    // Pass proxy address so maker=proxy, signer=EOA, signatureType=1 (funds are in proxy for Magic.link accounts)
    const signedOrder = await createSignedOrder(signingWallet, tokenId, amount, price, creds.proxyAddress);

    const orderPayload = {
      order: {
        salt: parseInt(signedOrder.salt),
        maker: signedOrder.maker,
        signer: signedOrder.signer,
        taker: signedOrder.taker,
        tokenId: signedOrder.tokenId,
        makerAmount: signedOrder.makerAmount,
        takerAmount: signedOrder.takerAmount,
        expiration: signedOrder.expiration,
        nonce: signedOrder.nonce,
        feeRateBps: signedOrder.feeRateBps,
        side: signedOrder.side,
        signatureType: signedOrder.signatureType,
        signature: signedOrder.signature,
      },
      // owner should be the account that holds the funds (proxy if available)
      owner: creds.proxyAddress ?? creds.address,
      orderType: 'FOK', // Fill-or-Kill for market orders
    };

    const result = await clobPost('/order', orderPayload, creds);

    log.info(
      `Live bet placed: ${direction} $${amount} @ ${price.toFixed(3)} | orderId=${result?.orderID ?? 'unknown'}`,
    );

    return { success: true, orderId: result?.orderID };
  } catch (err: any) {
    log.error(`Failed to place bet: ${err.message}`);
    return { success: false, error: err.message };
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
