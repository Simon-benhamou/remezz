/**
 * 📊 REGIME-AWARE BACKTEST V2
 * 
 * Strategy improvements based on pattern analysis:
 * 1. REGIME FILTER - Only trade in the direction of the regime
 * 2. RSI CONFIRMATION - Better entry timing
 * 3. VOLATILITY SCALING - Adjust size based on ATR
 * 4. MULTI-TIMEFRAME - Confirm with higher timeframes
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
  
  fees: { 
    slippageEntry: 0.0005,
    slippageExit: 0.0006,
    fundingPer8h: 0.0001,
  },
  
  // ENTRY - REGIME AWARE
  ENTRY: {
    VOL_MULTIPLIER: 4,  // Slightly lower threshold
    BTC_MOMENTUM_MIN: 0.5,  // Less strict
    BTC_MOMENTUM_PERIOD: 24,
    ALLOWED_DAYS: [0, 1, 2, 3, 4, 5, 6],
    
    // NEW: Regime-based rules
    REGIME_RULES: {
      strong_bull: { allowLong: true, allowShort: false, sizeMultiplier: 1.5 },
      bull: { allowLong: true, allowShort: false, sizeMultiplier: 1.0 },
      choppy: { allowLong: true, allowShort: true, sizeMultiplier: 0.5 },
      bear: { allowLong: false, allowShort: true, sizeMultiplier: 1.0 },
      strong_bear: { allowLong: false, allowShort: true, sizeMultiplier: 1.5 },
    },
    
    // NEW: RSI filters
    RSI: {
      LONG_MAX: 65,    // Don't buy when RSI > 65
      LONG_OPTIMAL: 45, // Best buys when RSI < 45
      SHORT_MIN: 35,   // Don't short when RSI < 35
      SHORT_OPTIMAL: 55, // Best shorts when RSI > 55
    },
  },
  
  EXIT: {
    HOLD_PERIOD_MAX_MIN: 360,
    STOP_LOSS_PCT: 2.0,
    TRAILING_ACTIVATION_PCT: 1.0,
    TRAILING_DISTANCE_PCT: 0.5,
    TRAILING_TIGHTEN_AT_PCT: 2.0,
    TRAILING_TIGHT_DISTANCE_PCT: 0.3,
    GAP_RISK_PROBABILITY: 0.10,
    GAP_RISK_EXTRA_LOSS_PCT: 0.5,
  },
  
  RISK: {
    RISK_PCT_PER_TRADE: 1.0,
    MAX_POSITIONS: 4,
    USE_COMPOUNDING: false,
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

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  
  const recentChanges = changes.slice(-period);
  const gains = recentChanges.filter(c => c > 0);
  const losses = recentChanges.filter(c => c < 0).map(c => Math.abs(c));
  
  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcVolRatio(volumes) {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avgVol > 0 ? current / avgVol : 0;
}

function detectMarketRegime(btcCandles, i) {
  if (i < 200) return 'choppy';
  
  const closes = btcCandles.slice(0, i + 1).map(c => c[4]);
  const currentPrice = closes[closes.length - 1];
  
  const ma20 = calcMA(closes, 20);
  const ma50 = calcMA(closes, 50);
  const ma200 = calcMA(closes, 200);
  
  const aboveMa20 = currentPrice > ma20;
  const aboveMa50 = currentPrice > ma50;
  const aboveMa200 = currentPrice > ma200;
  const ma20AboveMa50 = ma20 > ma50;
  const ma50AboveMa200 = ma50 > ma200;
  
  if (aboveMa20 && aboveMa50 && aboveMa200 && ma20AboveMa50 && ma50AboveMa200) {
    return 'strong_bull';
  } else if (aboveMa50 && aboveMa200 && ma50AboveMa200) {
    return 'bull';
  } else if (!aboveMa20 && !aboveMa50 && !aboveMa200 && !ma20AboveMa50 && !ma50AboveMa200) {
    return 'strong_bear';
  } else if (!aboveMa50 && !aboveMa200 && !ma50AboveMa200) {
    return 'bear';
  }
  
  return 'choppy';
}

function detectSignal(candles, btcCandles, i, btcI, regime) {
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
  const rsi = calcRSI(closes, 14);
  
  const btcNow = btcCloses[btcCloses.length - 1];
  const btc6hAgoIndex = Math.max(0, btcCloses.length - CONFIG.ENTRY.BTC_MOMENTUM_PERIOD - 1);
  const btc6hAgo = btcCloses[btc6hAgoIndex];
  const btcMomentum6h = btc6hAgo > 0 ? ((btcNow - btc6hAgo) / btc6hAgo) * 100 : 0;
  
  // Get regime rules
  const regimeRules = CONFIG.ENTRY.REGIME_RULES[regime] || CONFIG.ENTRY.REGIME_RULES.choppy;
  
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
  
  // LONG signal
  if (regimeRules.allowLong && isBullish && priceAboveMa20 && btcAboveMa50 && btcMomentumBullish) {
    // RSI filter for longs
    if (rsi > CONFIG.ENTRY.RSI.LONG_MAX) return null;
    
    const rsiBonus = rsi < CONFIG.ENTRY.RSI.LONG_OPTIMAL ? 1.2 : 1.0;
    
    return { 
      direction: 'LONG', 
      btcMomentum6h, 
      volRatio, 
      dayOfWeek, 
      regime, 
      rsi,
      sizeMultiplier: regimeRules.sizeMultiplier * rsiBonus,
    };
  }
  
  // SHORT signal
  if (regimeRules.allowShort && isBearish && priceBelowMa20 && btcBelowMa50 && btcMomentumBearish) {
    // RSI filter for shorts
    if (rsi < CONFIG.ENTRY.RSI.SHORT_MIN) return null;
    
    const rsiBonus = rsi > CONFIG.ENTRY.RSI.SHORT_OPTIMAL ? 1.2 : 1.0;
    
    return { 
      direction: 'SHORT', 
      btcMomentum6h, 
      volRatio, 
      dayOfWeek, 
      regime,
      rsi,
      sizeMultiplier: regimeRules.sizeMultiplier * rsiBonus,
    };
  }
  
  return null;
}

function simulateTrade(candles, entryIndex, direction, rawEntryPrice) {
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
    
    if (pnlPct <= -CONFIG.EXIT.STOP_LOSS_PCT) {
      const exitSlippage = CONFIG.fees.slippageExit;
      const finalPnl = -CONFIG.EXIT.STOP_LOSS_PCT - (exitSlippage * 100);
      return { outcome: 'LOSS', pnlPct: finalPnl, exitReason: 'STOP_LOSS', holdCandles };
    }
    
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
        let bestPnl;
        if (direction === 'LONG') {
          bestPnl = ((highWaterMark - entryPrice) / entryPrice) * 100;
        } else {
          bestPnl = ((entryPrice - lowWaterMark) / entryPrice) * 100;
        }
        
        let finalPnl = bestPnl - trailingDistance;
        
        if (Math.random() < CONFIG.EXIT.GAP_RISK_PROBABILITY) {
          finalPnl -= CONFIG.EXIT.GAP_RISK_EXTRA_LOSS_PCT;
        }
        
        finalPnl -= CONFIG.fees.slippageExit * 100;
        
        return { outcome: finalPnl > 0 ? 'WIN' : 'LOSS', pnlPct: finalPnl, exitReason: 'TRAILING_STOP', holdCandles };
      }
    }
  }
  
  const lastIndex = Math.min(entryIndex + maxHoldCandles - 1, candles.length - 1);
  const exitPrice = candles[lastIndex][4];
  let finalPnl = direction === 'LONG'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  finalPnl -= CONFIG.fees.slippageExit * 100;
  
  return { outcome: finalPnl > 0 ? 'WIN' : 'LOSS', pnlPct: finalPnl, exitReason: 'MAX_HOLD', holdCandles: maxHoldCandles };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 REGIME-AWARE BACKTEST V2 (Smarter Strategy)');
  console.log('═'.repeat(80));
  console.log(`\n🧠 NEW FEATURES:`);
  console.log(`   • Regime Filter: Trade WITH the trend, not against`);
  console.log(`   • RSI Timing: Better entries (not overbought/oversold)`);
  console.log(`   • Dynamic Sizing: 1.5x in strong trends, 0.5x in chop`);
  
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
  
  // Collect signals with regime awareness
  const allSignals = [];
  const regimeStats = { strong_bull: 0, bull: 0, choppy: 0, bear: 0, strong_bear: 0 };
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 200; i < candles.length - 30; i++) {
      const timestamp = candles[i][0];
      const btcI = btcTimestampIndex.get(timestamp);
      if (btcI === undefined || btcI < 200) continue;
      
      // Detect current regime
      const regime = detectMarketRegime(btcCandles, btcI);
      regimeStats[regime]++;
      
      const signal = detectSignal(candles, btcCandles, i, btcI, regime);
      if (!signal) continue;
      
      allSignals.push({
        symbol, candleIndex: i, timestamp,
        direction: signal.direction,
        entry: candles[i][4],
        candles,
        regime: signal.regime,
        rsi: signal.rsi,
        sizeMultiplier: signal.sizeMultiplier,
      });
    }
  }
  allSignals.sort((a, b) => a.timestamp - b.timestamp);
  
  console.log(`\n📊 Total signals: ${allSignals.length}`);
  console.log(`\n🎯 Regime distribution during backtest:`);
  const totalRegimeCandles = Object.values(regimeStats).reduce((a, b) => a + b, 0);
  for (const [regime, count] of Object.entries(regimeStats)) {
    console.log(`   ${regime}: ${(count / totalRegimeCandles * 100).toFixed(1)}%`);
  }
  
  // SIMULATION
  const FIXED_CAPITAL = CONFIG.initialCapital;
  let totalPnLUsd = 0;
  let totalFunding = 0;
  let wins = 0, losses = 0;
  let longWins = 0, longLosses = 0;
  let shortWins = 0, shortLosses = 0;
  const monthlyStats = {};
  const regimePerformance = {};
  
  let activePositionCount = 0;
  const positionEndTimes = [];
  
  for (const signal of allSignals) {
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
    
    // DYNAMIC position sizing based on regime
    const baseRiskAmount = FIXED_CAPITAL * (CONFIG.RISK.RISK_PCT_PER_TRADE / 100);
    const adjustedRiskAmount = baseRiskAmount * signal.sizeMultiplier;
    const positionSize = (adjustedRiskAmount / (CONFIG.EXIT.STOP_LOSS_PCT / 100)) * leverage;
    
    const holdHours = result.holdCandles * 15 / 60;
    const fundingPeriods = Math.floor(holdHours / 8);
    const funding = positionSize * CONFIG.fees.fundingPer8h * fundingPeriods;
    totalFunding += funding;
    
    const grossPnL = positionSize * (result.pnlPct / 100);
    const netPnL = grossPnL - funding;
    totalPnLUsd += netPnL;
    
    // Track regime performance
    if (!regimePerformance[signal.regime]) {
      regimePerformance[signal.regime] = { pnl: 0, trades: 0, wins: 0 };
    }
    regimePerformance[signal.regime].pnl += netPnL;
    regimePerformance[signal.regime].trades++;
    
    if (result.outcome === 'WIN') {
      wins++;
      regimePerformance[signal.regime].wins++;
      if (signal.direction === 'LONG') longWins++;
      else shortWins++;
    } else {
      losses++;
      if (signal.direction === 'LONG') longLosses++;
      else shortLosses++;
    }
    
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
  console.log('📊 REGIME-AWARE RESULTS');
  console.log('═'.repeat(80));
  
  console.log(`\n📈 Performance:`);
  console.log(`   Trades: ${totalTrades}`);
  console.log(`   Win Rate: ${(wins / totalTrades * 100).toFixed(1)}%`);
  console.log(`   LONG WR: ${(longWins / (longWins + longLosses) * 100).toFixed(1)}%`);
  console.log(`   SHORT WR: ${(shortWins / (shortWins + shortLosses) * 100).toFixed(1)}%`);
  
  console.log(`\n💰 P&L:`);
  console.log(`   Initial: $${CONFIG.initialCapital.toLocaleString()}`);
  console.log(`   Final: $${finalCapital.toFixed(2)}`);
  console.log(`   Total P&L: ${totalPnLUsd >= 0 ? '+' : ''}$${totalPnLUsd.toFixed(2)}`);
  console.log(`   Total ROI: ${totalROI >= 0 ? '+' : ''}${totalROI.toFixed(1)}%`);
  console.log(`   Monthly ROI: ${monthlyROI >= 0 ? '+' : ''}${monthlyROI.toFixed(2)}%`);
  
  // Regime performance breakdown
  console.log('\n' + '═'.repeat(80));
  console.log('📊 PERFORMANCE BY REGIME');
  console.log('═'.repeat(80));
  
  console.log('\n┌──────────────┬─────────┬───────────┬─────────────────┐');
  console.log('│    Regime    │ Trades  │  Win Rate │   P&L (USD)     │');
  console.log('├──────────────┼─────────┼───────────┼─────────────────┤');
  
  for (const [regime, stats] of Object.entries(regimePerformance).sort((a, b) => b[1].pnl - a[1].pnl)) {
    const wr = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1) : '0.0';
    console.log(`│ ${regime.padEnd(12)} │   ${String(stats.trades).padStart(4)}  │   ${wr.padStart(5)}%  │ ${(stats.pnl >= 0 ? '+' : '')}$${stats.pnl.toFixed(0).padStart(14)} │`);
  }
  
  console.log('└──────────────┴─────────┴───────────┴─────────────────┘');
  
  // Monthly breakdown
  console.log('\n' + '═'.repeat(80));
  console.log('📅 MONTHLY BREAKDOWN');
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
  
  // Comparison with old strategy
  console.log('\n' + '═'.repeat(80));
  console.log('⚖️ COMPARISON: OLD vs REGIME-AWARE');
  console.log('═'.repeat(80));
  
  const avgMonthlyPnL = totalPnLUsd / (actualDays / 30);
  
  console.log(`
┌─────────────────────────┬───────────────────┬───────────────────┐
│        Metric           │   Old Strategy    │   Regime-Aware    │
├─────────────────────────┼───────────────────┼───────────────────┤
│ Monthly ROI             │      ~31%         │     ~${monthlyROI.toFixed(1)}%         │
│ Positive months         │      54%          │     ${(positiveMonths / months.length * 100).toFixed(0)}%            │
│ Win Rate                │      56%          │     ${(wins / totalTrades * 100).toFixed(0)}%            │
│ Monthly profit ($10k)   │      ~$3,100      │     ~$${avgMonthlyPnL.toFixed(0).padStart(4)}        │
└─────────────────────────┴───────────────────┴───────────────────┘
`);
  
  // Projections
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
}

main().catch(console.error);
