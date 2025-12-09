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

const symbols = ['SEIUSDT', 'ETHUSDT', 'SUIUSDT', 'XRPUSDT', 'LINKUSDT', 'IMXUSDT'];

console.log('=== HISTORIQUE ALGO ORDERS (30 dernières minutes) ===\n');

for (const symbol of symbols) {
  try {
    // Get historical algo orders
    const now = Date.now();
    const thirtyMinsAgo = now - 30 * 60 * 1000;
    
    const history = await exchange.fapiPrivateGetAlgoHistoricalOrders({
      symbol: symbol,
      startTime: thirtyMinsAgo,
      endTime: now,
      limit: 20
    });
    
    if (history.orders && history.orders.length > 0) {
      console.log(`${symbol}: ${history.orders.length} ordres`);
      history.orders.forEach(o => {
        const time = new Date(parseInt(o.createTime)).toLocaleTimeString();
        const status = o.algoStatus;
        const execQty = o.executedQty;
        console.log(`  ${time} | ${o.type} | Status: ${status} | Exec: ${execQty}/${o.origQty}`);
        if (o.triggerPrice) console.log(`    Trigger: ${o.triggerPrice}`);
        if (o.callbackRate) console.log(`    Callback: ${o.callbackRate}% | Activation: ${o.activationPrice}`);
      });
    } else {
      console.log(`${symbol}: Aucun ordre recent`);
    }
  } catch (e) {
    console.log(`${symbol}: Erreur - ${e.message}`);
  }
  console.log('');
}

// Also check positions still exist
console.log('\n=== POSITIONS ACTUELLES ===');
const positions = await exchange.fetchPositions();
const openPositions = positions.filter(p => Math.abs(parseFloat(p.contracts)) > 0);
for (const p of openPositions) {
  console.log(`${p.symbol}: ${p.side} ${p.contracts} @ $${p.entryPrice} | PnL: $${parseFloat(p.unrealizedPnl).toFixed(2)}`);
}

await prisma.$disconnect();
