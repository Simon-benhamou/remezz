/**
 * 🎯 HIGH SELECTIVITY STRATEGY - ONLY THE BEST SETUPS
 * 
 * Problem found: Too many trades = fees eat profits
 * Solution: Be EXTREMELY selective - only take high-probability setups
 * 
 * Filters:
 * 1. Volume 5x+ (strong interest)
 * 2. Strong trend alignment
 * 3. RSI confirmation
 * 4. Multi-timeframe alignment
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
const RISK_PER_TRADE = 0.02; // 2% per trade (higher because fewer trades)

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

function calcMomentum(closes, period) {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - period - 1];
  return ((current - past) / past) * 100;
}

function detectTrendStrength(closes) {
  if (closes.length < 50) return { direction: 'sideways', strength: 0 };
  
  const ema8 = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const current = closes[closes.length - 1];
  
  // Calculate trend strength based on EMA separation
  const spread8_21 = Math.abs(ema8 - ema21) / ema21 * 100;
  const spread21_50 = Math.abs(ema21 - ema50) / ema50 * 100;
  const strength = (spread8_21 + spread21_50) / 2;
  
  // Strong bullish: price > all EMAs, all EMAs aligned
  if (current > ema8 && ema8 > ema21 && ema21 > ema50) {
    return { direction: 'strong_up', strength };
  }
  // Strong bearish: price < all EMAs, all EMAs aligned
  if (current < ema8 && ema8 < ema21 && ema21 < ema50) {
    return { direction: 'strong_down', strength };
  }
  // Weak trends
  if (ema8 > ema21) return { direction: 'up', strength: strength * 0.5 };
  if (ema8 < ema21) return { direction: 'down', strength: strength * 0.5 };
  
  return { direction: 'sideways', strength: 0 };
}

function simulateTrade(candles, entryIndex, direction, entryPrice, stopLossPct = 2.5, takeProfitPct = 3.5, maxHoldCandles = 32) {
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
    
    // Take Profit - lock in gains early
    if (pnlPct >= takeProfitPct) {
      const exitSlippage = SLIPPAGE * 100;
      const totalFees = (MAKER_FEE * 2) * 100; // Both maker fees
      return { 
        outcome: 'WIN', 
        pnlPctRaw: takeProfitPct - exitSlippage,
        fees: totalFees,
        holdCandles: j - entryIndex,
        exitReason: 'TP'
      };
    }
    
    // Stop Loss
    if (pnlPct <= -stopLossPct) {
      const exitSlippage = SLIPPAGE * 100;
      const totalFees = (TAKER_FEE * 2) * 100;
      return { 
        outcome: 'LOSS', 
        pnlPctRaw: -stopLossPct - exitSlippage,
        fees: totalFees,
        holdCandles: j - entryIndex,
        exitReason: 'SL'
      };
    }
    
    // Trailing stop at +1.5%
    if (pnlPct >= 1.5) {
      let trailingDistance = 0.7;
      if (pnlPct >= 2.5) trailingDistance = 0.5;
      
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
        const totalFees = (MAKER_FEE + TAKER_FEE) * 100;
        return { 
          outcome: 'WIN', 
          pnlPctRaw: bestPnl - trailingDistance - exitSlippage,
          fees: totalFees,
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
    outcome: finalPnl > totalFees ? 'WIN' : 'LOSS', 
    pnlPctRaw: finalPnl,
    fees: totalFees,
    holdCandles: maxHoldCandles,
    exitReason: 'TIMEOUT'
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 HIGH SELECTIVITY STRATEGY - Only Best Setups');
  console.log('═'.repeat(80));
  console.log(`\n💰 Initial Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log(`📊 Risk per trade: ${RISK_PER_TRADE * 100}% (higher because fewer trades)`);
  console.log(`💸 Fees: Maker ${MAKER_FEE * 100}%, Taker ${TAKER_FEE * 100}%, Slippage ${SLIPPAGE * 100}%`);
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  const btcCandles = allCandles['BTC/USDT:USDT'];
  const btcTimestampIndex = new Map();
  btcCandles.forEach((c, i) => btcTimestampIndex.set(c[0], i));
  
  console.log('\n🔍 Running HIGH SELECTIVITY backtest...\n');
  
  // Test multiple filter combinations
  const strategies = [
    {
      name: '1️⃣ EXTREME: Vol 10x+ only',
      filter: (data) => data.volRatio >= 10,
    },
    {
      name: '2️⃣ Vol 7x+ + Strong trend',
      filter: (data) => data.volRatio >= 7 && ['strong_up', 'strong_down'].includes(data.btcTrend.direction),
    },
    {
      name: '3️⃣ Vol 5x+ + Strong trend + RSI ok',
      filter: (data) => data.volRatio >= 5 && ['strong_up', 'strong_down'].includes(data.btcTrend.direction) && data.rsiOk,
    },
    {
      name: '4️⃣ Vol 5x+ + Momentum >1%',
      filter: (data) => data.volRatio >= 5 && Math.abs(data.btcMomentum4h) > 1,
    },
    {
      name: '5️⃣ BTC Momentum >2% + Vol 3x+',
      filter: (data) => Math.abs(data.btcMomentum4h) > 2 && data.volRatio >= 3,
    },
    {
      name: '6️⃣ Strong trend + Strong BTC momentum',
      filter: (data) => ['strong_up', 'strong_down'].includes(data.btcTrend.direction) && 
                        Math.abs(data.btcMomentum4h) > 1.5 && data.volRatio >= 3,
    },
    {
      name: '7️⃣ ULTRA SELECTIVE: All conditions',
      filter: (data) => data.volRatio >= 5 && 
                        ['strong_up', 'strong_down'].includes(data.btcTrend.direction) && 
                        Math.abs(data.btcMomentum4h) > 1 &&
                        data.rsiOk &&
                        data.trendStrength > 0.5,
    },
  ];
  
  console.log('Testing different selectivity levels...\n');
  
  for (const strategy of strategies) {
    const trades = [];
    
    for (const [symbol, candles] of Object.entries(allCandles)) {
      let lastTradeIndex = 0;
      
      for (let i = 100; i < candles.length - 50; i++) {
        // Cooldown: minimum 8 candles between trades (2 hours)
        if (i - lastTradeIndex < 8) continue;
        
        const timestamp = candles[i][0];
        const btcI = btcTimestampIndex.get(timestamp);
        if (btcI === undefined || btcI < 100) continue;
        
        const current = candles[i];
        const open = current[1];
        const close = current[4];
        const isBullishCandle = close > open;
        const isBearishCandle = close < open;
        const candleBody = Math.abs(close - open) / open * 100;
        
        // Need strong candle (body > 0.3%)
        if (candleBody < 0.3) continue;
        
        const closes = candles.slice(0, i + 1).map(c => c[4]);
        const volumes = candles.slice(0, i + 1).map(c => c[5]);
        const btcCloses = btcCandles.slice(0, btcI + 1).map(c => c[4]);
        
        const volRatio = calcVolRatio(volumes);
        const rsi = calcRSI(closes, 14);
        const ma20 = calcMA(closes, 20);
        const btcTrend = detectTrendStrength(btcCloses);
        const btcMomentum4h = calcMomentum(btcCloses, 16); // 4h = 16 candles of 15m
        const trendStrength = btcTrend.strength;
        
        // RSI confirmation
        const rsiOk = (isBullishCandle && rsi > 40 && rsi < 65) || 
                      (isBearishCandle && rsi > 35 && rsi < 60);
        
        // Build filter data
        const filterData = {
          volRatio,
          rsi,
          btcTrend,
          btcMomentum4h,
          trendStrength,
          rsiOk,
        };
        
        // Apply strategy filter
        if (!strategy.filter(filterData)) continue;
        
        // Determine direction based on trend
        let direction = null;
        
        if (btcTrend.direction === 'strong_down' && isBearishCandle && close < ma20) {
          direction = 'SHORT';
        } else if (btcTrend.direction === 'strong_up' && isBullishCandle && close > ma20) {
          direction = 'LONG';
        } else if (btcMomentum4h < -1 && isBearishCandle) {
          direction = 'SHORT';
        } else if (btcMomentum4h > 1 && isBullishCandle) {
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
          leverage: LEVERAGE[symbol],
          monthKey: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
        });
        
        lastTradeIndex = i;
      }
    }
    
    // Calculate results
    if (trades.length === 0) {
      console.log(`${strategy.name}: No trades generated\n`);
      continue;
    }
    
    let totalPnlNoLev = 0, totalPnlWithLev = 0, totalFees = 0;
    const wins = trades.filter(t => t.outcome === 'WIN');
    
    trades.forEach(t => {
      const posSize = INITIAL_CAPITAL * RISK_PER_TRADE;
      totalPnlNoLev += posSize * (t.pnlPctNet / 100);
      totalPnlWithLev += posSize * t.leverage * (t.pnlPctNet / 100);
      totalFees += posSize * t.leverage * (t.fees / 100);
    });
    
    // Monthly breakdown
    const monthlyPnl = {};
    trades.forEach(t => {
      if (!monthlyPnl[t.monthKey]) monthlyPnl[t.monthKey] = { noLev: 0, withLev: 0, trades: 0 };
      const posSize = INITIAL_CAPITAL * RISK_PER_TRADE;
      monthlyPnl[t.monthKey].noLev += posSize * (t.pnlPctNet / 100);
      monthlyPnl[t.monthKey].withLev += posSize * t.leverage * (t.pnlPctNet / 100);
      monthlyPnl[t.monthKey].trades++;
    });
    
    const months = Object.keys(monthlyPnl).sort();
    let positiveMonthsNoLev = 0, positiveMonthsWithLev = 0;
    months.forEach(m => {
      if (monthlyPnl[m].noLev > 0) positiveMonthsNoLev++;
      if (monthlyPnl[m].withLev > 0) positiveMonthsWithLev++;
    });
    
    const winRate = (wins.length / trades.length * 100).toFixed(1);
    
    console.log(`${'─'.repeat(80)}`);
    console.log(`${strategy.name}`);
    console.log(`${'─'.repeat(80)}`);
    console.log(`📊 Trades: ${trades.length} | Win Rate: ${winRate}%`);
    console.log(`💸 Total Fees: $${totalFees.toFixed(2)}`);
    console.log(`\n┌─────────────────────┬─────────────────────┬─────────────────────┐`);
    console.log(`│                     │   WITHOUT LEVERAGE  │   WITH LEVERAGE     │`);
    console.log(`├─────────────────────┼─────────────────────┼─────────────────────┤`);
    console.log(`│ Total P&L           │ ${(totalPnlNoLev >= 0 ? '+' : '')}$${totalPnlNoLev.toFixed(2).padStart(15)} │ ${(totalPnlWithLev >= 0 ? '+' : '')}$${totalPnlWithLev.toFixed(2).padStart(15)} │`);
    console.log(`│ ROI                 │ ${(totalPnlNoLev >= 0 ? '+' : '')}${(totalPnlNoLev / INITIAL_CAPITAL * 100).toFixed(1).padStart(16)}% │ ${(totalPnlWithLev >= 0 ? '+' : '')}${(totalPnlWithLev / INITIAL_CAPITAL * 100).toFixed(1).padStart(16)}% │`);
    console.log(`│ Monthly ROI         │ ${(totalPnlNoLev >= 0 ? '+' : '')}${(totalPnlNoLev / INITIAL_CAPITAL * 100 / 12).toFixed(2).padStart(16)}% │ ${(totalPnlWithLev >= 0 ? '+' : '')}${(totalPnlWithLev / INITIAL_CAPITAL * 100 / 12).toFixed(2).padStart(16)}% │`);
    console.log(`│ Positive Months     │ ${String(positiveMonthsNoLev).padStart(11)}/${months.length} (${(positiveMonthsNoLev/months.length*100).toFixed(0)}%) │ ${String(positiveMonthsWithLev).padStart(11)}/${months.length} (${(positiveMonthsWithLev/months.length*100).toFixed(0)}%) │`);
    console.log(`└─────────────────────┴─────────────────────┴─────────────────────┘`);
    
    // Monthly detail for best strategies
    if (positiveMonthsWithLev >= months.length * 0.5) {
      console.log(`\n📅 Monthly Breakdown:`);
      console.log(`   ${months.map(m => `${m}: ${monthlyPnl[m].withLev >= 0 ? '✅' : '❌'}$${Math.abs(monthlyPnl[m].withLev).toFixed(0)}`).join(' | ')}`);
    }
    
    console.log('');
  }
  
  console.log('\n' + '═'.repeat(80));
  console.log('💡 CONCLUSION');
  console.log('═'.repeat(80));
  console.log(`
Le problème fondamental:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 📉 Les frais de trading (0.1-0.12% par trade) mangent les profits
2. 📊 Un win rate de 50-55% avec un R:R de 1:1 = breakeven AVANT frais
3. 🎯 Pour être profitable il faut SOIT:
   a) Win rate > 60% (très dur à maintenir)
   b) R:R > 1.5:1 (risquer moins, gagner plus)
   c) Beaucoup moins de trades (réduire les frais)

Recommandation: 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Volume 7x+ minimum
• BTC momentum > 1.5%
• Take Profit 3.5%, Stop Loss 2.5% (R:R = 1.4:1)
• Maximum 100-200 trades par an
`);
}

main().catch(console.error);
