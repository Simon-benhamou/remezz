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
  options: { defaultType: 'future' }
});

const symbols = ['SEI/USDT:USDT', 'ETH/USDT:USDT', 'SUI/USDT:USDT', 'XRP/USDT:USDT', 'LINK/USDT:USDT', 'IMX/USDT:USDT'];

console.log('=== ORDRES FERMES RECEMMENT ===\n');

for (const symbol of symbols) {
  try {
    // Fetch recent closed orders
    const orders = await exchange.fetchClosedOrders(symbol, Date.now() - 60*60*1000, 20);
    
    if (orders.length > 0) {
      console.log(`${symbol}: ${orders.length} ordres recents`);
      orders.slice(-5).forEach(o => {
        const time = new Date(o.timestamp).toLocaleTimeString();
        console.log(`  ${time} | ${o.info?.type || o.type} | ${o.status} | qty:${o.amount} | prix:${o.price || o.info?.stopPrice || '-'}`);
      });
    } else {
      console.log(`${symbol}: Aucun ordre recent`);
    }
  } catch (e) {
    console.log(`${symbol}: Erreur - ${e.message}`);
  }
  console.log('');
}

// Check trades/fills
console.log('\n=== TRADES RECENTS ===\n');
for (const symbol of symbols) {
  try {
    const trades = await exchange.fetchMyTrades(symbol, Date.now() - 60*60*1000, 10);
    if (trades.length > 0) {
      console.log(`${symbol}: ${trades.length} trades`);
      trades.slice(-3).forEach(t => {
        const time = new Date(t.timestamp).toLocaleTimeString();
        console.log(`  ${time} | ${t.side} ${t.amount} @ $${t.price}`);
      });
    }
  } catch (e) {}
}

await prisma.$disconnect();
