#!/usr/bin/env node
/**
 * Strategy Backtest - Uses REAL strategy code
 * 
 * This backtest imports and calls the actual metaAdaptiveAgent.evaluate()
 * function to test the real strategy logic against historical data.
 * 
 * Usage: npm -w backend run build && node run-strategy-backtest.mjs
 */

import ccxt from 'ccxt';

// Import the REAL strategy
import { metaAdaptiveStrategyAgent } from './dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';

// Configuration
const CONFIG = {
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
  timeframe: '15m',
  days: 30,
  equityUsd: 10000,
  riskPerTrade: 0.01, // 1% risk per trade
};

// Fetch real OHLCV data from Binance
async function fetchHistoricalData(symbol, timeframe, days) {
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const limit = Math.floor(days * 24 * 60 / (timeframe === '15m' ? 15 : timeframe === '1h' ? 60 : 5));
  
  console.log(`📥 Fetching ${symbol} ${timeframe} data (${days} days, ~${limit} candles)...`);
  
  try {
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, since, Math.min(limit, 1500));
    console.log(`   ✅ Got ${ohlcv.length} candles from ${new Date(ohlcv[0]?.[0]).toLocaleDateString()} to ${new Date(ohlcv[ohlcv.length-1]?.[0]).toLocaleDateString()}`);
    return ohlcv;
  } catch (error) {
    console.error(`   ❌ Failed to fetch ${symbol}:`, error.message);
    return [];
  }
}

// Build TechnicalSnapshot from OHLCV data (mimics the real tech.ts calculations)
function buildTechnicalSnapshot(symbol, candles) {
  if (candles.length < 50) return null;
  
  const closes = candles.map(c => c[4]);
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const volumes = candles.map(c => c[5]);
  const opens = candles.map(c => c[1]);
  
  // EMA calculation
  function calcEma(arr, period) {
    const k = 2 / (period + 1);
    let result = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      result.push(arr[i] * k + result[i-1] * (1 - k));
    }
    return result;
  }
  
  // RSI calculation
  function calcRsi(arr, period = 14) {
    const changes = [];
    for (let i = 1; i < arr.length; i++) {
      changes.push(arr[i] - arr[i-1]);
    }
    
    let gains = [], losses = [];
    for (const change of changes) {
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? -change : 0);
    }
    
    const avgGain = calcEma(gains, period);
    const avgLoss = calcEma(losses, period);
    
    return avgGain.map((g, i) => {
      const l = avgLoss[i];
      if (l === 0) return 100;
      const rs = g / l;
      return 100 - (100 / (1 + rs));
    });
  }
  
  // ATR calculation
  function calcAtr(high, low, close, period = 14) {
    const tr = [];
    for (let i = 1; i < close.length; i++) {
      const hl = high[i] - low[i];
      const hpc = Math.abs(high[i] - close[i-1]);
      const lpc = Math.abs(low[i] - close[i-1]);
      tr.push(Math.max(hl, hpc, lpc));
    }
    return calcEma(tr, period);
  }
  
  // ADX calculation
  function calcAdx(high, low, close, period = 14) {
    const dmPlus = [], dmMinus = [], tr = [];
    
    for (let i = 1; i < close.length; i++) {
      const upMove = high[i] - high[i-1];
      const downMove = low[i-1] - low[i];
      
      dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0);
      dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);
      
      const hl = high[i] - low[i];
      const hpc = Math.abs(high[i] - close[i-1]);
      const lpc = Math.abs(low[i] - close[i-1]);
      tr.push(Math.max(hl, hpc, lpc));
    }
    
    const smoothedTr = calcEma(tr, period);
    const smoothedDmPlus = calcEma(dmPlus, period);
    const smoothedDmMinus = calcEma(dmMinus, period);
    
    const diPlus = smoothedDmPlus.map((dp, i) => (dp / smoothedTr[i]) * 100);
    const diMinus = smoothedDmMinus.map((dm, i) => (dm / smoothedTr[i]) * 100);
    
    const dx = diPlus.map((dp, i) => {
      const sum = dp + diMinus[i];
      if (sum === 0) return 0;
      return Math.abs(dp - diMinus[i]) / sum * 100;
    });
    
    return { adx: calcEma(dx, period), diPlus, diMinus };
  }
  
  // CMF (Chaikin Money Flow)
  function calcCmf(high, low, close, volume, period = 20) {
    const mfm = close.map((c, i) => {
      const hl = high[i] - low[i];
      if (hl === 0) return 0;
      return ((c - low[i]) - (high[i] - c)) / hl;
    });
    
    const mfv = mfm.map((m, i) => m * volume[i]);
    
    const result = [];
    for (let i = period - 1; i < mfv.length; i++) {
      let sumMfv = 0, sumVol = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sumMfv += mfv[j];
        sumVol += volume[j];
      }
      result.push(sumVol > 0 ? sumMfv / sumVol : 0);
    }
    return result;
  }
  
  // Calculate all indicators
  const ema9 = calcEma(closes, 9);
  const ema20 = calcEma(closes, 20);
  const ema50 = calcEma(closes, 50);
  const ema100 = calcEma(closes, Math.min(100, closes.length - 1));
  const ema200 = calcEma(closes, Math.min(200, closes.length - 1));
  const rsiValues = calcRsi(closes, 14);
  const atrValues = calcAtr(highs, lows, closes, 14);
  const { adx: adxValues, diPlus, diMinus } = calcAdx(highs, lows, closes, 14);
  const cmfValues = calcCmf(highs, lows, closes, volumes, 20);
  const volumeMA = calcEma(volumes, 20);
  
  const last = closes[closes.length - 1];
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  const lastOpen = opens[opens.length - 1];
  const atr14 = atrValues[atrValues.length - 1];
  const atrPct = (atr14 / last) * 100;
  const adx14 = adxValues[adxValues.length - 1] || 20;
  const rsi14 = rsiValues[rsiValues.length - 1];
  const currentVolume = volumes[volumes.length - 1];
  const avgVolume = volumeMA[volumeMA.length - 1];
  const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;
  const cmf20 = cmfValues[cmfValues.length - 1] || 0;
  
  // Calculate trend
  const ema20Val = ema20[ema20.length - 1];
  const ema50Val = ema50[ema50.length - 1];
  const trend = ema20Val > ema50Val ? 1 : ema20Val < ema50Val ? -1 : 0;
  
  // Calculate trendStrength
  const trendSpread = Math.abs(ema20Val - ema50Val) / ema50Val * 100;
  const trendStrength = Math.min(trendSpread / 2, 1);
  
  // EMA slope
  const ema20Prev = ema20[ema20.length - 2] || ema20Val;
  const ema20Slope = (ema20Val - ema20Prev) / ema20Prev;
  
  // Realized volatility
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i-1]));
  }
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / returns.length;
  const realizedVol = Math.sqrt(variance) * Math.sqrt(96 * 365) * 100; // Annualized, in %
  
  // Simple support/resistance
  const recentLows = lows.slice(-20);
  const recentHighs = highs.slice(-20);
  const support = Math.min(...recentLows);
  const resistance = Math.max(...recentHighs);
  
  // Volume z-score
  const volumeStdDev = Math.sqrt(volumes.slice(-20).reduce((a, v) => a + Math.pow(v - avgVolume, 2), 0) / 20);
  const volumeZScore = volumeStdDev > 0 ? (currentVolume - avgVolume) / volumeStdDev : 0;
  
  // Distance to EMAs
  const distEma20 = ((last - ema20Val) / ema20Val) * 100;
  const distEma50 = ((last - ema50Val) / ema50Val) * 100;
  
  // SR Bias
  const distToSupport = ((last - support) / last) * 100;
  const distToResistance = ((resistance - last) / last) * 100;
  const srBias = distToSupport < distToResistance * 0.5 ? 'nearSupport' 
    : distToResistance < distToSupport * 0.5 ? 'nearResistance' 
    : 'neutral';
  
  // Trend bias
  const trendBias = trend > 0 ? 'bullish' : trend < 0 ? 'bearish' : 'neutral';

  return {
    symbol,
    last,
    ema9: ema9[ema9.length - 1],
    ema20: ema20Val,
    ema50: ema50Val,
    ema100: ema100[ema100.length - 1],
    ema200: ema200[ema200.length - 1],
    ema20Slope,
    rsi14,
    rsi7: rsiValues[rsiValues.length - 1], // Simplified
    atr14,
    atrPct,
    adx14,
    diPlus14: diPlus[diPlus.length - 1],
    diMinus14: diMinus[diMinus.length - 1],
    support,
    resistance,
    supports: [{ price: support, label: 'recent_low', touches: 1, strength: 0.8 }],
    resistances: [{ price: resistance, label: 'recent_high', touches: 1, strength: 0.8 }],
    pivots: null,
    trend,
    srBias,
    meta: { tf: '15m', windowBars: candles.length, recentBarsFor24h: 96 },
    realizedVol: realizedVol / 100, // Normalized
    hurst: 0.5, // Default
    adxSlope: 0,
    trendStrength,
    trendBias,
    volume: currentVolume,
    volumeMA: avgVolume,
    volumeZScore,
    volumeRatio,
    cmf20,
    distEma20,
    distEma50,
    // Extra fields used by the strategy
    volumeAvg: avgVolume,
    volume24h: volumes.slice(-96).reduce((a, b) => a + b, 0),
  };
}

// Simulate a trade with proper R:R
function simulateTrade(entryPrice, candles, side, atrPct) {
  // Dynamic stop: 2x ATR for low vol, 2.5x for high vol
  const stopMultiplier = atrPct > 2.0 ? 2.5 : 2.0;
  const stopDistance = entryPrice * (atrPct / 100) * stopMultiplier;
  
  // R:R targets
  const tp1Distance = stopDistance * 2.0;  // 2:1
  const tp2Distance = stopDistance * 3.5;  // 3.5:1
  
  const stopPrice = side === 'long' 
    ? entryPrice - stopDistance 
    : entryPrice + stopDistance;
  const tp1Price = side === 'long'
    ? entryPrice + tp1Distance
    : entryPrice - tp1Distance;
  const tp2Price = side === 'long'
    ? entryPrice + tp2Distance
    : entryPrice - tp2Distance;
  
  let exitPrice = null;
  let exitReason = null;
  let holdBars = 0;
  
  for (let i = 0; i < candles.length && i < 96; i++) {
    const candle = candles[i];
    const high = candle[2];
    const low = candle[3];
    holdBars++;
    
    // Check stop
    if (side === 'long' && low <= stopPrice) {
      exitPrice = stopPrice;
      exitReason = 'STOP_LOSS';
      break;
    }
    if (side === 'short' && high >= stopPrice) {
      exitPrice = stopPrice;
      exitReason = 'STOP_LOSS';
      break;
    }
    
    // Check TP1 with trailing
    if (side === 'long' && high >= tp1Price && !exitPrice) {
      const trailingStop = tp1Price - (stopDistance * 0.5);
      if (low <= trailingStop) {
        exitPrice = trailingStop;
        exitReason = 'TRAILING_STOP_AFTER_TP1';
        break;
      }
    }
    if (side === 'short' && low <= tp1Price && !exitPrice) {
      const trailingStop = tp1Price + (stopDistance * 0.5);
      if (high >= trailingStop) {
        exitPrice = trailingStop;
        exitReason = 'TRAILING_STOP_AFTER_TP1';
        break;
      }
    }
    
    // Check TP2
    if (side === 'long' && high >= tp2Price) {
      exitPrice = tp2Price;
      exitReason = 'TP2_RUNNER';
      break;
    }
    if (side === 'short' && low <= tp2Price) {
      exitPrice = tp2Price;
      exitReason = 'TP2_RUNNER';
      break;
    }
  }
  
  // Time exit
  if (!exitPrice && candles.length > 0) {
    exitPrice = candles[Math.min(holdBars, candles.length - 1)][4];
    exitReason = 'TIME_EXIT';
  }
  
  if (!exitPrice) return null;
  
  const pnlPct = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  return { side, entryPrice, exitPrice, exitReason, pnlPct, holdBars };
}

// Run backtest on a symbol using REAL strategy
async function backtestSymbol(symbol, candles) {
  const trades = [];
  let equity = CONFIG.equityUsd;
  let peakEquity = equity;
  let maxDrawdown = 0;
  
  const lookback = 100;
  
  for (let i = lookback; i < candles.length - 96; i++) {
    const historyCandles = candles.slice(i - lookback, i + 1);
    const futureCandles = candles.slice(i + 1, i + 97);
    
    // Build snapshot like the real tech.ts does
    const snap = buildTechnicalSnapshot(symbol, historyCandles);
    if (!snap) continue;
    
    // Call the REAL strategy evaluation
    let result;
    try {
      result = await metaAdaptiveStrategyAgent.evaluate({
        symbol: symbol.replace('/USDT:USDT', 'USDT'),
        snap,
        sessionId: 'backtest',
        accountBalanceUsd: equity,
        volume24hUsd: 100000000, // Simulate high volume to bypass liquidity gate
        forceLiquidityGate: false, // Skip liquidity checks for backtest
        micro: {
          spreadBps: 2, // Assume good liquidity
          depthUsd: 1000000,
          slippageBps: 1,
          fillRatio: 0.95,
        },
      });
    } catch (err) {
      // Skip errors (missing dependencies in backtest mode)
      continue;
    }
    
    // Check if we have a signal
    const selection = result?.selection;
    if (!selection) continue;
    
    // Get bias (long or short)
    const bias = selection.bias;
    if (bias === 'both' || bias === 'none') continue;
    
    // Check confidence threshold
    const confidence = selection.confidence;
    if (confidence < 0.55) continue;
    
    // Simulate the trade
    const tradeResult = simulateTrade(snap.last, futureCandles, bias, snap.atrPct);
    if (!tradeResult) continue;
    
    // Position sizing
    const riskAmount = equity * CONFIG.riskPerTrade;
    const stopDistance = snap.atrPct * 2;
    const positionSize = riskAmount / (snap.last * (stopDistance / 100));
    const pnlUsd = positionSize * snap.last * (tradeResult.pnlPct / 100);
    equity += pnlUsd;
    
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = (peakEquity - equity) / peakEquity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    
    trades.push({
      timestamp: new Date(candles[i][0]).toISOString(),
      ...tradeResult,
      strategy: selection.family,
      confidence,
      reasons: selection.reasons.join(', '),
      equity: equity.toFixed(2),
    });
    
    // Skip forward after a trade
    i += tradeResult.holdBars;
  }
  
  return { symbol, trades, equity, maxDrawdown, peakEquity };
}

// Main execution
async function main() {
  console.log('═'.repeat(80));
  console.log('📊 REAL STRATEGY BACKTEST - Meta-Adaptive Agent');
  console.log('═'.repeat(80));
  console.log(`📅 Period: Last ${CONFIG.days} days`);
  console.log(`💰 Starting Equity: $${CONFIG.equityUsd.toLocaleString()}`);
  console.log(`📈 Risk per Trade: ${CONFIG.riskPerTrade * 100}%`);
  console.log(`⏱️ Timeframe: ${CONFIG.timeframe}`);
  console.log('═'.repeat(80));
  
  const allResults = [];
  
  for (const symbol of CONFIG.symbols) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🔍 Backtesting ${symbol}...`);
    console.log('─'.repeat(60));
    
    const candles = await fetchHistoricalData(symbol, CONFIG.timeframe, CONFIG.days);
    if (candles.length < 200) {
      console.log(`   ⚠️ Not enough data for ${symbol}, skipping`);
      continue;
    }
    
    const result = await backtestSymbol(symbol, candles);
    allResults.push(result);
    
    // Print results
    const wins = result.trades.filter(t => t.pnlPct > 0).length;
    const losses = result.trades.filter(t => t.pnlPct < 0).length;
    const winRate = result.trades.length > 0 ? (wins / result.trades.length) * 100 : 0;
    const totalPnlPct = ((result.equity - CONFIG.equityUsd) / CONFIG.equityUsd) * 100;
    const avgWin = wins > 0 
      ? result.trades.filter(t => t.pnlPct > 0).reduce((a, t) => a + t.pnlPct, 0) / wins 
      : 0;
    const avgLoss = losses > 0 
      ? result.trades.filter(t => t.pnlPct < 0).reduce((a, t) => a + t.pnlPct, 0) / losses 
      : 0;
    
    console.log(`\n📊 ${symbol} Results:`);
    console.log(`   Total Trades: ${result.trades.length}`);
    console.log(`   Win Rate: ${winRate.toFixed(1)}% (${wins}W / ${losses}L)`);
    console.log(`   Avg Win: ${avgWin.toFixed(2)}%`);
    console.log(`   Avg Loss: ${avgLoss.toFixed(2)}%`);
    console.log(`   Total Return: ${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(2)}%`);
    console.log(`   Max Drawdown: ${(result.maxDrawdown * 100).toFixed(2)}%`);
    
    if (result.trades.length > 0) {
      console.log(`\n   📋 Last 5 trades:`);
      for (const trade of result.trades.slice(-5)) {
        const emoji = trade.pnlPct > 0 ? '✅' : '❌';
        console.log(`   ${emoji} ${trade.side.toUpperCase()} | ${trade.strategy} | ${trade.exitReason} | PnL: ${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct.toFixed(2)}%`);
      }
    }
  }
  
  // Aggregate results
  console.log('\n' + '═'.repeat(80));
  console.log('📊 AGGREGATE RESULTS');
  console.log('═'.repeat(80));
  
  const totalTrades = allResults.reduce((a, r) => a + r.trades.length, 0);
  const allTrades = allResults.flatMap(r => r.trades);
  const allWins = allTrades.filter(t => t.pnlPct > 0).length;
  const allLosses = allTrades.filter(t => t.pnlPct < 0).length;
  const overallWinRate = totalTrades > 0 ? (allWins / totalTrades) * 100 : 0;
  const combinedPnl = allResults.reduce((a, r) => a + (r.equity - CONFIG.equityUsd), 0);
  const combinedReturn = (combinedPnl / (CONFIG.equityUsd * CONFIG.symbols.length)) * 100;
  
  console.log(`\n📈 Overall Performance:`);
  console.log(`   Total Trades: ${totalTrades}`);
  console.log(`   Overall Win Rate: ${overallWinRate.toFixed(1)}% (${allWins}W / ${allLosses}L)`);
  console.log(`   Combined Return: ${combinedReturn >= 0 ? '+' : ''}${combinedReturn.toFixed(2)}%`);
  
  // By strategy
  console.log(`\n📋 Performance by Strategy:`);
  const strategyStats = {};
  for (const trade of allTrades) {
    if (!strategyStats[trade.strategy]) {
      strategyStats[trade.strategy] = { wins: 0, losses: 0, totalPnl: 0 };
    }
    if (trade.pnlPct > 0) strategyStats[trade.strategy].wins++;
    else strategyStats[trade.strategy].losses++;
    strategyStats[trade.strategy].totalPnl += trade.pnlPct;
  }
  
  for (const [strategy, stats] of Object.entries(strategyStats)) {
    const total = stats.wins + stats.losses;
    const winRate = (stats.wins / total) * 100;
    console.log(`   ${strategy}: ${stats.wins}W/${stats.losses}L (${winRate.toFixed(0)}%) | Avg: ${(stats.totalPnl / total).toFixed(2)}%`);
  }
  
  console.log('\n' + '═'.repeat(80));
  console.log('🏁 BACKTEST COMPLETE');
  console.log('═'.repeat(80));
}

main().catch(console.error);
