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

console.log('=== TOUS LES ORDRES OUVERTS POUR DOGE ===');
const orders = await exchange.fetchOpenOrders('DOGE/USDT:USDT');
console.log('Nombre d\'ordres:', orders.length);

for (const order of orders) {
  console.log('\nOrder ID:', order.id);
  console.log('  Type:', order.type);
  console.log('  Info type:', order.info?.type);
  console.log('  Side:', order.side);
  console.log('  Amount:', order.amount);
  console.log('  Stop price:', order.stopPrice || order.info?.stopPrice);
  console.log('  Status:', order.status);
  console.log('  Full info:', JSON.stringify(order.info, null, 2));
}

await prisma.$disconnect();
