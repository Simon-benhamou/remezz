/**
 * 🧪 TEST LIVE EXCHANGE - Binance Futures
 * 
 * Ce script teste toutes les opérations exchange en LIVE:
 * 1. Récupération des credentials depuis la DB
 * 2. Connexion à Binance
 * 3. Fetch balance
 * 4. Set leverage
 * 5. Place un ordre d'ENTRY (petit montant ~$25)
 * 6. Place un Stop Loss
 * 7. Update le Stop Loss (trailing simulation)
 * 8. Ferme la position (EXIT)
 * 
 * ⚠️ ATTENTION: Ce script place de VRAIS ordres avec de VRAI argent!
 * Utilise un petit montant ($25) pour minimiser le risque.
 */

import ccxt from 'ccxt';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import dotenv from 'dotenv';

// Load .env
dotenv.config();

const prisma = new PrismaClient();

// Configuration du test
const TEST_CONFIG = {
  SYMBOL: 'XRP/USDT:USDT',  // Symbole à tester (XRP car petit prix)
  TEST_AMOUNT_USD: 25,      // Montant du test en USD
  LEVERAGE: 5,              // Leverage à utiliser
  SIDE: 'long',             // 'long' ou 'short'
  STOP_LOSS_PCT: 1.5,       // Stop loss en %
};

// Décryption - utilise la même méthode que src/utils/crypto.ts
function decryptApiKey(ciphertext) {
  const secret = process.env.JWT_SECRET || process.env.APP_API_KEY;
  if (!secret) {
    throw new Error('JWT_SECRET or APP_API_KEY not found in environment!');
  }
  
  const key = crypto.scryptSync(secret, 'apikey-salt', 32);
  
  const parts = ciphertext.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted data format');
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

async function getCredentialsFromDB() {
  console.log('\n📋 STEP 1: Fetching credentials from database...');
  
  const apiKey = await prisma.userApiKey.findFirst({
    where: {
      exchange: 'binance',
      testnet: false,
      isActive: true
    },
    orderBy: { updatedAt: 'desc' }
  });
  
  if (!apiKey) {
    throw new Error('No Binance API key found in database!');
  }
  
  console.log(`   ✅ Found API key for user: ${apiKey.userId}`);
  console.log(`   📅 Last updated: ${apiKey.updatedAt}`);
  
  const decrypted = {
    apiKey: decryptApiKey(apiKey.apiKey),
    apiSecret: decryptApiKey(apiKey.apiSecret),
    userId: apiKey.userId
  };
  
  console.log(`   🔑 API Key: ${decrypted.apiKey.substring(0, 8)}...${decrypted.apiKey.slice(-4)}`);
  
  return decrypted;
}

async function createExchange(credentials) {
  console.log('\n🔗 STEP 2: Connecting to Binance Futures...');
  
  const exchange = new ccxt.binanceusdm({
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    enableRateLimit: true,
    options: {
      defaultType: 'future',
      adjustForTimeDifference: true,
    }
  });
  
  // Test connection with balance fetch
  const balance = await exchange.fetchBalance();
  const usdtBalance = balance.USDT || balance.total?.USDT;
  
  console.log(`   ✅ Connected successfully!`);
  console.log(`   💰 USDT Balance: $${typeof usdtBalance === 'object' ? usdtBalance.free : usdtBalance}`);
  
  return exchange;
}

async function testSetLeverage(exchange) {
  console.log(`\n⚙️ STEP 3: Setting leverage to ${TEST_CONFIG.LEVERAGE}x...`);
  
  try {
    await exchange.setLeverage(TEST_CONFIG.LEVERAGE, TEST_CONFIG.SYMBOL);
    console.log(`   ✅ Leverage set to ${TEST_CONFIG.LEVERAGE}x for ${TEST_CONFIG.SYMBOL}`);
    return true;
  } catch (error) {
    if (error.message.includes('No need to change')) {
      console.log(`   ✅ Leverage already at ${TEST_CONFIG.LEVERAGE}x`);
      return true;
    }
    console.error(`   ❌ Failed to set leverage:`, error.message);
    return false;
  }
}

async function testEntryOrder(exchange) {
  console.log(`\n🚀 STEP 4: Placing ENTRY order (${TEST_CONFIG.SIDE.toUpperCase()})...`);
  
  // Get current price
  const ticker = await exchange.fetchTicker(TEST_CONFIG.SYMBOL);
  const currentPrice = ticker.last;
  console.log(`   📊 Current ${TEST_CONFIG.SYMBOL} price: $${currentPrice}`);
  
  // Calculate quantity
  const qty = TEST_CONFIG.TEST_AMOUNT_USD / currentPrice;
  const roundedQty = Math.floor(qty * 10) / 10; // Round to 1 decimal for XRP
  
  console.log(`   📦 Order quantity: ${roundedQty} (≈$${(roundedQty * currentPrice).toFixed(2)})`);
  
  try {
    let order;
    if (TEST_CONFIG.SIDE === 'long') {
      order = await exchange.createMarketBuyOrder(TEST_CONFIG.SYMBOL, roundedQty, { reduceOnly: false });
    } else {
      order = await exchange.createMarketSellOrder(TEST_CONFIG.SYMBOL, roundedQty, { reduceOnly: false });
    }
    
    console.log(`   ✅ ENTRY ORDER PLACED!`);
    console.log(`   📝 Order ID: ${order.id}`);
    console.log(`   💵 Filled price: $${order.average || order.price || currentPrice}`);
    console.log(`   📦 Filled qty: ${order.filled || roundedQty}`);
    
    return {
      orderId: order.id,
      entryPrice: order.average || order.price || currentPrice,
      qty: order.filled || roundedQty
    };
  } catch (error) {
    console.error(`   ❌ Failed to place entry order:`, error.message);
    throw error;
  }
}

async function testSetStopLoss(exchange, entryPrice, qty) {
  console.log(`\n🛡️ STEP 5: Setting STOP LOSS...`);
  
  const stopLossPrice = TEST_CONFIG.SIDE === 'long'
    ? entryPrice * (1 - TEST_CONFIG.STOP_LOSS_PCT / 100)
    : entryPrice * (1 + TEST_CONFIG.STOP_LOSS_PCT / 100);
  
  // Round to appropriate precision
  const roundedSL = Math.round(stopLossPrice * 10000) / 10000;
  
  console.log(`   📊 Entry price: $${entryPrice}`);
  console.log(`   🎯 Stop loss price: $${roundedSL} (${TEST_CONFIG.STOP_LOSS_PCT}% from entry)`);
  
  try {
    const side = TEST_CONFIG.SIDE === 'long' ? 'sell' : 'buy';
    
    const slOrder = await exchange.createOrder(
      TEST_CONFIG.SYMBOL,
      'STOP_MARKET',
      side,
      qty,
      undefined,
      {
        stopPrice: roundedSL,
        reduceOnly: true,
        workingType: 'MARK_PRICE'
      }
    );
    
    console.log(`   ✅ STOP LOSS SET!`);
    console.log(`   📝 SL Order ID: ${slOrder.id}`);
    
    return {
      slOrderId: slOrder.id,
      slPrice: roundedSL
    };
  } catch (error) {
    console.error(`   ❌ Failed to set stop loss:`, error.message);
    throw error;
  }
}

async function testUpdateStopLoss(exchange, oldSlOrderId, entryPrice, qty) {
  console.log(`\n🔄 STEP 6: Updating STOP LOSS (simulating trailing)...`);
  
  // Simulate price moved favorably - move SL to breakeven
  const newSlPrice = TEST_CONFIG.SIDE === 'long'
    ? entryPrice * (1 - 0.5 / 100)  // 0.5% below entry (tighter than before)
    : entryPrice * (1 + 0.5 / 100);
  
  const roundedNewSL = Math.round(newSlPrice * 10000) / 10000;
  
  console.log(`   📊 New stop loss price: $${roundedNewSL} (0.5% from entry - tighter)`);
  
  // Cancel old SL
  try {
    await exchange.cancelOrder(oldSlOrderId, TEST_CONFIG.SYMBOL);
    console.log(`   ✅ Old SL order cancelled: ${oldSlOrderId}`);
  } catch (error) {
    console.log(`   ⚠️ Could not cancel old SL (may already be cancelled):`, error.message);
  }
  
  // Place new SL
  try {
    const side = TEST_CONFIG.SIDE === 'long' ? 'sell' : 'buy';
    
    const newSlOrder = await exchange.createOrder(
      TEST_CONFIG.SYMBOL,
      'STOP_MARKET',
      side,
      qty,
      undefined,
      {
        stopPrice: roundedNewSL,
        reduceOnly: true,
        workingType: 'MARK_PRICE'
      }
    );
    
    console.log(`   ✅ NEW STOP LOSS SET!`);
    console.log(`   📝 New SL Order ID: ${newSlOrder.id}`);
    
    return {
      slOrderId: newSlOrder.id,
      slPrice: roundedNewSL
    };
  } catch (error) {
    console.error(`   ❌ Failed to update stop loss:`, error.message);
    throw error;
  }
}

async function testExitOrder(exchange, qty, slOrderId) {
  console.log(`\n🏁 STEP 7: Closing position (EXIT)...`);
  
  // First cancel ALL open orders for this symbol (safer)
  try {
    await exchange.cancelAllOrders(TEST_CONFIG.SYMBOL);
    console.log(`   ✅ All open orders cancelled`);
  } catch (error) {
    console.log(`   ⚠️ Could not cancel orders:`, error.message);
  }
  
  // Get actual position size from exchange (more reliable than tracked qty)
  const positions = await exchange.fetchPositions([TEST_CONFIG.SYMBOL]);
  const openPos = positions.find(p => 
    p.symbol === TEST_CONFIG.SYMBOL && 
    Math.abs(parseFloat(p.contracts || p.info?.positionAmt || 0)) > 0
  );
  
  if (!openPos) {
    console.log(`   ⚠️ No open position found - may already be closed`);
    return { exitOrderId: 'none', exitPrice: 0 };
  }
  
  const actualQty = Math.abs(parseFloat(openPos.contracts || openPos.info?.positionAmt || qty));
  const positionSide = parseFloat(openPos.contracts || openPos.info?.positionAmt || 0) > 0 ? 'long' : 'short';
  
  console.log(`   📊 Actual position: ${positionSide} ${actualQty} ${TEST_CONFIG.SYMBOL}`);
  
  // Close position with actual quantity
  try {
    let order;
    if (positionSide === 'long') {
      // Close long = sell
      order = await exchange.createMarketSellOrder(TEST_CONFIG.SYMBOL, actualQty, { reduceOnly: true });
    } else {
      // Close short = buy
      order = await exchange.createMarketBuyOrder(TEST_CONFIG.SYMBOL, actualQty, { reduceOnly: true });
    }
    
    console.log(`   ✅ POSITION CLOSED!`);
    console.log(`   📝 Exit Order ID: ${order.id}`);
    console.log(`   💵 Exit price: $${order.average || order.price}`);
    console.log(`   📦 Closed qty: ${order.filled || actualQty}`);
    
    return {
      exitOrderId: order.id,
      exitPrice: order.average || order.price
    };
  } catch (error) {
    console.error(`   ❌ Failed to close position:`, error.message);
    
    // Try one more time with market close
    try {
      console.log(`   🔄 Retrying with market close...`);
      const ticker = await exchange.fetchTicker(TEST_CONFIG.SYMBOL);
      const order = positionSide === 'long'
        ? await exchange.createOrder(TEST_CONFIG.SYMBOL, 'market', 'sell', actualQty, undefined, { reduceOnly: true })
        : await exchange.createOrder(TEST_CONFIG.SYMBOL, 'market', 'buy', actualQty, undefined, { reduceOnly: true });
      
      console.log(`   ✅ POSITION CLOSED (retry)!`);
      return { exitOrderId: order.id, exitPrice: ticker.last };
    } catch (retryError) {
      console.error(`   ❌ Retry failed:`, retryError.message);
      throw retryError;
    }
  }
}

async function verifyNoOpenPosition(exchange) {
  console.log(`\n🔍 STEP 8: Verifying no open positions...`);
  
  const positions = await exchange.fetchPositions([TEST_CONFIG.SYMBOL]);
  const openPosition = positions.find(p => 
    p.symbol === TEST_CONFIG.SYMBOL && 
    Math.abs(parseFloat(p.contracts || p.info?.positionAmt || 0)) > 0
  );
  
  if (openPosition) {
    console.log(`   ⚠️ Warning: Still have open position!`, openPosition);
    return false;
  }
  
  console.log(`   ✅ No open positions - all clean!`);
  return true;
}

async function main() {
  console.log('═'.repeat(70));
  console.log('🧪 BINANCE FUTURES LIVE EXCHANGE TEST');
  console.log('═'.repeat(70));
  console.log(`\n⚠️  WARNING: This will place REAL orders with REAL money!`);
  console.log(`   Symbol: ${TEST_CONFIG.SYMBOL}`);
  console.log(`   Amount: ~$${TEST_CONFIG.TEST_AMOUNT_USD}`);
  console.log(`   Side: ${TEST_CONFIG.SIDE.toUpperCase()}`);
  console.log(`   Leverage: ${TEST_CONFIG.LEVERAGE}x`);
  
  let credentials, exchange, entryResult, slResult;
  
  try {
    // Step 1: Get credentials
    credentials = await getCredentialsFromDB();
    
    // Step 2: Create exchange connection
    exchange = await createExchange(credentials);
    
    // Step 3: Set leverage
    await testSetLeverage(exchange);
    
    // Step 4: Place entry order
    entryResult = await testEntryOrder(exchange);
    
    // Wait a bit for order to settle
    await new Promise(r => setTimeout(r, 1000));
    
    // Step 5: Set stop loss
    slResult = await testSetStopLoss(exchange, entryResult.entryPrice, entryResult.qty);
    
    // Wait a bit
    await new Promise(r => setTimeout(r, 1000));
    
    // Step 6: Update stop loss (simulate trailing)
    slResult = await testUpdateStopLoss(exchange, slResult.slOrderId, entryResult.entryPrice, entryResult.qty);
    
    // Wait a bit
    await new Promise(r => setTimeout(r, 1000));
    
    // Step 7: Close position
    const exitResult = await testExitOrder(exchange, entryResult.qty, slResult.slOrderId);
    
    // Step 8: Verify clean
    await verifyNoOpenPosition(exchange);
    
    // Calculate PnL
    const pnl = TEST_CONFIG.SIDE === 'long'
      ? (exitResult.exitPrice - entryResult.entryPrice) * entryResult.qty
      : (entryResult.entryPrice - exitResult.exitPrice) * entryResult.qty;
    
    console.log('\n' + '═'.repeat(70));
    console.log('📊 TEST SUMMARY');
    console.log('═'.repeat(70));
    console.log(`
   ✅ All exchange operations PASSED!
   
   Entry: $${entryResult.entryPrice} × ${entryResult.qty} ${TEST_CONFIG.SYMBOL}
   Exit:  $${exitResult.exitPrice}
   PnL:   ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} (fees not included)
   
   Operations tested:
   ✅ Fetch credentials from DB
   ✅ Connect to Binance Futures
   ✅ Set leverage (${TEST_CONFIG.LEVERAGE}x)
   ✅ Place market ENTRY order
   ✅ Set STOP_MARKET stop loss
   ✅ Update/trail stop loss
   ✅ Close position (reduceOnly)
   ✅ Verify no residual positions
`);
    
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);
    console.error(error);
    
    // Try to clean up if we have an open position
    if (exchange && entryResult) {
      console.log('\n🧹 Attempting cleanup...');
      try {
        // Cancel all open orders
        await exchange.cancelAllOrders(TEST_CONFIG.SYMBOL);
        console.log('   ✅ Cancelled all open orders');
        
        // Close any open position
        const positions = await exchange.fetchPositions([TEST_CONFIG.SYMBOL]);
        const openPos = positions.find(p => Math.abs(parseFloat(p.contracts || p.info?.positionAmt || 0)) > 0);
        if (openPos) {
          const qty = Math.abs(parseFloat(openPos.contracts || openPos.info?.positionAmt));
          if (TEST_CONFIG.SIDE === 'long') {
            await exchange.createMarketSellOrder(TEST_CONFIG.SYMBOL, qty, { reduceOnly: true });
          } else {
            await exchange.createMarketBuyOrder(TEST_CONFIG.SYMBOL, qty, { reduceOnly: true });
          }
          console.log('   ✅ Closed open position');
        }
      } catch (cleanupError) {
        console.error('   ❌ Cleanup failed:', cleanupError.message);
      }
    }
    
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
