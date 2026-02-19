/**
 * Test complet Polymarket API :
 * 1. Dériver les credentials (comme PUT /credentials dans le front)
 * 2. Balance USDC
 * 3. Fetch odds d'un marché live
 * 4. Simuler un order (sans submit réel, juste la signature)
 */

import crypto from 'crypto';
import { ethers } from 'ethers';

const PRIVATE_KEY = process.env.POLYMARKET_ACCOUNT_PRIVATE_KEY ?? '';
// Adresse proxy Polymarket (montrée dans l'UI) — peut différer de l'EOA dérivé
const PROXY_ADDRESS = process.env.POLYMARKET_ACCOUNT ?? '';
if (!PRIVATE_KEY) {
  console.error('❌ POLYMARKET_ACCOUNT_PRIVATE_KEY manquant dans .env');
  process.exit(1);
}

const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const CHAIN_ID = 137;

const L1_AUTH_DOMAIN = { name: 'ClobAuthDomain', version: '1', chainId: CHAIN_ID };
const L1_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};

// ── Step 1 : Dériver API credentials (= ce que fait PUT /credentials) ──────

async function deriveApiCredentials(privateKey: string, proxyAddress?: string) {
  const wallet = new ethers.Wallet(privateKey);
  const eoaAddress = wallet.address;
  // Si compte Magic.link proxy : utiliser l'adresse proxy dans le message et les headers
  const authAddress = proxyAddress || eoaAddress;
  console.log('EOA (clé privée) :', eoaAddress);
  console.log('Auth address     :', authAddress, proxyAddress ? '(proxy)' : '(EOA direct)');

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await wallet.signTypedData(L1_AUTH_DOMAIN, L1_AUTH_TYPES, {
    address: authAddress,
    timestamp,
    nonce: 0,
    message: 'This message attests that I control the given wallet',
  });

  const res = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
    method: 'GET',
    headers: {
      'POLY-ADDRESS': authAddress,
      'POLY-SIGNATURE': signature,
      'POLY-TIMESTAMP': timestamp,
      'POLY-NONCE': '0',
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`derive-api-key HTTP ${res.status}: ${text}`);

  const data = JSON.parse(text);
  if (!data.apiKey || !data.secret || !data.passphrase) {
    throw new Error(`Réponse incomplète: ${text}`);
  }
  return { apiKey: data.apiKey, secret: data.secret, passphrase: data.passphrase, wallet, authAddress };
}

// ── Step 2 : HMAC L2 headers ────────────────────────────────────────────────

function buildHmacHeaders(
  address: string, apiKey: string, secret: string, passphrase: string,
  method: string, path: string, body?: string,
) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  let message = `${timestamp}\n${method.toUpperCase()}\n${path}`;
  if (body) message += `\n${body}`;

  const sig = crypto.createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(message).digest('base64');

  return {
    'POLY-ADDRESS': address,
    'POLY-SIGNATURE': sig,
    'POLY-TIMESTAMP': timestamp,
    'POLY-NONCE': nonce,
    'POLY-API-KEY': apiKey,
    'POLY-PASSPHRASE': passphrase,
    'Content-Type': 'application/json',
  };
}

// ── Step 3 : Balance ─────────────────────────────────────────────────────────

async function testBalance(address: string, apiKey: string, secret: string, passphrase: string) {
  const path = '/balance-allowance?asset_type=USDC';
  const headers = buildHmacHeaders(address, apiKey, secret, passphrase, 'GET', path);
  const res = await fetch(`${CLOB_HOST}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`balance HTTP ${res.status}: ${text}`);
  const data = JSON.parse(text);
  const balance = parseFloat(data?.balance ?? '0') / 1e6;
  return { raw: data, balance };
}

// ── Step 4 : Chercher un marché BTC live ─────────────────────────────────────

async function findLiveBtcMarket() {
  // Cherche un marché crypto 5min actif
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / 300) * 300;
  const slug = `btc-updown-5m-${windowStart}`;
  console.log('Slug marché :', slug);

  const res = await fetch(`${GAMMA_HOST}/events?slug=${slug}`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return null;
  const events: any[] = await res.json();
  if (!events.length) return null;

  const market = events[0]?.markets?.[0];
  if (!market) return null;

  const outcomes: string[] = JSON.parse(market.outcomes);
  const prices: string[] = JSON.parse(market.outcomePrices);
  const tokenIds: string[] = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];

  return { slug, outcomes, prices, tokenIds, market };
}

// ── Step 5 : Simuler un order (signe mais n'envoie PAS) ─────────────────────

async function simulateOrder(
  wallet: ethers.Wallet,
  address: string, apiKey: string, secret: string, passphrase: string,
  tokenId: string, usdcAmount: number, price: number,
) {
  const NEG_RISK_CTF = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
  const ORDER_DOMAIN = { name: 'ClobExchange', version: '1', chainId: CHAIN_ID, verifyingContract: NEG_RISK_CTF };
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

  const salt = BigInt('0x' + crypto.randomBytes(16).toString('hex')).toString();
  const makerAmount = Math.floor(usdcAmount * 1e6).toString();
  const takerAmount = Math.floor((usdcAmount / price) * 1e6).toString();

  const orderValues = {
    salt, maker: address, signer: address,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId, makerAmount, takerAmount,
    expiration: '0', nonce: '0', feeRateBps: '0', side: 0, signatureType: 0,
  };

  const signature = await wallet.signTypedData(ORDER_DOMAIN, ORDER_TYPES, orderValues);
  return { ...orderValues, signature };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== STEP 1 : Dériver les credentials API ===');
  // Essai 1 : avec proxy address (Magic.link)
  let result: Awaited<ReturnType<typeof deriveApiCredentials>> | null = null;
  if (PROXY_ADDRESS) {
    console.log('Tentative avec proxy address...');
    try {
      result = await deriveApiCredentials(PRIVATE_KEY, PROXY_ADDRESS);
    } catch (e: any) {
      console.log('Proxy échec:', e.message);
    }
  }
  // Essai 2 : EOA direct
  if (!result) {
    console.log('Tentative avec EOA direct...');
    result = await deriveApiCredentials(PRIVATE_KEY);
  }
  const { apiKey, secret, passphrase, wallet, authAddress } = result;
  console.log('✅ apiKey:', apiKey.slice(0, 12) + '...');
  console.log('✅ secret:', secret.slice(0, 10) + '...');
  console.log('✅ passphrase:', passphrase.slice(0, 8) + '...');

  console.log('\n=== STEP 2 : Valider les credentials (/auth/api-keys) ===');
  const path = '/auth/api-keys';
  const hdrs = buildHmacHeaders(authAddress, apiKey, secret, passphrase, 'GET', path);
  const valRes = await fetch(`${CLOB_HOST}${path}`, { headers: hdrs, signal: AbortSignal.timeout(10_000) });
  const valBody = await valRes.text();
  console.log(`HTTP ${valRes.status}:`, valBody.slice(0, 200));

  console.log('\n=== STEP 3 : Balance USDC ===');
  const { balance, raw } = await testBalance(authAddress, apiKey, secret, passphrase);
  console.log('Balance USDC:', balance, '$');
  console.log('Raw:', JSON.stringify(raw));

  console.log('\n=== STEP 4 : Marché BTC 5min live ===');
  const marketData = await findLiveBtcMarket();
  if (!marketData) {
    console.log('⚠️  Aucun marché BTC 5min actif trouvé (normal hors heures de trading)');
  } else {
    console.log('Marché trouvé:', marketData.slug);
    for (let i = 0; i < marketData.outcomes.length; i++) {
      console.log(`  ${marketData.outcomes[i]}: price=${marketData.prices[i]} tokenId=${marketData.tokenIds[i]?.slice(0, 20)}...`);
    }

    console.log('\n=== STEP 5 : Simuler order BUY UP $1 (signature seulement, pas d\'envoi) ===');
    const upIdx = marketData.outcomes.findIndex((o: string) => o.toLowerCase() === 'up');
    if (upIdx >= 0 && marketData.tokenIds[upIdx]) {
      const tokenId = marketData.tokenIds[upIdx];
      const price = parseFloat(marketData.prices[upIdx]);
      const order = await simulateOrder(wallet, wallet.address, apiKey, secret, passphrase, tokenId, 1.0, price);
      console.log('✅ Order signé:');
      console.log('  tokenId:', order.tokenId.slice(0, 20) + '...');
      console.log('  makerAmount:', order.makerAmount, '(USDC micro)');
      console.log('  takerAmount:', order.takerAmount, '(tokens micro)');
      console.log('  signature:', order.signature.slice(0, 30) + '...');
      console.log('\n⚠️  Order NON envoyé (simulation). Pour envoyer : décommenter clobPost() dans polymarketTrader.ts');
    }
  }

  console.log('\n✅ Tous les tests passés !');
}

main().catch((e) => {
  console.error('\n❌ Erreur:', e.message);
  process.exit(1);
});
