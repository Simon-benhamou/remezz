/**
 * 📊 REALISTIC BACKTEST - Matches Actual Agent Code
 * 
 * This backtest uses EXACTLY the same parameters as:
 * - backend/src/strategies/momentumSimple.ts
 * 
 * Key differences from previous test:
 * - 15m candles (not 1h)
 * - Allowed days: Sun, Mon, Wed, Thu (0, 1, 3, 4)
 * - Max hold: 6h (not 24h)
 * - BTC momentum period: 24 candles (6h at 15m)
 * - Requires: bullish candle + above MA20 for LONG
 * - Requires: bearish candle + below MA20 for SHORT
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];
const TIMEFRAME = '15m';
const DAYS = 365;
const CANDLES_PER_DAY = 96; // 15m = 96 candles/day
const TOTAL_CANDLES = DAYS * CANDLES_PER_DAY;

// ============================================================================
// CONFIG - EXACTLY MATCHING momentumSimple.ts
// ============================================================================
const CONFIG = {
  initialCapital: 10000,
  fees: { roundTrip: 0.0006 }, // 0.06% roundtrip
  
  // Entry (from MomentumConfig.ENTRY)
  ENTRY: {
    VOL_MULTIPLIER: 5,           // Volume > 5x average
    BTC_MOMENTUM_MIN: 0.75,      // BTC momentum 6h > 0.75%
    BTC_MOMENTUM_PERIOD: 24,     // 24 candles * 15m = 6h
    ALLOWED_DAYS: [0, 1, 3, 4],  // Sun, Mon, Wed, Thu
  },
  
  // Exit (from MomentumConfig.EXIT)
  EXIT: {
    HOLD_PERIOD_MAX_MIN: 360,    // 6 hours max = 24 candles
    STOP_LOSS_PCT: 2.0,          // 2% SL
    TRAILING_ACTIVATION_PCT: 1.0, // Activate trailing at +1%
    TRAILING_DISTANCE_PCT: 0.5,   // Trail 0.5%
    TRAILING_TIGHTEN_AT_PCT: 2.0, // Tighten at +2%
    TRAILING_TIGHT_DISTANCE_PCT: 0.3, // Tighten to 0.3%
  },
  
  // Risk (from MomentumConfig.RISK)
  RISK: {
    RISK_PCT_PER_TRADE: 1.0,     // 1% risk
    MAX_POSITIONS: 4,
  },
  
  // Leverage (from MomentumConfig.LEVERAGE)
  LEVERAGE: {
    'BTC/USDT:USDT': 3,
    'ETH/USDT:USDT': 4,
    'SOL/USDT:USDT': 5,
    'XRP/USDT:USDT': 5,
  },
};

async function fetchAllCandles(symbol) {
  console.log(`📥 Fetching ${symbol} (15m, ~12 months)...`);
  
  const allCandles = [];
  const now = Date.now();
  const candleDuration = 15 * 60 * 1000;
  let since = now - TOTAL_CANDLES * candleDuration;
  
  while (true) {
    try {
      const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, since, 1000);
      if (candles.length === 0) break;
      
      allCandles.push(...candles);
      since = candles[candles.length - 1][0] + candleDuration;
      
      if (allCandles.length % 5000 === 0) {
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

function calcMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcVolRatio(volumes) {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avgVol > 0 ? current / avgVol : 0;
}

/**
 * Signal detection - EXACTLY matching checkMomentumSignal()
 */
function detectSignal(candles, btcCandles, i, btcI) {
  if (i < 50 || btcI < 50) return null;
  
  // Current candle data
  const current = candles[i];
  const open = current[1];
  const close = current[4];
  const timestamp = current[0];
  
  // Check allowed day (IMPORTANT!)
  const date = new Date(timestamp);
  const dayOfWeek = date.getUTCDay();
  if (!CONFIG.ENTRY.ALLOWED_DAYS.includes(dayOfWeek)) return null;
  
  // Extract closes and volumes
  const closes = candles.slice(0, i + 1).map(c => c[4]);
  const volumes = candles.slice(0, i + 1).map(c => c[5]);
  const btcCloses = btcCandles.slice(0, btcI + 1).map(c => c[4]);
  
  // Calculate indicators
  const volRatio = calcVolRatio(volumes);
  const ma20 = calcMA(closes, 20);
  const btcMa50 = calcMA(btcCloses, 50);
  
  // BTC momentum 6h (24 candles of 15m)
  const btcNow = btcCloses[btcCloses.length - 1];
  const btc6hAgoIndex = Math.max(0, btcCloses.length - CONFIG.ENTRY.BTC_MOMENTUM_PERIOD - 1);
  const btc6hAgo = btcCloses[btc6hAgoIndex];
  const btcMomentum6h = btc6hAgo > 0 ? ((btcNow - btc6hAgo) / btc6hAgo) * 100 : 0;
  
  // Conditions
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
  
  // LONG: bullish + above MA20 + BTC above MA50 + BTC momentum > 0.75%
  if (isBullish && priceAboveMa20 && btcAboveMa50 && btcMomentumBullish) {
    return { direction: 'LONG', btcMomentum6h, volRatio, dayOfWeek };
  }
  
  // SHORT: bearish + below MA20 + BTC below MA50 + BTC momentum < -0.75%
  if (isBearish && priceBelowMa20 && btcBelowMa50 && btcMomentumBearish) {
    return { direction: 'SHORT', btcMomentum6h, volRatio, dayOfWeek };
  }
  
  return null;
}

/**
 * Simulate trade with trailing stop - EXACTLY matching shouldExitPosition()
 */
function simulateTrade(candles, entryIndex, direction, entryPrice) {
  const maxHoldCandles = CONFIG.EXIT.HOLD_PERIOD_MAX_MIN / 15; // 24 candles = 6h
  let highWaterMark = entryPrice;
  let lowWaterMark = entryPrice;
  
  for (let j = entryIndex + 1; j < Math.min(entryIndex + maxHoldCandles, candles.length); j++) {
    const high = candles[j][2];
    const low = candles[j][3];
    const currentPrice = candles[j][4];
    
    // Update water marks
    if (high > highWaterMark) highWaterMark = high;
    if (low < lowWaterMark) lowWaterMark = low;
    
    // Calculate PnL
    let pnlPct;
    if (direction === 'LONG') {
      pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    } else {
      pnlPct = ((entryPrice - currentPrice) / entryPrice) * 100;
    }
    
    // 1. Stop Loss check (2%)
    if (pnlPct <= -CONFIG.EXIT.STOP_LOSS_PCT) {
      return {
        outcome: 'LOSS',
        exitPrice: direction === 'LONG' 
          ? entryPrice * (1 - CONFIG.EXIT.STOP_LOSS_PCT / 100)
          : entryPrice * (1 + CONFIG.EXIT.STOP_LOSS_PCT / 100),
        pnlPct: -CONFIG.EXIT.STOP_LOSS_PCT,
        exitReason: 'STOP_LOSS',
        holdCandles: j - entryIndex,
      };
    }
    
    // 2. Trailing Stop Logic
    if (pnlPct >= CONFIG.EXIT.TRAILING_ACTIVATION_PCT) {
      let trailingDistance = CONFIG.EXIT.TRAILING_DISTANCE_PCT;
      
      // Tighten at +2%
      if (pnlPct >= CONFIG.EXIT.TRAILING_TIGHTEN_AT_PCT) {
        trailingDistance = CONFIG.EXIT.TRAILING_TIGHT_DISTANCE_PCT;
      }
      
      let trailingStopHit = false;
      let exitPrice;
      
      if (direction === 'LONG') {
        const trailingStop = highWaterMark * (1 - trailingDistance / 100);
        if (low <= trailingStop) {
          trailingStopHit = true;
          exitPrice = trailingStop;
        }
      } else {
        const trailingStop = lowWaterMark * (1 + trailingDistance / 100);
        if (high >= trailingStop) {
          trailingStopHit = true;
          exitPrice = trailingStop;
        }
      }
      
      if (trailingStopHit) {
        const finalPnl = direction === 'LONG'
          ? ((exitPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - exitPrice) / entryPrice) * 100;
        
        return {
          outcome: finalPnl > 0 ? 'WIN' : 'LOSS',
          exitPrice,
          pnlPct: finalPnl,
          exitReason: 'TRAILING_STOP',
          holdCandles: j - entryIndex,
          highWaterMark,
          lowWaterMark,
        };
      }
    }
  }
  
  // Max hold time (6h) - exit at last price
  const lastIndex = Math.min(entryIndex + maxHoldCandles - 1, candles.length - 1);
  const exitPrice = candles[lastIndex][4];
  const finalPnl = direction === 'LONG'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  return {
    outcome: finalPnl > 0 ? 'WIN' : 'LOSS',
    exitPrice,
    pnlPct: finalPnl,
    exitReason: 'MAX_HOLD',
    holdCandles: maxHoldCandles,
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 REALISTIC BACKTEST - Matching Agent Code');
  console.log('═'.repeat(80));
  console.log(`\n📋 Configuration (from momentumSimple.ts):`);
  console.log(`   Entry: Vol ${CONFIG.ENTRY.VOL_MULTIPLIER}x + MA20 + BTC MA50 + Mom 6h ±${CONFIG.ENTRY.BTC_MOMENTUM_MIN}%`);
  console.log(`   Days: ${CONFIG.ENTRY.ALLOWED_DAYS.map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')}`);
  console.log(`   Exit: Trailing (+${CONFIG.EXIT.TRAILING_ACTIVATION_PCT}% → ${CONFIG.EXIT.TRAILING_DISTANCE_PCT}%, tighten to ${CONFIG.EXIT.TRAILING_TIGHT_DISTANCE_PCT}% at +${CONFIG.EXIT.TRAILING_TIGHTEN_AT_PCT}%)`);
  console.log(`   SL: ${CONFIG.EXIT.STOP_LOSS_PCT}% | Max Hold: ${CONFIG.EXIT.HOLD_PERIOD_MAX_MIN / 60}h`);
  console.log(`   Timeframe: ${TIMEFRAME}`);
  
  // Fetch all data
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  const btcCandles = allCandles['BTC/USDT:USDT'];
  
  // Date range
  const startDate = new Date(Math.max(...Object.values(allCandles).map(c => c[0]?.[0] || 0)));
  const endDate = new Date(Math.min(...Object.values(allCandles).map(c => c[c.length - 1]?.[0] || Date.now())));
  const actualDays = Math.floor((endDate - startDate) / (24 * 60 * 60 * 1000));
  
  console.log(`\n📅 Period: ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]}`);
  console.log(`   Duration: ${actualDays} days (~${(actualDays / 30).toFixed(1)} months)`);
  
  // Build BTC timestamp index
  const btcTimestampIndex = new Map();
  btcCandles.forEach((c, i) => btcTimestampIndex.set(c[0], i));
  
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
        symbol,
        candleIndex: i,
        timestamp,
        direction: signal.direction,
        entry: candles[i][4],
        btcMomentum: signal.btcMomentum6h,
        volRatio: signal.volRatio,
        dayOfWeek: signal.dayOfWeek,
        candles
      });
    }
  }
  
  allSignals.sort((a, b) => a.timestamp - b.timestamp);
  
  const longSignals = allSignals.filter(s => s.direction === 'LONG').length;
  const shortSignals = allSignals.filter(s => s.direction === 'SHORT').length;
  
  console.log(`\n📊 Total signals: ${allSignals.length} (${longSignals} LONG, ${shortSignals} SHORT)`);
  
  // Count by day
  const dayCount = [0, 0, 0, 0, 0, 0, 0];
  allSignals.forEach(s => dayCount[s.dayOfWeek]++);
  console.log(`   By day: Sun=${dayCount[0]}, Mon=${dayCount[1]}, Wed=${dayCount[3]}, Thu=${dayCount[4]}`);
  
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
  
  // Limit concurrent positions
  let activePositionCount = 0;
  const positionEndTimes = [];
  
  for (const signal of allSignals) {
    // Clean up expired positions
    positionEndTimes.forEach((endTime, idx) => {
      if (signal.timestamp > endTime) {
        activePositionCount = Math.max(0, activePositionCount - 1);
      }
    });
    
    // Check max positions
    if (activePositionCount >= CONFIG.RISK.MAX_POSITIONS) continue;
    
    const leverage = CONFIG.LEVERAGE[signal.symbol] || 4;
    const result = simulateTrade(signal.candles, signal.candleIndex, signal.direction, signal.entry);
    
    if (!result) continue;
    
    // Track position duration
    const positionEndTime = signal.timestamp + result.holdCandles * 15 * 60 * 1000;
    positionEndTimes.push(positionEndTime);
    activePositionCount++;
    
    // Position sizing
    const riskAmount = capital * (CONFIG.RISK.RISK_PCT_PER_TRADE / 100);
    const positionSize = (riskAmount / (CONFIG.EXIT.STOP_LOSS_PCT / 100)) * leverage;
    
    // Fees
    const fees = positionSize * CONFIG.fees.roundTrip;
    totalFees += fees;
    
    // P&L
    const grossPnL = positionSize * (result.pnlPct / 100);
    const netPnL = grossPnL - fees;
    
    capital += netPnL;
    totalPnLPct += result.pnlPct;
    
    // Track stats
    if (result.outcome === 'WIN') {
      wins++;
      if (signal.direction === 'LONG') longWins++;
      else shortWins++;
    } else {
      losses++;
      if (signal.direction === 'LONG') longLosses++;
      else shortLosses++;
    }
    
    // Exit reasons
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
  console.log('📊 RESULTS');
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
  console.log(`   LONG: ${longWins + longLosses} trades, ${longWins + longLosses > 0 ? (longWins / (longWins + longLosses) * 100).toFixed(1) : 0}% WR`);
  console.log(`   SHORT: ${shortWins + shortLosses} trades, ${shortWins + shortLosses > 0 ? (shortWins / (shortWins + shortLosses) * 100).toFixed(1) : 0}% WR`);
  
  console.log(`\n🚪 Exit Reasons:`);
  console.log(`   Trailing Stop: ${trailingExits} (${totalTrades > 0 ? (trailingExits / totalTrades * 100).toFixed(1) : 0}%)`);
  console.log(`   Stop Loss: ${slExits} (${totalTrades > 0 ? (slExits / totalTrades * 100).toFixed(1) : 0}%)`);
  console.log(`   Max Hold (6h): ${maxHoldExits} (${totalTrades > 0 ? (maxHoldExits / totalTrades * 100).toFixed(1) : 0}%)`);
  
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
  
  console.log(`\n🎯 Positive months: ${positiveMonths}/${months.length} (${months.length > 0 ? (positiveMonths / months.length * 100).toFixed(0) : 0}%)`);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // PROJECTIONS
  // ═══════════════════════════════════════════════════════════════════════════
  
  const avgLeverage = Object.values(CONFIG.LEVERAGE).reduce((a, b) => a + b, 0) / 4;
  const monthlyROI = totalPnL / (actualDays / 30) / CONFIG.initialCapital * 100;
  const annualROI = totalPnL / CONFIG.initialCapital * 100 * (365 / actualDays);
  
  console.log('\n' + '═'.repeat(80));
  console.log('💰 REALISTIC PROJECTIONS');
  console.log('═'.repeat(80));
  
  console.log(`\n💵 Based on ${actualDays} days of historical data:`);
  console.log(`   Monthly ROI: ${monthlyROI >= 0 ? '+' : ''}${monthlyROI.toFixed(2)}%`);
  console.log(`   Monthly profit on $10k: ${monthlyROI >= 0 ? '+' : ''}$${(CONFIG.initialCapital * monthlyROI / 100).toFixed(0)}`);
  console.log(`   Annual ROI (projected): ${annualROI >= 0 ? '+' : ''}${annualROI.toFixed(1)}%`);
  
  console.log('\n📈 Expected monthly profit by capital:');
  console.log('\n┌──────────────────┬────────────────┬────────────────┐');
  console.log('│  Capital         │ Profit/Month   │ Profit/Year    │');
  console.log('├──────────────────┼────────────────┼────────────────┤');
  
  for (const cap of [1000, 5000, 10000, 25000, 50000]) {
    const monthlyProfit = cap * monthlyROI / 100;
    const yearlyProfit = cap * annualROI / 100;
    
    console.log(`│ $${cap.toLocaleString().padEnd(15)} │ ${monthlyProfit >= 0 ? '+' : ''}$${monthlyProfit.toFixed(0).padStart(12)} │ ${yearlyProfit >= 0 ? '+' : ''}$${yearlyProfit.toFixed(0).padStart(12)} │`);
  }
  
  console.log('└──────────────────┴────────────────┴────────────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════════
  // VERDICT
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 WHAT TO EXPECT AFTER DEPLOYMENT');
  console.log('═'.repeat(80));
  
  const tradesPerMonth = totalTrades / (actualDays / 30);
  const tradesPerWeek = totalTrades / (actualDays / 7);
  
  console.log(`
📊 Realistic Expectations:

   📈 Trade Frequency:
      - ~${tradesPerMonth.toFixed(0)} trades/month
      - ~${tradesPerWeek.toFixed(1)} trades/week
      - ~${(totalTrades / actualDays).toFixed(2)} trades/day
      
   ⏰ Trading Days:
      - Only Sun, Mon, Wed, Thu (${CONFIG.ENTRY.ALLOWED_DAYS.length}/7 days)
      - You may see 0-3 days without trades (normal!)
      
   💰 Expected Performance:
      - Win Rate: ~${(wins / totalTrades * 100).toFixed(0)}%
      - Monthly ROI: ~${monthlyROI.toFixed(1)}%
      - Positive months: ~${(positiveMonths / months.length * 100).toFixed(0)}%
      
   🎯 Per $10,000 capital:
      - Expected monthly profit: ~$${(CONFIG.initialCapital * monthlyROI / 100).toFixed(0)}
      - Some months may be negative (normal)
      
   ⚠️ Important Notes:
      - Past performance ≠ future results
      - Market conditions change
      - Slippage not fully modeled
      - The trailing stop captures trends well
`);

  const isViable = positiveMonths >= months.length * 0.5 && totalPnL > 0 && wins / totalTrades >= 0.5;
  
  if (isViable) {
    console.log(`✅ Strategy is VIABLE for deployment!`);
  } else {
    console.log(`⚠️ Strategy needs review before deployment.`);
  }
}

main().catch(console.error);
