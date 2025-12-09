// Ultra simple stop placement via standard Binance endpoint (not Algo)
import crypto from 'crypto';
import https from 'https';

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
const apiKey = decrypt(apiKeyRecord.apiKey, APP_API_KEY);
const apiSecret = decrypt(apiKeyRecord.apiSecret, APP_API_KEY);

function sign(params, secret) {
  const queryString = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', secret).update(queryString).digest('hex');
  return queryString + '&signature=' + signature;
}

async function binanceRequest(method, endpoint, params = {}) {
  params.timestamp = Date.now();
  params.recvWindow = 5000;
  
  const signedParams = sign(params, apiSecret);
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'fapi.binance.com',
      path: `${endpoint}?${signedParams}`,
      method: method,
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Get open positions
console.log('=== POSITIONS ACTUELLES ===\n');
const positions = await binanceRequest('GET', '/fapi/v2/positionRisk');
const openPos = positions.filter(p => parseFloat(p.positionAmt) !== 0);

if (openPos.length === 0) {
  console.log('Aucune position ouverte!');
  process.exit(0);
}

for (const p of openPos) {
  const qty = parseFloat(p.positionAmt);
  const side = qty > 0 ? 'LONG' : 'SHORT';
  console.log(`${p.symbol}: ${side} ${Math.abs(qty)} @ $${p.entryPrice}`);
  console.log(`   Mark: $${p.markPrice} | PnL: $${parseFloat(p.unRealizedProfit).toFixed(2)}`);
}

// Get precision for each symbol
const exchangeInfo = await binanceRequest('GET', '/fapi/v1/exchangeInfo');

function getPrecision(symbol) {
  const info = exchangeInfo.symbols.find(s => s.symbol === symbol);
  if (!info) return { price: 2, qty: 3 };
  const priceFilter = info.filters.find(f => f.filterType === 'PRICE_FILTER');
  const lotFilter = info.filters.find(f => f.filterType === 'LOT_SIZE');
  return {
    price: priceFilter ? Math.max(0, -Math.log10(parseFloat(priceFilter.tickSize))) : 2,
    qty: lotFilter ? Math.max(0, -Math.log10(parseFloat(lotFilter.stepSize))) : 3
  };
}

console.log('\n=== PLACEMENT DES STOPS (2% sous entry) ===\n');

for (const p of openPos) {
  const symbol = p.symbol;
  const qty = Math.abs(parseFloat(p.positionAmt));
  const entryPrice = parseFloat(p.entryPrice);
  const markPrice = parseFloat(p.markPrice);
  const isLong = parseFloat(p.positionAmt) > 0;
  
  // Calculate stop price (2% from entry)
  const slPercent = 0.02;
  let stopPrice;
  let closeSide;
  
  if (isLong) {
    stopPrice = entryPrice * (1 - slPercent);
    closeSide = 'SELL';
  } else {
    stopPrice = entryPrice * (1 + slPercent);
    closeSide = 'BUY';
  }
  
  // Get precision
  const precision = getPrecision(symbol);
  stopPrice = parseFloat(stopPrice.toFixed(precision.price));
  const formattedQty = parseFloat(qty.toFixed(precision.qty));
  
  console.log(`${symbol}:`);
  console.log(`  Position: ${isLong ? 'LONG' : 'SHORT'} ${formattedQty}`);
  console.log(`  Entry: $${entryPrice} | Mark: $${markPrice}`);
  console.log(`  Stop: $${stopPrice} (${(slPercent*100).toFixed(1)}% loss)`);
  
  // Safety check - stop should not trigger immediately
  if (isLong && stopPrice >= markPrice) {
    console.log(`  ❌ SKIP - Stop ($${stopPrice}) >= Mark ($${markPrice})`);
    continue;
  }
  if (!isLong && stopPrice <= markPrice) {
    console.log(`  ❌ SKIP - Stop ($${stopPrice}) <= Mark ($${markPrice})`);
    continue;
  }
  
  // Check existing orders
  const existingOrders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol });
  if (existingOrders.length > 0) {
    console.log(`  ⏭️  Deja ${existingOrders.length} ordres - skip`);
    continue;
  }
  
  // Place STOP_MARKET via standard endpoint
  console.log(`  📤 Placement STOP_MARKET...`);
  
  const orderParams = {
    symbol: symbol,
    side: closeSide,
    type: 'STOP_MARKET',
    quantity: formattedQty.toString(),
    stopPrice: stopPrice.toString(),
    reduceOnly: 'true',
    workingType: 'MARK_PRICE',
    priceProtect: 'TRUE'
  };
  
  const result = await binanceRequest('POST', '/fapi/v1/order', orderParams);
  
  if (result.orderId) {
    console.log(`  ✅ Order ID: ${result.orderId}`);
  } else if (result.code) {
    console.log(`  ❌ Erreur ${result.code}: ${result.msg}`);
  } else {
    console.log(`  ❓ Reponse:`, result);
  }
  
  console.log('');
  await new Promise(r => setTimeout(r, 200));
}

// Final verification
console.log('\n=== VERIFICATION (apres 3s) ===\n');
await new Promise(r => setTimeout(r, 3000));

for (const p of openPos) {
  const symbol = p.symbol;
  
  // Check standard orders
  const orders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol });
  const stopOrders = orders.filter(o => o.type === 'STOP_MARKET' || o.type === 'TRAILING_STOP_MARKET');
  
  // Check algo orders
  let algoCount = 0;
  try {
    const algoOrders = await binanceRequest('GET', '/fapi/v1/algo/openOrders', { symbol });
    algoCount = algoOrders.orders?.length || 0;
  } catch (e) {}
  
  const total = stopOrders.length + algoCount;
  
  if (total > 0) {
    console.log(`✅ ${symbol}: ${stopOrders.length} stop + ${algoCount} algo`);
    stopOrders.forEach(o => console.log(`   ${o.type} @ $${o.stopPrice}`));
  } else {
    console.log(`❌ ${symbol}: AUCUN STOP!`);
  }
}

await prisma.$disconnect();
console.log('\nDone');
