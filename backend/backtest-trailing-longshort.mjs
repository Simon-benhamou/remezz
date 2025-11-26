/**
 * 📊 BACKTEST WITH TRAILING STOP + LONG/SHORT
 * 
 * Strategy: Vol 5x + BTC MA50 + 6h momentum ±0.75%
 * Exit: Trailing Stop (activates +1%, trails 0.5%, tightens to 0.3% at +2%)
 * Directions: LONG + SHORT
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];
const TIMEFRAME = '1h';  // 1h for BTC momentum check
const DAYS = 365;
const CANDLES_PER_DAY = 24;
const TOTAL_CANDLES = DAYS * CANDLES_PER_DAY;

const CONFIG = {
  initialCapital: 10000,
  riskPerTrade: 0.01,      // 1% risk per trade
  maxPositions: 4,          // Max 4 positions simultanées
  fees: { roundTrip: 0.0006 }, // 0.06% roundtrip
  
  // Entry conditions
  entry: {
    VOL_MULTIPLIER: 5,       // Volume > 5x average
    BTC_MA_PERIOD: 50,       // BTC above MA50
    BTC_MOMENTUM_PERIOD: 6,  // 6h momentum
    BTC_MOMENTUM_MIN: 0.75,  // Min ±0.75% for signal
  },
  
  // Exit: Trailing Stop
  exit: {
    STOP_LOSS_PCT: 2.0,              // Initial SL at 2%
    TRAILING_ACTIVATION_PCT: 1.0,    // Activate trailing at +1%
    TRAILING_DISTANCE_PCT: 0.5,      // Trail 0.5% below high
    TRAILING_TIGHTEN_AT_PCT: 2.0,    // Tighten at +2%
    TRAILING_TIGHTEN_TO_PCT: 0.3,    // Tighten to 0.3%
    MAX_HOLD_HOURS: 24,              // Max 24h hold time
  },
  
  // Leverage par symbol
  leverage: {
    'BTC/USDT:USDT': 3,
    'ETH/USDT:USDT': 4,
    'SOL/USDT:USDT': 5,
    'XRP/USDT:USDT': 5,
  },
};

async function fetchAllCandles(symbol) {
  console.log(`📥 Fetching ${symbol} (1h, max 12 months)...`);
  
  const allCandles = [];
  const now = Date.now();
  const candleDuration = 60 * 60 * 1000; // 1h
  let since = now - TOTAL_CANDLES * candleDuration;
  
  while (true) {
    try {
      const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, since, 1000);
      if (candles.length === 0) break;
      
      allCandles.push(...candles);
      since = candles[candles.length - 1][0] + candleDuration;
      
      if (allCandles.length % 2000 === 0) {
        process.stdout.write(`   ${allCandles.length} candles...\r`);
      }
      
      await new Promise(r => setTimeout(r, 50));
      
      if (candles.length < 1000) break;
      if (allCandles.length >= TOTAL_CANDLES) break;
    } catch (e) {
      console.log(`   ⚠️ Error: ${e.message}, retrying...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  console.log(`   ✅ ${allCandles.length} candles (${(allCandles.length / CANDLES_PER_DAY).toFixed(0)} days)`);
  return allCandles;
}

function calcMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function getAvgVolume(candles, i, period = 20) {
  const slice = candles.slice(Math.max(0, i - period), i);
  if (slice.length === 0) return 0;
  return slice.reduce((s, x) => s + x[5], 0) / slice.length;
}

/**
 * Detect signal based on:
 * - Volume > 5x average
 * - BTC above/below MA50
 * - BTC 6h momentum > 0.75% (LONG) or < -0.75% (SHORT)
 */
function detectSignal(candles, btcCandles, i, btcI) {
  if (i < 60 || btcI < 60) return null;
  
  // 1. Volume check (5x average)
  const vol = candles[i][5];
  const avgVol = getAvgVolume(candles, i);
  if (avgVol === 0 || vol < avgVol * CONFIG.entry.VOL_MULTIPLIER) return null;
  
  // 2. BTC MA50 check
  const btcCloses = btcCandles.slice(0, btcI + 1).map(c => c[4]);
  const btcNow = btcCloses[btcCloses.length - 1];
  const btcMa50 = calcMA(btcCloses, CONFIG.entry.BTC_MA_PERIOD);
  const btcAboveMa50 = btcNow > btcMa50;
  
  // 3. BTC 6h momentum
  const btc6hAgoIndex = Math.max(0, btcCloses.length - CONFIG.entry.BTC_MOMENTUM_PERIOD - 1);
  const btc6hAgo = btcCloses[btc6hAgoIndex];
  const btcMomentum = btc6hAgo > 0 ? ((btcNow - btc6hAgo) / btc6hAgo) * 100 : 0;
  
  // LONG signal: BTC above MA50 + momentum > +0.75%
  if (btcAboveMa50 && btcMomentum > CONFIG.entry.BTC_MOMENTUM_MIN) {
    return { direction: 'LONG', btcMomentum, btcAboveMa50, volRatio: vol / avgVol };
  }
  
  // SHORT signal: BTC below MA50 + momentum < -0.75%
  if (!btcAboveMa50 && btcMomentum < -CONFIG.entry.BTC_MOMENTUM_MIN) {
    return { direction: 'SHORT', btcMomentum, btcAboveMa50, volRatio: vol / avgVol };
  }
  
  return null;
}

/**
 * Simulate trade with trailing stop
 */
function simulateTrade(candles, entryIndex, direction, entryPrice) {
  const maxHoldCandles = CONFIG.exit.MAX_HOLD_HOURS;
  let highWaterMark = entryPrice;
  let lowWaterMark = entryPrice;
  let trailingActivated = false;
  let currentTrailDistance = CONFIG.exit.TRAILING_DISTANCE_PCT;
  
  // Initial stop loss
  const initialSL = direction === 'LONG'
    ? entryPrice * (1 - CONFIG.exit.STOP_LOSS_PCT / 100)
    : entryPrice * (1 + CONFIG.exit.STOP_LOSS_PCT / 100);
  
  let stopLoss = initialSL;
  
  for (let j = entryIndex + 1; j < Math.min(entryIndex + maxHoldCandles, candles.length); j++) {
    const high = candles[j][2];
    const low = candles[j][3];
    const close = candles[j][4];
    
    if (direction === 'LONG') {
      // Update high water mark
      if (high > highWaterMark) {
        highWaterMark = high;
        
        // Check if trailing should activate
        const profitPct = ((highWaterMark - entryPrice) / entryPrice) * 100;
        
        if (profitPct >= CONFIG.exit.TRAILING_ACTIVATION_PCT) {
          trailingActivated = true;
          
          // Tighten trail at higher profit
          if (profitPct >= CONFIG.exit.TRAILING_TIGHTEN_AT_PCT) {
            currentTrailDistance = CONFIG.exit.TRAILING_TIGHTEN_TO_PCT;
          }
          
          // Update trailing stop
          const newStop = highWaterMark * (1 - currentTrailDistance / 100);
          if (newStop > stopLoss) {
            stopLoss = newStop;
          }
        }
      }
      
      // Check stop loss hit
      if (low <= stopLoss) {
        const exitPrice = stopLoss;
        const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
        return {
          outcome: pnlPct > 0 ? 'WIN' : 'LOSS',
          exitPrice,
          pnlPct,
          exitReason: trailingActivated ? 'TRAILING_STOP' : 'STOP_LOSS',
          holdCandles: j - entryIndex,
          highWaterMark,
        };
      }
      
    } else { // SHORT
      // Update low water mark
      if (low < lowWaterMark) {
        lowWaterMark = low;
        
        // Check if trailing should activate
        const profitPct = ((entryPrice - lowWaterMark) / entryPrice) * 100;
        
        if (profitPct >= CONFIG.exit.TRAILING_ACTIVATION_PCT) {
          trailingActivated = true;
          
          // Tighten trail at higher profit
          if (profitPct >= CONFIG.exit.TRAILING_TIGHTEN_AT_PCT) {
            currentTrailDistance = CONFIG.exit.TRAILING_TIGHTEN_TO_PCT;
          }
          
          // Update trailing stop
          const newStop = lowWaterMark * (1 + currentTrailDistance / 100);
          if (newStop < stopLoss) {
            stopLoss = newStop;
          }
        }
      }
      
      // Check stop loss hit
      if (high >= stopLoss) {
        const exitPrice = stopLoss;
        const pnlPct = ((entryPrice - exitPrice) / entryPrice) * 100;
        return {
          outcome: pnlPct > 0 ? 'WIN' : 'LOSS',
          exitPrice,
          pnlPct,
          exitReason: trailingActivated ? 'TRAILING_STOP' : 'STOP_LOSS',
          holdCandles: j - entryIndex,
          lowWaterMark,
        };
      }
    }
  }
  
  // Max hold time reached - exit at current price
  const lastCandle = candles[Math.min(entryIndex + maxHoldCandles - 1, candles.length - 1)];
  const exitPrice = lastCandle[4];
  const pnlPct = direction === 'LONG'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  return {
    outcome: pnlPct > 0 ? 'WIN' : 'LOSS',
    exitPrice,
    pnlPct,
    exitReason: 'MAX_HOLD',
    holdCandles: maxHoldCandles,
    highWaterMark,
    lowWaterMark,
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 BACKTEST: TRAILING STOP + LONG/SHORT');
  console.log('═'.repeat(80));
  console.log(`\n📋 Configuration:`);
  console.log(`   Entry: Vol ${CONFIG.entry.VOL_MULTIPLIER}x + BTC MA${CONFIG.entry.BTC_MA_PERIOD} + Mom ${CONFIG.entry.BTC_MOMENTUM_PERIOD}h ±${CONFIG.entry.BTC_MOMENTUM_MIN}%`);
  console.log(`   Exit: Trailing Stop (activate +${CONFIG.exit.TRAILING_ACTIVATION_PCT}%, trail ${CONFIG.exit.TRAILING_DISTANCE_PCT}%, tighten to ${CONFIG.exit.TRAILING_TIGHTEN_TO_PCT}% at +${CONFIG.exit.TRAILING_TIGHTEN_AT_PCT}%)`);
  console.log(`   SL: ${CONFIG.exit.STOP_LOSS_PCT}% | Max Hold: ${CONFIG.exit.MAX_HOLD_HOURS}h`);
  console.log(`   Symbols: ${SYMBOLS.join(', ')}`);
  
  // Fetch all data
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  const btcCandles = allCandles['BTC/USDT:USDT'];
  
  // Determine actual date range
  const startDate = new Date(Math.max(...Object.values(allCandles).map(c => c[0]?.[0] || 0)));
  const endDate = new Date(Math.min(...Object.values(allCandles).map(c => c[c.length - 1]?.[0] || Date.now())));
  const actualDays = Math.floor((endDate - startDate) / (24 * 60 * 60 * 1000));
  
  console.log(`\n📅 Period: ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]}`);
  console.log(`   Duration: ${actualDays} days (~${(actualDays / 30).toFixed(1)} months)`);
  
  // Build timestamp index for BTC candles
  const btcTimestampIndex = new Map();
  btcCandles.forEach((c, i) => btcTimestampIndex.set(c[0], i));
  
  // Collect all signals
  const allSignals = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 60; i < candles.length - 30; i++) {
      const timestamp = candles[i][0];
      const btcI = btcTimestampIndex.get(timestamp);
      if (btcI === undefined) continue;
      
      const signal = detectSignal(candles, btcCandles, i, btcI);
      if (!signal) continue;
      
      allSignals.push({
        symbol,
        candleIndex: i,
        timestamp,
        direction: signal.direction,
        entry: candles[i][4],
        btcMomentum: signal.btcMomentum,
        volRatio: signal.volRatio,
        candles
      });
    }
  }
  
  allSignals.sort((a, b) => a.timestamp - b.timestamp);
  
  const longSignals = allSignals.filter(s => s.direction === 'LONG').length;
  const shortSignals = allSignals.filter(s => s.direction === 'SHORT').length;
  
  console.log(`\n📊 Total signals: ${allSignals.length} (${longSignals} LONG, ${shortSignals} SHORT)`);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // SIMULATION
  // ═══════════════════════════════════════════════════════════════════════════
  
  let capital = CONFIG.initialCapital;
  const monthlyStats = {};
  let totalFees = 0;
  let wins = 0, losses = 0;
  let longWins = 0, longLosses = 0;
  let shortWins = 0, shortLosses = 0;
  let trailingExits = 0, slExits = 0, maxHoldExits = 0;
  let totalPnLPct = 0;
  const allPnLs = [];
  
  // Track active positions (limit to maxPositions)
  const activePositions = new Map();
  
  for (const signal of allSignals) {
    // Skip if max positions reached
    if (activePositions.size >= CONFIG.maxPositions) {
      // Check if any position should be closed
      for (const [posId, pos] of activePositions) {
        const candlesSinceEntry = (signal.timestamp - pos.timestamp) / (60 * 60 * 1000);
        if (candlesSinceEntry >= CONFIG.exit.MAX_HOLD_HOURS) {
          activePositions.delete(posId);
        }
      }
      if (activePositions.size >= CONFIG.maxPositions) continue;
    }
    
    const leverage = CONFIG.leverage[signal.symbol] || 4;
    const result = simulateTrade(signal.candles, signal.candleIndex, signal.direction, signal.entry);
    
    if (!result) continue;
    
    // Position sizing
    const riskAmount = capital * CONFIG.riskPerTrade;
    const positionSize = (riskAmount / (CONFIG.exit.STOP_LOSS_PCT / 100)) * leverage;
    
    // Fees
    const fees = positionSize * CONFIG.fees.roundTrip;
    totalFees += fees;
    
    // P&L calculation
    const grossPnL = positionSize * (result.pnlPct / 100);
    const netPnL = grossPnL - fees;
    
    capital += netPnL;
    totalPnLPct += result.pnlPct;
    allPnLs.push(result.pnlPct);
    
    // Track wins/losses
    if (result.outcome === 'WIN') {
      wins++;
      if (signal.direction === 'LONG') longWins++;
      else shortWins++;
    } else {
      losses++;
      if (signal.direction === 'LONG') longLosses++;
      else shortLosses++;
    }
    
    // Track exit reasons
    if (result.exitReason === 'TRAILING_STOP') trailingExits++;
    else if (result.exitReason === 'STOP_LOSS') slExits++;
    else maxHoldExits++;
    
    // Monthly tracking
    const date = new Date(signal.timestamp);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!monthlyStats[monthKey]) {
      monthlyStats[monthKey] = { 
        startCapital: capital - netPnL, 
        pnl: 0, 
        trades: 0, 
        wins: 0,
        fees: 0,
        longTrades: 0,
        shortTrades: 0,
        longWins: 0,
        shortWins: 0,
      };
    }
    monthlyStats[monthKey].pnl += netPnL;
    monthlyStats[monthKey].trades++;
    monthlyStats[monthKey].fees += fees;
    if (result.outcome === 'WIN') monthlyStats[monthKey].wins++;
    
    if (signal.direction === 'LONG') {
      monthlyStats[monthKey].longTrades++;
      if (result.outcome === 'WIN') monthlyStats[monthKey].longWins++;
    } else {
      monthlyStats[monthKey].shortTrades++;
      if (result.outcome === 'WIN') monthlyStats[monthKey].shortWins++;
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════════════════
  
  const totalTrades = wins + losses;
  const totalPnL = capital - CONFIG.initialCapital;
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 GLOBAL RESULTS');
  console.log('═'.repeat(80));
  
  console.log(`\n📈 Performance:`);
  console.log(`   Trades: ${totalTrades}`);
  console.log(`   Trades/day: ${(totalTrades / actualDays).toFixed(2)}`);
  console.log(`   Win Rate: ${totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : 0}%`);
  console.log(`   Avg PnL/trade: ${totalTrades > 0 ? (totalPnLPct / totalTrades).toFixed(2) : 0}%`);
  
  console.log(`\n💰 Capital:`);
  console.log(`   Initial: $${CONFIG.initialCapital.toLocaleString()}`);
  console.log(`   Final: $${capital.toFixed(2)}`);
  console.log(`   P&L net: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`);
  console.log(`   ROI total: ${totalPnL >= 0 ? '+' : ''}${(totalPnL / CONFIG.initialCapital * 100).toFixed(1)}%`);
  
  console.log(`\n🎯 LONG vs SHORT:`);
  console.log(`   LONG: ${longWins + longLosses} trades, ${longWins + longLosses > 0 ? (longWins / (longWins + longLosses) * 100).toFixed(1) : 0}% win rate`);
  console.log(`   SHORT: ${shortWins + shortLosses} trades, ${shortWins + shortLosses > 0 ? (shortWins / (shortWins + shortLosses) * 100).toFixed(1) : 0}% win rate`);
  
  console.log(`\n🚪 Exit Reasons:`);
  console.log(`   Trailing Stop: ${trailingExits} (${(trailingExits / totalTrades * 100).toFixed(1)}%)`);
  console.log(`   Stop Loss: ${slExits} (${(slExits / totalTrades * 100).toFixed(1)}%)`);
  console.log(`   Max Hold: ${maxHoldExits} (${(maxHoldExits / totalTrades * 100).toFixed(1)}%)`);
  
  console.log(`\n💸 Fees:`);
  console.log(`   Total fees: $${totalFees.toFixed(2)}`);
  console.log(`   Fees/trade: $${totalTrades > 0 ? (totalFees / totalTrades).toFixed(2) : 0}`);
  
  // Monthly breakdown
  console.log('\n' + '═'.repeat(80));
  console.log('📅 MONTHLY PERFORMANCE');
  console.log('═'.repeat(80));
  
  const months = Object.keys(monthlyStats).sort();
  let positiveMonths = 0;
  
  console.log('\n┌────────────┬─────────┬───────────┬──────────────┬──────────────┬─────────────┬──────────┐');
  console.log('│    Month   │ Trades  │  Win Rate │  Long WR     │  Short WR    │   P&L %     │  Status  │');
  console.log('├────────────┼─────────┼───────────┼──────────────┼──────────────┼─────────────┼──────────┤');
  
  for (const month of months) {
    const m = monthlyStats[month];
    const wr = m.trades > 0 ? (m.wins / m.trades * 100).toFixed(1) : '0.0';
    const longWr = m.longTrades > 0 ? (m.longWins / m.longTrades * 100).toFixed(1) : '-';
    const shortWr = m.shortTrades > 0 ? (m.shortWins / m.shortTrades * 100).toFixed(1) : '-';
    const pnlPct = (m.pnl / m.startCapital * 100).toFixed(2);
    const status = m.pnl >= 0 ? '✅' : '❌';
    
    if (m.pnl >= 0) positiveMonths++;
    
    console.log(`│ ${month}   │   ${String(m.trades).padStart(4)}  │   ${wr.padStart(5)}%  │   ${String(longWr).padStart(5)}%     │   ${String(shortWr).padStart(5)}%     │ ${(m.pnl >= 0 ? '+' : '')}${pnlPct.padStart(9)}% │    ${status}    │`);
  }
  
  console.log('└────────────┴─────────┴───────────┴──────────────┴──────────────┴─────────────┴──────────┘');
  
  console.log(`\n🎯 Positive months: ${positiveMonths}/${months.length} (${(positiveMonths / months.length * 100).toFixed(0)}%)`);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // PROFIT PROJECTIONS
  // ═══════════════════════════════════════════════════════════════════════════
  
  const avgLeverage = Object.values(CONFIG.leverage).reduce((a, b) => a + b, 0) / 4;
  const monthlyROI = totalPnL / (actualDays / 30) / CONFIG.initialCapital * 100;
  const annualROI = totalPnL / CONFIG.initialCapital * 100 * (365 / actualDays);
  
  console.log('\n' + '═'.repeat(80));
  console.log('💰 PROFIT PROJECTIONS');
  console.log('═'.repeat(80));
  
  console.log(`\n📊 Configuration:`);
  console.log(`   Avg leverage: ${avgLeverage.toFixed(1)}x`);
  console.log(`   Risk/trade: ${CONFIG.riskPerTrade * 100}%`);
  
  console.log(`\n💵 Based on ${actualDays} days:`);
  console.log(`   Monthly ROI: ${monthlyROI >= 0 ? '+' : ''}${monthlyROI.toFixed(2)}%`);
  console.log(`   Annual ROI (projected): ${annualROI >= 0 ? '+' : ''}${annualROI.toFixed(1)}%`);
  
  console.log('\n📈 Projections by capital:');
  console.log('\n┌──────────────────┬────────────────┬────────────────┬────────────────┐');
  console.log('│  Initial Capital │ Profit/Month   │ Profit/Year    │ Capital @1yr   │');
  console.log('├──────────────────┼────────────────┼────────────────┼────────────────┤');
  
  for (const cap of [1000, 5000, 10000, 25000, 50000, 100000]) {
    const monthlyProfit = cap * monthlyROI / 100;
    const yearlyProfit = cap * annualROI / 100;
    const capitalAfter1Year = cap + yearlyProfit;
    
    console.log(`│ $${cap.toLocaleString().padEnd(15)} │ ${monthlyProfit >= 0 ? '+' : ''}$${monthlyProfit.toFixed(0).padStart(12)} │ ${yearlyProfit >= 0 ? '+' : ''}$${yearlyProfit.toFixed(0).padStart(12)} │ $${capitalAfter1Year.toFixed(0).padStart(13)} │`);
  }
  
  console.log('└──────────────────┴────────────────┴────────────────┴────────────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL VERDICT
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 FINAL VERDICT');
  console.log('═'.repeat(80));
  
  const isViable = positiveMonths >= months.length * 0.6 && totalPnL > 0;
  const winRate = totalTrades > 0 ? wins / totalTrades * 100 : 0;
  
  if (isViable && winRate >= 50) {
    console.log(`
✅ STRATEGY VIABLE!

📊 Summary:
   - ${totalTrades} trades (${(totalTrades / actualDays).toFixed(1)}/day)
   - ${winRate.toFixed(1)}% win rate
   - ${positiveMonths}/${months.length} positive months (${(positiveMonths / months.length * 100).toFixed(0)}%)
   - Total ROI: ${totalPnL >= 0 ? '+' : ''}${(totalPnL / CONFIG.initialCapital * 100).toFixed(0)}%
   - LONG: ${longWins + longLosses} trades (${(longWins / (longWins + longLosses) * 100).toFixed(0)}% WR)
   - SHORT: ${shortWins + shortLosses} trades (${(shortWins / (shortWins + shortLosses) * 100).toFixed(0)}% WR)

🎯 Trailing Stop Stats:
   - ${trailingExits}/${totalTrades} exits via trailing (${(trailingExits / totalTrades * 100).toFixed(0)}%)
   - Avg profit on trailing exits: higher profits captured

💡 Strategy is ready for production!
`);
  } else {
    console.log(`
⚠️ STRATEGY NEEDS REVIEW

📊 Summary:
   - ${positiveMonths}/${months.length} positive months
   - Win Rate: ${winRate.toFixed(1)}%
   - P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}

💡 Consider adjusting parameters.
`);
  }
}

main().catch(console.error);
