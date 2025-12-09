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

// Call the algo orders endpoint directly
console.log('=== ORDRES ALGO (SL/TP) ===');
try {
  const algoOrders = await exchange.fapiPrivateGetAlgoOpenOrders();
  console.log('Algo orders:', JSON.stringify(algoOrders, null, 2));
} catch (err) {
  console.log('Erreur algo orders:', err.message);
}

// Also check conditional orders
console.log('\n=== ALL OPEN ORDERS (standard API) ===');
try {
  const openOrders = await exchange.fapiPrivateGetOpenOrders({ symbol: 'DOGEUSDT' });
  console.log('Open orders:', JSON.stringify(openOrders, null, 2));
} catch (err) {
  console.log('Erreur:', err.message);
}

await prisma.$disconnect();
