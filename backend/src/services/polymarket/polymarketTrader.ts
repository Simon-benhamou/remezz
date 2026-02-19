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

// Default fee rate (Polymarket standard: 0 bps for taker)
const FEE_RATE_BPS = 0;

// USDC has 6 decimals on Polygon
const USDC_DECIMALS = 6;

// ─── Settings keys ──────────────────────────────────────────────────────────

const SETTING_KEYS = {
  MODE: 'polymarket_mode',
  AMOUNT: 'polymarket_amount',
  PRIVATE_KEY: 'polymarket_private_key',
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
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}

// ─── L1 Authentication (wallet signature → derive API creds) ────────────────

async function buildL1Headers(
  wallet: ethers.Wallet,
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = '0';

  const signature = await wallet.signTypedData(L1_AUTH_DOMAIN, L1_AUTH_TYPES, {
    address: wallet.address,
    timestamp,
    nonce,
    message: 'This message attests that I control the given wallet',
  });

  return {
    'POLY-ADDRESS': wallet.address,
    'POLY-SIGNATURE': signature,
    'POLY-TIMESTAMP': timestamp,
    'POLY-NONCE': nonce,
  };
}

/**
 * Derive API credentials (key, secret, passphrase) from wallet private key.
 * This calls the CLOB /auth/derive-api-key endpoint with L1 auth.
 */
async function deriveApiCredentials(
  privateKey: string,
): Promise<{ apiKey: string; secret: string; passphrase: string }> {
  const wallet = new ethers.Wallet(privateKey);
  const headers = await buildL1Headers(wallet);

  const res = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
    method: 'GET',
    headers: { ...headers, 'Content-Type': 'application/json' },
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

  return { apiKey: data.apiKey, secret: data.secret, passphrase: data.passphrase };
}

// ─── L2 HMAC Authentication ────────────────────────────────────────────────

function buildHmacHeaders(
  creds: ClobCredentials,
  method: string,
  path: string,
  body?: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();

  // Message: timestamp + \n + method + \n + path + optional body
  let message = `${timestamp}\n${method.toUpperCase()}\n${path}`;
  if (body) message += `\n${body}`;

  const secretBytes = Buffer.from(creds.apiSecret, 'base64');
  const hmac = crypto.createHmac('sha256', secretBytes);
  hmac.update(message);
  const signature = hmac.digest('base64');

  const wallet = new ethers.Wallet(creds.privateKey);

  return {
    'POLY-ADDRESS': wallet.address,
    'POLY-SIGNATURE': signature,
    'POLY-TIMESTAMP': timestamp,
    'POLY-NONCE': nonce,
    'POLY-API-KEY': creds.apiKey,
    'POLY-PASSPHRASE': creds.apiPassphrase,
  };
}

// ─── Order Signing ──────────────────────────────────────────────────────────

function generateSalt(): string {
  const bytes = crypto.randomBytes(16);
  return BigInt('0x' + bytes.toString('hex')).toString();
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
): Promise<SignedOrder> {
  const salt = generateSalt();
  const maker = wallet.address;
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
    signatureType: SIG_TYPE_EOA,
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
  const headers = buildHmacHeaders(creds, 'GET', path);
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
  privateKey: string,
): Promise<{ address: string }> {
  // Validate private key
  const wallet = new ethers.Wallet(privateKey);

  // Derive API creds from Polymarket CLOB
  log.info(`Deriving API credentials for address ${wallet.address}...`);
  const { apiKey, secret, passphrase } = await deriveApiCredentials(privateKey);
  log.info(`API credentials derived successfully for ${wallet.address}`);

  // Store all 4 values encrypted
  await Promise.all([
    prisma.systemSetting.upsert({
      where: { key: SETTING_KEYS.PRIVATE_KEY },
      create: { key: SETTING_KEYS.PRIVATE_KEY, value: encryptApiKey(privateKey) },
      update: { value: encryptApiKey(privateKey) },
    }),
    prisma.systemSetting.upsert({
      where: { key: SETTING_KEYS.API_KEY },
      create: { key: SETTING_KEYS.API_KEY, value: encryptApiKey(apiKey) },
      update: { value: encryptApiKey(apiKey) },
    }),
    prisma.systemSetting.upsert({
      where: { key: SETTING_KEYS.API_SECRET },
      create: { key: SETTING_KEYS.API_SECRET, value: encryptApiKey(secret) },
      update: { value: encryptApiKey(secret) },
    }),
    prisma.systemSetting.upsert({
      where: { key: SETTING_KEYS.API_PASSPHRASE },
      create: { key: SETTING_KEYS.API_PASSPHRASE, value: encryptApiKey(passphrase) },
      update: { value: encryptApiKey(passphrase) },
    }),
  ]);

  return { address: wallet.address };
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
    return {
      privateKey: decryptApiKey(encPk),
      apiKey: decryptApiKey(encKey),
      apiSecret: decryptApiKey(encSecret),
      apiPassphrase: decryptApiKey(encPass),
    };
  } catch (err) {
    log.error(`Failed to decrypt Polymarket credentials: ${err}`);
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
    // Validate the private key produces a valid address
    const wallet = new ethers.Wallet(creds.privateKey);

    // Test API auth by fetching API keys list
    await clobGet('/auth/api-keys', creds);

    return { valid: true, address: wallet.address };
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
    const data = await clobGet('/balance-allowance?asset_type=USDC', creds);
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
    const wallet = new ethers.Wallet(creds.privateKey);
    const signedOrder = await createSignedOrder(wallet, tokenId, amount, price);

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
      owner: wallet.address,
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
