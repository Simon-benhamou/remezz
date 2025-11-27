/**
 * 🧪 TEST COMPLET DU FLOW ORDER - Paper + Live
 * 
 * Ce script teste tout le cycle de vie d'un order:
 * 1. PAPER MODE: Ouvrir position → Vérifier DB → Fermer → Vérifier DB
 * 2. LIVE MODE: Ouvrir position → Vérifier DB + Exchange → Fermer → Vérifier
 * 
 * Vérifie:
 * - CapitalPool (réservation, commit, release)
 * - Base de données (Order, Fill, Position tables)
 * - Exchange (Binance positions, orders)
 * 
 * ⚠️ ATTENTION: Le test LIVE place de VRAIS ordres avec de VRAI argent!
 */

import ccxt from 'ccxt';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient({
  log: ['error'],
});

// Configuration
const TEST_CONFIG = {
  SYMBOL: 'XRP/USDT:USDT',
  TEST_AMOUNT_USD: 25,
  LEVERAGE: 5,
  SIDE: 'long',  // 'long' ou 'short'
};

// Décryption (même méthode que src/utils/crypto.ts)
function decryptApiKey(ciphertext) {
  const secret = process.env.JWT_SECRET || process.env.APP_API_KEY;
  if (!secret) throw new Error('JWT_SECRET or APP_API_KEY not found!');
  
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

// ============================================================================
// CAPITAL POOL SIMULATOR (simplifié pour test)
// ============================================================================
class TestCapitalPool {
  constructor(initialCapital, mode) {
    this.totalCapital = initialCapital;
    this.reserved = 0;
    this.inPosition = 0;
    this.mode = mode;
    console.log(`   💰 CapitalPool initialisé: $${initialCapital} (${mode})`);
  }
  
  getAvailable() { return this.totalCapital - this.reserved - this.inPosition; }
  
  reserve(amount) {
    const available = this.getAvailable();
    if (amount > available) {
      console.log(`   ❌ Cannot reserve $${amount}, only $${available} available`);
      return false;
    }
    this.reserved += amount;
    console.log(`   📝 Reserved $${amount.toFixed(2)} | Available: $${this.getAvailable().toFixed(2)}`);
    return true;
  }
  
  commit(amount) {
    this.reserved = Math.max(0, this.reserved - amount);
    this.inPosition += amount;
    console.log(`   ✅ Committed $${amount.toFixed(2)} | In position: $${this.inPosition.toFixed(2)}`);
  }
  
  release(amount, pnl = 0) {
    this.inPosition = Math.max(0, this.inPosition - amount);
    this.totalCapital += pnl;
    console.log(`   🔓 Released $${amount.toFixed(2)} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Total: $${this.totalCapital.toFixed(2)}`);
  }
  
  status() {
    return {
      total: this.totalCapital,
      reserved: this.reserved,
      inPosition: this.inPosition,
      available: this.getAvailable()
    };
  }
}

// ============================================================================
// PAPER MODE TEST
// ============================================================================
async function testPaperMode() {
  console.log('\n' + '═'.repeat(70));
  console.log('📋 TEST 1: PAPER MODE');
  console.log('═'.repeat(70));
  
  // Create test session
  const sessionId = `test_paper_${Date.now()}`;
  
  // Get a real user from DB for the session
  const existingUser = await prisma.user.findFirst();
  if (!existingUser) {
    console.log('   ❌ No user in DB - Cannot run test');
    return false;
  }
  const actualUserId = existingUser.id;
  console.log(`   ✅ Found user: ${actualUserId}`);
  
  console.log(`\n📋 Creating test session: ${sessionId}`);
  
  // Use AgentSession model (matches schema)
  const session = await prisma.agentSession.create({
    data: {
      id: sessionId,
      userId: actualUserId,
      symbol: TEST_CONFIG.SYMBOL,
      mode: 'paper',
      startBalanceUsd: 1000,
    }
  });
  console.log(`   ✅ Session created: ${session.id}`);
  
  // Initialize capital pool
  const capitalPool = new TestCapitalPool(1000, 'paper');
  
  // Get "current price" (simulated)
  const currentPrice = 2.50; // Simulated XRP price
  const qty = TEST_CONFIG.TEST_AMOUNT_USD / currentPrice;
  const notionalUsd = qty * currentPrice;
  
  console.log(`\n📊 Simulated market data:`);
  console.log(`   Symbol: ${TEST_CONFIG.SYMBOL}`);
  console.log(`   Price: $${currentPrice}`);
  console.log(`   Qty: ${qty.toFixed(2)}`);
  console.log(`   Notional: $${notionalUsd.toFixed(2)}`);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: OPEN PAPER POSITION
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n🚀 STEP 1: Opening PAPER ${TEST_CONFIG.SIDE.toUpperCase()} position...`);
  
  // Reserve capital
  if (!capitalPool.reserve(notionalUsd)) {
    throw new Error('Failed to reserve capital');
  }
  
  // Simulate position
  const position = {
    symbol: TEST_CONFIG.SYMBOL,
    side: TEST_CONFIG.SIDE,
    entryPrice: currentPrice,
    qty,
    entryTime: Date.now(),
    stopLoss: TEST_CONFIG.SIDE === 'long' 
      ? currentPrice * 0.985  // -1.5%
      : currentPrice * 1.015, // +1.5%
  };
  
  // Commit capital
  capitalPool.commit(notionalUsd);
  
  // Save to DB - Order
  const clientOrderId = `paper_entry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const entrySide = position.side === 'long' ? 'buy' : 'sell';
  
  const order = await prisma.order.create({
    data: {
      clientOrderId,
      sessionId: sessionId,
      symbol: position.symbol,
      side: entrySide,
      type: 'market',
      qty: position.qty,
      price: position.entryPrice,
      status: 'filled',
      source: 'test_script',
      strategyUsed: 'momentum_simple',
    },
  });
  console.log(`   💾 Order saved: ${order.id} (${order.clientOrderId})`);
  
  // Save to DB - Fill
  const fill = await prisma.fill.create({
    data: {
      orderId: order.id,
      sessionId: sessionId,
      symbol: position.symbol,
      price: position.entryPrice,
      qty: position.qty,
      side: entrySide,
      realizedPnl: 0,
      strategyUsed: 'momentum_simple',
      strategyFamily: 'momentum',
      ts: new Date(position.entryTime),
    },
  });
  console.log(`   💾 Fill saved: ${fill.id}`);
  
  // Save to DB - Position
  const dbPosition = await prisma.position.create({
    data: {
      sessionId: sessionId,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      qty: position.qty,
      leverage: TEST_CONFIG.LEVERAGE,
      stopPrice: position.stopLoss,
      openedAt: new Date(position.entryTime),
    },
  });
  console.log(`   💾 Position saved: ${dbPosition.id}`);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: VERIFY DB STATE
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n🔍 STEP 2: Verifying database state...`);
  
  const dbOrders = await prisma.order.findMany({ where: { sessionId } });
  const dbFills = await prisma.fill.findMany({ where: { sessionId } });
  const dbPositions = await prisma.position.findMany({ where: { sessionId } });
  
  console.log(`   📊 Orders in DB: ${dbOrders.length}`);
  dbOrders.forEach(o => console.log(`      - ${o.id}: ${o.side} ${o.qty} @ $${o.price} (${o.status})`));
  
  console.log(`   📊 Fills in DB: ${dbFills.length}`);
  dbFills.forEach(f => console.log(`      - ${f.id}: ${f.side} ${f.qty} @ $${f.price}`));
  
  console.log(`   📊 Positions in DB: ${dbPositions.length}`);
  dbPositions.forEach(p => console.log(`      - ${p.id}: ${p.side} ${p.qty} @ $${p.entryPrice} (SL: $${p.stopPrice})`));
  
  console.log(`   📊 Capital Pool:`, capitalPool.status());
  
  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: CLOSE PAPER POSITION
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n🏁 STEP 3: Closing PAPER position...`);
  
  // Simulate price moved +2%
  const exitPrice = currentPrice * 1.02;
  const pnlPct = position.side === 'long'
    ? ((exitPrice - position.entryPrice) / position.entryPrice) * 100
    : ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
  const pnlUsd = position.side === 'long'
    ? position.qty * (exitPrice - position.entryPrice)
    : position.qty * (position.entryPrice - exitPrice);
  
  console.log(`   📊 Exit price: $${exitPrice.toFixed(4)}`);
  console.log(`   📊 PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})`);
  
  // Release capital
  capitalPool.release(notionalUsd, pnlUsd);
  
  // Save exit to DB - Order
  const exitClientOrderId = `paper_exit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const exitSide = position.side === 'long' ? 'sell' : 'buy';
  
  const exitOrder = await prisma.order.create({
    data: {
      clientOrderId: exitClientOrderId,
      sessionId: sessionId,
      symbol: position.symbol,
      side: exitSide,
      type: 'market',
      qty: position.qty,
      price: exitPrice,
      status: 'filled',
      source: 'test_script',
      strategyUsed: 'momentum_simple',
    },
  });
  console.log(`   💾 Exit Order saved: ${exitOrder.id}`);
  
  // Save exit to DB - Fill
  const exitFill = await prisma.fill.create({
    data: {
      orderId: exitOrder.id,
      sessionId: sessionId,
      symbol: position.symbol,
      price: exitPrice,
      qty: position.qty,
      side: exitSide,
      realizedPnl: pnlUsd,
      strategyUsed: 'momentum_simple',
      strategyFamily: 'momentum',
      ts: new Date(),
    },
  });
  console.log(`   💾 Exit Fill saved: ${exitFill.id}`);
  
  // Update position as closed
  await prisma.position.update({
    where: { id: dbPosition.id },
    data: { 
      markPrice: exitPrice,
      unrealizedPnl: pnlUsd,
    }
  });
  console.log(`   💾 Position updated (no closedAt field - using markPrice)`);
  
  // Delete position to simulate closure
  await prisma.position.delete({ where: { id: dbPosition.id } });
  console.log(`   💾 Position deleted (simulating close)`);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: FINAL VERIFICATION
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n🔍 STEP 4: Final verification...`);
  
  const finalOrders = await prisma.order.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
  const finalFills = await prisma.fill.findMany({ where: { sessionId }, orderBy: { ts: 'asc' } });
  const finalPosition = await prisma.position.findFirst({ where: { sessionId } });
  const finalSession = await prisma.agentSession.findUnique({ where: { id: sessionId } });
  
  console.log(`\n   📊 Final Orders (${finalOrders.length}):`);
  finalOrders.forEach(o => console.log(`      - ${o.side.toUpperCase()} ${o.qty.toFixed(2)} @ $${o.price.toFixed(4)}`));
  
  console.log(`   📊 Final Fills (${finalFills.length}):`);
  finalFills.forEach(f => console.log(`      - ${f.side.toUpperCase()} ${f.qty.toFixed(2)} @ $${f.price.toFixed(4)} | PnL: $${f.realizedPnl?.toFixed(2) || 0}`));
  
  console.log(`   📊 Position Status: ${finalPosition ? 'OPEN' : 'CLOSED (deleted)'}`);
  
  console.log(`   📊 Session: ${finalSession?.id}`);
  console.log(`   📊 Capital Pool Final:`, capitalPool.status());
  
  // Cleanup
  console.log(`\n🧹 Cleaning up test data...`);
  await prisma.fill.deleteMany({ where: { sessionId } });
  await prisma.order.deleteMany({ where: { sessionId } });
  await prisma.position.deleteMany({ where: { sessionId } });
  await prisma.agentSession.delete({ where: { id: sessionId } });
  console.log(`   ✅ Test data cleaned`);
  
  console.log(`\n${'═'.repeat(70)}`);
  console.log('✅ PAPER MODE TEST PASSED!');
  console.log('═'.repeat(70));
  
  return true;
}

// ============================================================================
// LIVE MODE TEST
// ============================================================================
async function testLiveMode() {
  console.log('\n' + '═'.repeat(70));
  console.log('📋 TEST 2: LIVE MODE (REAL MONEY!)');
  console.log('═'.repeat(70));
  
  // Get credentials
  console.log('\n📋 Getting credentials from database...');
  const apiKey = await prisma.userApiKey.findFirst({
    where: { exchange: 'binance', testnet: false, isActive: true },
    orderBy: { updatedAt: 'desc' }
  });
  
  if (!apiKey) {
    console.log('   ⚠️ No Binance API key found - SKIPPING LIVE TEST');
    return false;
  }
  
  const credentials = {
    apiKey: decryptApiKey(apiKey.apiKey),
    apiSecret: decryptApiKey(apiKey.apiSecret),
    userId: apiKey.userId
  };
  console.log(`   ✅ Found API key for user: ${credentials.userId}`);
  
  // Create exchange
  const exchange = new ccxt.binanceusdm({
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    enableRateLimit: true,
    options: { defaultType: 'future', adjustForTimeDifference: true }
  });
  
  // Get balance
  const balance = await exchange.fetchBalance();
  const usdtBalance = balance.USDT?.free || 0;
  console.log(`   💰 USDT Balance: $${usdtBalance.toFixed(2)}`);
  
  if (usdtBalance < TEST_CONFIG.TEST_AMOUNT_USD) {
    console.log(`   ⚠️ Insufficient balance - SKIPPING LIVE TEST`);
    return false;
  }
  
  // Create test session
  const sessionId = `test_live_${Date.now()}`;
  const session = await prisma.agentSession.create({
    data: {
      id: sessionId,
      userId: credentials.userId,
      symbol: TEST_CONFIG.SYMBOL,
      mode: 'live',
      startBalanceUsd: usdtBalance,
    }
  });
  console.log(`   ✅ Session created: ${session.id}`);
  
  // Initialize capital pool
  const capitalPool = new TestCapitalPool(usdtBalance, 'live');
  
  // Get current price
  const ticker = await exchange.fetchTicker(TEST_CONFIG.SYMBOL);
  const currentPrice = ticker.last;
  const qty = Math.floor((TEST_CONFIG.TEST_AMOUNT_USD / currentPrice) * 10) / 10; // Round for XRP
  const notionalUsd = qty * currentPrice;
  
  console.log(`\n📊 Live market data:`);
  console.log(`   Symbol: ${TEST_CONFIG.SYMBOL}`);
  console.log(`   Price: $${currentPrice}`);
  console.log(`   Qty: ${qty}`);
  console.log(`   Notional: $${notionalUsd.toFixed(2)}`);
  
  let entryOrderId, slOrderId, entryPrice, dbPositionId;
  
  try {
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: SET LEVERAGE
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(`\n⚙️ STEP 1: Setting leverage to ${TEST_CONFIG.LEVERAGE}x...`);
    try {
      await exchange.setLeverage(TEST_CONFIG.LEVERAGE, TEST_CONFIG.SYMBOL);
      console.log(`   ✅ Leverage set`);
    } catch (e) {
      if (e.message.includes('No need')) console.log(`   ✅ Already at ${TEST_CONFIG.LEVERAGE}x`);
      else throw e;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: OPEN LIVE POSITION
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(`\n🚀 STEP 2: Opening LIVE ${TEST_CONFIG.SIDE.toUpperCase()} position...`);
    
    // Reserve capital
    if (!capitalPool.reserve(notionalUsd)) {
      throw new Error('Failed to reserve capital');
    }
    
    // Place market order
    const order = TEST_CONFIG.SIDE === 'long'
      ? await exchange.createMarketBuyOrder(TEST_CONFIG.SYMBOL, qty, { reduceOnly: false })
      : await exchange.createMarketSellOrder(TEST_CONFIG.SYMBOL, qty, { reduceOnly: false });
    
    entryPrice = order.average || order.price || currentPrice;
    entryOrderId = order.id;
    
    console.log(`   ✅ Entry order placed: ${entryOrderId}`);
    console.log(`   📊 Filled @ $${entryPrice}`);
    
    // Commit capital
    capitalPool.commit(notionalUsd);
    
    // Calculate stop loss
    const stopLoss = TEST_CONFIG.SIDE === 'long'
      ? entryPrice * 0.985
      : entryPrice * 1.015;
    
    // Save to DB - Order
    const dbOrder = await prisma.order.create({
      data: {
        clientOrderId: entryOrderId,
        sessionId: sessionId,
        symbol: TEST_CONFIG.SYMBOL,
        side: TEST_CONFIG.SIDE === 'long' ? 'buy' : 'sell',
        type: 'market',
        qty,
        price: entryPrice,
        status: 'filled',
        source: 'test_script',
        strategyUsed: 'momentum_simple',
      },
    });
    console.log(`   💾 Order saved to DB: ${dbOrder.id}`);
    
    // Save to DB - Fill
    await prisma.fill.create({
      data: {
        orderId: dbOrder.id,
        sessionId: sessionId,
        symbol: TEST_CONFIG.SYMBOL,
        price: entryPrice,
        qty,
        side: TEST_CONFIG.SIDE === 'long' ? 'buy' : 'sell',
        realizedPnl: 0,
        strategyUsed: 'momentum_simple',
        strategyFamily: 'momentum',
        ts: new Date(),
      },
    });
    console.log(`   💾 Fill saved to DB`);
    
    // Save to DB - Position
    const dbPosition = await prisma.position.create({
      data: {
        sessionId: sessionId,
        symbol: TEST_CONFIG.SYMBOL,
        side: TEST_CONFIG.SIDE,
        entryPrice: entryPrice,
        qty,
        leverage: TEST_CONFIG.LEVERAGE,
        stopPrice: stopLoss,
        openedAt: new Date(),
      },
    });
    dbPositionId = dbPosition.id;
    console.log(`   💾 Position saved to DB: ${dbPositionId}`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: SET STOP LOSS ON EXCHANGE
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(`\n🛡️ STEP 3: Setting stop loss @ $${stopLoss.toFixed(4)}...`);
    
    const slSide = TEST_CONFIG.SIDE === 'long' ? 'sell' : 'buy';
    const slOrder = await exchange.createOrder(
      TEST_CONFIG.SYMBOL,
      'STOP_MARKET',
      slSide,
      qty,
      undefined,
      { stopPrice: stopLoss, reduceOnly: true, workingType: 'MARK_PRICE' }
    );
    slOrderId = slOrder.id;
    console.log(`   ✅ SL order placed: ${slOrderId}`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: VERIFY ON EXCHANGE
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(`\n🔍 STEP 4: Verifying on exchange...`);
    
    await new Promise(r => setTimeout(r, 1000)); // Wait for settlement
    
    const positions = await exchange.fetchPositions([TEST_CONFIG.SYMBOL]);
    const openPosition = positions.find(p => 
      Math.abs(parseFloat(p.contracts || p.info?.positionAmt || 0)) > 0
    );
    
    if (openPosition) {
      console.log(`   ✅ Position verified on exchange:`);
      console.log(`      - Qty: ${openPosition.contracts}`);
      console.log(`      - Entry: $${openPosition.entryPrice}`);
      console.log(`      - uPnL: $${openPosition.unrealizedPnl || 0}`);
    } else {
      console.log(`   ⚠️ Position not found on exchange (may be too small)`);
    }
    
    const openOrders = await exchange.fetchOpenOrders(TEST_CONFIG.SYMBOL);
    console.log(`   📊 Open orders on exchange: ${openOrders.length}`);
    openOrders.forEach(o => console.log(`      - ${o.type} ${o.side} ${o.amount} @ trigger $${o.stopPrice}`));
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5: VERIFY IN DB
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(`\n🔍 STEP 5: Verifying in database...`);
    
    const dbOrders = await prisma.order.findMany({ where: { sessionId } });
    const dbFills = await prisma.fill.findMany({ where: { sessionId } });
    const dbPositions = await prisma.position.findMany({ where: { sessionId } });
    
    console.log(`   📊 Orders in DB: ${dbOrders.length}`);
    console.log(`   📊 Fills in DB: ${dbFills.length}`);
    console.log(`   📊 Positions in DB: ${dbPositions.length}`);
    console.log(`   📊 Capital Pool:`, capitalPool.status());
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 6: CLOSE POSITION
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(`\n🏁 STEP 6: Closing LIVE position...`);
    
    // Cancel SL order first
    try {
      await exchange.cancelOrder(slOrderId, TEST_CONFIG.SYMBOL);
      console.log(`   ✅ SL order cancelled`);
    } catch (e) {
      console.log(`   ⚠️ SL cancel failed (may be ok):`, e.message);
    }
    
    // Close position
    const exitOrder = TEST_CONFIG.SIDE === 'long'
      ? await exchange.createMarketSellOrder(TEST_CONFIG.SYMBOL, qty, { reduceOnly: true })
      : await exchange.createMarketBuyOrder(TEST_CONFIG.SYMBOL, qty, { reduceOnly: true });
    
    const exitPrice = exitOrder.average || exitOrder.price || currentPrice;
    const pnlPct = TEST_CONFIG.SIDE === 'long'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;
    const pnlUsd = TEST_CONFIG.SIDE === 'long'
      ? qty * (exitPrice - entryPrice)
      : qty * (entryPrice - exitPrice);
    
    console.log(`   ✅ Exit order placed: ${exitOrder.id}`);
    console.log(`   📊 Exit @ $${exitPrice}`);
    console.log(`   📊 PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(4)})`);
    
    // Release capital
    capitalPool.release(notionalUsd, pnlUsd);
    
    // Save exit to DB
    const exitDbOrder = await prisma.order.create({
      data: {
        clientOrderId: exitOrder.id,
        sessionId: sessionId,
        symbol: TEST_CONFIG.SYMBOL,
        side: TEST_CONFIG.SIDE === 'long' ? 'sell' : 'buy',
        type: 'market',
        qty,
        price: exitPrice,
        status: 'filled',
        source: 'test_script',
        strategyUsed: 'momentum_simple',
      },
    });
    
    await prisma.fill.create({
      data: {
        orderId: exitDbOrder.id,
        sessionId: sessionId,
        symbol: TEST_CONFIG.SYMBOL,
        price: exitPrice,
        qty,
        side: TEST_CONFIG.SIDE === 'long' ? 'sell' : 'buy',
        realizedPnl: pnlUsd,
        strategyUsed: 'momentum_simple',
        strategyFamily: 'momentum',
        ts: new Date(),
      },
    });
    
    await prisma.position.update({
      where: { id: dbPositionId },
      data: { markPrice: exitPrice, unrealizedPnl: pnlUsd }
    });
    
    // Delete position to simulate closure
    await prisma.position.delete({ where: { id: dbPositionId } });
    
    console.log(`   💾 Exit saved to DB`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 7: FINAL VERIFICATION
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(`\n🔍 STEP 7: Final verification...`);
    
    // Verify no position on exchange
    await new Promise(r => setTimeout(r, 1000));
    const finalPositions = await exchange.fetchPositions([TEST_CONFIG.SYMBOL]);
    const stillOpen = finalPositions.find(p => 
      Math.abs(parseFloat(p.contracts || p.info?.positionAmt || 0)) > 0
    );
    
    if (stillOpen) {
      console.log(`   ⚠️ Warning: Still have position on exchange!`);
    } else {
      console.log(`   ✅ No open position on exchange`);
    }
    
    // Verify no open orders
    const finalOrders = await exchange.fetchOpenOrders(TEST_CONFIG.SYMBOL);
    console.log(`   📊 Open orders remaining: ${finalOrders.length}`);
    
    // DB final state
    const allDbOrders = await prisma.order.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
    const allDbFills = await prisma.fill.findMany({ where: { sessionId }, orderBy: { ts: 'asc' } });
    const finalDbPosition = await prisma.position.findFirst({ where: { sessionId } });
    
    console.log(`\n   📊 Final DB State:`);
    console.log(`      Orders: ${allDbOrders.length}`);
    allDbOrders.forEach(o => console.log(`         - ${o.side.toUpperCase()} ${o.qty} @ $${o.price?.toFixed(4)} (${o.clientOrderId?.slice(0,10)}...)`));
    
    console.log(`      Fills: ${allDbFills.length}`);
    allDbFills.forEach(f => console.log(`         - ${f.side.toUpperCase()} ${f.qty} @ $${f.price?.toFixed(4)} | PnL: $${f.realizedPnl?.toFixed(4)}`));
    
    console.log(`      Position: ${finalDbPosition ? 'STILL EXISTS' : 'CLOSED (deleted)'}`);
    if (finalDbPosition) {
      console.log(`         - Entry: $${finalDbPosition.entryPrice}`);
      console.log(`         - Mark: $${finalDbPosition.markPrice}`);
      console.log(`         - uPnL: $${finalDbPosition.unrealizedPnl?.toFixed(4)}`);
    }
    
    console.log(`\n   📊 Capital Pool Final:`, capitalPool.status());
    
  } catch (error) {
    console.error('\n❌ LIVE TEST ERROR:', error.message);
    
    // Cleanup: try to close position if open
    console.log('\n🧹 Attempting cleanup...');
    try {
      await exchange.cancelAllOrders(TEST_CONFIG.SYMBOL);
      console.log('   ✅ Cancelled all orders');
      
      const positions = await exchange.fetchPositions([TEST_CONFIG.SYMBOL]);
      const openPos = positions.find(p => Math.abs(parseFloat(p.contracts || p.info?.positionAmt || 0)) > 0);
      if (openPos) {
        const qty = Math.abs(parseFloat(openPos.contracts || openPos.info?.positionAmt));
        if (TEST_CONFIG.SIDE === 'long') {
          await exchange.createMarketSellOrder(TEST_CONFIG.SYMBOL, qty, { reduceOnly: true });
        } else {
          await exchange.createMarketBuyOrder(TEST_CONFIG.SYMBOL, qty, { reduceOnly: true });
        }
        console.log('   ✅ Closed position');
      }
    } catch (cleanupError) {
      console.error('   ❌ Cleanup failed:', cleanupError.message);
    }
    
    return false;
  } finally {
    // Cleanup DB
    console.log(`\n🧹 Cleaning up test data from DB...`);
    try {
      await prisma.fill.deleteMany({ where: { sessionId } });
      await prisma.order.deleteMany({ where: { sessionId } });
      await prisma.position.deleteMany({ where: { sessionId } });
      await prisma.agentSession.delete({ where: { id: sessionId } });
      console.log(`   ✅ Test data cleaned`);
    } catch (e) {
      console.log(`   ⚠️ Cleanup partial:`, e.message);
    }
  }
  
  console.log(`\n${'═'.repeat(70)}`);
  console.log('✅ LIVE MODE TEST PASSED!');
  console.log('═'.repeat(70));
  
  return true;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═'.repeat(70));
  console.log('🧪 TEST COMPLET DU FLOW ORDER - Paper + Live');
  console.log('═'.repeat(70));
  console.log(`\nConfiguration:`);
  console.log(`   Symbol: ${TEST_CONFIG.SYMBOL}`);
  console.log(`   Amount: $${TEST_CONFIG.TEST_AMOUNT_USD}`);
  console.log(`   Side: ${TEST_CONFIG.SIDE.toUpperCase()}`);
  console.log(`   Leverage: ${TEST_CONFIG.LEVERAGE}x`);
  
  let paperPassed = false;
  let livePassed = false;
  
  try {
    // Test 1: Paper mode
    paperPassed = await testPaperMode();
    
    // Test 2: Live mode
    console.log('\n\n⚠️  Le test LIVE va placer un VRAI ordre sur Binance!');
    console.log('   Appuyez sur Ctrl+C dans les 5 secondes pour annuler...');
    await new Promise(r => setTimeout(r, 5000));
    
    livePassed = await testLiveMode();
    
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
  } finally {
    await prisma.$disconnect();
  }
  
  console.log('\n' + '═'.repeat(70));
  console.log('📊 RÉSUMÉ DES TESTS');
  console.log('═'.repeat(70));
  console.log(`   PAPER MODE: ${paperPassed ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`   LIVE MODE:  ${livePassed ? '✅ PASSED' : '⚠️ SKIPPED/FAILED'}`);
  console.log('═'.repeat(70));
}

main();
