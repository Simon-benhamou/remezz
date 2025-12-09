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

console.log('=== POSITION DOGE ===');
const positions = await exchange.fetchPositions(['DOGE/USDT:USDT']);
const dogePos = positions.find(p => p.symbol === 'DOGE/USDT:USDT' && Math.abs(parseFloat(p.contracts)) > 0);
if (dogePos) {
  console.log('  Side: ' + dogePos.side);
  console.log('  Qty: ' + dogePos.contracts);
  console.log('  Entry: $' + dogePos.entryPrice);
  console.log('  Mark: $' + dogePos.markPrice);
}

console.log('\n=== ORDRES ALGO (API directe) ===');
try {
  // Use the algo orders endpoint
  const response = await exchange.fapiPrivateV1GetAlgoOpenOrders({});
  console.log('Algo orders:', JSON.stringify(response, null, 2));
} catch (err) {
  console.log('Erreur algo endpoint v1:', err.message);
  
  // Try v2
  try {
    const response = await exchange.fapiPrivateV2GetAlgoOpenOrders({});
    console.log('Algo orders v2:', JSON.stringify(response, null, 2));
  } catch (err2) {
    console.log('Erreur algo endpoint v2:', err2.message);
  }
}

// Try a specific query for the order we created
console.log('\n=== QUERY ORDER STATUS ===');
try {
  const response = await exchange.fapiPrivateGetAlgoOpenOrders({
    algoId: '1000000012355012'
  });
  console.log('Order details:', JSON.stringify(response, null, 2));
} catch (err) {
  console.log('Erreur query:', err.message);
}

await prisma.$disconnect();
