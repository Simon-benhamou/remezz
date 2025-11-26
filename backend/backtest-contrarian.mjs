/**
 * 🔮 CONTRARIAN PREDICTIVE STRATEGY
 * 
 * Based on analysis findings:
 * - 79% accuracy: Compression + Volume + RSI oversold → BIG UP
 * - 85% of UP moves preceded by BEARISH candles
 * - Momentum is NEGATIVE before UP moves
 * 
 * Strategy: BUY THE DIP when compression + volume + oversold
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

// FEES
const MAKER_FEE = 0.0004;
const TAKER_FEE = 0.0006;
const SLIPPAGE = 0.0002;

// Leverage
const LEVERAGE = {
  'BTC/USDT:USDT': 3,
  'ETH/USDT:USDT': 4,
  'SOL/USDT:USDT': 5,
  'XRP/USDT:USDT': 5,
};

const INITIAL_CAPITAL = 10000;
const RISK_PER_TRADE = 0.03; // 3% per trade - bigger bets on high probability

async function fetchAllCandles(symbol) {
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
  return allCandles;
}

function calcMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcStdDev(values, period) {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  return Math.sqrt(variance);
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
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcVolRatio(volumes) {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avgVol > 0 ? current / avgVol : 0;
}

function detectVolatilityCompression(closes) {
  if (closes.length < 50) return { compressed: false, ratio: 1 };
  
  const bb20std = calcStdDev(closes, 20);
  const bb50std = calcStdDev(closes, 50);
  const ratio = bb20std / bb50std;
  
  return { compressed: ratio < 0.9, ratio };
}

function countConsecutiveCandles(candles, lookback = 3) {
  if (candles.length < lookback) return 'mixed';
  
  const recent = candles.slice(-lookback);
  const allBullish = recent.every(c => c[4] > c[1]); // close > open
  const allBearish = recent.every(c => c[4] < c[1]); // close < open
  
  if (allBullish) return 'bullish';
  if (allBearish) return 'bearish';
  return 'mixed';
}

function calcMomentum(closes, period) {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - period - 1];
  return ((current - past) / past) * 100;
}

function simulateTrade(candles, entryIndex, direction, entryPrice) {
  // Strategy: Looking for BIG moves (3%+), so wider stops and targets
  const stopLossPct = 3.0;  // 3% stop
  const takeProfitPct = 5.0; // 5% target (R:R = 1.67)
  const maxHoldCandles = 96; // 24 hours max hold
  
  const slippageMultiplier = direction === 'LONG' ? (1 + SLIPPAGE) : (1 - SLIPPAGE);
  const actualEntryPrice = entryPrice * slippageMultiplier;
  
  let highWaterMark = actualEntryPrice;
  let lowWaterMark = actualEntryPrice;
  
  for (let j = entryIndex + 1; j < Math.min(entryIndex + maxHoldCandles, candles.length); j++) {
    const high = candles[j][2];
    const low = candles[j][3];
    const currentPrice = candles[j][4];
    
    if (high > highWaterMark) highWaterMark = high;
    if (low < lowWaterMark) lowWaterMark = low;
    
    let pnlPct;
    if (direction === 'LONG') {
      pnlPct = ((currentPrice - actualEntryPrice) / actualEntryPrice) * 100;
    } else {
      pnlPct = ((actualEntryPrice - currentPrice) / actualEntryPrice) * 100;
    }
    
    // Take Profit
    if (pnlPct >= takeProfitPct) {
      const totalFees = (MAKER_FEE * 2) * 100;
      return { 
        outcome: 'WIN', 
        pnlPctNet: takeProfitPct - SLIPPAGE * 100 - totalFees,
        holdCandles: j - entryIndex,
        exitReason: 'TP'
      };
    }
    
    // Stop Loss
    if (pnlPct <= -stopLossPct) {
      const totalFees = (TAKER_FEE * 2) * 100;
      return { 
        outcome: 'LOSS', 
        pnlPctNet: -stopLossPct - SLIPPAGE * 100 - totalFees,
        holdCandles: j - entryIndex,
        exitReason: 'SL'
      };
    }
    
    // Trailing at +3%
    if (pnlPct >= 3.0) {
      const trailingDistance = 1.0;
      
      let trailingStopHit = false;
      if (direction === 'LONG') {
        const trailingStop = highWaterMark * (1 - trailingDistance / 100);
        if (low <= trailingStop) trailingStopHit = true;
      } else {
        const trailingStop = lowWaterMark * (1 + trailingDistance / 100);
        if (high >= trailingStop) trailingStopHit = true;
      }
      
      if (trailingStopHit) {
        let bestPnl = direction === 'LONG' 
          ? ((highWaterMark - actualEntryPrice) / actualEntryPrice) * 100
          : ((actualEntryPrice - lowWaterMark) / actualEntryPrice) * 100;
        
        const totalFees = (MAKER_FEE + TAKER_FEE) * 100;
        return { 
          outcome: 'WIN', 
          pnlPctNet: bestPnl - trailingDistance - SLIPPAGE * 100 - totalFees,
          holdCandles: j - entryIndex,
          exitReason: 'TRAIL'
        };
      }
    }
  }
  
  // Max hold
  const lastPrice = candles[Math.min(entryIndex + maxHoldCandles - 1, candles.length - 1)][4];
  const exitSlippage = direction === 'LONG' ? -SLIPPAGE : SLIPPAGE;
  const actualExitPrice = lastPrice * (1 + exitSlippage);
  
  let finalPnl = direction === 'LONG'
    ? ((actualExitPrice - actualEntryPrice) / actualEntryPrice) * 100
    : ((actualEntryPrice - actualExitPrice) / actualEntryPrice) * 100;
    
  const totalFees = (TAKER_FEE * 2) * 100;
  
  return { 
    outcome: finalPnl > 0 ? 'WIN' : 'LOSS', 
    pnlPctNet: finalPnl - totalFees,
    holdCandles: maxHoldCandles,
    exitReason: 'TIMEOUT'
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🔮 CONTRARIAN PREDICTIVE STRATEGY BACKTEST');
  console.log('═'.repeat(80));
  console.log(`\n💰 Initial Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log(`📊 Risk per trade: ${RISK_PER_TRADE * 100}%`);
  console.log(`🎯 Target: +5%, Stop: -3% (R:R = 1.67)`);
  
  console.log('\n📥 Fetching data...');
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    allCandles[symbol] = await fetchAllCandles(symbol);
    console.log(`   ✅ ${symbol}: ${allCandles[symbol].length} candles`);
  }
  
  const btcCandles = allCandles['BTC/USDT:USDT'];
  const btcTimestampIndex = new Map();
  btcCandles.forEach((c, i) => btcTimestampIndex.set(c[0], i));
  
  console.log('\n🔍 Running contrarian predictive backtest...\n');
  
  const trades = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    let lastTradeCandle = 0;
    
    for (let i = 200; i < candles.length - 100; i++) {
      // Cooldown: 24 candles (6 hours) between trades
      if (i - lastTradeCandle < 24) continue;
      
      const timestamp = candles[i][0];
      const btcI = btcTimestampIndex.get(timestamp);
      if (btcI === undefined || btcI < 200) continue;
      
      const current = candles[i];
      const close = current[4];
      
      const closes = candles.slice(0, i + 1).map(c => c[4]);
      const volumes = candles.slice(0, i + 1).map(c => c[5]);
      const btcCloses = btcCandles.slice(0, btcI + 1).map(c => c[4]);
      
      // Calculate predictive indicators
      const volRatio = calcVolRatio(volumes);
      const rsi = calcRSI(closes, 14);
      const { compressed, ratio: volCompression } = detectVolatilityCompression(closes);
      const btcVolCompression = detectVolatilityCompression(btcCloses);
      const consecutive = countConsecutiveCandles(candles.slice(0, i + 1), 3);
      const momentum1h = calcMomentum(closes, 4);
      const momentum4h = calcMomentum(closes, 16);
      
      let direction = null;
      let setupType = null;
      
      // ============================================
      // SETUP 1: CONTRARIAN REVERSAL (79% accuracy)
      // Compression + Volume building + RSI oversold + Bearish candles
      // → BUY (expect UP move)
      // ============================================
      if (compressed && volRatio > 1.1 && rsi < 45 && consecutive === 'bearish') {
        direction = 'LONG';
        setupType = 'REVERSAL_UP';
      }
      
      // ============================================
      // SETUP 2: CONTRARIAN TOP
      // Compression + Volume building + RSI overbought + Bullish candles
      // → SHORT (expect DOWN move)
      // ============================================
      if (compressed && volRatio > 1.1 && rsi > 55 && consecutive === 'bullish') {
        direction = 'SHORT';
        setupType = 'REVERSAL_DOWN';
      }
      
      // ============================================
      // SETUP 3: MOMENTUM EXHAUSTION
      // Strong momentum + RSI extreme → expect reversal
      // ============================================
      if (!direction && volRatio > 1.5) {
        // Price has been pumping but showing exhaustion
        if (momentum4h > 2 && rsi > 65 && momentum1h < 0) {
          direction = 'SHORT';
          setupType = 'EXHAUSTION_DOWN';
        }
        // Price has been dumping but showing recovery
        if (momentum4h < -2 && rsi < 35 && momentum1h > 0) {
          direction = 'LONG';
          setupType = 'EXHAUSTION_UP';
        }
      }
      
      // ============================================
      // SETUP 4: BTC DIVERGENCE
      // BTC compressed + altcoin showing strength/weakness
      // ============================================
      if (!direction && btcVolCompression.compressed && symbol !== 'BTC/USDT:USDT') {
        const altMom = momentum4h;
        const btcMom = calcMomentum(btcCloses, 16);
        
        // Altcoin stronger than BTC during compression = potential breakout leader
        if (altMom > btcMom + 1 && volRatio > 1.3 && rsi < 60) {
          direction = 'LONG';
          setupType = 'ALT_STRENGTH';
        }
        // Altcoin weaker than BTC = potential dump leader
        if (altMom < btcMom - 1 && volRatio > 1.3 && rsi > 40) {
          direction = 'SHORT';
          setupType = 'ALT_WEAKNESS';
        }
      }
      
      if (!direction) continue;
      
      const result = simulateTrade(candles, i, direction, close);
      const date = new Date(timestamp);
      
      trades.push({
        symbol,
        timestamp,
        direction,
        setupType,
        outcome: result.outcome,
        pnlPctNet: result.pnlPctNet,
        leverage: LEVERAGE[symbol],
        exitReason: result.exitReason,
        monthKey: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      });
      
      lastTradeCandle = i;
    }
  }
  
  // Results
  console.log(`📊 Total trades: ${trades.length}`);
  
  if (trades.length === 0) {
    console.log('❌ No trades generated. Filters too strict.');
    return;
  }
  
  let totalPnlNoLev = 0, totalPnlWithLev = 0;
  const wins = trades.filter(t => t.outcome === 'WIN');
  
  trades.forEach(t => {
    const posSize = INITIAL_CAPITAL * RISK_PER_TRADE;
    totalPnlNoLev += posSize * (t.pnlPctNet / 100);
    totalPnlWithLev += posSize * t.leverage * (t.pnlPctNet / 100);
  });
  
  const winRate = (wins.length / trades.length * 100).toFixed(1);
  
  console.log(`\n${'═'.repeat(80)}`);
  console.log('📈 OVERALL PERFORMANCE');
  console.log('═'.repeat(80));
  
  console.log(`\n🎯 Win Rate: ${winRate}%`);
  console.log(`\n┌─────────────────────┬─────────────────────┬─────────────────────┐`);
  console.log(`│                     │   WITHOUT LEVERAGE  │   WITH LEVERAGE     │`);
  console.log(`├─────────────────────┼─────────────────────┼─────────────────────┤`);
  console.log(`│ Total P&L           │ ${(totalPnlNoLev >= 0 ? '+' : '')}$${totalPnlNoLev.toFixed(2).padStart(15)} │ ${(totalPnlWithLev >= 0 ? '+' : '')}$${totalPnlWithLev.toFixed(2).padStart(15)} │`);
  console.log(`│ ROI                 │ ${(totalPnlNoLev >= 0 ? '+' : '')}${(totalPnlNoLev / INITIAL_CAPITAL * 100).toFixed(1).padStart(16)}% │ ${(totalPnlWithLev >= 0 ? '+' : '')}${(totalPnlWithLev / INITIAL_CAPITAL * 100).toFixed(1).padStart(16)}% │`);
  console.log(`│ Monthly ROI         │ ${(totalPnlNoLev >= 0 ? '+' : '')}${(totalPnlNoLev / INITIAL_CAPITAL * 100 / 12).toFixed(2).padStart(16)}% │ ${(totalPnlWithLev >= 0 ? '+' : '')}${(totalPnlWithLev / INITIAL_CAPITAL * 100 / 12).toFixed(2).padStart(16)}% │`);
  console.log(`└─────────────────────┴─────────────────────┴─────────────────────┘`);
  
  // By setup type
  console.log(`\n📊 Performance by Setup Type:`);
  console.log(`┌─────────────────────┬─────────┬───────────┬─────────────────────┐`);
  console.log(`│     Setup Type      │ Trades  │  Win Rate │  P&L (with lev)     │`);
  console.log(`├─────────────────────┼─────────┼───────────┼─────────────────────┤`);
  
  const setupTypes = [...new Set(trades.map(t => t.setupType))];
  for (const setup of setupTypes) {
    const setupTrades = trades.filter(t => t.setupType === setup);
    const setupWins = setupTrades.filter(t => t.outcome === 'WIN').length;
    let pnl = 0;
    setupTrades.forEach(t => {
      pnl += INITIAL_CAPITAL * RISK_PER_TRADE * t.leverage * (t.pnlPctNet / 100);
    });
    const wr = (setupWins / setupTrades.length * 100).toFixed(1);
    console.log(`│ ${setup.padEnd(19)} │  ${String(setupTrades.length).padStart(5)}  │   ${wr.padStart(5)}%  │ ${(pnl >= 0 ? '+' : '')}$${pnl.toFixed(2).padStart(16)} │`);
  }
  console.log(`└─────────────────────┴─────────┴───────────┴─────────────────────┘`);
  
  // Monthly
  console.log(`\n📅 Monthly Performance:`);
  console.log(`┌──────────────┬─────────┬───────────┬─────────────────────┬─────────────────────┐`);
  console.log(`│    Month     │ Trades  │  Win Rate │  P&L (no lev)       │  P&L (with lev)     │`);
  console.log(`├──────────────┼─────────┼───────────┼─────────────────────┼─────────────────────┤`);
  
  const monthlyPnl = {};
  trades.forEach(t => {
    if (!monthlyPnl[t.monthKey]) monthlyPnl[t.monthKey] = { noLev: 0, withLev: 0, trades: 0, wins: 0 };
    const posSize = INITIAL_CAPITAL * RISK_PER_TRADE;
    monthlyPnl[t.monthKey].noLev += posSize * (t.pnlPctNet / 100);
    monthlyPnl[t.monthKey].withLev += posSize * t.leverage * (t.pnlPctNet / 100);
    monthlyPnl[t.monthKey].trades++;
    if (t.outcome === 'WIN') monthlyPnl[t.monthKey].wins++;
  });
  
  const months = Object.keys(monthlyPnl).sort();
  let positiveMonths = 0;
  
  for (const month of months) {
    const stats = monthlyPnl[month];
    const wr = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1) : '0.0';
    if (stats.withLev > 0) positiveMonths++;
    console.log(`│ ${month.padEnd(12)} │  ${String(stats.trades).padStart(5)}  │   ${wr.padStart(5)}%  │ ${(stats.noLev >= 0 ? '+' : '')}$${stats.noLev.toFixed(2).padStart(16)} │ ${(stats.withLev >= 0 ? '+' : '')}$${stats.withLev.toFixed(2).padStart(16)} │`);
  }
  
  console.log(`├──────────────┴─────────┴───────────┴─────────────────────┴─────────────────────┤`);
  console.log(`│ Positive Months: ${positiveMonths}/${months.length} (${(positiveMonths / months.length * 100).toFixed(0)}%)${' '.repeat(52)}│`);
  console.log(`└────────────────────────────────────────────────────────────────────────────────┘`);
  
  // By exit reason
  console.log(`\n📊 Exit Reasons:`);
  const exitReasons = {};
  trades.forEach(t => {
    if (!exitReasons[t.exitReason]) exitReasons[t.exitReason] = { count: 0, wins: 0 };
    exitReasons[t.exitReason].count++;
    if (t.outcome === 'WIN') exitReasons[t.exitReason].wins++;
  });
  
  for (const [reason, stats] of Object.entries(exitReasons)) {
    console.log(`   ${reason}: ${stats.count} trades (${(stats.wins / stats.count * 100).toFixed(0)}% wins)`);
  }
}

main().catch(console.error);
