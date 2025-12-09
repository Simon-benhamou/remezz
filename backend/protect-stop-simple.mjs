import ccxt from 'ccxt';
import crypto from 'crypto';

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();

function decrypt(encrypted, appApiKey) {
  const key = crypto.scryptSync(appApiKey, 'apikey-salt', 32);
  const [ivHex, encryptedHex] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedText = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

const APP_API_KEY = process.env.APP_API_KEY;
const apiKeyRecord = await prisma.userApiKey.findFirst({ where: { exchange: 'binance' } });
const exchange = new ccxt.binanceusdm({
  apiKey: decrypt(apiKeyRecord.apiKey, APP_API_KEY),
  secret: decrypt(apiKeyRecord.apiSecret, APP_API_KEY),
  options: { defaultType: 'future' }
});

await exchange.loadMarkets();

const positions = await exchange.fetchPositions();
const openPositions = positions.filter(p => Math.abs(parseFloat(p.contracts)) > 0);

console.log(`\n=== PROTECTION avec STOP_MARKET simple (2% sous entry) ===\n`);

for (const pos of openPositions) {
  const symbol = pos.symbol;
  const side = pos.side;
  const qty = Math.abs(parseFloat(pos.contracts));
  const entryPrice = parseFloat(pos.entryPrice);
  const currentPrice = parseFloat(pos.markPrice);
  const binanceSymbol = symbol.replace('/', '').replace(':USDT', '');
  
  console.log(`--- ${symbol} ---`);
  console.log(`${side.toUpperCase()} ${qty} @ entry $${entryPrice} | Actuel: $${currentPrice}`);
  
  // Check if already has orders
  const existingOrders = await exchange.fetchOpenOrders(symbol);
  if (existingOrders.length > 0) {
    console.log(`⏭️  Deja ${existingOrders.length} ordres - skip`);
    continue;
  }
  
  try {
    const algoOrders = await exchange.fapiPrivateGetOpenAlgoOrders({ symbol: binanceSymbol });
    if (algoOrders.orders && algoOrders.orders.length > 0) {
      console.log(`⏭️  Deja ${algoOrders.orders.length} algo ordres - skip`);
      continue;
    }
  } catch (e) {}
  
  const closeSide = side === 'long' ? 'sell' : 'buy';
  const SL_PERCENT = 2.0;
  
  let slPrice;
  if (side === 'long') {
    slPrice = entryPrice * (1 - SL_PERCENT / 100);
  } else {
    slPrice = entryPrice * (1 + SL_PERCENT / 100);
  }
  
  slPrice = parseFloat(exchange.priceToPrecision(symbol, slPrice));
  
  // Safety check
  if (side === 'long' && slPrice >= currentPrice) {
    console.log(`❌ SL ($${slPrice}) >= prix actuel ($${currentPrice}) - SKIP!`);
    continue;
  }
  if (side === 'short' && slPrice <= currentPrice) {
    console.log(`❌ SL ($${slPrice}) <= prix actuel ($${currentPrice}) - SKIP!`);
    continue;
  }
  
  console.log(`🔒 Placement STOP_MARKET @ $${slPrice} (${SL_PERCENT}% loss)...`);
  
  try {
    // Methode 1: Via stopLossPrice (route vers Algo Order API)
    const order = await exchange.createOrder(
      symbol,
      'market',
      closeSide,
      qty,
      undefined,
      {
        stopLossPrice: slPrice,
        reduceOnly: true
      }
    );
    console.log(`✅ STOP place via stopLossPrice: ID ${order.id}`);
  } catch (e) {
    console.log(`❌ Erreur stopLossPrice: ${e.message}`);
    
    // Methode 2: Direct STOP_MARKET
    try {
      const order = await exchange.createOrder(
        symbol,
        'STOP_MARKET',
        closeSide,
        qty,
        undefined,
        {
          stopPrice: slPrice,
          reduceOnly: true
        }
      );
      console.log(`✅ STOP_MARKET direct: ID ${order.id}`);
    } catch (e2) {
      console.log(`❌ Erreur STOP_MARKET: ${e2.message}`);
    }
  }
  
  await new Promise(r => setTimeout(r, 300));
}

console.log('\n⏳ Verification dans 3s...\n');
await new Promise(r => setTimeout(r, 3000));

// Verify
console.log('=== VERIFICATION ===\n');
for (const pos of openPositions) {
  const symbol = pos.symbol;
  const binanceSymbol = symbol.replace('/', '').replace(':USDT', '');
  
  // Check regular orders
  const orders = await exchange.fetchOpenOrders(symbol);
  
  // Check algo orders
  let algoCount = 0;
  try {
    const algoOrders = await exchange.fapiPrivateGetOpenAlgoOrders({ symbol: binanceSymbol });
    algoCount = algoOrders.orders?.length || 0;
  } catch (e) {}
  
  const total = orders.length + algoCount;
  if (total > 0) {
    console.log(`✅ ${symbol}: ${orders.length} regular + ${algoCount} algo orders`);
    orders.forEach(o => console.log(`   ${o.info?.type || o.type} @ $${o.info?.stopPrice || o.stopPrice}`));
  } else {
    console.log(`❌ ${symbol}: AUCUN ORDRE!`);
  }
}

await prisma.$disconnect();
console.log('\nDone');
