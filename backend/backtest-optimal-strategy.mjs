/**
 * 🎯 OPTIMAL STRATEGY BACKTEST
 * 
 * Based on deep analysis findings:
 * - Best strategy: SHORT when BTC in downtrend (85% positive months)
 * - Secondary: LONG when BTC in uptrend  
 * 
 * Includes:
 * - Realistic trading fees (0.04% maker, 0.06% taker)
 * - Slippage (0.02%)
 * - With and without leverage comparison
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

// FEES (Binance Futures)
const MAKER_FEE = 0.0004; // 0.04%
const TAKER_FEE = 0.0006; // 0.06%
const SLIPPAGE = 0.0002;  // 0.02%

// Leverage by symbol
const LEVERAGE = {
  'BTC/USDT:USDT': 3,
  'ETH/USDT:USDT': 4,
  'SOL/USDT:USDT': 5,
  'XRP/USDT:USDT': 5,
};

const INITIAL_CAPITAL = 10000;
const RISK_PER_TRADE = 0.01; // 1%

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

function calcEMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
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

function detectBTCTrend(closes) {
  if (closes.length < 50) return 'sideways';
  
  const ema8 = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  
  // Strong trend = all EMAs aligned
  if (ema8 > ema21 && ema21 > ema50) return 'strong_up';
  if (ema8 < ema21 && ema21 < ema50) return 'strong_down';
  
  // Weak trend
  if (ema8 > ema21) return 'up';
  if (ema8 < ema21) return 'down';
  
  return 'sideways';
}

function simulateTrade(candles, entryIndex, direction, entryPrice, stopLossPct = 2, maxHoldCandles = 24) {
  // Apply slippage on entry
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
    
    // Stop Loss
    if (pnlPct <= -stopLossPct) {
      // Apply exit slippage + fees
      const exitSlippage = SLIPPAGE * 100;
      const totalFees = (TAKER_FEE * 2) * 100; // Entry + exit taker fees
      return { 
        outcome: 'LOSS', 
        pnlPctRaw: -stopLossPct - exitSlippage,
        fees: totalFees,
        holdCandles: j - entryIndex 
      };
    }
    
    // Trailing stop at +1%
    if (pnlPct >= 1.0) {
      let trailingDistance = 0.5;
      if (pnlPct >= 2.0) trailingDistance = 0.3;
      
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
        
        const exitSlippage = SLIPPAGE * 100;
        const totalFees = (MAKER_FEE + TAKER_FEE) * 100; // Maker entry, taker exit
        return { 
          outcome: 'WIN', 
          pnlPctRaw: bestPnl - trailingDistance - exitSlippage,
          fees: totalFees,
          holdCandles: j - entryIndex 
        };
      }
    }
  }
  
  // Max hold - exit at market
  const lastPrice = candles[Math.min(entryIndex + maxHoldCandles - 1, candles.length - 1)][4];
  const exitSlippage = direction === 'LONG' ? -SLIPPAGE : SLIPPAGE;
  const actualExitPrice = lastPrice * (1 + exitSlippage);
  
  let finalPnl = direction === 'LONG'
    ? ((actualExitPrice - actualEntryPrice) / actualEntryPrice) * 100
    : ((actualEntryPrice - actualExitPrice) / actualEntryPrice) * 100;
    
  const totalFees = (TAKER_FEE * 2) * 100;
  
  return { 
    outcome: finalPnl > totalFees ? 'WIN' : 'LOSS', 
    pnlPctRaw: finalPnl,
    fees: totalFees,
    holdCandles: maxHoldCandles 
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 OPTIMAL STRATEGY BACKTEST - With Realistic Fees');
  console.log('═'.repeat(80));
  console.log(`\n💰 Initial Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log(`📊 Risk per trade: ${RISK_PER_TRADE * 100}%`);
  console.log(`💸 Fees: Maker ${MAKER_FEE * 100}%, Taker ${TAKER_FEE * 100}%, Slippage ${SLIPPAGE * 100}%`);
  console.log(`🔧 Leverage: BTC=${LEVERAGE['BTC/USDT:USDT']}x, ETH=${LEVERAGE['ETH/USDT:USDT']}x, SOL/XRP=${LEVERAGE['SOL/USDT:USDT']}x`);
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  const btcCandles = allCandles['BTC/USDT:USDT'];
  const btcTimestampIndex = new Map();
  btcCandles.forEach((c, i) => btcTimestampIndex.set(c[0], i));
  
  console.log('\n🔍 Running backtest with optimal strategy...\n');
  
  const trades = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 100; i < candles.length - 30; i++) {
      const timestamp = candles[i][0];
      const btcI = btcTimestampIndex.get(timestamp);
      if (btcI === undefined || btcI < 100) continue;
      
      const current = candles[i];
      const open = current[1];
      const close = current[4];
      const isBullishCandle = close > open;
      const isBearishCandle = close < open;
      
      const closes = candles.slice(0, i + 1).map(c => c[4]);
      const volumes = candles.slice(0, i + 1).map(c => c[5]);
      const btcCloses = btcCandles.slice(0, btcI + 1).map(c => c[4]);
      
      const volRatio = calcVolRatio(volumes);
      const rsi = calcRSI(closes, 14);
      const ma20 = calcMA(closes, 20);
      const btcTrend = detectBTCTrend(btcCloses);
      
      // Minimum volume requirement
      if (volRatio < 2) continue;
      
      let direction = null;
      
      // 🏆 OPTIMAL STRATEGY RULES
      
      // SHORT: BTC in downtrend (strong_down or down) + bearish candle + RSI not oversold
      if (['strong_down', 'down'].includes(btcTrend) && isBearishCandle && close < ma20 && rsi > 30) {
        direction = 'SHORT';
      }
      
      // LONG: BTC in uptrend (strong_up or up) + bullish candle + RSI not overbought
      if (['strong_up', 'up'].includes(btcTrend) && isBullishCandle && close > ma20 && rsi < 70) {
        direction = 'LONG';
      }
      
      if (!direction) continue;
      
      const result = simulateTrade(candles, i, direction, close);
      const date = new Date(timestamp);
      
      trades.push({
        symbol,
        timestamp,
        direction,
        outcome: result.outcome,
        pnlPctRaw: result.pnlPctRaw,
        fees: result.fees,
        pnlPctNet: result.pnlPctRaw - result.fees,
        holdCandles: result.holdCandles,
        btcTrend,
        leverage: LEVERAGE[symbol],
        monthKey: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      });
      
      // Skip next 4 candles (1 hour cooldown)
      i += 4;
    }
  }
  
  console.log(`📊 Total trades: ${trades.length}`);
  
  // Calculate P&L with and without leverage
  let totalPnlWithLeverage = 0;
  let totalPnlWithoutLeverage = 0;
  let totalFees = 0;
  
  const wins = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');
  
  trades.forEach(t => {
    const positionSize = INITIAL_CAPITAL * RISK_PER_TRADE;
    
    // Without leverage
    const pnlNoLev = positionSize * (t.pnlPctNet / 100);
    totalPnlWithoutLeverage += pnlNoLev;
    
    // With leverage
    const pnlWithLev = positionSize * t.leverage * (t.pnlPctNet / 100);
    totalPnlWithLeverage += pnlWithLev;
    
    totalFees += positionSize * t.leverage * (t.fees / 100);
  });
  
  const winRate = (wins.length / trades.length * 100).toFixed(1);
  
  console.log(`\n${'═'.repeat(80)}`);
  console.log('📈 OVERALL PERFORMANCE');
  console.log('═'.repeat(80));
  
  console.log(`\n🎯 Win Rate: ${winRate}% (${wins.length} wins / ${losses.length} losses)`);
  console.log(`💸 Total Fees Paid: $${totalFees.toFixed(2)}`);
  
  console.log(`\n┌─────────────────────────────────┬─────────────────────────┬─────────────────────────┐`);
  console.log(`│                                 │   WITHOUT LEVERAGE      │   WITH LEVERAGE         │`);
  console.log(`├─────────────────────────────────┼─────────────────────────┼─────────────────────────┤`);
  console.log(`│ Total P&L                       │ ${(totalPnlWithoutLeverage >= 0 ? '+' : '')}$${totalPnlWithoutLeverage.toFixed(2).padStart(19)} │ ${(totalPnlWithLeverage >= 0 ? '+' : '')}$${totalPnlWithLeverage.toFixed(2).padStart(19)} │`);
  console.log(`│ ROI                             │ ${(totalPnlWithoutLeverage >= 0 ? '+' : '')}${(totalPnlWithoutLeverage / INITIAL_CAPITAL * 100).toFixed(1).padStart(20)}% │ ${(totalPnlWithLeverage >= 0 ? '+' : '')}${(totalPnlWithLeverage / INITIAL_CAPITAL * 100).toFixed(1).padStart(20)}% │`);
  console.log(`│ Monthly Avg ROI                 │ ${(totalPnlWithoutLeverage >= 0 ? '+' : '')}${(totalPnlWithoutLeverage / INITIAL_CAPITAL * 100 / 12).toFixed(2).padStart(20)}% │ ${(totalPnlWithLeverage >= 0 ? '+' : '')}${(totalPnlWithLeverage / INITIAL_CAPITAL * 100 / 12).toFixed(2).padStart(20)}% │`);
  console.log(`└─────────────────────────────────┴─────────────────────────┴─────────────────────────┘`);
  
  // Performance by direction
  console.log(`\n📊 Performance by Direction:`);
  console.log(`┌──────────────┬─────────┬───────────┬─────────────────────┬─────────────────────┐`);
  console.log(`│  Direction   │ Trades  │  Win Rate │  P&L (no lev)       │  P&L (with lev)     │`);
  console.log(`├──────────────┼─────────┼───────────┼─────────────────────┼─────────────────────┤`);
  
  for (const dir of ['LONG', 'SHORT']) {
    const dirTrades = trades.filter(t => t.direction === dir);
    if (dirTrades.length === 0) continue;
    
    const dirWins = dirTrades.filter(t => t.outcome === 'WIN').length;
    let pnlNoLev = 0, pnlWithLev = 0;
    
    dirTrades.forEach(t => {
      const posSize = INITIAL_CAPITAL * RISK_PER_TRADE;
      pnlNoLev += posSize * (t.pnlPctNet / 100);
      pnlWithLev += posSize * t.leverage * (t.pnlPctNet / 100);
    });
    
    const wr = (dirWins / dirTrades.length * 100).toFixed(1);
    console.log(`│ ${dir.padEnd(12)} │  ${String(dirTrades.length).padStart(5)}  │   ${wr.padStart(5)}%  │ ${(pnlNoLev >= 0 ? '+' : '')}$${pnlNoLev.toFixed(2).padStart(16)} │ ${(pnlWithLev >= 0 ? '+' : '')}$${pnlWithLev.toFixed(2).padStart(16)} │`);
  }
  console.log(`└──────────────┴─────────┴───────────┴─────────────────────┴─────────────────────┘`);
  
  // Performance by BTC Trend
  console.log(`\n📊 Performance by BTC Trend:`);
  console.log(`┌──────────────────┬─────────┬───────────┬─────────────────────┬─────────────────────┐`);
  console.log(`│    BTC Trend     │ Trades  │  Win Rate │  P&L (no lev)       │  P&L (with lev)     │`);
  console.log(`├──────────────────┼─────────┼───────────┼─────────────────────┼─────────────────────┤`);
  
  const trends = [...new Set(trades.map(t => t.btcTrend))].sort();
  for (const trend of trends) {
    const trendTrades = trades.filter(t => t.btcTrend === trend);
    if (trendTrades.length === 0) continue;
    
    const trendWins = trendTrades.filter(t => t.outcome === 'WIN').length;
    let pnlNoLev = 0, pnlWithLev = 0;
    
    trendTrades.forEach(t => {
      const posSize = INITIAL_CAPITAL * RISK_PER_TRADE;
      pnlNoLev += posSize * (t.pnlPctNet / 100);
      pnlWithLev += posSize * t.leverage * (t.pnlPctNet / 100);
    });
    
    const wr = (trendWins / trendTrades.length * 100).toFixed(1);
    console.log(`│ ${trend.padEnd(16)} │  ${String(trendTrades.length).padStart(5)}  │   ${wr.padStart(5)}%  │ ${(pnlNoLev >= 0 ? '+' : '')}$${pnlNoLev.toFixed(2).padStart(16)} │ ${(pnlWithLev >= 0 ? '+' : '')}$${pnlWithLev.toFixed(2).padStart(16)} │`);
  }
  console.log(`└──────────────────┴─────────┴───────────┴─────────────────────┴─────────────────────┘`);
  
  // Monthly breakdown
  console.log(`\n📅 Monthly Performance:`);
  console.log(`┌──────────────┬─────────┬───────────┬─────────────────────┬─────────────────────┐`);
  console.log(`│    Month     │ Trades  │  Win Rate │  P&L (no lev)       │  P&L (with lev)     │`);
  console.log(`├──────────────┼─────────┼───────────┼─────────────────────┼─────────────────────┤`);
  
  const months = [...new Set(trades.map(t => t.monthKey))].sort();
  let positiveMonthsNoLev = 0;
  let positiveMonthsWithLev = 0;
  
  for (const month of months) {
    const monthTrades = trades.filter(t => t.monthKey === month);
    const monthWins = monthTrades.filter(t => t.outcome === 'WIN').length;
    
    let pnlNoLev = 0, pnlWithLev = 0;
    monthTrades.forEach(t => {
      const posSize = INITIAL_CAPITAL * RISK_PER_TRADE;
      pnlNoLev += posSize * (t.pnlPctNet / 100);
      pnlWithLev += posSize * t.leverage * (t.pnlPctNet / 100);
    });
    
    if (pnlNoLev > 0) positiveMonthsNoLev++;
    if (pnlWithLev > 0) positiveMonthsWithLev++;
    
    const wr = monthTrades.length > 0 ? (monthWins / monthTrades.length * 100).toFixed(1) : '0.0';
    const noLevStr = `${pnlNoLev >= 0 ? '+' : ''}$${pnlNoLev.toFixed(2)}`;
    const withLevStr = `${pnlWithLev >= 0 ? '+' : ''}$${pnlWithLev.toFixed(2)}`;
    
    console.log(`│ ${month.padEnd(12)} │  ${String(monthTrades.length).padStart(5)}  │   ${wr.padStart(5)}%  │ ${noLevStr.padStart(19)} │ ${withLevStr.padStart(19)} │`);
  }
  
  console.log(`├──────────────┴─────────┴───────────┴─────────────────────┴─────────────────────┤`);
  console.log(`│ Positive Months:                    ${String(positiveMonthsNoLev).padStart(2)}/${months.length} (${(positiveMonthsNoLev/months.length*100).toFixed(0)}%)             ${String(positiveMonthsWithLev).padStart(2)}/${months.length} (${(positiveMonthsWithLev/months.length*100).toFixed(0)}%)             │`);
  console.log(`└────────────────────────────────────────────────────────────────────────────────┘`);
  
  // Summary
  console.log(`\n${'═'.repeat(80)}`);
  console.log('💡 STRATEGY SUMMARY');
  console.log('═'.repeat(80));
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🎯 OPTIMAL STRATEGY RESULTS (with fees & slippage):                           ║
║                                                                               ║
║ ┌─────────────────────────────────────────────────────────────────────────┐   ║
║ │ WITHOUT LEVERAGE:                                                       │   ║
║ │   • Total P&L: ${(totalPnlWithoutLeverage >= 0 ? '+' : '')}$${totalPnlWithoutLeverage.toFixed(2).padEnd(50)}│   ║
║ │   • ROI: ${(totalPnlWithoutLeverage / INITIAL_CAPITAL * 100).toFixed(1)}% annually (${(totalPnlWithoutLeverage / INITIAL_CAPITAL * 100 / 12).toFixed(2)}%/month)${' '.repeat(27)}│   ║
║ │   • Positive months: ${positiveMonthsNoLev}/${months.length} (${(positiveMonthsNoLev/months.length*100).toFixed(0)}%)${' '.repeat(38)}│   ║
║ └─────────────────────────────────────────────────────────────────────────┘   ║
║                                                                               ║
║ ┌─────────────────────────────────────────────────────────────────────────┐   ║
║ │ WITH LEVERAGE (3-5x):                                                   │   ║
║ │   • Total P&L: ${(totalPnlWithLeverage >= 0 ? '+' : '')}$${totalPnlWithLeverage.toFixed(2).padEnd(50)}│   ║
║ │   • ROI: ${(totalPnlWithLeverage / INITIAL_CAPITAL * 100).toFixed(1)}% annually (${(totalPnlWithLeverage / INITIAL_CAPITAL * 100 / 12).toFixed(2)}%/month)${' '.repeat(26)}│   ║
║ │   • Positive months: ${positiveMonthsWithLev}/${months.length} (${(positiveMonthsWithLev/months.length*100).toFixed(0)}%)${' '.repeat(38)}│   ║
║ └─────────────────────────────────────────────────────────────────────────┘   ║
║                                                                               ║
║ 📊 KEY STATS:                                                                 ║
║   • Win Rate: ${winRate}%                                                       ║
║   • Total Trades: ${trades.length}                                                       ║
║   • Total Fees Paid: $${totalFees.toFixed(2)}                                            ║
║   • Best: SHORT in downtrend, LONG in uptrend                                 ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
}

main().catch(console.error);
