/**
 * 🎯 ULTRA SELECTIVE - Only THE BEST setups
 * 
 * Based on all our analysis:
 * - ONLY take exhaustion setups (57.7% WR was profitable)
 * - Require EXTREME conditions
 * - Max 50-100 trades per year
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
  'BTC/USDT:USDT': 5,  // Higher leverage for best setups
  'ETH/USDT:USDT': 7,
  'SOL/USDT:USDT': 10,
  'XRP/USDT:USDT': 10,
};

const INITIAL_CAPITAL = 10000;
const RISK_PER_TRADE = 0.05; // 5% per trade - big bets on rare high-prob setups

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
  const recent5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avgVol > 0 ? recent5 / avgVol : 0;
}

function calcMomentum(closes, period) {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - period - 1];
  return ((current - past) / past) * 100;
}

function calcStdDev(values, period) {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  return Math.sqrt(variance);
}

function detectVolatilitySpike(candles) {
  if (candles.length < 50) return false;
  
  // Current candle range
  const currentRange = Math.abs(candles[candles.length - 1][2] - candles[candles.length - 1][3]);
  const currentClose = candles[candles.length - 1][4];
  const currentRangePct = (currentRange / currentClose) * 100;
  
  // Average range of last 20
  let avgRange = 0;
  for (let i = candles.length - 21; i < candles.length - 1; i++) {
    avgRange += Math.abs(candles[i][2] - candles[i][3]) / candles[i][4] * 100;
  }
  avgRange /= 20;
  
  return currentRangePct > avgRange * 2; // 2x normal range = volatility spike
}

function simulateTrade(candles, entryIndex, direction, entryPrice) {
  // Aggressive targets for high-prob setups
  const stopLossPct = 4.0;  // 4% stop
  const takeProfitPct = 8.0; // 8% target (R:R = 2)
  const maxHoldCandles = 192; // 48 hours max hold
  
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
        exitReason: 'TP'
      };
    }
    
    // Stop Loss
    if (pnlPct <= -stopLossPct) {
      const totalFees = (TAKER_FEE * 2) * 100;
      return { 
        outcome: 'LOSS', 
        pnlPctNet: -stopLossPct - SLIPPAGE * 100 - totalFees,
        exitReason: 'SL'
      };
    }
    
    // Trailing at +4%
    if (pnlPct >= 4.0) {
      const trailingDistance = 1.5;
      
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
          exitReason: 'TRAIL'
        };
      }
    }
  }
  
  // Max hold
  const lastPrice = candles[Math.min(entryIndex + maxHoldCandles - 1, candles.length - 1)][4];
  let finalPnl = direction === 'LONG'
    ? ((lastPrice - actualEntryPrice) / actualEntryPrice) * 100
    : ((actualEntryPrice - lastPrice) / actualEntryPrice) * 100;
    
  const totalFees = (TAKER_FEE * 2) * 100;
  
  return { 
    outcome: finalPnl > 0 ? 'WIN' : 'LOSS', 
    pnlPctNet: finalPnl - SLIPPAGE * 100 - totalFees,
    exitReason: 'TIMEOUT'
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 ULTRA SELECTIVE STRATEGY - Only EXTREME Setups');
  console.log('═'.repeat(80));
  console.log(`\n💰 Initial Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log(`📊 Risk per trade: ${RISK_PER_TRADE * 100}%`);
  console.log(`🎯 Target: +8%, Stop: -4% (R:R = 2)`);
  console.log(`🔧 High Leverage: BTC=5x, ETH=7x, SOL/XRP=10x`);
  
  console.log('\n📥 Fetching data...');
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    allCandles[symbol] = await fetchAllCandles(symbol);
    console.log(`   ✅ ${symbol}: ${allCandles[symbol].length} candles`);
  }
  
  const btcCandles = allCandles['BTC/USDT:USDT'];
  const btcTimestampIndex = new Map();
  btcCandles.forEach((c, i) => btcTimestampIndex.set(c[0], i));
  
  console.log('\n🔍 Finding EXTREME setups only...\n');
  
  const trades = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    let lastTradeCandle = 0;
    
    for (let i = 200; i < candles.length - 200; i++) {
      // Long cooldown: 96 candles (24 hours) between trades per symbol
      if (i - lastTradeCandle < 96) continue;
      
      const timestamp = candles[i][0];
      const btcI = btcTimestampIndex.get(timestamp);
      if (btcI === undefined || btcI < 200) continue;
      
      const current = candles[i];
      const close = current[4];
      const open = current[1];
      const isBigCandle = Math.abs(close - open) / open * 100 > 1; // >1% body
      
      const closes = candles.slice(0, i + 1).map(c => c[4]);
      const volumes = candles.slice(0, i + 1).map(c => c[5]);
      const btcCloses = btcCandles.slice(0, btcI + 1).map(c => c[4]);
      
      // Indicators
      const volRatio = calcVolRatio(volumes);
      const rsi = calcRSI(closes, 14);
      const btcRsi = calcRSI(btcCloses, 14);
      const momentum4h = calcMomentum(closes, 16);
      const momentum24h = calcMomentum(closes, 96);
      const btcMomentum24h = calcMomentum(btcCloses, 96);
      const volSpike = detectVolatilitySpike(candles.slice(0, i + 1));
      
      let direction = null;
      let setupType = null;
      
      // ============================================
      // SETUP 1: EXTREME OVERSOLD BOUNCE
      // RSI < 25, BTC RSI < 30, Volume spike, momentum deeply negative
      // → BUY expecting mean reversion
      // ============================================
      if (rsi < 25 && btcRsi < 35 && volRatio > 2 && momentum24h < -5 && isBigCandle && close < open) {
        direction = 'LONG';
        setupType = 'EXTREME_OVERSOLD';
      }
      
      // ============================================
      // SETUP 2: EXTREME OVERBOUGHT DUMP
      // RSI > 75, BTC RSI > 70, Volume spike, momentum extremely positive
      // → SHORT expecting pullback
      // ============================================
      if (rsi > 75 && btcRsi > 65 && volRatio > 2 && momentum24h > 5 && isBigCandle && close > open) {
        direction = 'SHORT';
        setupType = 'EXTREME_OVERBOUGHT';
      }
      
      // ============================================
      // SETUP 3: CAPITULATION (panic selling)
      // Huge red candle + extreme volume + RSI crushed
      // → BUY the panic
      // ============================================
      if (!direction && volRatio > 3 && rsi < 30 && momentum4h < -3 && close < open && isBigCandle && volSpike) {
        direction = 'LONG';
        setupType = 'CAPITULATION';
      }
      
      // ============================================
      // SETUP 4: BLOW-OFF TOP (euphoria)
      // Huge green candle + extreme volume + RSI maxed
      // → SHORT the euphoria
      // ============================================
      if (!direction && volRatio > 3 && rsi > 70 && momentum4h > 3 && close > open && isBigCandle && volSpike) {
        direction = 'SHORT';
        setupType = 'BLOWOFF_TOP';
      }
      
      // ============================================
      // SETUP 5: BTC DIVERGENCE EXTREME
      // Asset lagging BTC significantly during BTC move
      // ============================================
      if (!direction && symbol !== 'BTC/USDT:USDT') {
        // BTC pumping but alt not following
        if (btcMomentum24h > 4 && momentum24h < 1 && btcRsi > 60 && rsi < 50 && volRatio > 1.5) {
          direction = 'LONG';
          setupType = 'BTC_LAG_LONG';
        }
        // BTC dumping but alt holding
        if (btcMomentum24h < -4 && momentum24h > -1 && btcRsi < 40 && rsi > 50 && volRatio > 1.5) {
          direction = 'SHORT';
          setupType = 'BTC_LAG_SHORT';
        }
      }
      
      if (!direction) continue;
      
      const result = simulateTrade(candles, i, direction, close);
      const date = new Date(timestamp);
      
      trades.push({
        symbol,
        timestamp,
        date: date.toISOString().split('T')[0],
        direction,
        setupType,
        outcome: result.outcome,
        pnlPctNet: result.pnlPctNet,
        leverage: LEVERAGE[symbol],
        exitReason: result.exitReason,
        monthKey: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
        rsi: rsi.toFixed(1),
        volRatio: volRatio.toFixed(1),
        momentum24h: momentum24h.toFixed(1),
      });
      
      lastTradeCandle = i;
    }
  }
  
  console.log(`📊 Total trades: ${trades.length} (target: <100/year)`);
  
  if (trades.length === 0) {
    console.log('❌ No trades generated.');
    return;
  }
  
  // Show individual trades
  console.log('\n📋 All trades:');
  console.log('┌──────────────┬────────────────┬──────────┬───────────────────┬─────────┬───────────┐');
  console.log('│    Date      │    Symbol      │   Dir    │     Setup Type    │ Result  │  P&L %    │');
  console.log('├──────────────┼────────────────┼──────────┼───────────────────┼─────────┼───────────┤');
  
  for (const t of trades.slice(0, 50)) { // Show first 50
    const pnlStr = t.pnlPctNet >= 0 ? `+${t.pnlPctNet.toFixed(1)}%` : `${t.pnlPctNet.toFixed(1)}%`;
    console.log(`│ ${t.date} │ ${t.symbol.replace('/USDT:USDT', '').padEnd(14)} │ ${t.direction.padEnd(8)} │ ${t.setupType.padEnd(17)} │ ${t.outcome.padEnd(7)} │ ${pnlStr.padStart(9)} │`);
  }
  if (trades.length > 50) {
    console.log(`│ ... and ${trades.length - 50} more trades ...${' '.repeat(50)}│`);
  }
  console.log('└──────────────┴────────────────┴──────────┴───────────────────┴─────────┴───────────┘');
  
  // Calculate totals
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
  
  console.log(`\n🎯 Win Rate: ${winRate}% (${wins.length}/${trades.length})`);
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
  
  console.log(`┌──────────────┬─────────┬───────────┬─────────────────────┐`);
  console.log(`│    Month     │ Trades  │  Win Rate │  P&L (with lev)     │`);
  console.log(`├──────────────┼─────────┼───────────┼─────────────────────┤`);
  
  for (const month of months) {
    const stats = monthlyPnl[month];
    const wr = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(0) : '0';
    if (stats.withLev > 0) positiveMonths++;
    const pnlStr = stats.withLev >= 0 ? `+$${stats.withLev.toFixed(2)}` : `$${stats.withLev.toFixed(2)}`;
    console.log(`│ ${month.padEnd(12)} │  ${String(stats.trades).padStart(5)}  │   ${wr.padStart(5)}%  │ ${pnlStr.padStart(19)} │`);
  }
  
  console.log(`├──────────────┴─────────┴───────────┴─────────────────────┤`);
  console.log(`│ Positive Months: ${positiveMonths}/${months.length} (${(positiveMonths / months.length * 100).toFixed(0)}%)${' '.repeat(33)}│`);
  console.log(`└────────────────────────────────────────────────────────────┘`);
}

main().catch(console.error);
