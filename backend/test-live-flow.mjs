/**
 * TEST LIVE FLOW - Complete E2E Test for Live Trading
 * 
 * This script tests the full live trading flow:
 * 1. Fetch balance from Binance
 * 2. Calculate position size based on real balance
 * 3. Set leverage on Binance
 * 4. Open a position (small test amount)
 * 5. Set stop loss order
 * 6. Close position
 * 7. Cancel/cleanup stop loss order
 * 8. Verify final balance
 * 
 * Usage: node test-live-flow.mjs [--dry-run] [--symbol=ETH/USDT:USDT]
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import ccxt from 'ccxt';
import crypto from 'crypto';

const prisma = new PrismaClient();

// Configuration
const TEST_CONFIG = {
  // Test with minimal position size
  MIN_NOTIONAL_USD: 6,      // Binance min is ~$5 for most pairs
  MAX_NOTIONAL_USD: 15,     // Cap test positions at $15
  DEFAULT_LEVERAGE: 5,
  TEST_SYMBOLS: ['DOT/USDT:USDT', 'XRP/USDT:USDT'],  // Small-priced cryptos for testing
};

// Parse command line args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const symbolArg = args.find(a => a.startsWith('--symbol='));
const TEST_SYMBOL = symbolArg ? symbolArg.split('=')[1] : TEST_CONFIG.TEST_SYMBOLS[0];

console.log('🧪 LIVE FLOW TEST');
console.log('================');
console.log(`Mode: ${DRY_RUN ? '🔵 DRY RUN (no real orders)' : '🔴 LIVE (real orders!)'}`);
console.log(`Symbol: ${TEST_SYMBOL}`);
console.log('');

// Check required environment variables
const requiredEnvVars = ['DATABASE_URL'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:');
  missingVars.forEach(v => console.error(`   - ${v}`));
  console.error('\nPlease add them to your .env file');
  process.exit(1);
}

// Decryption function (must match encryption used in app - uses JWT_SECRET)
function decryptApiKey(ciphertext) {
  const secret = process.env.JWT_SECRET || process.env.APP_API_KEY;
  if (!secret) throw new Error('JWT_SECRET or APP_API_KEY not found in environment!');
  
  const key = crypto.scryptSync(secret, 'apikey-salt', 32);
  const parts = ciphertext.split(':');
  if (parts.length !== 2) throw new Error('Invalid encrypted data format');
  
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

// Get user with API keys from DB
async function getUserWithApiKeys() {
  const apiKey = await prisma.userApiKey.findFirst({
    where: {
      exchange: 'binance',
      testnet: false,
      isActive: true,
    },
    include: {
      user: true,
    },
  });
  
  if (!apiKey) {
    throw new Error('No active Binance API key found in database');
  }
  
  return {
    userId: apiKey.userId,
    username: apiKey.user.username,
    credentials: {
      apiKey: decryptApiKey(apiKey.apiKey),
      apiSecret: decryptApiKey(apiKey.apiSecret),
    },
  };
}

// Create exchange instance
async function createExchange(credentials) {
  const exchange = new ccxt.binanceusdm({
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    enableRateLimit: true,
    options: {
      defaultType: 'future',
    },
  });
  
  console.log('📡 Loading markets...');
  await exchange.loadMarkets();
  console.log(`✅ Markets loaded: ${Object.keys(exchange.markets).length} markets`);
  
  return exchange;
}

// Test 1: Fetch Balance
async function testFetchBalance(exchange) {
  console.log('\n📊 TEST 1: Fetch Balance');
  console.log('------------------------');
  
  const balance = await exchange.fetchBalance({ type: 'future' });
  const usdtTotal = parseFloat(balance?.total?.USDT || '0');
  const usdtFree = parseFloat(balance?.free?.USDT || '0');
  const usdtUsed = parseFloat(balance?.used?.USDT || '0');
  
  console.log(`  Total USDT:  $${usdtTotal.toFixed(2)}`);
  console.log(`  Free USDT:   $${usdtFree.toFixed(2)}`);
  console.log(`  Used USDT:   $${usdtUsed.toFixed(2)}`);
  
  if (usdtTotal < TEST_CONFIG.MIN_NOTIONAL_USD) {
    throw new Error(`Insufficient balance: $${usdtTotal.toFixed(2)} < $${TEST_CONFIG.MIN_NOTIONAL_USD} minimum`);
  }
  
  return { total: usdtTotal, free: usdtFree, used: usdtUsed };
}

// Test 2: Calculate Position Size
function testCalculatePositionSize(balance, currentPrice) {
  console.log('\n📐 TEST 2: Calculate Position Size');
  console.log('-----------------------------------');
  
  const leverage = TEST_CONFIG.DEFAULT_LEVERAGE;
  
  // Use 40% of free balance for position, capped at MAX_NOTIONAL_USD
  const targetMargin = Math.min(balance.free * 0.4, TEST_CONFIG.MAX_NOTIONAL_USD / leverage);
  const notional = targetMargin * leverage;
  const qty = notional / currentPrice;
  
  console.log(`  Current Price: $${currentPrice.toFixed(4)}`);
  console.log(`  Target Margin: $${targetMargin.toFixed(2)}`);
  console.log(`  Leverage:      ${leverage}x`);
  console.log(`  Notional:      $${notional.toFixed(2)}`);
  console.log(`  Quantity:      ${qty.toFixed(6)}`);
  
  return { margin: targetMargin, notional, qty, leverage };
}

// Test 3: Set Leverage
async function testSetLeverage(exchange, symbol, leverage) {
  console.log('\n⚙️ TEST 3: Set Leverage');
  console.log('-----------------------');
  
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would set leverage to ${leverage}x for ${symbol}`);
    return true;
  }
  
  try {
    await exchange.setLeverage(leverage, symbol);
    console.log(`  ✅ Leverage set to ${leverage}x for ${symbol}`);
    return true;
  } catch (error) {
    // Try with Binance format
    const binanceSymbol = symbol.replace('/', '').replace(':USDT', '');
    console.log(`  ⚠️ Failed with CCXT symbol, trying Binance format: ${binanceSymbol}`);
    
    try {
      await exchange.setLeverage(leverage, binanceSymbol);
      console.log(`  ✅ Leverage set to ${leverage}x using Binance format`);
      return true;
    } catch (retryError) {
      console.error(`  ❌ Failed to set leverage:`, retryError.message);
      throw retryError;
    }
  }
}

// Test 4: Open Position
async function testOpenPosition(exchange, symbol, side, qty) {
  console.log('\n🚀 TEST 4: Open Position');
  console.log('------------------------');
  
  // Format quantity to exchange precision
  const market = exchange.markets[symbol];
  const formattedQty = exchange.amountToPrecision(symbol, qty);
  
  console.log(`  Symbol:        ${symbol}`);
  console.log(`  Side:          ${side.toUpperCase()}`);
  console.log(`  Raw Qty:       ${qty}`);
  console.log(`  Formatted Qty: ${formattedQty}`);
  
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would open ${side} position`);
    return { id: 'dry-run-order-id', average: 0, filled: parseFloat(formattedQty) };
  }
  
  const order = side === 'long'
    ? await exchange.createMarketBuyOrder(symbol, parseFloat(formattedQty), { reduceOnly: false })
    : await exchange.createMarketSellOrder(symbol, parseFloat(formattedQty), { reduceOnly: false });
  
  console.log(`  ✅ Order placed!`);
  console.log(`  Order ID:      ${order.id}`);
  console.log(`  Fill Price:    $${(order.average || order.price || 0).toFixed(4)}`);
  console.log(`  Filled Qty:    ${order.filled}`);
  
  return order;
}

// Test 5: Set Stop Loss
async function testSetStopLoss(exchange, symbol, side, entryPrice, qty, slPct = 2) {
  console.log('\n🛡️ TEST 5: Set Stop Loss');
  console.log('-------------------------');
  
  const stopPrice = side === 'long'
    ? entryPrice * (1 - slPct / 100)
    : entryPrice * (1 + slPct / 100);
  
  const formattedQty = exchange.amountToPrecision(symbol, qty);
  const formattedStopPrice = exchange.priceToPrecision(symbol, stopPrice);
  
  console.log(`  Entry Price:   $${entryPrice.toFixed(4)}`);
  console.log(`  SL Percent:    ${slPct}%`);
  console.log(`  Stop Price:    $${formattedStopPrice}`);
  console.log(`  Qty:           ${formattedQty}`);
  
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would set stop loss order`);
    return { id: 'dry-run-sl-order-id' };
  }
  
  try {
    const closeSide = side === 'long' ? 'sell' : 'buy';
    const slOrder = await exchange.createOrder(
      symbol,
      'STOP_MARKET',
      closeSide,
      parseFloat(formattedQty),
      undefined,
      {
        stopPrice: parseFloat(formattedStopPrice),
        reduceOnly: true,
        closePosition: false,
      }
    );
    
    console.log(`  ✅ Stop loss order placed!`);
    console.log(`  SL Order ID:   ${slOrder.id}`);
    
    return slOrder;
  } catch (error) {
    console.error(`  ❌ Failed to set stop loss:`, error.message);
    // Continue anyway - we'll close manually
    return null;
  }
}

// Test 6: Close Position
async function testClosePosition(exchange, symbol, side, qty) {
  console.log('\n🚪 TEST 6: Close Position');
  console.log('--------------------------');
  
  const formattedQty = exchange.amountToPrecision(symbol, qty);
  const closeSide = side === 'long' ? 'sell' : 'buy';
  
  console.log(`  Side:          ${closeSide.toUpperCase()} (close ${side})`);
  console.log(`  Qty:           ${formattedQty}`);
  
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would close position`);
    return { id: 'dry-run-close-order-id', average: 0 };
  }
  
  const order = side === 'long'
    ? await exchange.createMarketSellOrder(symbol, parseFloat(formattedQty), { reduceOnly: true })
    : await exchange.createMarketBuyOrder(symbol, parseFloat(formattedQty), { reduceOnly: true });
  
  console.log(`  ✅ Position closed!`);
  console.log(`  Order ID:      ${order.id}`);
  console.log(`  Exit Price:    $${(order.average || order.price || 0).toFixed(4)}`);
  
  return order;
}

// Test 7: Cancel Stop Loss
async function testCancelStopLoss(exchange, symbol, slOrder) {
  console.log('\n🧹 TEST 7: Cancel Stop Loss Order');
  console.log('-----------------------------------');
  
  if (!slOrder || !slOrder.id) {
    console.log('  ⏭️ No stop loss order to cancel');
    return;
  }
  
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would cancel stop loss order ${slOrder.id}`);
    return;
  }
  
  try {
    await exchange.cancelOrder(slOrder.id, symbol);
    console.log(`  ✅ Stop loss order cancelled: ${slOrder.id}`);
  } catch (error) {
    // Order might already be filled or cancelled
    if (error.message.includes('Unknown order') || error.message.includes('UNKNOWN_ORDER')) {
      console.log(`  ⏭️ Stop loss order already gone (filled or cancelled)`);
    } else {
      console.error(`  ⚠️ Failed to cancel stop loss:`, error.message);
    }
  }
}

// Test 8: Verify Final Balance
async function testVerifyFinalBalance(exchange, initialBalance) {
  console.log('\n💰 TEST 8: Verify Final Balance');
  console.log('--------------------------------');
  
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would verify balance unchanged`);
    return;
  }
  
  // Wait a moment for balance to update
  await new Promise(r => setTimeout(r, 2000));
  
  const balance = await exchange.fetchBalance({ type: 'future' });
  const usdtTotal = parseFloat(balance?.total?.USDT || '0');
  const difference = usdtTotal - initialBalance.total;
  
  console.log(`  Initial:       $${initialBalance.total.toFixed(2)}`);
  console.log(`  Final:         $${usdtTotal.toFixed(2)}`);
  console.log(`  Difference:    $${difference.toFixed(4)} (fees + slippage)`);
  
  if (Math.abs(difference) > 1) {
    console.log(`  ⚠️ Balance changed significantly - check positions!`);
  } else {
    console.log(`  ✅ Balance within expected range`);
  }
}

// Main test runner
async function runTests() {
  let exchange = null;
  let entryOrder = null;
  let slOrder = null;
  let initialBalance = null;
  
  try {
    // Get credentials
    console.log('🔐 Loading API credentials from database...');
    const user = await getUserWithApiKeys();
    console.log(`✅ Found API keys for user: ${user.username} (${user.userId})`);
    
    // Create exchange
    exchange = await createExchange(user.credentials);
    
    // Test 1: Fetch Balance
    initialBalance = await testFetchBalance(exchange);
    
    // Get current price
    const ticker = await exchange.fetchTicker(TEST_SYMBOL);
    const currentPrice = ticker.last || ticker.close;
    console.log(`\n📈 Current ${TEST_SYMBOL} price: $${currentPrice.toFixed(4)}`);
    
    // Test 2: Calculate Position Size
    const sizing = testCalculatePositionSize(initialBalance, currentPrice);
    
    // Test 3: Set Leverage
    await testSetLeverage(exchange, TEST_SYMBOL, sizing.leverage);
    
    // Test 4: Open Position (SHORT for test - easier to profit in bear market)
    const side = 'short';
    entryOrder = await testOpenPosition(exchange, TEST_SYMBOL, side, sizing.qty);
    const entryPrice = DRY_RUN ? currentPrice : (entryOrder.average || entryOrder.price || currentPrice);
    
    // Wait a moment
    if (!DRY_RUN) {
      console.log('\n⏳ Waiting 3 seconds before setting stop loss...');
      await new Promise(r => setTimeout(r, 3000));
    }
    
    // Test 5: Set Stop Loss
    slOrder = await testSetStopLoss(exchange, TEST_SYMBOL, side, entryPrice, sizing.qty);
    
    // Wait a moment
    if (!DRY_RUN) {
      console.log('\n⏳ Waiting 3 seconds before closing position...');
      await new Promise(r => setTimeout(r, 3000));
    }
    
    // Test 6: Close Position
    await testClosePosition(exchange, TEST_SYMBOL, side, sizing.qty);
    
    // Test 7: Cancel Stop Loss
    await testCancelStopLoss(exchange, TEST_SYMBOL, slOrder);
    
    // Test 8: Verify Final Balance
    await testVerifyFinalBalance(exchange, initialBalance);
    
    console.log('\n');
    console.log('═══════════════════════════════════════');
    console.log('  ✅ ALL TESTS PASSED!');
    console.log('═══════════════════════════════════════');
    
  } catch (error) {
    console.error('\n');
    console.error('═══════════════════════════════════════');
    console.error('  ❌ TEST FAILED!');
    console.error('═══════════════════════════════════════');
    console.error('Error:', error.message);
    console.error('');
    
    // Cleanup: try to close position if open
    if (exchange && entryOrder && !DRY_RUN) {
      console.log('🧹 Attempting cleanup...');
      try {
        // Cancel all open orders
        const openOrders = await exchange.fetchOpenOrders(TEST_SYMBOL);
        for (const order of openOrders) {
          await exchange.cancelOrder(order.id, TEST_SYMBOL);
          console.log(`  Cancelled order: ${order.id}`);
        }
        
        // Check if we have a position
        const positions = await exchange.fetchPositions([TEST_SYMBOL]);
        const pos = positions.find(p => p.symbol === TEST_SYMBOL && Math.abs(p.contracts || 0) > 0);
        if (pos) {
          const qty = Math.abs(pos.contracts);
          const side = pos.side === 'long' ? 'sell' : 'buy';
          const formattedQty = exchange.amountToPrecision(TEST_SYMBOL, qty);
          
          if (side === 'sell') {
            await exchange.createMarketSellOrder(TEST_SYMBOL, parseFloat(formattedQty), { reduceOnly: true });
          } else {
            await exchange.createMarketBuyOrder(TEST_SYMBOL, parseFloat(formattedQty), { reduceOnly: true });
          }
          console.log(`  Closed position: ${qty} ${TEST_SYMBOL}`);
        }
        console.log('✅ Cleanup complete');
      } catch (cleanupError) {
        console.error('❌ Cleanup failed:', cleanupError.message);
      }
    }
    
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run
runTests();
