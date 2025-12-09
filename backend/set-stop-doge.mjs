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

const apiKey = await prisma.userApiKey.findFirst({
  where: { exchange: 'binance' }
});

const decryptedApiKey = decrypt(apiKey.apiKey, APP_API_KEY);
const decryptedSecret = decrypt(apiKey.apiSecret, APP_API_KEY);

const exchange = new ccxt.binanceusdm({
  apiKey: decryptedApiKey,
  secret: decryptedSecret,
  options: { defaultType: 'future' }
});

// Load markets for precision
await exchange.loadMarkets();

// Get DOGE position
const positions = await exchange.fetchPositions(['DOGE/USDT:USDT']);
const dogePos = positions.find(p => p.symbol === 'DOGE/USDT:USDT' && Math.abs(parseFloat(p.contracts)) > 0);

if (!dogePos) {
  console.log('Pas de position DOGE ouverte');
  process.exit(0);
}

console.log('Position DOGE trouvee:');
console.log('  Side: ' + dogePos.side);
console.log('  Qty: ' + dogePos.contracts);
console.log('  Entry: $' + dogePos.entryPrice);
console.log('  Mark: $' + dogePos.markPrice);

const qty = Math.abs(parseFloat(dogePos.contracts));
const markPrice = parseFloat(dogePos.markPrice);
const entryPrice = parseFloat(dogePos.entryPrice);

// Calculate trailing stop level (0.4% from mark since in profit)
const trailingPct = 0.4;
const stopPrice = dogePos.side === 'long' 
  ? markPrice * (1 - trailingPct / 100)
  : markPrice * (1 + trailingPct / 100);

console.log('\nPlacement du stop...');
console.log('  Stop price: $' + stopPrice.toFixed(5));

// Format quantity
const formattedQty = exchange.amountToPrecision('DOGE/USDT:USDT', qty);

try {
  const slOrder = await exchange.createOrder(
    'DOGE/USDT:USDT',
    'market',
    dogePos.side === 'long' ? 'sell' : 'buy',
    formattedQty,
    undefined,
    {
      stopLossPrice: stopPrice,
      reduceOnly: true,
      workingType: 'MARK_PRICE'
    }
  );
  
  console.log('\nSTOP PLACE! Order ID: ' + slOrder.id);
  console.log('La position DOGE est maintenant protegee.');
} catch (err) {
  console.error('Erreur:', err.message);
}

await prisma.$disconnect();
