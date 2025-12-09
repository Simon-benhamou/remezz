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

// Check order status
const orderId = '1000000012351110';
console.log('=== STATUS ORDER', orderId, '===');
try {
  const order = await exchange.fetchOrder(orderId, 'DOGE/USDT:USDT');
  console.log('Order status:', order.status);
  console.log('Order type:', order.type);
  console.log('Info:', JSON.stringify(order.info, null, 2));
} catch (err) {
  console.log('Erreur:', err.message);
}

// Also try fetching all orders (including filled)
console.log('\n=== ORDRES RECENTS ===');
const orders = await exchange.fetchOrders('DOGE/USDT:USDT', undefined, 5);
for (const o of orders) {
  console.log(o.id + ': ' + o.type + ' ' + o.side + ' ' + o.status + ' @ ' + (o.stopPrice || o.price));
}

await prisma.$disconnect();
