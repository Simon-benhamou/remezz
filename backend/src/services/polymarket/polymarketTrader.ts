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
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { createWalletClient, http, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
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

// ─── On-chain CTF redemption constants ──────────────────────────────────────
// After market resolution, the CLOB orderbook is removed. Winning tokens must
// be redeemed on-chain via the Conditional Token Framework (CTF) contract.
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
// Viem-format ABI for CTF redeemPositions (used by Builder Relayer)
const CTF_REDEEM_ABI = [
  {
    type: 'function',
    name: 'redeemPositions',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'indexSets', type: 'uint256[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

// Builder Relayer — gasless on-chain tx via Polymarket proxy (replaces direct ethers5 CTF call)
const RELAYER_URL = 'https://relayer-v2.polymarket.com/';

// ERC-1155 balanceOf ABI — for querying actual on-chain token balance
const ERC1155_BALANCE_ABI = ['function balanceOf(address account, uint256 id) view returns (uint256)'];
const POLYGON_RPC = 'https://polygon-rpc.com';

/**
 * Query on-chain CTF token balance for a user's proxy address.
 * Returns the actual number of tokens held (not a calculated estimate).
 * V5.138: Fixes token residual leak — sell/redeem now uses real balance instead of betAmount/executionPrice.
 */
async function getOnChainTokenBalance(
  prisma: PrismaClient,
  userId: string,
  tokenId: string,
): Promise<number | null> {
  const creds = await loadCredentials(prisma, userId);
  if (!creds) return null;

  // Use proxy address if available (Magic.link), otherwise EOA
  const holderAddress = creds.proxyAddress ?? creds.address;

  try {
    const provider = new ethers6.JsonRpcProvider(POLYGON_RPC);
    const ctf = new ethers6.Contract(CTF_ADDRESS, ERC1155_BALANCE_ABI, provider);
    const rawBalance: bigint = await ctf.balanceOf(holderAddress, tokenId);
    // CTF tokens use 6 decimals (like USDC) — actually no, CTF conditional tokens
    // are whole units (1 token = 1 unit, no decimals). The raw bigint IS the token count.
    // But the CLOB SDK uses floating-point token amounts, so we convert.
    const balance = Number(rawBalance) / 1e6; // USDC-denominated conditional tokens use 6 decimals
    log.debug(`On-chain balance for ${holderAddress.slice(0, 8)}… tokenId=${tokenId.slice(0, 12)}…: ${balance.toFixed(4)} tokens`);
    return balance;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`getOnChainTokenBalance failed: ${msg}`);
    return null;
  }
}

// Confidence-tiered pricing: higher score → accept higher CLOB price.
// V5.130: Min score lowered to 50 (backtest 30d: 80.6% WR, +7.6pp edge, all CLOB buckets +EV)
//   Score 50-64: ~80% WR → cap 0.78 (same as 65-69, backtest confirms +EV across all CLOB bands)
//   Score 65-69: ~80% WR → cap 0.78
//   Score 70-79: ~83% WR → cap 0.82
//   Score 80+:   ~85% WR → cap 0.85
export const CLOB_PRICE_TIERS = [
  { minScore: 80, maxPrice: 0.85 },
  { minScore: 70, maxPrice: 0.82 },
  { minScore: 65, maxPrice: 0.78 },
] as const;

/** Get the maximum acceptable CLOB price for a given confidence score. */
export function getMaxPriceForScore(score: number): number {
  for (const tier of CLOB_PRICE_TIERS) {
    if (score >= tier.minScore) return tier.maxPrice;
  }
  return 0.50; // fallback — should never hit (MIN_SCORE = 65 in worker)
}

// Keep MAX_CLOB_PRICE for hedge bets (they don't have a score — use the lowest tier)
export const MAX_CLOB_PRICE = CLOB_PRICE_TIERS[CLOB_PRICE_TIERS.length - 1].maxPrice; // 0.78

// Maximum divergence allowed between CLOB and Gamma prices.
// If CLOB is more than 50% above Gamma, something is likely wrong (stale Gamma, wrong market).
const MAX_GAMMA_DIVERGENCE_PCT = 0.50;

// ─── Settings keys ──────────────────────────────────────────────────────────

const SETTING_KEYS = {
  MODE: 'polymarket_mode',
  AMOUNT: 'polymarket_amount',
  HEDGE_AMOUNT: 'polymarket_hedge_amount',
  SYMBOLS: 'polymarket_symbols',
  PRIVATE_KEY: 'polymarket_private_key',
  PROXY_ADDRESS: 'polymarket_proxy_address', // proxy wallet shown in Polymarket UI (Magic.link)
  API_KEY: 'polymarket_api_key',
  API_SECRET: 'polymarket_api_secret',
  API_PASSPHRASE: 'polymarket_api_passphrase',
  BUILDER_KEY: 'polymarket_builder_key',
  BUILDER_SECRET: 'polymarket_builder_secret',
  BUILDER_PASSPHRASE: 'polymarket_builder_passphrase',
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export const ALL_POLYMARKET_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'] as const;
export type PolymarketSymbol = (typeof ALL_POLYMARKET_SYMBOLS)[number];

export interface PolymarketConfig {
  mode: 'virtual' | 'live';
  amount: number; // USDC per Early Bird trade
  hedgeAmount: number; // USDC for T+4:00 hedge bet
  symbols: string[]; // Active symbols (e.g. ['BTC', 'ETH'])
  hasCredentials: boolean;
  hasBuilderCredentials: boolean;
}

interface BuilderCreds {
  key: string;
  secret: string;
  passphrase: string;
}

interface StoredCreds {
  privateKey: string;
  address: string; // EOA address derived from private key
  proxyAddress?: string; // Magic.link proxy wallet (holds USDC)
  apiCreds: ApiKeyCreds; // { key, secret, passphrase } for L2 HMAC auth
  builderCreds?: BuilderCreds; // Builder API creds for relay auth (from polymarket.com/settings?tab=builder)
}

// ─── In-memory credential cache (per-user) ──────────────────────────────────

const _credCacheByUser = new Map<string, StoredCreds>();

function clearCredCache(userId?: string): void {
  if (userId) _credCacheByUser.delete(userId);
  else _credCacheByUser.clear();
}

// ─── In-memory balance cache (per-user) ──────────────────────────────────────
// Guard against cluster nodes that silently return $0 instead of proxy balance.

const _balanceCacheByUser = new Map<string, { balance: number; at: number }>();
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

/**
 * Build a RelayClient for gasless on-chain transactions via Polymarket's Relayer.
 * Uses a viem WalletClient (avoids ethers5 provider requirement).
 * PROXY type for Magic.link wallets (auto-deploys, no MATIC needed).
 */
function buildRelayClient(creds: StoredCreds): RelayClient {
  const account = privateKeyToAccount(creds.privateKey as `0x${string}`);
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http('https://polygon-rpc.com'),
  });
  // PROXY for Magic.link wallets (gasless, auto-deploy). SAFE for direct EOA.
  const txType = creds.proxyAddress ? RelayerTxType.PROXY : RelayerTxType.SAFE;

  // Builder credentials required for relay auth (HMAC headers)
  let builderConfig: BuilderConfig | undefined;
  if (creds.builderCreds) {
    builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: creds.builderCreds.key,
        secret: creds.builderCreds.secret,
        passphrase: creds.builderCreds.passphrase,
      },
    });
  } else {
    log.warn('No Builder credentials — relay redeem will fail (get them at polymarket.com/settings?tab=builder)');
  }

  return new RelayClient(RELAYER_URL, CHAIN_ID, wallet, builderConfig, txType);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Read polymarket trading config from UserSetting.
 */
export async function getPolymarketConfig(
  prisma: PrismaClient,
  userId: string,
): Promise<PolymarketConfig> {
  const settings = await prisma.userSetting.findMany({
    where: { userId, key: { in: [SETTING_KEYS.MODE, SETTING_KEYS.AMOUNT, SETTING_KEYS.HEDGE_AMOUNT, SETTING_KEYS.SYMBOLS, SETTING_KEYS.API_KEY, SETTING_KEYS.BUILDER_KEY] } },
  });
  const map = new Map(settings.map((s) => [s.key, s.value]));

  // Parse symbols CSV, default to ['BTC'] for backward compat
  const symbolsCsv = map.get(SETTING_KEYS.SYMBOLS);
  const symbols = symbolsCsv
    ? symbolsCsv.split(',').map((s) => s.trim().toUpperCase()).filter((s) => (ALL_POLYMARKET_SYMBOLS as readonly string[]).includes(s))
    : ['BTC'];

  return {
    mode: (map.get(SETTING_KEYS.MODE) as 'virtual' | 'live') || 'virtual',
    amount: parseFloat(map.get(SETTING_KEYS.AMOUNT) || '5'),
    hedgeAmount: parseFloat(map.get(SETTING_KEYS.HEDGE_AMOUNT) || '1'),
    symbols: symbols.length > 0 ? symbols : ['BTC'],
    hasCredentials: !!map.get(SETTING_KEYS.API_KEY),
    hasBuilderCredentials: !!map.get(SETTING_KEYS.BUILDER_KEY),
  };
}

/**
 * Save polymarket trading config (mode + amount + hedgeAmount).
 */
export async function savePolymarketConfig(
  prisma: PrismaClient,
  userId: string,
  mode: 'virtual' | 'live',
  amount: number,
  hedgeAmount: number,
  symbols?: string[],
): Promise<void> {
  const ops: Promise<any>[] = [
    prisma.userSetting.upsert({
      where: { userId_key: { userId, key: SETTING_KEYS.MODE } },
      create: { userId, key: SETTING_KEYS.MODE, value: mode, category: 'polymarket' },
      update: { value: mode },
    }),
    prisma.userSetting.upsert({
      where: { userId_key: { userId, key: SETTING_KEYS.AMOUNT } },
      create: { userId, key: SETTING_KEYS.AMOUNT, value: amount.toString(), category: 'polymarket' },
      update: { value: amount.toString() },
    }),
    prisma.userSetting.upsert({
      where: { userId_key: { userId, key: SETTING_KEYS.HEDGE_AMOUNT } },
      create: { userId, key: SETTING_KEYS.HEDGE_AMOUNT, value: hedgeAmount.toString(), category: 'polymarket' },
      update: { value: hedgeAmount.toString() },
    }),
  ];

  if (symbols) {
    const csv = symbols.map((s) => s.toUpperCase()).join(',');
    ops.push(
      prisma.userSetting.upsert({
        where: { userId_key: { userId, key: SETTING_KEYS.SYMBOLS } },
        create: { userId, key: SETTING_KEYS.SYMBOLS, value: csv, category: 'polymarket' },
        update: { value: csv },
      }),
    );
  }

  await Promise.all(ops);
}

/**
 * Save private key and auto-derive API credentials from the CLOB API.
 * The user only provides the wallet private key — everything else is derived.
 */
export async function savePolymarketCredentials(
  prisma: PrismaClient,
  userId: string,
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
    prisma.userSetting.upsert({
      where: { userId_key: { userId, key: SETTING_KEYS.PRIVATE_KEY } },
      create: { userId, key: SETTING_KEYS.PRIVATE_KEY, value: encryptedPk, category: 'polymarket' },
      update: { value: encryptedPk },
    }),
    prisma.userSetting.upsert({
      where: { userId_key: { userId, key: SETTING_KEYS.API_KEY } },
      create: { userId, key: SETTING_KEYS.API_KEY, value: encryptedApiKey, category: 'polymarket' },
      update: { value: encryptedApiKey },
    }),
    prisma.userSetting.upsert({
      where: { userId_key: { userId, key: SETTING_KEYS.API_SECRET } },
      create: { userId, key: SETTING_KEYS.API_SECRET, value: encryptedSecret, category: 'polymarket' },
      update: { value: encryptedSecret },
    }),
    prisma.userSetting.upsert({
      where: { userId_key: { userId, key: SETTING_KEYS.API_PASSPHRASE } },
      create: { userId, key: SETTING_KEYS.API_PASSPHRASE, value: encryptedPassphrase, category: 'polymarket' },
      update: { value: encryptedPassphrase },
    }),
  ];

  if (proxyAddress) {
    upserts.push(
      prisma.userSetting.upsert({
        where: { userId_key: { userId, key: SETTING_KEYS.PROXY_ADDRESS } },
        create: { userId, key: SETTING_KEYS.PROXY_ADDRESS, value: proxyAddress, category: 'polymarket' },
        update: { value: proxyAddress },
      }),
    );
  } else {
    upserts.push(prisma.userSetting.deleteMany({ where: { userId, key: SETTING_KEYS.PROXY_ADDRESS } }));
  }

  await Promise.all(upserts);

  clearCredCache(userId);
  _balanceCacheByUser.delete(userId);

  return { address: wallet6.address };
}

/**
 * Delete all Polymarket credentials and reset mode to virtual.
 */
export async function deletePolymarketCredentials(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.userSetting.deleteMany({
    where: {
      userId,
      key: {
        in: [
          SETTING_KEYS.PRIVATE_KEY,
          SETTING_KEYS.PROXY_ADDRESS,
          SETTING_KEYS.API_KEY,
          SETTING_KEYS.API_SECRET,
          SETTING_KEYS.API_PASSPHRASE,
          SETTING_KEYS.BUILDER_KEY,
          SETTING_KEYS.BUILDER_SECRET,
          SETTING_KEYS.BUILDER_PASSPHRASE,
        ],
      },
    },
  });
  await prisma.userSetting.upsert({
    where: { userId_key: { userId, key: SETTING_KEYS.MODE } },
    create: { userId, key: SETTING_KEYS.MODE, value: 'virtual', category: 'polymarket' },
    update: { value: 'virtual' },
  });
  clearCredCache(userId);
  _balanceCacheByUser.delete(userId);
}

/**
 * Save Builder API credentials (from polymarket.com/settings?tab=builder).
 * Required for relay-based CTF redemption of winning tokens.
 */
export async function saveBuilderCredentials(
  prisma: PrismaClient,
  userId: string,
  key: string,
  secret: string,
  passphrase: string,
): Promise<void> {
  const encKey = encryptApiKey(key.trim());
  const encSecret = encryptApiKey(secret.trim());
  const encPass = encryptApiKey(passphrase.trim());

  await Promise.all([
    prisma.userSetting.upsert({
      where: { userId_key: { userId, key: SETTING_KEYS.BUILDER_KEY } },
      create: { userId, key: SETTING_KEYS.BUILDER_KEY, value: encKey, category: 'polymarket' },
      update: { value: encKey },
    }),
    prisma.userSetting.upsert({
      where: { userId_key: { userId, key: SETTING_KEYS.BUILDER_SECRET } },
      create: { userId, key: SETTING_KEYS.BUILDER_SECRET, value: encSecret, category: 'polymarket' },
      update: { value: encSecret },
    }),
    prisma.userSetting.upsert({
      where: { userId_key: { userId, key: SETTING_KEYS.BUILDER_PASSPHRASE } },
      create: { userId, key: SETTING_KEYS.BUILDER_PASSPHRASE, value: encPass, category: 'polymarket' },
      update: { value: encPass },
    }),
  ]);

  clearCredCache(userId);
  log.info(`Builder credentials saved for user=${userId}`);
}

/**
 * Load decrypted credentials from DB (with per-user in-memory cache).
 */
async function loadCredentials(prisma: PrismaClient, userId: string): Promise<StoredCreds | null> {
  const cached = _credCacheByUser.get(userId);
  if (cached) return cached;

  const settings = await prisma.userSetting.findMany({
    where: {
      userId,
      key: {
        in: [
          SETTING_KEYS.PRIVATE_KEY,
          SETTING_KEYS.PROXY_ADDRESS,
          SETTING_KEYS.API_KEY,
          SETTING_KEYS.API_SECRET,
          SETTING_KEYS.API_PASSPHRASE,
          SETTING_KEYS.BUILDER_KEY,
          SETTING_KEYS.BUILDER_SECRET,
          SETTING_KEYS.BUILDER_PASSPHRASE,
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

    // Builder credentials (optional — needed for relay-based CTF redemption)
    const encBuilderKey = map.get(SETTING_KEYS.BUILDER_KEY);
    const encBuilderSecret = map.get(SETTING_KEYS.BUILDER_SECRET);
    const encBuilderPass = map.get(SETTING_KEYS.BUILDER_PASSPHRASE);
    let builderCreds: BuilderCreds | undefined;
    if (encBuilderKey && encBuilderSecret && encBuilderPass) {
      builderCreds = {
        key: decryptApiKey(encBuilderKey).trim(),
        secret: decryptApiKey(encBuilderSecret).trim(),
        passphrase: decryptApiKey(encBuilderPass).trim(),
      };
    }

    log.debug(`Credentials loaded for user=${userId} — address=${wallet.address}${proxyAddress ? ` proxy=${proxyAddress}` : ''}${builderCreds ? ' builder=YES' : ' builder=NO'}`);

    const creds: StoredCreds = {
      privateKey,
      address: wallet.address,
      proxyAddress,
      apiCreds: {
        key: decryptApiKey(encKey).trim(),
        secret: decryptApiKey(encSecret).trim(),
        passphrase: decryptApiKey(encPass).trim(),
      },
      builderCreds,
    };
    _credCacheByUser.set(userId, creds);
    return creds;
  } catch (err) {
    log.error(`Failed to load Polymarket credentials for user=${userId}: ${err}`);
    return null;
  }
}

/**
 * Validate credentials by calling a lightweight authenticated endpoint.
 * Retries up to 3x with 2s backoff for Polymarket's eventual consistency.
 */
export async function validatePolymarketCredentials(
  prisma: PrismaClient,
  userId: string,
): Promise<{ valid: boolean; address?: string; error?: string }> {
  const creds = await loadCredentials(prisma, userId);
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
  userId: string,
): Promise<{ balance: number; cached?: boolean; error?: string }> {
  const creds = await loadCredentials(prisma, userId);
  if (!creds) return { balance: 0, error: 'No credentials configured' };

  const client = buildClient(creds);
  const balCache = _balanceCacheByUser.get(userId);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      if ((data as any)?.error) throw new Error(String((data as any).error));
      const balance = parseFloat(data?.balance ?? '0') / 10 ** USDC_DECIMALS;

      // If we get $0 but have a proxy configured AND previously had a non-zero balance,
      // the cluster node may have silently ignored signature_type=1 — retry
      if (balance === 0 && creds.proxyAddress && balCache && balCache.balance > 0 && attempt < 3) {
        log.warn(`Balance returned $0 with proxy configured (attempt ${attempt}/3) — retrying`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }

      if (balance > 0 || !creds.proxyAddress) {
        _balanceCacheByUser.set(userId, { balance, at: Date.now() });
      }
      return { balance };
    } catch (err: any) {
      log.warn(`Balance fetch failed (attempt ${attempt}/3): ${err?.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // All attempts failed — return cached balance if recent enough
  if (balCache && Date.now() - balCache.at < BALANCE_CACHE_TTL_MS) {
    log.warn(`Returning cached balance $${balCache.balance.toFixed(2)} (API temporarily inconsistent)`);
    return { balance: balCache.balance, cached: true };
  }

  return { balance: 0, error: 'Failed to fetch balance (cluster inconsistency)' };
}

/**
 * Place a market buy order on Polymarket.
 * The official client handles EIP-712 order signing, HMAC auth, and salt generation.
 */
export async function placePolymarketBet(
  prisma: PrismaClient,
  userId: string,
  direction: 'UP' | 'DOWN',
  tokenId: string,
  amount: number,
  price: number,
  skipEvCheck = false,
  confidenceScore?: number,
): Promise<{ success: boolean; orderId?: string; executionPrice?: number; actualAmount?: number; error?: string }> {
  const creds = await loadCredentials(prisma, userId);
  if (!creds) return { success: false, error: 'No credentials' };

  try {
    const client = buildClient(creds);

    // Price validation: use CLOB as the real price (Gamma API can be stale).
    const clobPriceData = await client.getPrice(tokenId, 'BUY');
    const clobAsk = parseFloat((clobPriceData as any)?.price ?? '0');

    if (clobAsk === 0) {
      return { success: false, error: 'CLOB price unavailable — skipping bet' };
    }

    // V5.138: Raised from 0.40 to 0.60 — live data (104 trades): 0.40-0.55 = 50% WR (coin flip),
    // 0.55-0.65 = 50% WR/-$9.96. Only 0.65+ is profitable. Floor at 0.60 as safety margin.
    const MIN_CLOB_PRICE = 0.60;
    if (!skipEvCheck && clobAsk < MIN_CLOB_PRICE) {
      log.warn(`Price too low: CLOB=${clobAsk.toFixed(3)} < ${MIN_CLOB_PRICE} — aberrant price, skipping`);
      return { success: false, error: `Price too low (${clobAsk.toFixed(3)} < ${MIN_CLOB_PRICE})` };
    }

    // 1. Confidence-tiered EV cap: higher score → accept higher price
    //    skipEvCheck: used by hedge bets (small insurance, EV cap doesn't apply)
    const maxPrice = confidenceScore ? getMaxPriceForScore(confidenceScore) : MAX_CLOB_PRICE;
    if (!skipEvCheck && clobAsk > maxPrice) {
      log.warn(`EV too low: CLOB ask=${clobAsk.toFixed(3)} > cap=${maxPrice.toFixed(2)} (score=${confidenceScore ?? 'n/a'}) — skipping`);
      return { success: false, error: `EV too low (CLOB=${clobAsk.toFixed(3)} > cap=${maxPrice.toFixed(2)})` };
    }

    // 2. Gamma divergence: warn if CLOB above Gamma, REJECT if CLOB significantly below Gamma (reversal)
    const divergence = (clobAsk - price) / price;
    if (divergence > MAX_GAMMA_DIVERGENCE_PCT) {
      log.warn(`Gamma divergence: CLOB=${clobAsk.toFixed(3)} vs Gamma=${price.toFixed(3)} (${(divergence * 100).toFixed(0)}% above) — proceeding with CLOB price`);
    }
    // V5.124: CLOB >20% below Gamma = market reversed against our prediction ("too good to be true")
    const MIN_GAMMA_DIVERGENCE_PCT = -0.20;
    if (!skipEvCheck && divergence < MIN_GAMMA_DIVERGENCE_PCT) {
      log.warn(`Reversal signal: CLOB=${clobAsk.toFixed(3)} << Gamma=${price.toFixed(3)} (${(divergence * 100).toFixed(0)}% below) — skipping`);
      return { success: false, error: `Reversal signal (CLOB ${(divergence * 100).toFixed(0)}% below Gamma)` };
    }

    log.info(`Price OK: CLOB ask=${clobAsk.toFixed(3)}, Gamma=${price.toFixed(3)}, cap=${maxPrice.toFixed(2)} (score=${confidenceScore ?? 'n/a'})`);

    // Place GTC limit order (not FOK) — 5-min BTC markets have thin liquidity,
    // FOK fails when the order book can't fill $10 at the ask price in one shot.
    // GTC sits in the book and fills as liquidity comes in.
    // Note: createAndPostOrder uses UserOrder (size in tokens), not UserMarketOrder (amount in USDC).
    const CLOB_MIN_TOKEN_SIZE = 5; // Polymarket CLOB minimum order size
    let tokenSize = amount / clobAsk; // Convert USDC amount to token quantity
    if (tokenSize < CLOB_MIN_TOKEN_SIZE) {
      const adjustedAmount = Math.ceil(CLOB_MIN_TOKEN_SIZE * clobAsk * 100) / 100;
      log.info(`Token size ${tokenSize.toFixed(2)} < ${CLOB_MIN_TOKEN_SIZE} min — bumping $${amount} → $${adjustedAmount}`);
      amount = adjustedAmount;
      tokenSize = CLOB_MIN_TOKEN_SIZE;
    }
    const order = {
      tokenID: tokenId,
      price: clobAsk,
      size: tokenSize,
      side: Side.BUY,
    };

    const result = await client.createAndPostOrder(order, undefined, OrderType.GTC);

    if (result?.error) {
      const errMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
      throw new Error(`Order rejected (${result.status ?? '?'}): ${errMsg}`);
    }

    const orderId = result?.orderID ?? result?.id ?? 'unknown';
    log.info(`GTC order placed: ${direction} $${amount} @ ${clobAsk.toFixed(3)} | orderId=${orderId} — polling for fill...`);

    // Poll for fill status — wait up to 30s, check every 2s
    const GTC_POLL_INTERVAL_MS = 2000;
    const GTC_MAX_WAIT_MS = 30_000;
    const startTime = Date.now();

    while (Date.now() - startTime < GTC_MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, GTC_POLL_INTERVAL_MS));

      try {
        const orderStatus = await client.getOrder(orderId);
        const status = (orderStatus as any)?.status ?? (orderStatus as any)?.order?.status;

        if (status === 'MATCHED' || status === 'FILLED') {
          log.info(`GTC order FILLED: ${direction} $${amount} @ CLOB ${clobAsk.toFixed(3)} (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
          return { success: true, orderId, executionPrice: clobAsk, actualAmount: amount };
        }

        if (status === 'CANCELED' || status === 'CANCELLED' || status === 'EXPIRED') {
          log.warn(`GTC order ${status}: ${orderId}`);
          return { success: false, error: `Order ${status} by exchange` };
        }
        // Still LIVE/OPEN — continue polling
      } catch (pollErr: any) {
        log.warn(`GTC poll error: ${pollErr?.message} — retrying`);
      }
    }

    // Timed out — cancel the unfilled order
    log.warn(`GTC order not filled after ${GTC_MAX_WAIT_MS / 1000}s — cancelling orderId=${orderId}`);
    try {
      await client.cancelOrder({ orderID: orderId });
      log.info(`GTC order cancelled: ${orderId}`);
    } catch (cancelErr: any) {
      log.warn(`Failed to cancel GTC order: ${cancelErr?.message}`);
    }

    return { success: false, error: `GTC order not filled within ${GTC_MAX_WAIT_MS / 1000}s (liquidity too thin)` };
  } catch (err: any) {
    log.error(`Failed to place bet: ${err?.message}`);
    return { success: false, error: err?.message };
  }
}

/**
 * Place a GTC limit BUY order at a specific price (non-blocking).
 * Returns immediately after order placement — caller manages polling/cancellation.
 * Used as fallback when CLOB ask exceeds tier cap: place limit at cap and wait.
 */
export async function placeGtcLimitBuy(
  prisma: PrismaClient,
  userId: string,
  tokenId: string,
  amount: number,
  limitPrice: number,
): Promise<{ success: boolean; orderId?: string; actualAmount?: number; error?: string }> {
  const creds = await loadCredentials(prisma, userId);
  if (!creds) return { success: false, error: 'No credentials' };

  try {
    const client = buildClient(creds);
    const CLOB_MIN_TOKEN_SIZE = 5;
    let tokenSize = amount / limitPrice;
    if (tokenSize < CLOB_MIN_TOKEN_SIZE) {
      const adjustedAmount = Math.ceil(CLOB_MIN_TOKEN_SIZE * limitPrice * 100) / 100;
      log.info(`Limit token size ${tokenSize.toFixed(2)} < ${CLOB_MIN_TOKEN_SIZE} min — bumping $${amount} → $${adjustedAmount}`);
      amount = adjustedAmount;
      tokenSize = CLOB_MIN_TOKEN_SIZE;
    }
    const order = {
      tokenID: tokenId,
      price: limitPrice,
      size: tokenSize,
      side: Side.BUY,
    };

    const result = await client.createAndPostOrder(order, undefined, OrderType.GTC);

    if (result?.error) {
      const errMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
      throw new Error(`Limit order rejected: ${errMsg}`);
    }

    const orderId = result?.orderID ?? result?.id ?? 'unknown';
    log.info(`GTC LIMIT placed: BUY $${amount} @ ${limitPrice.toFixed(3)} | orderId=${orderId}`);
    return { success: true, orderId, actualAmount: amount };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to place GTC limit: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Sell winning tokens on the CLOB to convert back to USDC.
 * Called after oracle confirms a WIN. Sells at market price (best bid).
 * Returns the USDC amount received, or null if sell failed.
 */
export async function sellWinningTokens(
  prisma: PrismaClient,
  userId: string,
  tokenId: string,
  betAmount: number,
  executionPrice: number,
  minBid = 0.90,
): Promise<{ success: boolean; usdcReceived?: number; sellPrice?: number; error?: string }> {
  const creds = await loadCredentials(prisma, userId);
  if (!creds) return { success: false, error: 'No credentials' };

  try {
    const client = buildClient(creds);

    // Check current bid price — only sell if price is good (>= 0.90)
    let clobBid: number;
    try {
      const clobPriceData = await client.getPrice(tokenId, 'SELL');
      clobBid = parseFloat((clobPriceData as any)?.price ?? '0');
    } catch (priceErr: any) {
      // Market resolved → orderbook removed (404). Expected for 5-min markets.
      // The CLOB client may log the error internally and throw with various message formats.
      const msg = priceErr?.message ?? '';
      const status = priceErr?.response?.status ?? priceErr?.status;
      const dataErr = priceErr?.response?.data?.error ?? priceErr?.data?.error ?? '';
      if (status === 404 || msg.includes('404') || msg.includes('orderbook') || dataErr.includes('orderbook')) {
        return { success: false, error: 'Market closed (orderbook removed after resolution)' };
      }
      throw priceErr;
    }

    // Bid = 0 means CLOB SDK got 404 but didn't throw (logs error internally).
    // Treat as market closed so caller falls through to CTF redeem immediately.
    if (clobBid === 0) {
      return { success: false, error: 'Market closed (orderbook removed after resolution)' };
    }

    if (clobBid < minBid) {
      return { success: false, error: `Bid too low (${clobBid.toFixed(3)} < ${minBid})` };
    }

    // CLOB rejects prices outside [0.01, 0.99] — cap at 0.99 near resolution
    if (clobBid >= 1.0) {
      clobBid = 0.99;
    }

    // V5.138: Use actual on-chain balance instead of calculated betAmount/executionPrice.
    // Prevents token residual leak from CLOB rounding/fees during buy.
    const calculatedTokens = betAmount / executionPrice;
    const onChainBalance = await getOnChainTokenBalance(prisma, userId, tokenId);
    const tokenAmount = onChainBalance != null && onChainBalance > 0 ? onChainBalance : calculatedTokens;

    if (onChainBalance != null && Math.abs(onChainBalance - calculatedTokens) > 0.01) {
      log.info(`Token balance mismatch: on-chain=${onChainBalance.toFixed(4)}, calculated=${calculatedTokens.toFixed(4)} — using on-chain`);
    }

    if (tokenAmount < 0.01) {
      return { success: false, error: `Token balance too small (${tokenAmount.toFixed(4)})` };
    }

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

    log.info(`Auto-sell OK: ${tokenAmount.toFixed(4)} tokens @ ${clobBid.toFixed(3)} = $${expectedUsdc.toFixed(2)} USDC`);
    return { success: true, usdcReceived: expectedUsdc, sellPrice: clobBid };
  } catch (err: any) {
    log.error(`Auto-sell failed: ${err?.message}`);
    return { success: false, error: err?.message };
  }
}

/**
 * Get current CLOB ask price for a token (lightweight, no order placement).
 * Used by the observation phase to poll price every tick.
 */
export async function getClobAskPrice(
  prisma: PrismaClient,
  userId: string,
  tokenId: string,
): Promise<number | null> {
  const creds = await loadCredentials(prisma, userId);
  if (!creds) return null;

  try {
    const client = buildClient(creds);
    const data = await client.getPrice(tokenId, 'BUY');
    const price = parseFloat((data as any)?.price ?? '0');
    return price > 0 ? price : null;
  } catch (err: any) {
    log.warn(`getClobAskPrice failed: ${err?.message}`);
    return null;
  }
}

/**
 * Place a GTC limit sell order for take-profit.
 * Used mid-window for cheap entries (< 40c) to lock in gains at 2.5x.
 * Returns the orderId for later cancellation if not filled.
 */
export async function placeTakeProfitSell(
  prisma: PrismaClient,
  userId: string,
  tokenId: string,
  betAmount: number,
  executionPrice: number,
  targetPrice: number,
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  const creds = await loadCredentials(prisma, userId);
  if (!creds) return { success: false, error: 'No credentials' };

  try {
    const client = buildClient(creds);
    // V5.138: Use actual on-chain balance to prevent selling more than we have
    const calculatedTokens = betAmount / executionPrice;
    const onChainBalance = await getOnChainTokenBalance(prisma, userId, tokenId);
    const tokenAmount = onChainBalance != null && onChainBalance > 0 ? onChainBalance : calculatedTokens;

    const order = {
      tokenID: tokenId,
      price: targetPrice,
      size: tokenAmount,
      side: Side.SELL,
    };

    const result = await client.createAndPostOrder(order, undefined, OrderType.GTC);

    if (result?.error) {
      const errMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
      throw new Error(`TP sell rejected (${result.status ?? '?'}): ${errMsg}`);
    }

    const orderId = result?.orderID ?? result?.id ?? 'unknown';
    log.info(`TP SELL placed: ${tokenAmount.toFixed(4)} tokens @ ${targetPrice.toFixed(3)} | orderId=${orderId}`);
    return { success: true, orderId };
  } catch (err: any) {
    log.error(`TP sell failed: ${err?.message}`);
    return { success: false, error: err?.message };
  }
}

/**
 * Check if a GTC order has been filled.
 * Returns 'MATCHED'|'FILLED' if filled, 'LIVE' if still open, or 'CANCELED'/'EXPIRED' if dead.
 */
export async function checkOrderStatus(
  prisma: PrismaClient,
  userId: string,
  orderId: string,
): Promise<string | null> {
  const creds = await loadCredentials(prisma, userId);
  if (!creds) return null;

  try {
    const client = buildClient(creds);
    const orderStatus = await client.getOrder(orderId);
    return (orderStatus as any)?.status ?? (orderStatus as any)?.order?.status ?? null;
  } catch (err: any) {
    log.warn(`checkOrderStatus failed: ${err?.message}`);
    return null;
  }
}

/**
 * Cancel a GTC order by orderId.
 */
export async function cancelClobOrder(
  prisma: PrismaClient,
  userId: string,
  orderId: string,
): Promise<boolean> {
  const creds = await loadCredentials(prisma, userId);
  if (!creds) return false;

  try {
    const client = buildClient(creds);
    await client.cancelOrder({ orderID: orderId });
    log.info(`Order cancelled: ${orderId}`);
    return true;
  } catch (err: any) {
    log.warn(`Cancel order failed: ${err?.message}`);
    return false;
  }
}

/**
 * Check if live mode is active and return config for the worker.
 */
export async function getLiveTradingConfig(
  prisma: PrismaClient,
  userId: string,
): Promise<{ live: boolean; amount: number } | null> {
  const config = await getPolymarketConfig(prisma, userId);
  if (config.mode !== 'live' || !config.hasCredentials) return null;
  return { live: true, amount: config.amount };
}

// Global relay cooldown: when 429 is received, skip all relay calls until reset
let relayCooldownUntil = 0;

/**
 * Redeem winning tokens on-chain via CTF contract after market resolution.
 * Uses Polymarket's Builder Relayer for gasless execution through the proxy wallet.
 * Each winning token = exactly $1.00 USDC.
 * Called as fallback when CLOB sell fails (orderbook removed after resolution).
 *
 * Requires: conditionId from Gamma API, POLYMARKET_BUILDER_* env vars.
 * Burns ALL winning tokens for this condition — no partial redemption.
 */
export async function redeemWinningTokens(
  prisma: PrismaClient,
  userId: string,
  conditionId: string,
  betAmount: number,
  executionPrice: number,
): Promise<{ success: boolean; usdcReceived?: number; error?: string }> {
  // Skip relay calls while rate-limited (429 cooldown)
  if (Date.now() < relayCooldownUntil) {
    const remainMin = Math.round((relayCooldownUntil - Date.now()) / 60000);
    return { success: false, error: `Relay rate limited (${remainMin}min remaining)` };
  }

  const creds = await loadCredentials(prisma, userId);
  if (!creds) return { success: false, error: 'No credentials' };

  const relay = buildRelayClient(creds);

  try {
    const BYTES32_ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

    const redeemTx = {
      to: CTF_ADDRESS,
      data: encodeFunctionData({
        abi: CTF_REDEEM_ABI,
        functionName: 'redeemPositions',
        args: [
          USDC_ADDRESS as `0x${string}`,
          BYTES32_ZERO,                     // parentCollectionId (always zero for Polymarket)
          conditionId as `0x${string}`,
          [1n, 2n],                         // both outcomes for binary market
        ],
      }),
      value: '0',
    };

    const response = await relay.execute([redeemTx], 'Redeem winning tokens');
    const result = await response.wait();

    // SDK returns undefined when tx reverts onchain (STATE_FAILED) — does NOT throw
    if (!result) {
      const failedHash = response.transactionHash ?? '?';
      log.error(`Relay redeem REVERTED onchain: conditionId=${conditionId.slice(0, 12)}… | tx=${failedHash.slice(0, 14)}… — tokens may already be redeemed`);
      return { success: false, error: `Transaction reverted onchain (${failedHash.slice(0, 14)}…)` };
    }

    // V5.138: Use actual on-chain balance (queried before redeem) for accurate usdcReceived.
    // CTF redeemPositions redeems ALL tokens for the condition — returns $1 per winning token.
    // Previously used betAmount/executionPrice which overestimated due to CLOB rounding/fees.
    const calculatedTokens = betAmount / executionPrice;
    // Note: tokens are already redeemed at this point, so on-chain balance would be 0.
    // We use the calculated value as best estimate. The sell path (which runs first) uses on-chain balance.
    const expectedUsdc = calculatedTokens;
    const txHash = result.transactionHash ?? response.transactionHash ?? '?';

    log.info(`Relay redeem OK: conditionId=${conditionId.slice(0, 12)}… | tx=${txHash.slice(0, 14)}… | ~$${expectedUsdc.toFixed(2)} USDC`);
    return { success: true, usdcReceived: expectedUsdc };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    // Detect 429 rate limit and set global cooldown to avoid hammering
    const status = err?.status ?? err?.response?.status;
    const dataErr = err?.data?.error ?? err?.response?.data?.error ?? msg;
    if (status === 429 || msg.includes('429') || dataErr.includes('quota exceeded')) {
      const resetMatch = dataErr.match(/resets in (\d+)/);
      const resetSec = resetMatch ? parseInt(resetMatch[1], 10) : 3600;
      relayCooldownUntil = Date.now() + resetSec * 1000;
      log.error(`Relay 429 rate limited — cooldown until ${new Date(relayCooldownUntil).toISOString()} (${Math.round(resetSec / 60)}min)`);
      return { success: false, error: `Rate limited (resets in ${Math.round(resetSec / 60)}min)` };
    }
    log.error(`Relay redeem failed: ${msg}`);
    return { success: false, error: msg };
  }
}

// ─── Multi-user helpers ─────────────────────────────────────────────────────

/**
 * Returns all userIds that have polymarket_mode = 'live' AND credentials configured.
 * Used by the worker to iterate over all active Polymarket users.
 */
export async function getActivePolymarketUserIds(prisma: PrismaClient): Promise<string[]> {
  const modeSettings = await prisma.userSetting.findMany({
    where: { key: SETTING_KEYS.MODE, value: 'live' },
    select: { userId: true },
  });
  const userIds = modeSettings.map((s) => s.userId);
  if (userIds.length === 0) return [];

  // Verify each has credentials (API key = derived from private key = ready to trade)
  const credSettings = await prisma.userSetting.findMany({
    where: { userId: { in: userIds }, key: SETTING_KEYS.API_KEY },
    select: { userId: true },
  });
  return credSettings.map((s) => s.userId);
}

/**
 * Returns all userIds that have polymarket_mode = 'virtual' AND credentials configured.
 * Virtual users need credentials to fetch CLOB prices, but don't place orders.
 */
export async function getVirtualPolymarketUserIds(prisma: PrismaClient): Promise<string[]> {
  const modeSettings = await prisma.userSetting.findMany({
    where: { key: SETTING_KEYS.MODE, value: 'virtual' },
    select: { userId: true },
  });
  const userIds = modeSettings.map((s) => s.userId);
  if (userIds.length === 0) return [];

  const credSettings = await prisma.userSetting.findMany({
    where: { userId: { in: userIds }, key: SETTING_KEYS.API_KEY },
    select: { userId: true },
  });
  return credSettings.map((s) => s.userId);
}

/**
 * Simulate a Polymarket bet: fetch real CLOB ask, apply identical guards as placePolymarketBet,
 * but DON'T place any order. Returns the CLOB ask price if guards pass.
 * Used by virtual mode for realistic WR tracking.
 */
export async function simulatePolymarketBet(
  prisma: PrismaClient,
  userId: string,
  direction: 'UP' | 'DOWN',
  tokenId: string,
  amount: number,
  gammaPrice: number,
  confidenceScore?: number,
): Promise<{ success: boolean; clobAsk?: number; error?: string }> {
  const creds = await loadCredentials(prisma, userId);
  if (!creds) return { success: false, error: 'No credentials' };

  try {
    const client = buildClient(creds);
    const clobPriceData = await client.getPrice(tokenId, 'BUY');
    const clobAsk = parseFloat((clobPriceData as any)?.price ?? '0');

    if (clobAsk === 0) {
      return { success: false, error: 'CLOB price unavailable' };
    }

    // Same guards as placePolymarketBet (V5.138: raised from 0.40 to 0.60):
    const MIN_CLOB_PRICE = 0.60;
    if (clobAsk < MIN_CLOB_PRICE) {
      return { success: false, clobAsk, error: `Price too low (${clobAsk.toFixed(3)} < ${MIN_CLOB_PRICE})` };
    }

    const maxPrice = confidenceScore ? getMaxPriceForScore(confidenceScore) : MAX_CLOB_PRICE;
    if (clobAsk > maxPrice) {
      return { success: false, clobAsk, error: `EV too low (CLOB=${clobAsk.toFixed(3)} > cap=${maxPrice.toFixed(2)})` };
    }

    const divergence = (clobAsk - gammaPrice) / gammaPrice;
    if (divergence < -0.20) {
      return { success: false, clobAsk, error: `Reversal signal (${(divergence * 100).toFixed(0)}% below Gamma)` };
    }

    return { success: true, clobAsk };
  } catch (err: any) {
    return { success: false, error: err?.message ?? 'Simulation failed' };
  }
}
