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
const apiKey = await prisma.userApiKey.findFirst({ where: { exchange: 'binance' } });
const decryptedApiKey = decrypt(apiKey.apiKey, APP_API_KEY);
const decryptedSecret = decrypt(apiKey.apiSecret, APP_API_KEY);

const exchange = new ccxt.binanceusdm({
  apiKey: decryptedApiKey,
  secret: decryptedSecret,
  options: { defaultType: 'future' }
});

await exchange.loadMarkets();

// Get current position
const positions = await exchange.fetchPositions(['DOGE/USDT:USDT']);
const dogePos = positions.find(p => p.symbol === 'DOGE/USDT:USDT' && Math.abs(parseFloat(p.contracts)) > 0);

if (!dogePos) {
  console.log('Pas de position DOGE');
  process.exit(0);
}

const qty = Math.abs(parseFloat(dogePos.contracts));
const markPrice = parseFloat(dogePos.markPrice);
const entryPrice = parseFloat(dogePos.entryPrice);

console.log('Position DOGE:');
console.log('  Entry: $' + entryPrice);
console.log('  Mark: $' + markPrice);
console.log('  Qty: ' + qty);

// Set a trailing stop with 0.5% callback rate
// Activate immediately since price is above entry
const callbackRate = 0.5;  // 0.5% trailing distance

console.log('\nPlacement du TRAILING_STOP_MARKET...');
console.log('  Callback rate: ' + callbackRate + '%');

try {
  // Method from CCXT docs for trailing stop
  const order = await exchange.createOrder(
    'DOGE/USDT:USDT',
    'market',  // CCXT converts to TRAILING_STOP_MARKET when trailingPercent is set
    'sell',
    qty,
    undefined,
    {
      trailingPercent: callbackRate,  // 0.5% callback
      reduceOnly: true,
      workingType: 'MARK_PRICE'
    }
  );
  console.log('\nSUCCESS! Order ID:', order.id);
  console.log('Order info:', JSON.stringify(order.info, null, 2));
} catch (err) {
  console.log('Erreur trailing:', err.message);
  
  // Try direct API
  console.log('\nEssai API directe...');
  try {
    const response = await exchange.fapiPrivatePostOrder({
      symbol: 'DOGEUSDT',
      side: 'SELL',
      type: 'TRAILING_STOP_MARKET',
      quantity: qty.toString(),
      callbackRate: callbackRate.toString(),
      reduceOnly: 'true',
      workingType: 'MARK_PRICE'
    });
    console.log('SUCCESS direct! Order ID:', response.orderId);
  } catch (err2) {
    console.log('Erreur direct:', err2.message);
  }
}

// Check open orders
console.log('\n=== ORDRES OUVERTS ===');
const orders = await exchange.fetchOpenOrders('DOGE/USDT:USDT');
console.log('Nombre ordres:', orders.length);
for (const o of orders) {
  console.log('  ' + o.type + ' ' + o.side + ' qty=' + o.amount);
}

await prisma.$disconnect();
