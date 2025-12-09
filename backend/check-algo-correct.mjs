import ccxt from 'ccxt';
import crypto from 'crypto';
const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();

function decrypt(enc, key) {
  const k = crypto.scryptSync(key, 'apikey-salt', 32);
  const [iv, txt] = enc.split(':');
  const d = crypto.createDecipheriv('aes-256-cbc', k, Buffer.from(iv, 'hex'));
  return Buffer.concat([d.update(Buffer.from(txt, 'hex')), d.final()]).toString();
}

const a = await prisma.userApiKey.findFirst({ where: { exchange: 'binance' } });
const ex = new ccxt.binanceusdm({
  apiKey: decrypt(a.apiKey, process.env.APP_API_KEY),
  secret: decrypt(a.apiSecret, process.env.APP_API_KEY)
});

const symbols = ['ETHUSDT', 'XRPUSDT', 'LINKUSDT', 'SUIUSDT', 'IMXUSDT'];

console.log('=== VERIFICATION COMPLETE DES ALGO ORDERS ===\n');

for (const symbol of symbols) {
  const result = await ex.fapiPrivateGetOpenAlgoOrders({ symbol });
  
  // The result is an array directly, not {orders: [...]}
  const orders = Array.isArray(result) ? result : (result.orders || []);
  
  console.log(`${symbol}: ${orders.length} algo order(s)`);
  
  for (const o of orders) {
    const type = o.orderType || o.type;
    if (type === 'TRAILING_STOP_MARKET') {
      console.log(`  ✅ TRAILING activate@$${o.activatePrice} callback:${o.callbackRate}%`);
    } else if (type === 'STOP_MARKET') {
      console.log(`  ✅ STOP_MARKET trigger@$${o.triggerPrice}`);
    } else {
      console.log(`  ✅ ${type} trigger@$${o.triggerPrice || o.stopPrice}`);
    }
  }
  console.log('');
}

await prisma.$disconnect();
