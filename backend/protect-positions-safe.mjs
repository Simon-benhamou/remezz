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

const apiKeyRecord = await prisma.userApiKey.findFirst({ where: { exchange: 'binance' } });
if (!apiKeyRecord) {
  console.error('No Binance API key found');
  process.exit(1);
}

const exchange = new ccxt.binanceusdm({
  apiKey: decrypt(apiKeyRecord.apiKey, APP_API_KEY),
  secret: decrypt(apiKeyRecord.apiSecret, APP_API_KEY),
  options: { defaultType: 'future' }
});

await exchange.loadMarkets();

// Get open positions
const positions = await exchange.fetchPositions();
const openPositions = positions.filter(p => Math.abs(parseFloat(p.contracts)) > 0);

console.log(`\n=== ${openPositions.length} POSITIONS A PROTEGER ===\n`);

for (const pos of openPositions) {
  const symbol = pos.symbol;
  const side = pos.side; // 'long' or 'short'
  const qty = Math.abs(parseFloat(pos.contracts));
  const entryPrice = parseFloat(pos.entryPrice);
  const currentPrice = parseFloat(pos.markPrice);
  
  console.log(`\n--- ${symbol} ---`);
  console.log(`Position: ${side.toUpperCase()} ${qty} @ $${entryPrice}`);
  console.log(`Prix actuel: $${currentPrice}`);
  
  // Check existing algo orders
  const binanceSymbol = symbol.replace('/', '').replace(':USDT', '');
  let hasAlgoOrders = false;
  
  try {
    const algoOrders = await exchange.fapiPrivateGetOpenAlgoOrders({ symbol: binanceSymbol });
    if (algoOrders.orders && algoOrders.orders.length > 0) {
      console.log(`⚠️  ${algoOrders.orders.length} algo orders existent deja:`);
      algoOrders.orders.forEach(o => {
        console.log(`   - ${o.type} qty:${o.origQty} trigger:${o.stopPrice || o.triggerPrice || '-'}`);
      });
      hasAlgoOrders = true;
    }
  } catch (e) {
    console.log(`Erreur check algo: ${e.message}`);
  }
  
  // Check regular orders
  const regularOrders = await exchange.fetchOpenOrders(symbol);
  const stopOrders = regularOrders.filter(o => 
    o.info?.type?.includes('STOP') || o.type?.includes('stop')
  );
  
  if (stopOrders.length > 0) {
    console.log(`⚠️  ${stopOrders.length} stop orders reguliers existent`);
    hasAlgoOrders = true;
  }
  
  if (hasAlgoOrders) {
    console.log(`⏭️  Position deja protegee, skip`);
    continue;
  }
  
  // Calculate stop and trailing prices
  // For LONG: SL below entry, trailing activates above entry
  // For SHORT: SL above entry, trailing activates below entry
  
  const SL_PERCENT = 2.0;  // 2% stop loss
  const TRAILING_ACTIVATION_PERCENT = 0.8;  // Trailing activates after 0.8% profit
  const TRAILING_CALLBACK = 0.6;  // 0.6% callback rate
  
  let slPrice, trailActivation, closeSide;
  
  if (side === 'long') {
    slPrice = entryPrice * (1 - SL_PERCENT / 100);
    trailActivation = entryPrice * (1 + TRAILING_ACTIVATION_PERCENT / 100);
    closeSide = 'sell';
  } else {
    slPrice = entryPrice * (1 + SL_PERCENT / 100);
    trailActivation = entryPrice * (1 - TRAILING_ACTIVATION_PERCENT / 100);
    closeSide = 'buy';
  }
  
  // Get market precision
  const market = exchange.market(symbol);
  const pricePrecision = market.precision.price;
  
  // Round prices properly
  slPrice = parseFloat(exchange.priceToPrecision(symbol, slPrice));
  trailActivation = parseFloat(exchange.priceToPrecision(symbol, trailActivation));
  
  console.log(`\n📊 Configuration protection:`);
  console.log(`   Stop Loss: $${slPrice} (${SL_PERCENT}% sous entry)`);
  console.log(`   Trailing activation: $${trailActivation} (+${TRAILING_ACTIVATION_PERCENT}% profit)`);
  console.log(`   Trailing callback: ${TRAILING_CALLBACK}%`);
  
  // IMPORTANT: Verify stop price is BELOW current price for LONG (not immediate trigger)
  if (side === 'long' && slPrice >= currentPrice) {
    console.log(`❌ ERREUR: SL ($${slPrice}) >= prix actuel ($${currentPrice}) - skip pour eviter exit immediat!`);
    continue;
  }
  if (side === 'short' && slPrice <= currentPrice) {
    console.log(`❌ ERREUR: SL ($${slPrice}) <= prix actuel ($${currentPrice}) - skip pour eviter exit immediat!`);
    continue;
  }
  
  // Place STOP_MARKET order (backup)
  console.log(`\n🔒 Placement STOP_MARKET...`);
  try {
    const stopOrder = await exchange.createOrder(
      symbol,
      'STOP_MARKET',
      closeSide,
      qty,
      undefined,
      {
        stopPrice: slPrice,
        reduceOnly: true
      }
    );
    console.log(`✅ STOP_MARKET place: ID ${stopOrder.id} @ $${slPrice}`);
  } catch (e) {
    console.log(`❌ Erreur STOP_MARKET: ${e.message}`);
    
    // Try via Algo Order API directly
    console.log(`   Tentative via stopLossPrice...`);
    try {
      const stopOrder = await exchange.createOrder(
        symbol,
        'market',
        closeSide,
        qty,
        undefined,
        {
          stopLossPrice: slPrice,
          reduceOnly: true
        }
      );
      console.log(`✅ STOP via stopLossPrice: ${JSON.stringify(stopOrder.id)}`);
    } catch (e2) {
      console.log(`❌ Erreur stopLossPrice: ${e2.message}`);
    }
  }
  
  // Place TRAILING_STOP_MARKET order
  console.log(`\n📈 Placement TRAILING_STOP_MARKET...`);
  try {
    const trailOrder = await exchange.createOrder(
      symbol,
      'TRAILING_STOP_MARKET',
      closeSide,
      qty,
      undefined,
      {
        activationPrice: trailActivation,
        callbackRate: TRAILING_CALLBACK,
        reduceOnly: true
      }
    );
    console.log(`✅ TRAILING_STOP place: ID ${trailOrder.id} activation@$${trailActivation}`);
  } catch (e) {
    console.log(`❌ Erreur TRAILING: ${e.message}`);
    
    // Try with trailingPercent
    console.log(`   Tentative via trailingPercent...`);
    try {
      const trailOrder = await exchange.createOrder(
        symbol,
        'market',
        closeSide,
        qty,
        undefined,
        {
          trailingPercent: TRAILING_CALLBACK,
          reduceOnly: true
        }
      );
      console.log(`✅ TRAILING via trailingPercent: ${JSON.stringify(trailOrder.id)}`);
    } catch (e2) {
      console.log(`❌ Erreur trailingPercent: ${e2.message}`);
    }
  }
  
  // Small delay between symbols to avoid rate limits
  await new Promise(r => setTimeout(r, 500));
}

console.log(`\n\n=== VERIFICATION FINALE ===\n`);

// Re-check all positions
for (const pos of openPositions) {
  const symbol = pos.symbol;
  const binanceSymbol = symbol.replace('/', '').replace(':USDT', '');
  
  let isProtected = false;
  let details = [];
  
  // Check algo orders
  try {
    const algoOrders = await exchange.fapiPrivateGetOpenAlgoOrders({ symbol: binanceSymbol });
    if (algoOrders.orders && algoOrders.orders.length > 0) {
      isProtected = true;
      algoOrders.orders.forEach(o => {
        if (o.type === 'TRAILING_STOP_MARKET') {
          details.push(`TRAILING @${o.activationPrice} cb:${o.callbackRate}%`);
        } else {
          details.push(`${o.type} @${o.stopPrice || o.triggerPrice}`);
        }
      });
    }
  } catch (e) {}
  
  // Check regular orders
  const regularOrders = await exchange.fetchOpenOrders(symbol);
  const stopOrders = regularOrders.filter(o => o.info?.type?.includes('STOP'));
  if (stopOrders.length > 0) {
    isProtected = true;
    stopOrders.forEach(o => details.push(`${o.info.type} @${o.info.stopPrice}`));
  }
  
  if (isProtected) {
    console.log(`✅ ${symbol}: ${details.join(' + ')}`);
  } else {
    console.log(`❌ ${symbol}: NON PROTEGE!`);
  }
}

await prisma.$disconnect();
console.log('\nDone');
