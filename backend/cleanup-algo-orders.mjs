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

console.log('=== ANNULATION DE TOUS LES ORDRES CONDITIONNELS DOGE ===\n');

try {
  // Cancel all open orders for DOGE (this should include algo orders)
  await exchange.cancelAllOrders('DOGE/USDT:USDT');
  console.log('Tous les ordres DOGE annulés via cancelAllOrders');
} catch (err) {
  console.log('Erreur cancelAllOrders:', err.message);
}

// Try direct API to cancel algo orders
console.log('\nEssai annulation via API directe...');
try {
  const response = await exchange.fapiPrivateDeleteAllOpenOrders({
    symbol: 'DOGEUSDT'
  });
  console.log('Response:', JSON.stringify(response, null, 2));
} catch (err) {
  console.log('Erreur API directe:', err.message);
}

console.log('\n✅ Ordres nettoyés. Vérifie sur Binance.');

await prisma.$disconnect();
