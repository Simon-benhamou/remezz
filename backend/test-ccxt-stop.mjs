// Use CCXT with explicit stopLossPrice to trigger Algo endpoint
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
  options: { 
    defaultType: 'future',
    // Enable verbose mode to see what endpoint CCXT uses
  }
});

await exchange.loadMarkets();

// Get positions
const positions = await exchange.fetchPositions();
const openPositions = positions.filter(p => Math.abs(parseFloat(p.contracts)) > 0);

console.log('=== POSITIONS ===\n');
for (const p of openPositions) {
  console.log(`${p.symbol}: ${p.side} ${p.contracts} @ $${p.entryPrice}`);
}

console.log('\n=== TEST: Place ONE stop and watch what happens ===\n');

if (openPositions.length > 0) {
  const pos = openPositions[0];
  const symbol = pos.symbol;
  const qty = Math.abs(parseFloat(pos.contracts));
  const entryPrice = parseFloat(pos.entryPrice);
  const closeSide = pos.side === 'long' ? 'sell' : 'buy';
  
  // 2% stop
  const stopPrice = parseFloat(exchange.priceToPrecision(symbol, entryPrice * 0.98));
  const formattedQty = parseFloat(exchange.amountToPrecision(symbol, qty));
  
  console.log(`Test sur ${symbol}:`);
  console.log(`  Qty: ${formattedQty}, Stop: $${stopPrice}`);
  
  // Enable verbose to see API calls
  exchange.verbose = true;
  
  console.log('\n--- CCXT API Call ---\n');
  
  try {
    const order = await exchange.createOrder(
      symbol,
      'market',
      closeSide,
      formattedQty,
      undefined,
      {
        stopLossPrice: stopPrice,
        reduceOnly: true
      }
    );
    
    console.log('\n--- Result ---');
    console.log('Order ID:', order.id);
    console.log('Info:', JSON.stringify(order.info, null, 2));
    
    // Immediately check if it exists
    console.log('\n--- Immediate check ---');
    
    const binanceSymbol = symbol.replace('/', '').replace(':USDT', '');
    const algoOrders = await exchange.fapiPrivateGetOpenAlgoOrders({ symbol: binanceSymbol });
    console.log('Algo orders:', algoOrders.orders?.length || 0);
    
    if (algoOrders.orders && algoOrders.orders.length > 0) {
      console.log('✅ Order existe!');
      algoOrders.orders.forEach(o => console.log(`  ${o.type} @ $${o.stopPrice}`));
    } else {
      console.log('❌ Order a disparu!');
      
      // Check if position still exists
      const newPositions = await exchange.fetchPositions();
      const stillOpen = newPositions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.contracts)) > 0);
      if (stillOpen) {
        console.log('Position existe toujours - ordre annule pour raison inconnue');
      } else {
        console.log('Position FERMEE - le stop s\'est declenche!');
      }
    }
    
  } catch (e) {
    console.log('Erreur:', e.message);
  }
}

await prisma.$disconnect();
