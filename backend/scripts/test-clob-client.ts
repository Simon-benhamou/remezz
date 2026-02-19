/**
 * Test du client officiel @polymarket/clob-client — sans placer de vrai ordre.
 *
 * Étapes :
 *  1. Auth L1 (EIP-712) → dériver les API credentials
 *  2. Balance USDC (signature_type=1 pour proxy)
 *  3. Fetch le market BTC 5min en cours + token IDs
 *  4. Créer + signer un ordre market (sans le soumettre)
 *  5. Valider la structure de l'ordre signé
 *
 * Usage :
 *   POLYMARKET_ACCOUNT_PRIVATE_KEY=0x... PROXY_WALLET_ACCOUNT_POLYMARKET=0x... \
 *   npx tsx scripts/test-clob-client.ts
 */

import { ClobClient, AssetType, Side } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { Wallet } from 'ethers5';

const PK = process.env.POLYMARKET_ACCOUNT_PRIVATE_KEY ?? '';
const PROXY = process.env.PROXY_WALLET_ACCOUNT_POLYMARKET ?? '';
const CLOB = 'https://clob.polymarket.com';
const GAMMA = 'https://gamma-api.polymarket.com';
const CHAIN_ID = 137;
const USDC_DECIMALS = 6;

if (!PK) {
  console.error('POLYMARKET_ACCOUNT_PRIVATE_KEY manquant');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 1. Construire le wallet + client ────────────────────────────────────────

const wallet = new Wallet(PK);
const signatureType = PROXY ? SignatureType.POLY_PROXY : SignatureType.EOA;

console.log('\n=== Config ===');
console.log(`EOA      : ${wallet.address}`);
console.log(`Proxy    : ${PROXY || '(non configuré)'}`);
console.log(`SigType  : ${signatureType === 1 ? 'POLY_PROXY (1)' : 'EOA (0)'}`);

// Client sans creds pour la dérivation L1
const clientL1 = new ClobClient(CLOB, CHAIN_ID, wallet, undefined, signatureType, PROXY || undefined);

// ── 2. Dériver les API credentials ──────────────────────────────────────────

console.log('\n=== Étape 1 : createOrDeriveApiKey ===');
let apiCreds: { key: string; secret: string; passphrase: string };
try {
  apiCreds = await clientL1.createOrDeriveApiKey();
  console.log(`✓ key=${apiCreds.key.slice(0, 8)}... secret=${apiCreds.secret.slice(0, 8)}...`);
} catch (err: any) {
  console.error(`✗ Échec derivation: ${err?.message}`);
  process.exit(1);
}

await sleep(1200);

// Client complet avec creds L2
const client = new ClobClient(CLOB, CHAIN_ID, wallet, apiCreds, signatureType, PROXY || undefined);

// ── 3. Balance USDC ─────────────────────────────────────────────────────────

console.log('\n=== Étape 2 : getBalanceAllowance ===');
try {
  const balData = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const balance = parseFloat(balData.balance ?? '0') / 10 ** USDC_DECIMALS;
  const allowance = parseFloat(balData.allowance ?? '0') / 10 ** USDC_DECIMALS;
  console.log(`✓ Balance   : $${balance.toFixed(2)} USDC`);
  console.log(`  Allowance : $${allowance.toFixed(2)} USDC`);
  if (balance === 0) {
    console.warn('  ⚠ Balance à $0 — vérifier que le proxy wallet est bien configuré');
  }
} catch (err: any) {
  console.error(`✗ Balance fetch: ${err?.message}`);
}

await sleep(1200);

// ── 4. Fetch le market BTC 5min en cours ────────────────────────────────────

console.log('\n=== Étape 3 : Market BTC 5min en cours ===');
const nowSec = Math.floor(Date.now() / 1000);
const windowSec = Math.floor(nowSec / 300) * 300;
const slug = `btc-updown-5m-${windowSec}`;
console.log(`Slug : ${slug}`);

let upTokenId: string | null = null;
let downTokenId: string | null = null;
let upPrice = 0.5;
let downPrice = 0.5;

try {
  const res = await fetch(`${GAMMA}/events?slug=${slug}`, { signal: AbortSignal.timeout(5000) });
  const events: any[] = await res.json();

  if (!events.length) {
    console.warn('  ⚠ Aucun event trouvé pour ce slug');
  } else {
    const market = events[0]?.markets?.[0];
    const outcomes: string[] = JSON.parse(market.outcomes);
    const prices: string[] = JSON.parse(market.outcomePrices);
    const tokenIds: string[] = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];

    for (let i = 0; i < outcomes.length; i++) {
      const label = outcomes[i].toLowerCase();
      if (label === 'up') { upPrice = parseFloat(prices[i]); upTokenId = tokenIds[i] ?? null; }
      if (label === 'down') { downPrice = parseFloat(prices[i]); downTokenId = tokenIds[i] ?? null; }
    }

    console.log(`✓ UP   : price=${upPrice.toFixed(3)} tokenId=${upTokenId?.slice(0, 12)}...`);
    console.log(`  DOWN : price=${downPrice.toFixed(3)} tokenId=${downTokenId?.slice(0, 12)}...`);
  }
} catch (err: any) {
  console.error(`✗ Gamma API: ${err?.message}`);
}

// ── 5. Créer l'ordre signé (SANS le soumettre) ──────────────────────────────

console.log('\n=== Étape 4 : createMarketOrder (sign only, NO POST) ===');
const testTokenId = downTokenId ?? upTokenId;
const testPrice = downTokenId ? downPrice : upPrice;
const testAmount = 1.0; // $1 USDC — test only

if (!testTokenId) {
  console.warn('  ⚠ Pas de token ID disponible — market peut-être fermé');
} else {
  try {
    const signedOrder = await client.createMarketOrder({
      tokenID: testTokenId,
      amount: testAmount,
      price: testPrice,
      side: Side.BUY,
    });

    console.log('✓ Ordre signé (NON soumis) :');
    console.log(`  salt          : ${(signedOrder as any).salt}`);
    console.log(`  maker         : ${(signedOrder as any).maker}`);
    console.log(`  signer        : ${(signedOrder as any).signer}`);
    console.log(`  tokenId       : ${(signedOrder as any).tokenId?.slice(0, 20)}...`);
    console.log(`  makerAmount   : ${(signedOrder as any).makerAmount} (µUSDC)`);
    console.log(`  takerAmount   : ${(signedOrder as any).takerAmount}`);
    console.log(`  signatureType : ${(signedOrder as any).signatureType} (${(signedOrder as any).signatureType === 1 ? 'POLY_PROXY ✓' : 'EOA'})`);
    console.log(`  signature     : ${(signedOrder as any).signature?.slice(0, 20)}...`);

    // Validations
    const salt = Number((signedOrder as any).salt);
    if (salt > Number.MAX_SAFE_INTEGER) {
      console.error('  ✗ SALT TRUNCATION — salt dépasse Number.MAX_SAFE_INTEGER!');
    } else {
      console.log(`  ✓ Salt dans les limites (${salt})`);
    }

    if (PROXY) {
      const maker = (signedOrder as any).maker?.toLowerCase();
      if (maker === PROXY.toLowerCase()) {
        console.log(`  ✓ maker = proxy wallet (${maker.slice(0, 10)}...)`);
      } else {
        console.warn(`  ⚠ maker = ${maker} (attendu proxy ${PROXY.slice(0, 10)}...)`);
      }
    }

  } catch (err: any) {
    console.error(`✗ createMarketOrder: ${err?.message}`);
  }
}

// ── 6. Vérifier les ordres ouverts ──────────────────────────────────────────

console.log('\n=== Étape 5 : getOpenOrders ===');
await sleep(1200);
try {
  const openOrders = await client.getOpenOrders();
  const count = Array.isArray(openOrders) ? openOrders.length : (openOrders as any)?.data?.length ?? 0;
  console.log(`✓ ${count} ordre(s) ouvert(s) en cours`);
  if (count > 0) {
    const orders = Array.isArray(openOrders) ? openOrders : (openOrders as any)?.data ?? [];
    for (const o of orders.slice(0, 3)) {
      console.log(`  - id=${o.id?.slice(0, 12)} asset=${o.asset_id?.slice(0, 12)} side=${o.side} size=${o.original_size} price=${o.price}`);
    }
  }
} catch (err: any) {
  console.error(`✗ getOpenOrders: ${err?.message}`);
}

console.log('\n=== Test terminé — aucun ordre soumis ===\n');
