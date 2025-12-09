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

// Check recent trades for multiple symbols
const symbols = ['XRP/USDT:USDT', 'LINK/USDT:USDT', 'ETH/USDT:USDT', 'DOGE/USDT:USDT'];

for (const symbol of symbols) {
  console.log(`\n=== ${symbol} - TRADES RÉCENTS ===`);
  try {
    const trades = await exchange.fetchMyTrades(symbol, undefined, 10);
    if (trades.length === 0) {
      console.log('Aucun trade');
      continue;
    }
    
    // Group by position (entry/exit)
    for (const trade of trades.slice(-8)) {
      const date = new Date(trade.timestamp);
      const pnl = trade.info.realizedPnl && parseFloat(trade.info.realizedPnl) !== 0 
        ? ` | PnL: $${parseFloat(trade.info.realizedPnl).toFixed(2)}`
        : '';
      console.log(`${date.toLocaleString('fr-FR')} | ${trade.side.padEnd(4)} ${String(trade.amount).padStart(10)} @ $${trade.price}${pnl}`);
    }
  } catch (e) {
    console.log('Erreur:', e.message);
  }
}

await prisma.$disconnect();
