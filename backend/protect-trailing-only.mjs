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
if (!APP_API_KEY) {
  console.error('APP_API_KEY not set');
  process.exit(1);
}

const apiKeyRecord = await prisma.userApiKey.findFirst({ where: { exchange: 'binance' } });
if (!apiKeyRecord) {
  console.error('No Binance API key found');
  process.exit(1);
}

const exchange = new ccxt.binanceusdm({
  apiKey: decrypt(apiKeyRecord.apiKey, APP_API_KEY),
  secret: decrypt(apiKeyRecord.apiSecret, APP_API_KEY),
  options: { defaultType: 'future' }
});

await exchange.loadMarkets();

// Get open positions
const positions = await exchange.fetchPositions();
const openPositions = positions.filter(p => Math.abs(parseFloat(p.contracts)) > 0);

console.log(`\n=== ${openPositions.length} POSITIONS A PROTEGER ===\n`);
console.log('Strategie: TRAILING_STOP_MARKET avec callback 1.5% (pas de prix activation = actif immediatement)\n');

for (const pos of openPositions) {
  const symbol = pos.symbol;
  const side = pos.side;
  const qty = Math.abs(parseFloat(pos.contracts));
  const entryPrice = parseFloat(pos.entryPrice);
  const currentPrice = parseFloat(pos.markPrice);
  const binanceSymbol = symbol.replace('/', '').replace(':USDT', '');
  
  console.log(`--- ${symbol} ---`);
  console.log(`Position: ${side.toUpperCase()} ${qty} @ entry $${entryPrice} | Prix actuel: $${currentPrice}`);
  
  // Check existing algo orders
  let existingOrders = [];
  try {
    const algoOrders = await exchange.fapiPrivateGetOpenAlgoOrders({ symbol: binanceSymbol });
    existingOrders = algoOrders.orders || [];
  } catch (e) {}
  
  if (existingOrders.length > 0) {
    console.log(`⏭️  Deja ${existingOrders.length} algo orders - skip`);
    continue;
  }
  
  const closeSide = side === 'long' ? 'sell' : 'buy';
  const TRAILING_CALLBACK = 1.5;  // 1.5% callback - gives some room
  
  console.log(`📈 Placement TRAILING_STOP_MARKET callback ${TRAILING_CALLBACK}%...`);
  
  try {
    // Use trailingPercent which activates immediately at current price
    const order = await exchange.createOrder(
      symbol,
      'market',  // ccxt converts to TRAILING_STOP_MARKET with trailingPercent
      closeSide,
      qty,
      undefined,
      {
        trailingPercent: TRAILING_CALLBACK,
        reduceOnly: true
      }
    );
    console.log(`✅ TRAILING place: ID ${order.id}`);
  } catch (e) {
    console.log(`❌ Erreur: ${e.message}`);
    
    // Try direct API
    console.log(`   Tentative directe TRAILING_STOP_MARKET...`);
    try {
      const order = await exchange.createOrder(
        symbol,
        'TRAILING_STOP_MARKET',
        closeSide,
        qty,
        undefined,
        {
          callbackRate: TRAILING_CALLBACK,
          reduceOnly: true
          // No activationPrice = activates at current price
        }
      );
      console.log(`✅ TRAILING place: ID ${order.id}`);
    } catch (e2) {
      console.log(`❌ Erreur: ${e2.message}`);
    }
  }
  
  await new Promise(r => setTimeout(r, 300));
}

// Wait a bit then verify
console.log('\n⏳ Attente 2s avant verification...\n');
await new Promise(r => setTimeout(r, 2000));

console.log('=== VERIFICATION FINALE ===\n');
for (const pos of openPositions) {
  const symbol = pos.symbol;
  const binanceSymbol = symbol.replace('/', '').replace(':USDT', '');
  
  try {
    const algoOrders = await exchange.fapiPrivateGetOpenAlgoOrders({ symbol: binanceSymbol });
    const count = algoOrders.orders?.length || 0;
    
    if (count > 0) {
      console.log(`✅ ${symbol}: ${count} algo order(s)`);
      algoOrders.orders.forEach(o => {
        if (o.type === 'TRAILING_STOP_MARKET') {
          console.log(`   TRAILING callback:${o.callbackRate}% activate:${o.activationPrice || 'immediate'}`);
        } else {
          console.log(`   ${o.type} @${o.stopPrice}`);
        }
      });
    } else {
      console.log(`❌ ${symbol}: AUCUN ORDRE!`);
    }
  } catch (e) {
    console.log(`❌ ${symbol}: Erreur verification - ${e.message}`);
  }
}

await prisma.$disconnect();
console.log('\nDone');
