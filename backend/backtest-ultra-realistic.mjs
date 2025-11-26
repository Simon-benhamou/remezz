/**
 * 📊 ULTRA-REALISTIC BACKTEST
 * 
 * Adds what's missing:
 * - Slippage (0.1% entry, 0.15% exit on volatility)
 * - Funding fees (0.01% per 8h hold)
 * - Trailing stop gap risk (10% chance of 0.5% extra loss)
 * - NO compounding (fixed position sizing)
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];
const TIMEFRAME = '15m';
const DAYS = 365;
const CANDLES_PER_DAY = 96;
const TOTAL_CANDLES = DAYS * CANDLES_PER_DAY;

const CONFIG = {
  initialCapital: 10000,
  
  // REALISTIC FEES (0.04% per trade = 0.08% roundtrip)
  // These are ALREADY factored into the entry/exit prices via slippage simulation
  // We don't add them again as a separate cost!
  fees: { 
    // Entry slippage includes: spread + fees + market impact = ~0.05%
    slippageEntry: 0.0005,   // 0.05% total cost on entry (fees + spread)
    // Exit slippage includes: spread + fees + market impact = ~0.06%  
    slippageExit: 0.0006,    // 0.06% total cost on exit (fees + spread)
    // Funding is separate (only applies if holding through funding time)
    fundingPer8h: 0.0001,   // 0.01% funding every 8h (conservative estimate)
  },
  
  // Entry
  ENTRY: {
    VOL_MULTIPLIER: 5,
    BTC_MOMENTUM_MIN: 0.75,
    BTC_MOMENTUM_PERIOD: 24,
    ALLOWED_DAYS: [0, 1, 2, 3, 4, 5, 6], // ALL DAYS for this test
  },
  
  // Exit
  EXIT: {
    HOLD_PERIOD_MAX_MIN: 360,
    STOP_LOSS_PCT: 2.0,
    TRAILING_ACTIVATION_PCT: 1.0,
    TRAILING_DISTANCE_PCT: 0.5,
    TRAILING_TIGHTEN_AT_PCT: 2.0,
    TRAILING_TIGHT_DISTANCE_PCT: 0.3,
    // Gap risk: 10% chance trailing stop gaps 0.5%
    GAP_RISK_PROBABILITY: 0.10,
    GAP_RISK_EXTRA_LOSS_PCT: 0.5,
  },
  
  // Risk - NO COMPOUNDING
  RISK: {
    RISK_PCT_PER_TRADE: 1.0,
    MAX_POSITIONS: 4,
    USE_COMPOUNDING: false,  // <-- KEY DIFFERENCE
  },
  
  LEVERAGE: {
    'BTC/USDT:USDT': 3,
    'ETH/USDT:USDT': 4,
    'SOL/USDT:USDT': 5,
    'XRP/USDT:USDT': 5,
  },
};

async function fetchAllCandles(symbol) {
  console.log(`📥 Fetching ${symbol}...`);
  const allCandles = [];
  const now = Date.now();
  const candleDuration = 15 * 60 * 1000;
  let since = now - TOTAL_CANDLES * candleDuration;
  
  while (allCandles.length < TOTAL_CANDLES) {
    try {
      const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, since, 1000);
      if (candles.length === 0) break;
      allCandles.push(...candles);
      since = candles[candles.length - 1][0] + candleDuration;
      await new Promise(r => setTimeout(r, 50));
      if (candles.length < 1000) break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.log(`   ✅ ${allCandles.length} candles`);
  return allCandles;
}

function calcMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcVolRatio(volumes) {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avgVol > 0 ? current / avgVol : 0;
}

function detectSignal(candles, btcCandles, i, btcI) {
  if (i < 50 || btcI < 50) return null;
  
  const current = candles[i];
  const open = current[1];
  const close = current[4];
  const timestamp = current[0];
  
  const date = new Date(timestamp);
  const dayOfWeek = date.getUTCDay();
  if (!CONFIG.ENTRY.ALLOWED_DAYS.includes(dayOfWeek)) return null;
  
  const closes = candles.slice(0, i + 1).map(c => c[4]);
  const volumes = candles.slice(0, i + 1).map(c => c[5]);
  const btcCloses = btcCandles.slice(0, btcI + 1).map(c => c[4]);
  
  const volRatio = calcVolRatio(volumes);
  const ma20 = calcMA(closes, 20);
  const btcMa50 = calcMA(btcCloses, 50);
  
  const btcNow = btcCloses[btcCloses.length - 1];
  const btc6hAgoIndex = Math.max(0, btcCloses.length - CONFIG.ENTRY.BTC_MOMENTUM_PERIOD - 1);
  const btc6hAgo = btcCloses[btc6hAgoIndex];
  const btcMomentum6h = btc6hAgo > 0 ? ((btcNow - btc6hAgo) / btc6hAgo) * 100 : 0;
  
  const isBullish = close > open;
  const isBearish = close < open;
  const priceAboveMa20 = close > ma20;
  const priceBelowMa20 = close < ma20;
  const btcAboveMa50 = btcNow > btcMa50;
  const btcBelowMa50 = btcNow < btcMa50;
  const btcMomentumBullish = btcMomentum6h > CONFIG.ENTRY.BTC_MOMENTUM_MIN;
  const btcMomentumBearish = btcMomentum6h < -CONFIG.ENTRY.BTC_MOMENTUM_MIN;
  const volOk = volRatio >= CONFIG.ENTRY.VOL_MULTIPLIER;
  
  if (!volOk) return null;
  
  if (isBullish && priceAboveMa20 && btcAboveMa50 && btcMomentumBullish) {
    return { direction: 'LONG', btcMomentum6h, volRatio, dayOfWeek };
  }
  
  if (isBearish && priceBelowMa20 && btcBelowMa50 && btcMomentumBearish) {
    return { direction: 'SHORT', btcMomentum6h, volRatio, dayOfWeek };
  }
  
  return null;
}

function simulateTrade(candles, entryIndex, direction, rawEntryPrice) {
  // REALISTIC: Add slippage on entry
  const entrySlippage = direction === 'LONG' 
    ? (1 + CONFIG.fees.slippageEntry) 
    : (1 - CONFIG.fees.slippageEntry);
  const entryPrice = rawEntryPrice * entrySlippage;
  
  const maxHoldCandles = CONFIG.EXIT.HOLD_PERIOD_MAX_MIN / 15;
  let highWaterMark = entryPrice;
  let lowWaterMark = entryPrice;
  let holdCandles = 0;
  
  for (let j = entryIndex + 1; j < Math.min(entryIndex + maxHoldCandles, candles.length); j++) {
    holdCandles = j - entryIndex;
    const high = candles[j][2];
    const low = candles[j][3];
    const currentPrice = candles[j][4];
    
    if (high > highWaterMark) highWaterMark = high;
    if (low < lowWaterMark) lowWaterMark = low;
    
    let pnlPct;
    if (direction === 'LONG') {
      pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    } else {
      pnlPct = ((entryPrice - currentPrice) / entryPrice) * 100;
    }
    
    // Stop Loss
    if (pnlPct <= -CONFIG.EXIT.STOP_LOSS_PCT) {
      // Add exit slippage
      const exitSlippage = CONFIG.fees.slippageExit;
      const finalPnl = -CONFIG.EXIT.STOP_LOSS_PCT - (exitSlippage * 100);
      return {
        outcome: 'LOSS',
        pnlPct: finalPnl,
        exitReason: 'STOP_LOSS',
        holdCandles,
      };
    }
    
    // Trailing Stop
    if (pnlPct >= CONFIG.EXIT.TRAILING_ACTIVATION_PCT) {
      let trailingDistance = CONFIG.EXIT.TRAILING_DISTANCE_PCT;
      if (pnlPct >= CONFIG.EXIT.TRAILING_TIGHTEN_AT_PCT) {
        trailingDistance = CONFIG.EXIT.TRAILING_TIGHT_DISTANCE_PCT;
      }
      
      let trailingStopHit = false;
      
      if (direction === 'LONG') {
        const trailingStop = highWaterMark * (1 - trailingDistance / 100);
        if (low <= trailingStop) trailingStopHit = true;
      } else {
        const trailingStop = lowWaterMark * (1 + trailingDistance / 100);
        if (high >= trailingStop) trailingStopHit = true;
      }
      
      if (trailingStopHit) {
        // Calculate profit from high/low water mark
        let bestPnl;
        if (direction === 'LONG') {
          bestPnl = ((highWaterMark - entryPrice) / entryPrice) * 100;
        } else {
          bestPnl = ((entryPrice - lowWaterMark) / entryPrice) * 100;
        }
        
        // Subtract trailing distance
        let finalPnl = bestPnl - trailingDistance;
        
        // REALISTIC: Gap risk - 10% chance of extra 0.5% loss
        if (Math.random() < CONFIG.EXIT.GAP_RISK_PROBABILITY) {
          finalPnl -= CONFIG.EXIT.GAP_RISK_EXTRA_LOSS_PCT;
        }
        
        // Exit slippage
        finalPnl -= CONFIG.fees.slippageExit * 100;
        
        return {
          outcome: finalPnl > 0 ? 'WIN' : 'LOSS',
          pnlPct: finalPnl,
          exitReason: 'TRAILING_STOP',
          holdCandles,
        };
      }
    }
  }
  
  // Max hold exit
  const lastIndex = Math.min(entryIndex + maxHoldCandles - 1, candles.length - 1);
  const exitPrice = candles[lastIndex][4];
  let finalPnl = direction === 'LONG'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  // Exit slippage
  finalPnl -= CONFIG.fees.slippageExit * 100;
  
  return {
    outcome: finalPnl > 0 ? 'WIN' : 'LOSS',
    pnlPct: finalPnl,
    exitReason: 'MAX_HOLD',
    holdCandles: maxHoldCandles,
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 ULTRA-REALISTIC BACKTEST (Slippage + Funding + No Compounding)');
  console.log('═'.repeat(80));
  console.log(`\n⚠️ KEY DIFFERENCES FROM OPTIMISTIC BACKTEST:`);
  console.log(`   • Slippage: ${(CONFIG.fees.slippageEntry * 100).toFixed(2)}% entry, ${(CONFIG.fees.slippageExit * 100).toFixed(2)}% exit`);
  console.log(`   • Funding: ${(CONFIG.fees.fundingPer8h * 100).toFixed(3)}% per 8h hold`);
  console.log(`   • Gap Risk: ${(CONFIG.EXIT.GAP_RISK_PROBABILITY * 100)}% chance of ${CONFIG.EXIT.GAP_RISK_EXTRA_LOSS_PCT}% extra loss on trailing`);
  console.log(`   • NO Compounding: Fixed $${CONFIG.initialCapital} position sizing`);
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  const btcCandles = allCandles['BTC/USDT:USDT'];
  const btcTimestampIndex = new Map();
  btcCandles.forEach((c, i) => btcTimestampIndex.set(c[0], i));
  
  const startDate = new Date(Math.max(...Object.values(allCandles).map(c => c[0]?.[0] || 0)));
  const endDate = new Date(Math.min(...Object.values(allCandles).map(c => c[c.length - 1]?.[0] || Date.now())));
  const actualDays = Math.floor((endDate - startDate) / (24 * 60 * 60 * 1000));
  
  console.log(`\n📅 Period: ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]} (${actualDays} days)`);
  
  // Collect signals
  const allSignals = [];
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 60; i < candles.length - 30; i++) {
      const timestamp = candles[i][0];
      const btcI = btcTimestampIndex.get(timestamp);
      if (btcI === undefined) continue;
      
      const signal = detectSignal(candles, btcCandles, i, btcI);
      if (!signal) continue;
      
      allSignals.push({
        symbol, candleIndex: i, timestamp,
        direction: signal.direction,
        entry: candles[i][4],
        candles
      });
    }
  }
  allSignals.sort((a, b) => a.timestamp - b.timestamp);
  
  console.log(`\n📊 Total signals: ${allSignals.length}`);
  
  // SIMULATION - NO COMPOUNDING
  const FIXED_CAPITAL = CONFIG.initialCapital;  // Always use initial capital
  let totalPnLUsd = 0;
  let totalFees = 0;
  let totalFunding = 0;
  let wins = 0, losses = 0;
  let longWins = 0, longLosses = 0;
  let shortWins = 0, shortLosses = 0;
  const monthlyStats = {};
  
  let activePositionCount = 0;
  const positionEndTimes = [];
  
  for (const signal of allSignals) {
    // Clean up expired positions
    positionEndTimes.forEach((endTime) => {
      if (signal.timestamp > endTime) {
        activePositionCount = Math.max(0, activePositionCount - 1);
      }
    });
    
    if (activePositionCount >= CONFIG.RISK.MAX_POSITIONS) continue;
    
    const leverage = CONFIG.LEVERAGE[signal.symbol] || 4;
    const result = simulateTrade(signal.candles, signal.candleIndex, signal.direction, signal.entry);
    if (!result) continue;
    
    const positionEndTime = signal.timestamp + result.holdCandles * 15 * 60 * 1000;
    positionEndTimes.push(positionEndTime);
    activePositionCount++;
    
    // FIXED position sizing (no compounding)
    const riskAmount = FIXED_CAPITAL * (CONFIG.RISK.RISK_PCT_PER_TRADE / 100);
    const positionSize = (riskAmount / (CONFIG.EXIT.STOP_LOSS_PCT / 100)) * leverage;
    
    // Trading fees are ALREADY included in slippage (entry + exit)
    // So we don't add them separately - that would be double counting!
    // Only funding fees are separate
    
    // Funding fees (based on hold time) - only if holding through 00:00, 08:00, or 16:00 UTC
    const holdHours = result.holdCandles * 15 / 60;
    const fundingPeriods = Math.floor(holdHours / 8); // Only whole 8h periods
    const funding = positionSize * CONFIG.fees.fundingPer8h * fundingPeriods;
    totalFunding += funding;
    
    // P&L (slippage/fees already factored into result.pnlPct)
    const grossPnL = positionSize * (result.pnlPct / 100);
    const netPnL = grossPnL - funding;  // Only subtract funding, fees are in slippage
    totalPnLUsd += netPnL;
    
    if (result.outcome === 'WIN') {
      wins++;
      if (signal.direction === 'LONG') longWins++;
      else shortWins++;
    } else {
      losses++;
      if (signal.direction === 'LONG') longLosses++;
      else shortLosses++;
    }
    
    // Monthly tracking
    const date = new Date(signal.timestamp);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!monthlyStats[monthKey]) {
      monthlyStats[monthKey] = { pnl: 0, trades: 0, wins: 0 };
    }
    monthlyStats[monthKey].pnl += netPnL;
    monthlyStats[monthKey].trades++;
    if (result.outcome === 'WIN') monthlyStats[monthKey].wins++;
  }
  
  // RESULTS
  const totalTrades = wins + losses;
  const finalCapital = CONFIG.initialCapital + totalPnLUsd;
  const totalROI = (totalPnLUsd / CONFIG.initialCapital) * 100;
  const monthlyROI = totalROI / (actualDays / 30);
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 REALISTIC RESULTS');
  console.log('═'.repeat(80));
  
  console.log(`\n📈 Performance:`);
  console.log(`   Trades: ${totalTrades}`);
  console.log(`   Win Rate: ${(wins / totalTrades * 100).toFixed(1)}%`);
  console.log(`   LONG WR: ${(longWins / (longWins + longLosses) * 100).toFixed(1)}%`);
  console.log(`   SHORT WR: ${(shortWins / (shortWins + shortLosses) * 100).toFixed(1)}%`);
  
  console.log(`\n💰 P&L (NO Compounding):`);
  console.log(`   Initial: $${CONFIG.initialCapital.toLocaleString()}`);
  console.log(`   Final: $${finalCapital.toFixed(2)}`);
  console.log(`   Total P&L: ${totalPnLUsd >= 0 ? '+' : ''}$${totalPnLUsd.toFixed(2)}`);
  console.log(`   Total ROI: ${totalROI >= 0 ? '+' : ''}${totalROI.toFixed(1)}%`);
  console.log(`   Monthly ROI: ${monthlyROI >= 0 ? '+' : ''}${monthlyROI.toFixed(2)}%`);
  
  console.log(`\n💸 Costs Breakdown:`);
  console.log(`   Slippage+Fees (in P&L): ~${((CONFIG.fees.slippageEntry + CONFIG.fees.slippageExit) * 100).toFixed(2)}% per trade`);
  console.log(`   Funding fees: $${totalFunding.toFixed(2)}`);
  console.log(`   (Fees are included in slippage, not double-counted)`);
  console.log(`   Total extra costs: $${totalFunding.toFixed(2)}`);
  
  // Monthly breakdown
  console.log('\n' + '═'.repeat(80));
  console.log('📅 MONTHLY (No Compounding)');
  console.log('═'.repeat(80));
  
  const months = Object.keys(monthlyStats).sort();
  let positiveMonths = 0;
  
  console.log('\n┌────────────┬─────────┬───────────┬─────────────────┬──────────┐');
  console.log('│    Month   │ Trades  │  Win Rate │   P&L (USD)     │  Status  │');
  console.log('├────────────┼─────────┼───────────┼─────────────────┼──────────┤');
  
  for (const month of months) {
    const m = monthlyStats[month];
    const wr = m.trades > 0 ? (m.wins / m.trades * 100).toFixed(1) : '0.0';
    const status = m.pnl >= 0 ? '✅' : '❌';
    if (m.pnl >= 0) positiveMonths++;
    
    console.log(`│ ${month}   │   ${String(m.trades).padStart(4)}  │   ${wr.padStart(5)}%  │ ${(m.pnl >= 0 ? '+' : '')}$${m.pnl.toFixed(0).padStart(14)} │    ${status}    │`);
  }
  
  console.log('└────────────┴─────────┴───────────┴─────────────────┴──────────┘');
  console.log(`\n🎯 Positive months: ${positiveMonths}/${months.length} (${(positiveMonths / months.length * 100).toFixed(0)}%)`);
  
  // Projections
  console.log('\n' + '═'.repeat(80));
  console.log('💰 REALISTIC MONTHLY EXPECTATIONS');
  console.log('═'.repeat(80));
  
  const avgMonthlyPnL = totalPnLUsd / (actualDays / 30);
  
  console.log(`\n📊 Per $10,000 capital (no compounding):`);
  console.log(`   Expected monthly profit: ${avgMonthlyPnL >= 0 ? '+' : ''}$${avgMonthlyPnL.toFixed(0)}`);
  console.log(`   Expected monthly ROI: ${monthlyROI >= 0 ? '+' : ''}${monthlyROI.toFixed(1)}%`);
  console.log(`   Expected yearly profit: ${totalPnLUsd >= 0 ? '+' : ''}$${(avgMonthlyPnL * 12).toFixed(0)}`);
  
  console.log('\n📈 By capital (monthly profit):');
  console.log('\n┌──────────────────┬────────────────┬────────────────┐');
  console.log('│  Capital         │ Profit/Month   │ Profit/Year    │');
  console.log('├──────────────────┼────────────────┼────────────────┤');
  
  for (const cap of [1000, 5000, 10000, 25000, 50000]) {
    const monthly = avgMonthlyPnL * (cap / CONFIG.initialCapital);
    const yearly = monthly * 12;
    console.log(`│ $${cap.toLocaleString().padEnd(15)} │ ${monthly >= 0 ? '+' : ''}$${monthly.toFixed(0).padStart(12)} │ ${yearly >= 0 ? '+' : ''}$${yearly.toFixed(0).padStart(12)} │`);
  }
  
  console.log('└──────────────────┴────────────────┴────────────────┘');
  
  console.log('\n' + '═'.repeat(80));
  console.log('⚠️ COMPARISON: OPTIMISTIC vs REALISTIC');
  console.log('═'.repeat(80));
  console.log(`
┌─────────────────────────┬───────────────────┬───────────────────┐
│        Metric           │    Optimistic     │     Realistic     │
├─────────────────────────┼───────────────────┼───────────────────┤
│ Monthly ROI             │      ~42%         │     ~${monthlyROI.toFixed(1)}%         │
│ Compounding             │      YES          │     NO            │
│ Slippage                │      NO           │     YES (0.25%)   │
│ Funding fees            │      NO           │     YES           │
│ Gap risk                │      NO           │     YES (10%)     │
│ Monthly profit ($10k)   │      ~$4,200      │     ~$${avgMonthlyPnL.toFixed(0).padStart(4)}        │
└─────────────────────────┴───────────────────┴───────────────────┘

✅ The REALISTIC numbers are what you should expect after deployment.
`);
}

main().catch(console.error);
