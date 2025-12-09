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

// Get DOGE position first
const positions = await exchange.fetchPositions(['DOGE/USDT:USDT']);
const dogePos = positions.find(p => p.symbol === 'DOGE/USDT:USDT' && Math.abs(parseFloat(p.contracts)) > 0);

if (!dogePos) {
  console.log('Pas de position DOGE');
  process.exit(0);
}

const qty = Math.abs(parseFloat(dogePos.contracts));
console.log('Position DOGE: ' + qty + ' @ $' + dogePos.entryPrice);

// Create a test STOP_MARKET order
console.log('\n1. Creation STOP_MARKET...');
const stopOrder = await exchange.createOrder(
  'DOGE/USDT:USDT',
  'market',
  'sell',
  qty,
  undefined,
  {
    stopLossPrice: parseFloat(dogePos.entryPrice) * 0.99,  // 1% below entry
    reduceOnly: true,
    workingType: 'MARK_PRICE'
  }
);
console.log('   Order ID (algoId):', stopOrder.id);
console.log('   Info:', JSON.stringify(stopOrder.info, null, 2).substring(0, 300));

// Wait a bit
await new Promise(r => setTimeout(r, 1000));

// Try to cancel it
console.log('\n2. Annulation via cancelOrder...');
try {
  await exchange.cancelOrder(stopOrder.id, 'DOGE/USDT:USDT');
  console.log('   SUCCESS - ordre annulé!');
} catch (err) {
  console.log('   ERREUR:', err.message);
  
  // Try with algoId param
  console.log('\n3. Essai avec param algoId...');
  try {
    await exchange.cancelOrder(stopOrder.id, 'DOGE/USDT:USDT', { algoId: stopOrder.id });
    console.log('   SUCCESS avec algoId!');
  } catch (err2) {
    console.log('   ERREUR avec algoId:', err2.message);
  }
}

// Check if order still exists
console.log('\n4. Verification...');
const orders = await exchange.fetchOpenOrders('DOGE/USDT:USDT');
console.log('   Ordres ouverts standard:', orders.length);

await prisma.$disconnect();
