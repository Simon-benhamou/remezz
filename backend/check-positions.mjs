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
if (!APP_API_KEY) {
  console.error('APP_API_KEY not set');
  process.exit(1);
}

console.log('Connecting to database...');

const apiKey = await prisma.userApiKey.findFirst({
  where: { exchange: 'binance' }
});

if (!apiKey) {
  console.log('No API key found');
  process.exit(1);
}

const decryptedApiKey = decrypt(apiKey.apiKey, APP_API_KEY);
const decryptedSecret = decrypt(apiKey.apiSecret, APP_API_KEY);

const exchange = new ccxt.binanceusdm({
  apiKey: decryptedApiKey,
  secret: decryptedSecret,
  options: { 
    defaultType: 'future',
    warnOnFetchOpenOrdersWithoutSymbol: false  // Suppress warning
  }
});

// Fetch positions
console.log('\n=== POSITIONS OUVERTES ===');
const positions = await exchange.fetchPositions();
const openPositions = positions.filter(p => Math.abs(parseFloat(p.contracts)) > 0);

if (openPositions.length === 0) {
  console.log('Aucune position ouverte');
} else {
  for (const pos of openPositions) {
    const pnl = parseFloat(pos.unrealizedPnl);
    const pnlPct = ((parseFloat(pos.markPrice) - parseFloat(pos.entryPrice)) / parseFloat(pos.entryPrice) * 100);
    const pnlSign = pnl >= 0 ? '+' : '';
    console.log(pos.symbol + ': ' + pos.side.toUpperCase() + ' ' + pos.contracts + ' @ $' + pos.entryPrice);
    console.log('   Mark: $' + pos.markPrice + ' | PnL: $' + pnl.toFixed(2) + ' (' + pnlSign + pnlPct.toFixed(2) + '%)');
  }
}

// Fetch open orders for each position's symbol
console.log('\n=== ORDRES STOP ===');
let allStopOrders = [];

for (const pos of openPositions) {
  const orders = await exchange.fetchOpenOrders(pos.symbol);
  const stopOrders = orders.filter(o => 
    o.info?.type === 'STOP_MARKET' || 
    o.info?.type === 'TRAILING_STOP_MARKET' ||
    o.type?.includes('stop')
  );
  allStopOrders.push(...stopOrders);
  
  if (stopOrders.length > 0) {
    for (const order of stopOrders) {
      const trigger = order.stopPrice || order.triggerPrice || order.info?.stopPrice || 'N/A';
      const callbackRate = order.info?.callbackRate;
      const activatePrice = order.info?.activatePrice;
      
      let orderType = order.info?.type || order.type;
      
      let details = 'trigger $' + trigger;
      if (callbackRate) {
        details = 'callback ' + callbackRate + '%, activate $' + activatePrice;
      }
      
      console.log(pos.symbol + ': ' + orderType + ' ' + order.side + ' ' + order.amount + ' @ ' + details);
    }
  }
}

// Verification
console.log('\n=== VERIFICATION ===');
for (const pos of openPositions) {
  const hasStop = allStopOrders.some(o => o.symbol === pos.symbol);
  if (hasStop) {
    console.log('OK ' + pos.symbol + ' est protege par un stop');
  } else {
    console.log('ATTENTION ' + pos.symbol + ' n\'a PAS de stop!');
  }
}

await prisma.$disconnect();
console.log('\nDone');
