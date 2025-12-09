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

// Calculate stop at 0.5% loss from entry (more conservative)
const stopLossPct = 0.5;
const stopPrice = entryPrice * (1 - stopLossPct / 100);

console.log('Position DOGE:');
console.log('  Entry: $' + entryPrice);
console.log('  Mark: $' + markPrice);
console.log('  Stop price (0.5% loss from entry): $' + stopPrice.toFixed(5));

// Method 1: Try using createStopOrder if available
console.log('\nPlacement du STOP_MARKET...');
try {
  // Use the private API directly
  const response = await exchange.fapiPrivatePostOrder({
    symbol: 'DOGEUSDT',
    side: 'SELL',
    type: 'STOP_MARKET',
    quantity: qty.toString(),
    stopPrice: stopPrice.toFixed(5),
    reduceOnly: 'true',
    workingType: 'MARK_PRICE'
  });
  console.log('SUCCESS! Order ID:', response.orderId);
  console.log('Response:', JSON.stringify(response, null, 2));
} catch (err) {
  console.log('Erreur STOP_MARKET:', err.message);
  
  // Try method 2: use createOrder with different params
  console.log('\nEssai avec createOrder (triggerPrice)...');
  try {
    const order = await exchange.createOrder(
      'DOGE/USDT:USDT',
      'STOP_MARKET',
      'sell',
      qty,
      undefined,
      {
        stopPrice: stopPrice,
        reduceOnly: true,
        workingType: 'MARK_PRICE'
      }
    );
    console.log('SUCCESS avec createOrder! Order ID:', order.id);
  } catch (err2) {
    console.log('Erreur createOrder:', err2.message);
  }
}

// Verify
console.log('\n=== VERIFICATION ===');
const orders = await exchange.fetchOpenOrders('DOGE/USDT:USDT');
console.log('Ordres ouverts:', orders.length);
for (const o of orders) {
  console.log('  ', o.type, o.side, o.amount, '@ stop', o.stopPrice || o.info?.stopPrice);
}

await prisma.$disconnect();
