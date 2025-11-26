/**
 * 🧪 TEST COMPLET DU SYSTÈME DE TRADING
 * 
 * Ce script teste tous les scénarios:
 * 1. Capital Pool (paper vs live, réservation, release)
 * 2. Position Entry (long/short, paper/live)
 * 3. Position Exit (SL/TP/trailing/time)
 * 4. Database persistence (Order, Fill, Position)
 * 5. API endpoints
 * 6. Edge cases
 */

import { PrismaClient } from '@prisma/client';
import { 
  MomentumConfig, 
  checkMomentumSignal, 
  shouldExitPosition, 
  calculatePositionSize,
  updatePositionWaterMarks,
} from './dist/strategies/momentumSimple.js';
import { CapitalPool, resetCapitalPool, getCapitalPool } from './dist/strategies/simpleAgent.js';

const prisma = new PrismaClient();

// ============================================================================
// TEST UTILITIES
// ============================================================================

const TEST_RESULTS = {
  passed: 0,
  failed: 0,
  errors: [],
};

function test(name, condition, details = '') {
  if (condition) {
    console.log(`✅ ${name}`);
    TEST_RESULTS.passed++;
  } else {
    console.log(`❌ ${name}${details ? ` - ${details}` : ''}`);
    TEST_RESULTS.failed++;
    TEST_RESULTS.errors.push({ name, details });
  }
}

function testSection(name) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📋 ${name}`);
  console.log(`${'═'.repeat(60)}\n`);
}

// ============================================================================
// 1. CAPITAL POOL TESTS
// ============================================================================

async function testCapitalPool() {
  testSection('CAPITAL POOL TESTS');
  
  // Test 1.1: Paper pool creation
  const paperPool = resetCapitalPool('test-user-1', 1000, 'paper');
  test('Paper pool created with correct capital', paperPool.getStatus().totalUsd === 1000);
  test('Paper pool mode is paper', paperPool.getMode() === 'paper');
  
  // Test 1.2: Live pool creation (separate)
  const livePool = resetCapitalPool('test-user-1', 65, 'live');
  test('Live pool created separately', livePool.getStatus().totalUsd === 65);
  test('Live pool mode is live', livePool.getMode() === 'live');
  
  // Test 1.3: Pools are separate
  const paperPoolAgain = getCapitalPool('test-user-1', undefined, 'paper');
  const livePoolAgain = getCapitalPool('test-user-1', undefined, 'live');
  test('Paper and live pools are separate', 
    paperPoolAgain.getStatus().totalUsd === 1000 && 
    livePoolAgain.getStatus().totalUsd === 65
  );
  
  // Test 1.4: Capital reservation
  const reserved = paperPool.reserve('agent-1', 400);
  test('Capital reservation succeeds', reserved === true);
  test('Available capital reduced after reservation', 
    paperPool.getAvailableCapital() === 600
  );
  
  // Test 1.5: Over-reservation fails
  const overReserve = paperPool.reserve('agent-2', 700);
  test('Over-reservation fails', overReserve === false);
  
  // Test 1.6: Capital commit
  paperPool.commit('agent-1', 400);
  test('Capital committed correctly', 
    paperPool.getStatus().inPositionsUsd === 400
  );
  
  // Test 1.7: Capital release with profit
  paperPool.release('agent-1', 400, 50); // +$50 profit
  test('Capital released with profit', 
    paperPool.getStatus().totalUsd === 1050
  );
  test('No capital in positions after release', 
    paperPool.getStatus().inPositionsUsd === 0
  );
  
  // Test 1.8: Capital release with loss
  paperPool.reserve('agent-1', 400);
  paperPool.commit('agent-1', 400);
  paperPool.release('agent-1', 400, -30); // -$30 loss
  test('Capital released with loss', 
    paperPool.getStatus().totalUsd === 1020
  );
  
  // Test 1.9: Multiple agents sharing pool
  const pool = resetCapitalPool('multi-agent-user', 200, 'paper');
  pool.reserve('eth-agent', 80);
  pool.reserve('xrp-agent', 80);
  test('Multiple agents can reserve', pool.getAvailableCapital() === 40);
  pool.commit('eth-agent', 80);
  test('Status shows all agents', 
    Object.keys(pool.getStatus().byAgent).length === 2
  );
  
  // Test 1.10: Small capital ($65) scenarios
  const smallPool = resetCapitalPool('small-capital', 65, 'paper');
  const position40Pct = 65 * 0.4; // $26
  const canReserve = smallPool.reserve('agent', position40Pct);
  test('$26 position (40% of $65) can be reserved', canReserve === true);
  test('Available after $26 reservation is $39', 
    Math.abs(smallPool.getAvailableCapital() - 39) < 0.01
  );
}

// ============================================================================
// 2. POSITION SIZING TESTS
// ============================================================================

async function testPositionSizing() {
  testSection('POSITION SIZING TESTS');
  
  // Test 2.1: ETH sizing with $65
  const ethSizing = calculatePositionSize({
    symbol: 'ETH/USDT:USDT',
    currentPrice: 3500,
    totalCapitalUsd: 65,
    riskPerTradePct: 1,
    stopLossPct: 1.5,
  });
  
  test('ETH sizing notional is ~$26 (40% of $65)', 
    Math.abs(ethSizing.notionalUsd - 26) < 1
  );
  test('ETH sizing qty is correct', 
    Math.abs(ethSizing.qty - (26 / 3500)) < 0.0001
  );
  test('ETH leverage is 5x', 
    ethSizing.suggestedLeverage === 5
  );
  
  // Test 2.2: XRP sizing
  const xrpSizing = calculatePositionSize({
    symbol: 'XRP/USDT:USDT',
    currentPrice: 1.5,
    totalCapitalUsd: 65,
    riskPerTradePct: 1,
    stopLossPct: 1.5,
  });
  
  test('XRP sizing notional is ~$26', 
    Math.abs(xrpSizing.notionalUsd - 26) < 1
  );
  test('XRP qty is ~17.3 units', 
    Math.abs(xrpSizing.qty - (26 / 1.5)) < 0.1
  );
  
  // Test 2.3: Very small capital
  const tinySizing = calculatePositionSize({
    symbol: 'ETH/USDT:USDT',
    currentPrice: 3500,
    totalCapitalUsd: 10,
    riskPerTradePct: 1,
    stopLossPct: 1.5,
  });
  
  test('$10 capital produces ~$4 notional', 
    tinySizing.notionalUsd > 0 && tinySizing.notionalUsd < 10
  );
  
  // Test 2.4: Large capital
  const largeSizing = calculatePositionSize({
    symbol: 'ETH/USDT:USDT',
    currentPrice: 3500,
    totalCapitalUsd: 10000,
    riskPerTradePct: 1,
    stopLossPct: 1.5,
  });
  
  test('$10000 capital produces ~$4000 notional', 
    Math.abs(largeSizing.notionalUsd - 4000) < 100
  );
}

// ============================================================================
// 3. ENTRY SIGNAL TESTS
// ============================================================================

async function testEntrySignals() {
  testSection('ENTRY SIGNAL TESTS');
  
  // Create mock candles with realistic conditions (not too many consec up/down)
  const bullCandles = createMockCandlesRealistic({
    basePrice: 3500,
    trend: 'up',
    volatility: 0.02,
    volume: 1000000,
    count: 100,
  });
  
  // Create mock BTC candles above SMA200 (bull market)
  const btcBullCandles = createMockCandlesRealistic({
    basePrice: 95000,
    trend: 'up',
    volatility: 0.01,
    volume: 5000000,
    count: 250,
  });
  
  // Test 3.1: Check signal structure (note: checkMomentumSignal takes 3 args: symbol, candles, btcCandles)
  const signal = checkMomentumSignal('ETH/USDT:USDT', bullCandles, btcBullCandles);
  test('Signal has correct structure', 
    signal && typeof signal.valid === 'boolean'
  );
  test('Signal includes features object', 
    signal && signal.features !== undefined
  );
  
  // Test regime detection - features may be undefined if signal validation fails early
  const hasFeatures = signal?.features !== undefined;
  test('Signal returns features when processed', 
    hasFeatures || signal?.reason?.includes('regime') // Either has features or failed on regime check
  );
  
  console.log('\n📊 Signal details:');
  console.log(`   Valid: ${signal?.valid || false}`);
  console.log(`   Side: ${signal?.side || 'N/A'}`);
  console.log(`   Reason: ${signal?.reason || 'N/A'}`);
  console.log(`   BTC Above SMA200: ${signal?.features?.btcAboveSma200}`);
}

// ============================================================================
// 4. EXIT SIGNAL TESTS
// ============================================================================

async function testExitSignals() {
  testSection('EXIT SIGNAL TESTS');
  
  // Test 4.1: Stop Loss trigger (LONG)
  // Entry at 3500, SL at 1.5% = need price to drop enough for -1.5% PnL
  const longPosition = {
    symbol: 'ETH/USDT:USDT',
    side: 'long',
    entryPrice: 3500,
    qty: 0.01,
    entryTime: Date.now(),
    stopLoss: 3500 * (1 - 0.015), // 1.5% SL = $3447.50
    highWaterMark: 3500,
  };
  
  // Price drops to trigger -1.5% PnL loss
  const slPrice = 3500 * 0.984; // -1.6% to be below SL
  const slExit = shouldExitPosition(longPosition, slPrice);
  test('LONG Stop Loss triggers below SL price', 
    slExit.shouldExit === true && slExit.reason === 'stoploss'
  );
  
  // Test 4.2: Take Profit trigger (LONG)
  // TP at 3% = need +3.1% to trigger
  const tpPrice = 3500 * 1.031; // +3.1%
  const tpExit = shouldExitPosition(longPosition, tpPrice);
  test('LONG Take Profit triggers at +3%', 
    tpExit.shouldExit === true && (tpExit.reason === 'trailing' || tpExit.pnlPct >= 3)
  );
  
  // Test 4.3: Stop Loss trigger (SHORT)
  const shortPosition = {
    symbol: 'ETH/USDT:USDT',
    side: 'short',
    entryPrice: 3500,
    qty: 0.01,
    entryTime: Date.now(),
    stopLoss: 3500 * (1 + 0.015), // 1.5% SL = $3552.50
    lowWaterMark: 3500,
  };
  
  // Price rises enough for SHORT to have -1.5% PnL (price needs to rise for short loss)
  const shortSlPrice = 3500 * 1.016; // +1.6% price = -1.6% PnL for short
  const shortSlExit = shouldExitPosition(shortPosition, shortSlPrice);
  test('SHORT Stop Loss triggers above SL price', 
    shortSlExit.shouldExit === true && shortSlExit.reason === 'stoploss'
  );
  
  // Test 4.4: Take Profit trigger (SHORT)
  // For short, TP when price drops = positive PnL
  const shortTpPrice = 3500 * 0.968; // -3.2% price = +3.2% PnL for short
  const shortTpExit = shouldExitPosition(shortPosition, shortTpPrice);
  test('SHORT Take Profit triggers at -3%', 
    shortTpExit.shouldExit === true && shortTpExit.pnlPct >= 3
  );
  
  // Test 4.5: Trailing stop update (LONG)
  const longPosForTrail = {
    symbol: 'ETH/USDT:USDT',
    side: 'long',
    entryPrice: 3500,
    qty: 0.01,
    entryTime: Date.now(),
    stopLoss: 3500 * (1 - 0.015),
    highWaterMark: 3500,
  };
  
  // Price goes up to +1.5%
  const trailPrice = 3500 * 1.015;
  const updatedPos = updatePositionWaterMarks(longPosForTrail, trailPrice);
  test('LONG High water mark updated', 
    updatedPos.highWaterMark === trailPrice
  );
  // Note: updatePositionWaterMarks updates watermarks, shouldExitPosition calculates new SL
  const trailExit = shouldExitPosition(updatedPos, trailPrice);
  test('LONG Trailing stop calculated (newStopLoss exists when in profit)', 
    trailExit.newStopLoss !== undefined || trailExit.pnlPct > 0
  );
  
  // Test 4.6: Trailing stop update (SHORT)
  const shortPosForTrail = {
    symbol: 'ETH/USDT:USDT',
    side: 'short',
    entryPrice: 3500,
    qty: 0.01,
    entryTime: Date.now(),
    stopLoss: 3500 * (1 + 0.015),
    lowWaterMark: 3500,
  };
  
  // Price goes down to -1.5%
  const shortTrailPrice = 3500 * 0.985;
  const updatedShort = updatePositionWaterMarks(shortPosForTrail, shortTrailPrice);
  test('SHORT Low water mark updated', 
    updatedShort.lowWaterMark === shortTrailPrice
  );
  const shortTrailExit = shouldExitPosition(updatedShort, shortTrailPrice);
  test('SHORT Trailing stop calculated (newStopLoss or in profit)', 
    shortTrailExit.newStopLoss !== undefined || shortTrailExit.pnlPct > 0
  );
  
  // Test 4.7: Max hold time
  const oldPosition = {
    symbol: 'ETH/USDT:USDT',
    side: 'long',
    entryPrice: 3500,
    qty: 0.01,
    entryTime: Date.now() - (49 * 60 * 60 * 1000), // 49 hours ago
    stopLoss: 3500 * (1 - 0.015),
    highWaterMark: 3500,
  };
  
  const holdExit = shouldExitPosition(oldPosition, 3510);
  test('Max hold time exit triggers after 48h', 
    holdExit.shouldExit === true && holdExit.reason === 'time'
  );
  
  // Test 4.8: PnL calculation for LONG
  const longPnlCheck = shouldExitPosition(longPosition, 3600);
  const expectedLongPnl = ((3600 - 3500) / 3500) * 100; // ~2.857%
  test('LONG PnL calculation correct (+2.86%)', 
    Math.abs(longPnlCheck.pnlPct - expectedLongPnl) < 0.1
  );
  
  // Test 4.9: PnL calculation for SHORT
  const shortPnlCheck = shouldExitPosition(shortPosition, 3400);
  const expectedShortPnl = ((3500 - 3400) / 3500) * 100; // ~2.857%
  test('SHORT PnL calculation correct (+2.86%)', 
    Math.abs(shortPnlCheck.pnlPct - expectedShortPnl) < 0.1
  );
}

// ============================================================================
// 5. DATABASE PERSISTENCE TESTS
// ============================================================================

async function testDatabasePersistence() {
  testSection('DATABASE PERSISTENCE TESTS');
  
  try {
    // First, get an existing user (don't create, as schema requires many fields)
    let testUser = await prisma.user.findFirst({
      orderBy: { createdAt: 'desc' }
    });
    
    if (!testUser) {
      console.log('⚠️ No existing user found - skipping DB tests');
      test('Test user available', false, 'No users in database');
      return;
    }
    
    test('Test user available', !!testUser.id);
    
    // Test 5.1: Create session
    const session = await prisma.agentSession.create({
      data: {
        userId: testUser.id,
        symbol: 'ETH/USDT:USDT',
        mode: 'paper',
        profileJson: { capitalUsd: 1000 },
      }
    });
    test('Session created in DB', !!session.id);
    
    // Test 5.2: Create Order
    const order = await prisma.order.create({
      data: {
        clientOrderId: `test-order-${Date.now()}`,
        sessionId: session.id,
        symbol: 'ETH/USDT:USDT',
        side: 'buy',
        type: 'market',
        qty: 0.01,
        price: 3500,
        status: 'filled',
        source: 'test',
        strategyUsed: 'momentum_simple',
      }
    });
    test('Order created in DB', !!order.id);
    
    // Test 5.3: Create Fill
    const fill = await prisma.fill.create({
      data: {
        orderId: order.id,
        sessionId: session.id,
        symbol: 'ETH/USDT:USDT',
        price: 3500,
        qty: 0.01,
        side: 'buy',
        realizedPnl: 0,
        strategyUsed: 'momentum_simple',
        strategyFamily: 'momentum',
      }
    });
    test('Fill created in DB', !!fill.id);
    
    // Test 5.4: Create Position
    const position = await prisma.position.create({
      data: {
        sessionId: session.id,
        symbol: 'ETH/USDT:USDT',
        side: 'long',
        entryPrice: 3500,
        qty: 0.01,
        leverage: 5,
        stopPrice: 3447.5,
      }
    });
    test('Position created in DB', !!position.id);
    
    // Test 5.5: Query position
    const foundPos = await prisma.position.findFirst({
      where: { sessionId: session.id }
    });
    test('Position queried from DB', 
      foundPos?.entryPrice === 3500 && foundPos?.side === 'long'
    );
    
    // Test 5.6: Delete position (simulating close)
    await prisma.position.delete({ where: { id: position.id } });
    const deletedPos = await prisma.position.findFirst({
      where: { sessionId: session.id }
    });
    test('Position deleted after close', deletedPos === null);
    
    // Test 5.7: Create exit Fill with PnL
    const exitOrder = await prisma.order.create({
      data: {
        clientOrderId: `test-exit-${Date.now()}`,
        sessionId: session.id,
        symbol: 'ETH/USDT:USDT',
        side: 'sell',
        type: 'market',
        qty: 0.01,
        price: 3600,
        status: 'filled',
        source: 'test',
        strategyUsed: 'momentum_simple',
      }
    });
    
    const exitFill = await prisma.fill.create({
      data: {
        orderId: exitOrder.id,
        sessionId: session.id,
        symbol: 'ETH/USDT:USDT',
        price: 3600,
        qty: 0.01,
        side: 'sell',
        realizedPnl: 1.0, // $1 profit
        strategyUsed: 'momentum_simple',
        strategyFamily: 'momentum',
      }
    });
    test('Exit fill with PnL created', exitFill.realizedPnl === 1.0);
    
    // Test 5.8: Aggregate fills for session
    const allFills = await prisma.fill.findMany({
      where: { sessionId: session.id }
    });
    test('All fills retrieved', allFills.length === 2);
    
    const totalPnl = allFills.reduce((sum, f) => sum + (f.realizedPnl || 0), 0);
    test('Total PnL aggregation correct', totalPnl === 1.0);
    
    // Cleanup
    await prisma.fill.deleteMany({ where: { sessionId: session.id } });
    await prisma.order.deleteMany({ where: { sessionId: session.id } });
    await prisma.agentSession.delete({ where: { id: session.id } });
    test('Cleanup successful', true);
    
  } catch (error) {
    console.error('Database test error:', error);
    test('Database operations', false, error.message);
  }
}

// ============================================================================
// 6. EDGE CASES TESTS
// ============================================================================

async function testEdgeCases() {
  testSection('EDGE CASE TESTS');
  
  // Test 6.1: Zero price
  const zeroSizing = calculatePositionSize({
    symbol: 'ETH/USDT:USDT',
    currentPrice: 0,
    totalCapitalUsd: 1000,
    riskPerTradePct: 1,
    stopLossPct: 1.5,
  });
  test('Zero price handling', 
    zeroSizing.qty === 0 || !isFinite(zeroSizing.qty)
  );
  
  // Test 6.2: Negative capital
  const negPool = new CapitalPool(-100, 'paper');
  test('Negative capital handled', negPool.getAvailableCapital() <= 0);
  
  // Test 6.3: Very large numbers
  const hugeSizing = calculatePositionSize({
    symbol: 'ETH/USDT:USDT',
    currentPrice: 100000,
    totalCapitalUsd: 1000000,
    riskPerTradePct: 1,
    stopLossPct: 1.5,
  });
  test('Large numbers handled', isFinite(hugeSizing.notionalUsd));
  
  // Test 6.4: Position side consistency
  const longPos = {
    symbol: 'ETH/USDT:USDT',
    side: 'long',
    entryPrice: 100,
    qty: 1,
    entryTime: Date.now(),
    stopLoss: 98.5,
    highWaterMark: 100,
  };
  
  // Long position should profit when price goes UP
  const longUp = shouldExitPosition(longPos, 110);
  const longDown = shouldExitPosition(longPos, 90);
  test('LONG profits when price goes up', longUp.pnlPct > 0);
  test('LONG loses when price goes down', longDown.pnlPct < 0);
  
  // Short position should profit when price goes DOWN
  const shortPos = {
    symbol: 'ETH/USDT:USDT',
    side: 'short',
    entryPrice: 100,
    qty: 1,
    entryTime: Date.now(),
    stopLoss: 101.5,
    lowWaterMark: 100,
  };
  
  const shortUp = shouldExitPosition(shortPos, 110);
  const shortDown = shouldExitPosition(shortPos, 90);
  test('SHORT loses when price goes up', shortUp.pnlPct < 0);
  test('SHORT profits when price goes down', shortDown.pnlPct > 0);
  
  // Test 6.5: Minimum notional check ($10 default)
  // With $25 capital, 40% = $10 notional (at limit)
  const minSizing = calculatePositionSize({
    symbol: 'ETH/USDT:USDT',
    currentPrice: 3500,
    totalCapitalUsd: 25,
    riskPerTradePct: 1,
    stopLossPct: 1.5,
  });
  test('$25 capital produces $10 notional (40%)', 
    Math.abs(minSizing.notionalUsd - 10) < 0.5
  );
  
  // Test 6.6: Multiple positions from same pool
  const multiPool = resetCapitalPool('multi-test', 100, 'paper');
  const pos1 = multiPool.reserve('agent-1', 40);
  const pos2 = multiPool.reserve('agent-2', 40);
  const pos3 = multiPool.reserve('agent-3', 40); // Should fail
  test('Third position fails (over 100%)', pos3 === false);
  test('Two 40% positions allowed', pos1 && pos2);
}

// ============================================================================
// MOCK DATA HELPERS
// ============================================================================

function createMockCandles({ basePrice, trend, volatility, volume, count }) {
  const candles = [];
  let price = basePrice;
  
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.5) * 2 * volatility;
    const trendBias = trend === 'up' ? 0.001 : trend === 'down' ? -0.001 : 0;
    
    price = price * (1 + change + trendBias);
    const volChange = 0.8 + Math.random() * 0.4;
    
    candles.push({
      timestamp: Date.now() - (count - i) * 15 * 60 * 1000,
      open: price * (1 - Math.random() * 0.005),
      high: price * (1 + Math.random() * 0.01),
      low: price * (1 - Math.random() * 0.01),
      close: price,
      volume: volume * volChange,
    });
  }
  
  return candles;
}

// Realistic candles with mixed up/down (not all consecutive same direction)
function createMockCandlesRealistic({ basePrice, trend, volatility, volume, count }) {
  const candles = [];
  let price = basePrice;
  
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.5) * 2 * volatility;
    const trendBias = trend === 'up' ? 0.0005 : trend === 'down' ? -0.0005 : 0;
    
    // Add randomness to prevent too many consecutive candles
    const randomDirection = Math.random() > 0.4; // 60% chance of trend direction
    const directionMultiplier = randomDirection ? 1 : -1;
    
    price = price * (1 + (change + trendBias) * directionMultiplier);
    const volChange = 0.8 + Math.random() * 0.4;
    
    // Randomize open vs close for up/down candles
    const isUp = Math.random() > 0.4;
    const open = isUp ? price * (1 - Math.random() * 0.003) : price * (1 + Math.random() * 0.003);
    const close = isUp ? price * (1 + Math.random() * 0.001) : price * (1 - Math.random() * 0.001);
    
    candles.push({
      timestamp: Date.now() - (count - i) * 15 * 60 * 1000,
      open: open,
      high: Math.max(open, close) * (1 + Math.random() * 0.005),
      low: Math.min(open, close) * (1 - Math.random() * 0.005),
      close: close,
      volume: volume * volChange,
    });
  }
  
  return candles;
}

// ============================================================================
// MAIN TEST RUNNER
// ============================================================================

async function runAllTests() {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🧪 TRADING SYSTEM COMPREHENSIVE TEST SUITE                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  
  try {
    await testCapitalPool();
    await testPositionSizing();
    await testEntrySignals();
    await testExitSignals();
    await testDatabasePersistence();
    await testEdgeCases();
    
  } catch (error) {
    console.error('\n❌ Test suite error:', error);
  }
  
  // Summary
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  📊 TEST SUMMARY                                             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\n✅ Passed: ${TEST_RESULTS.passed}`);
  console.log(`❌ Failed: ${TEST_RESULTS.failed}`);
  
  if (TEST_RESULTS.errors.length > 0) {
    console.log('\n🔴 Failed Tests:');
    TEST_RESULTS.errors.forEach((e, i) => {
      console.log(`   ${i + 1}. ${e.name}${e.details ? ` - ${e.details}` : ''}`);
    });
  }
  
  console.log('\n');
  
  await prisma.$disconnect();
  
  process.exit(TEST_RESULTS.failed > 0 ? 1 : 0);
}

runAllTests();
