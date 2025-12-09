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
  let d = decipher.update(encryptedText);
  d = Buffer.concat([d, decipher.final()]);
  return d.toString();
}

const APP = process.env.APP_API_KEY;
const k = await prisma.userApiKey.findFirst({ where: { exchange: 'binance' } });
const ex = new ccxt.binanceusdm({
  apiKey: decrypt(k.apiKey, APP),
  secret: decrypt(k.apiSecret, APP),
  options: { defaultType: 'future' }
});

const symbols = ['SEIUSDT', 'ETHUSDT', 'SUIUSDT', 'XRPUSDT', 'LINKUSDT', 'IMXUSDT'];

console.log('=== VERIFICATION ALGO ORDERS ===\n');
for (const s of symbols) {
  const r = await ex.fapiPrivateGetOpenAlgoOrders({ symbol: s });
  const count = r.orders?.length || 0;
  if (count > 0) {
    console.log(s + ': ' + count + ' algo orders ✅');
    r.orders.forEach(o => {
      if (o.type === 'TRAILING_STOP_MARKET') {
        console.log('  TRAILING activate@' + o.activationPrice + ' cb:' + o.callbackRate + '%');
      } else {
        console.log('  ' + o.type + ' @' + (o.stopPrice || o.triggerPrice));
      }
    });
  } else {
    console.log(s + ': ❌ AUCUN ORDRE');
  }
}
await prisma.$disconnect();
