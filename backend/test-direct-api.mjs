// Direct Binance API call to place stop order (bypass CCXT)
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
  const url = `https://fapi.binance.com${endpoint}?${signedParams}`;
  
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: method,
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }, (res) => {
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

// Get positions first
console.log('=== Positions via API directe ===\n');
const positions = await binanceRequest('GET', '/fapi/v2/positionRisk');
const openPos = positions.filter(p => parseFloat(p.positionAmt) !== 0);

for (const p of openPos) {
  console.log(`${p.symbol}: ${p.positionAmt} @ $${p.entryPrice} | Mark: $${p.markPrice}`);
}

// Test placing one STOP_MARKET order directly via Algo endpoint
console.log('\n=== Test placement STOP direct via Algo API ===\n');

const testSymbol = 'SEIUSDT';
const testPos = openPos.find(p => p.symbol === testSymbol);

if (testPos) {
  const qty = Math.abs(parseFloat(testPos.positionAmt));
  const entryPrice = parseFloat(testPos.entryPrice);
  const stopPrice = (entryPrice * 0.98).toFixed(4);  // 2% below
  
  console.log(`Placement STOP_MARKET pour ${testSymbol}:`);
  console.log(`  Qty: ${qty}, Stop @ $${stopPrice}`);
  
  // Place via Algo Order endpoint
  const orderParams = {
    symbol: testSymbol,
    side: 'SELL',
    type: 'STOP_MARKET',
    quantity: qty,
    stopPrice: stopPrice,
    reduceOnly: 'true',
    workingType: 'MARK_PRICE'
  };
  
  console.log('\nAppel API: POST /fapi/v1/order');
  console.log('Params:', JSON.stringify(orderParams, null, 2));
  
  const result = await binanceRequest('POST', '/fapi/v1/order', orderParams);
  console.log('\nResultat:', JSON.stringify(result, null, 2));
  
  // Wait and check if order exists
  console.log('\n⏳ Attente 2s...');
  await new Promise(r => setTimeout(r, 2000));
  
  // Check open orders
  const openOrders = await binanceRequest('GET', '/fapi/v1/openOrders', { symbol: testSymbol });
  console.log(`\nOrdres ouverts pour ${testSymbol}:`, openOrders.length);
  if (openOrders.length > 0) {
    openOrders.forEach(o => console.log(`  ${o.type} @ $${o.stopPrice}`));
  }
  
  // Check algo orders
  const algoOrders = await binanceRequest('GET', '/fapi/v1/algo/openOrders', { symbol: testSymbol });
  console.log(`Algo orders pour ${testSymbol}:`, algoOrders.orders?.length || 0);
}

await prisma.$disconnect();
