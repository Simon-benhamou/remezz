#!/usr/bin/env node
/**
 * 📊 ANALYSE DE STABILITÉ MOIS PAR MOIS
 * 
 * Objectif: Vérifier que CHAQUE mois est positif
 * Si mois 1 = +4%, mois 2 doit être >= 0% (pas négatif)
 */

import ccxt from 'ccxt';

const CONFIG = {
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
  timeframe: '15m',
  days: 120,  // 4 mois
  equityUsd: 10000,
  riskPerTrade: 0.01,
};

// Fetch with pagination
async function fetchHistoricalData(symbol, timeframe, days) {
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  
  const timeframeMs = 15 * 60 * 1000;
  const totalCandles = Math.floor(days * 24 * 60 * 60 * 1000 / timeframeMs);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  
  console.log(`📥 Fetching ${symbol} (${days} days)...`);
  
  try {
    let allCandles = [];
    let currentSince = since;
    const batchSize = 1000;
    
    while (allCandles.length < totalCandles) {
      const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, currentSince, batchSize);
      if (ohlcv.length === 0) break;
      allCandles = allCandles.concat(ohlcv);
      currentSince = ohlcv[ohlcv.length - 1][0] + timeframeMs;
      await new Promise(r => setTimeout(r, 100));
      if (ohlcv.length < batchSize) break;
    }
    
    console.log(`   ✅ Got ${allCandles.length} candles`);
    return allCandles;
  } catch (error) {
    console.error(`   ❌ Failed: ${error.message}`);
    return [];
  }
}

// Calculate indicators (simplified)
function calculateIndicators(candles, i) {
  if (i < 50) return null;
  
  const slice = candles.slice(i - 50, i + 1);
  const closes = slice.map(c => c[4]);
  const highs = slice.map(c => c[2]);
  const lows = slice.map(c => c[3]);
  const volumes = slice.map(c => c[5]);
  const last = closes[closes.length - 1];
  const open = candles[i][1];
  
  // EMAs
  const ema9 = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  
  // RSI
  const rsi14 = calcRSI(closes, 14);
  
  // ADX & DI
  const { adx: adx14, diPlus, diMinus } = calcADX(highs, lows, closes, 14);
  
  // Bollinger Bands
  const bb = calcBB(closes, 20, 2);
  const bbPosition = (last - bb.lower) / (bb.upper - bb.lower);
  const bbWidth = (bb.upper - bb.lower) / bb.middle;
  
  // CMF
  const cmf20 = calcCMF(highs, lows, closes, volumes, 20);
  
  // Volume ratio
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volumeRatio = volumes[volumes.length - 1] / avgVolume;
  
  // ATR
  const atr14 = calcATR(highs, lows, closes, 14);
  const atrPct = (atr14 / last) * 100;
  
  // Changes
  const change15m = ((last - closes[closes.length - 2]) / closes[closes.length - 2]) * 100;
  const change1h = ((last - closes[closes.length - 5]) / closes[closes.length - 5]) * 100;
  const change4h = ((last - closes[closes.length - 17]) / closes[closes.length - 17]) * 100;
  
  // Trend
  const trend = last > ema20 ? 1 : -1;
  const trendAlignment = (last > ema20 && ema20 > ema50) ? 1 : (last < ema20 && ema20 < ema50) ? -1 : 0;
  const emaStack = (ema9 > ema20 && ema20 > ema50) ? 1 : (ema9 < ema20 && ema20 < ema50) ? -1 : 0;
  
  // HTF trend (simulated)
  const htfTrend = change4h / 2;
  
  // Volatility regime
  const recentReturns = [];
  for (let j = closes.length - 20; j < closes.length; j++) {
    recentReturns.push(Math.abs((closes[j] - closes[j-1]) / closes[j-1] * 100));
  }
  const avgReturn = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
  const volatilityRegime = avgReturn < 0.25 ? 'LOW' : avgReturn < 0.5 ? 'MEDIUM' : 'HIGH';
  
  // Candle analysis
  const bodySize = Math.abs(last - open);
  const candleRange = highs[highs.length - 1] - lows[lows.length - 1];
  const bodyRatio = candleRange > 0 ? bodySize / candleRange : 0;
  const isBullishCandle = last > open;
  const isBearishCandle = last < open;
  
  return {
    timestamp: candles[i][0],
    last, open, ema9, ema20, ema50,
    rsi14, adx14, diPlus, diMinus,
    bbUpper: bb.upper, bbLower: bb.lower, bbMiddle: bb.middle,
    bbPosition, bbWidth,
    cmf20, volumeRatio, atrPct,
    change15m, change1h, change4h,
    trend, trendAlignment, emaStack, htfTrend,
    volatilityRegime,
    bodyRatio, isBullishCandle, isBearishCandle,
  };
}

// Helper functions
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period) {
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcADX(highs, lows, closes, period) {
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < highs.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
    const upMove = highs[i] - highs[i-1];
    const downMove = lows[i-1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  
  const atr = tr.slice(-period).reduce((a, b) => a + b, 0) / period;
  const plusDI = (plusDM.slice(-period).reduce((a, b) => a + b, 0) / period) / atr * 100;
  const minusDI = (minusDM.slice(-period).reduce((a, b) => a + b, 0) / period) / atr * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  
  return { adx: dx, diPlus: plusDI, diMinus: minusDI };
}

function calcBB(closes, period, mult) {
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.map(x => Math.pow(x - sma, 2)).reduce((a, b) => a + b, 0) / period);
  return { upper: sma + mult * std, middle: sma, lower: sma - mult * std };
}

function calcCMF(highs, lows, closes, volumes, period) {
  let mfv = 0, vol = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const range = highs[i] - lows[i];
    const mf = range > 0 ? ((closes[i] - lows[i]) - (highs[i] - closes[i])) / range : 0;
    mfv += mf * volumes[i];
    vol += volumes[i];
  }
  return vol > 0 ? mfv / vol : 0;
}

function calcATR(highs, lows, closes, period) {
  const tr = [];
  for (let i = 1; i < highs.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  }
  return tr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/**
 * 🎯 STRATÉGIE ADAPTATIVE - Focus HIGH volatility
 */
function makeAdaptiveDecision(ind) {
  const { 
    rsi14, adx14, diPlus, diMinus, cmf20, volumeRatio, 
    trend, trendAlignment, emaStack, atrPct, 
    change15m, change1h, change4h, htfTrend,
    volatilityRegime, bbWidth, bbPosition, bbUpper, bbLower, bbMiddle,
    bodyRatio, isBullishCandle, isBearishCandle, last,
  } = ind;
  
  let decision = 'NO_TRADE';
  let confidence = 0;
  let reasons = [];
  let strategy = '';
  let riskMultiplier = 1.0;
  
  // LOW VOLATILITY - Skip
  if (volatilityRegime === 'LOW') {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['SKIP_LOW_VOL'], strategy: 'LOW_VOL', riskMultiplier: 0 };
  }
  
  // MEDIUM VOLATILITY - Très strict
  if (volatilityRegime === 'MEDIUM') {
    strategy = 'MED_VOL';
    riskMultiplier = 0.4;
    
    if (adx14 >= 28 && volumeRatio >= 1.8 && bodyRatio >= 0.6) {
      if (
        trendAlignment === 1 && emaStack === 1 && htfTrend > 0.6 &&
        cmf20 > 0.08 && diPlus > diMinus * 1.3 &&
        rsi14 >= 48 && rsi14 <= 62 && isBullishCandle && change1h > 0.25
      ) {
        decision = 'LONG';
        confidence = 0.65;
        reasons.push('MED_PERFECT_UPTREND');
      }
      else if (
        trendAlignment === -1 && emaStack === -1 && htfTrend < -0.6 &&
        cmf20 < -0.08 && diMinus > diPlus * 1.3 &&
        rsi14 >= 38 && rsi14 <= 52 && isBearishCandle && change1h < -0.25
      ) {
        decision = 'SHORT';
        confidence = 0.67;
        reasons.push('MED_PERFECT_DOWNTREND');
      }
    }
  }
  
  // HIGH VOLATILITY - Agressif
  else if (volatilityRegime === 'HIGH') {
    strategy = 'HIGH_VOL';
    riskMultiplier = 1.0;
    
    // Momentum breakout
    if (Math.abs(change1h) >= 0.35 && volumeRatio >= 1.4) {
      if (change1h > 0.35 && cmf20 > 0.04 && trend > 0 && isBullishCandle && bodyRatio >= 0.45) {
        decision = 'LONG';
        confidence = 0.65;
        reasons.push('HIGH_MOMENTUM_LONG');
        if (trendAlignment === 1) confidence += 0.05;
        if (adx14 >= 25) confidence += 0.03;
        if (volumeRatio >= 2.0) confidence += 0.05;
      }
      else if (change1h < -0.35 && cmf20 < -0.04 && trend < 0 && isBearishCandle && bodyRatio >= 0.45) {
        decision = 'SHORT';
        confidence = 0.67;
        reasons.push('HIGH_MOMENTUM_SHORT');
        if (trendAlignment === -1) confidence += 0.05;
        if (adx14 >= 25) confidence += 0.03;
        if (volumeRatio >= 2.0) confidence += 0.05;
      }
    }
    
    // Trend continuation
    if (decision === 'NO_TRADE' && adx14 >= 22) {
      if (trendAlignment === 1 && cmf20 > 0.06 && rsi14 >= 48 && rsi14 <= 72 && change4h > 0.4 && volumeRatio >= 1.2 && isBullishCandle) {
        decision = 'LONG';
        confidence = 0.63;
        reasons.push('HIGH_TREND_CONTINUATION_LONG');
        if (emaStack === 1) confidence += 0.04;
      }
      else if (trendAlignment === -1 && cmf20 < -0.06 && rsi14 <= 52 && rsi14 >= 28 && change4h < -0.4 && volumeRatio >= 1.2 && isBearishCandle) {
        decision = 'SHORT';
        confidence = 0.65;
        reasons.push('HIGH_TREND_CONTINUATION_SHORT');
        if (emaStack === -1) confidence += 0.04;
      }
    }
    
    // BB breakout
    if (decision === 'NO_TRADE' && volumeRatio >= 1.8 && bodyRatio >= 0.55) {
      if (last > bbUpper * 0.997 && cmf20 > 0.04 && change15m > 0.15 && trend > 0) {
        decision = 'LONG';
        confidence = 0.60;
        reasons.push('HIGH_BB_BREAKOUT_LONG');
      }
      else if (last < bbLower * 1.003 && cmf20 < -0.04 && change15m < -0.15 && trend < 0) {
        decision = 'SHORT';
        confidence = 0.62;
        reasons.push('HIGH_BB_BREAKDOWN_SHORT');
      }
    }
    
    // Pullback
    if (decision === 'NO_TRADE' && Math.abs(htfTrend) > 0.8 && volumeRatio >= 1.3) {
      if (htfTrend > 0.8 && trendAlignment === 1 && rsi14 >= 40 && rsi14 <= 55 && bbPosition >= 0.3 && bbPosition <= 0.6 && cmf20 > 0.03 && isBullishCandle) {
        decision = 'LONG';
        confidence = 0.60;
        reasons.push('HIGH_PULLBACK_LONG');
      }
      else if (htfTrend < -0.8 && trendAlignment === -1 && rsi14 >= 45 && rsi14 <= 60 && bbPosition >= 0.4 && bbPosition <= 0.7 && cmf20 < -0.03 && isBearishCandle) {
        decision = 'SHORT';
        confidence = 0.62;
        reasons.push('HIGH_PULLBACK_SHORT');
      }
    }
  }
  
  // Filters
  if (decision === 'LONG' && rsi14 > 75) confidence -= 0.12;
  if (decision === 'SHORT' && rsi14 < 25) confidence -= 0.12;
  if (decision !== 'NO_TRADE' && volumeRatio >= 3.0) {
    confidence += 0.05;
    reasons.push('EXCEPTIONAL_VOLUME');
  }
  
  const minConfidence = volatilityRegime === 'MEDIUM' ? 0.63 : 0.58;
  if (confidence < minConfidence) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['LOW_CONFIDENCE'], strategy, riskMultiplier };
  }
  
  return { decision, confidence, reasons, strategy, riskMultiplier };
}

// Simulate trade
function simulateTrade(candles, entryIdx, direction, ind) {
  const entry = candles[entryIdx][4];
  const atrPct = ind.atrPct;
  
  // Dynamic SL/TP based on volatility
  let slPct, tpPct;
  if (ind.volatilityRegime === 'HIGH') {
    slPct = Math.max(0.8, Math.min(2.0, atrPct * 1.2));
    tpPct = slPct * 2.2;
  } else {
    slPct = Math.max(0.6, Math.min(1.5, atrPct * 1.0));
    tpPct = slPct * 2.0;
  }
  
  const sl = direction === 'LONG' ? entry * (1 - slPct/100) : entry * (1 + slPct/100);
  const tp = direction === 'LONG' ? entry * (1 + tpPct/100) : entry * (1 - tpPct/100);
  
  let exitPrice = entry;
  let exitReason = 'MAX_BARS';
  let barsHeld = 0;
  const maxBars = 48;
  
  for (let j = entryIdx + 1; j < Math.min(entryIdx + maxBars, candles.length); j++) {
    const high = candles[j][2];
    const low = candles[j][3];
    const close = candles[j][4];
    barsHeld++;
    
    if (direction === 'LONG') {
      if (low <= sl) { exitPrice = sl; exitReason = 'SL'; break; }
      if (high >= tp) { exitPrice = tp; exitReason = 'TP'; break; }
    } else {
      if (high >= sl) { exitPrice = sl; exitReason = 'SL'; break; }
      if (low <= tp) { exitPrice = tp; exitReason = 'TP'; break; }
    }
    
    exitPrice = close;
  }
  
  const pnlPct = direction === 'LONG' 
    ? ((exitPrice - entry) / entry) * 100
    : ((entry - exitPrice) / entry) * 100;
  
  return {
    entry, exitPrice, pnlPct, exitReason, holdBars: barsHeld,
    slPct, tpPct, volatilityRegime: ind.volatilityRegime
  };
}

// Backtest one symbol and return trades with timestamps
async function backtestSymbol(symbol, candles) {
  const trades = [];
  let equity = CONFIG.equityUsd;
  let maxDrawdown = 0;
  let peakEquity = equity;
  
  for (let i = 100; i < candles.length - 50; i++) {
    const indicators = calculateIndicators(candles, i);
    if (!indicators) continue;
    
    const { decision, confidence, reasons, strategy, riskMultiplier } = makeAdaptiveDecision(indicators);
    if (decision === 'NO_TRADE') continue;
    
    const result = simulateTrade(candles, i, decision, indicators);
    
    // Apply risk
    const riskPct = CONFIG.riskPerTrade * riskMultiplier;
    const positionSize = equity * riskPct;
    const pnlUsd = positionSize * (result.pnlPct / 100) * 10;
    
    equity += pnlUsd;
    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;
    
    trades.push({
      timestamp: candles[i][0],
      date: new Date(candles[i][0]),
      symbol,
      direction: decision,
      pnlPct: result.pnlPct,
      pnlUsd,
      equity,
      volatilityRegime: result.volatilityRegime,
      strategy,
    });
    
    // Skip after trade
    const skipMult = result.volatilityRegime === 'LOW' ? 0.5 : result.volatilityRegime === 'MEDIUM' ? 0.6 : 0.7;
    i += Math.max(4, Math.floor(result.holdBars * skipMult));
  }
  
  return { symbol, trades, equity, maxDrawdown };
}

// Main
async function main() {
  console.log('═'.repeat(80));
  console.log('📊 ANALYSE DE STABILITÉ MOIS PAR MOIS');
  console.log('═'.repeat(80));
  console.log(`📅 Période: ${CONFIG.days} jours (${Math.round(CONFIG.days/30)} mois)`);
  console.log(`💰 Capital: $${CONFIG.equityUsd.toLocaleString()}`);
  console.log('═'.repeat(80));
  
  // Collect all trades from all symbols
  const allTrades = [];
  
  for (const symbol of CONFIG.symbols) {
    console.log(`\n📥 ${symbol}...`);
    const candles = await fetchHistoricalData(symbol, CONFIG.timeframe, CONFIG.days);
    if (candles.length < 200) continue;
    
    const result = await backtestSymbol(symbol, candles);
    allTrades.push(...result.trades);
    console.log(`   ✅ ${result.trades.length} trades`);
  }
  
  // Sort all trades by timestamp
  allTrades.sort((a, b) => a.timestamp - b.timestamp);
  
  // Group trades by month
  const monthlyResults = {};
  
  for (const trade of allTrades) {
    const monthKey = `${trade.date.getFullYear()}-${String(trade.date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!monthlyResults[monthKey]) {
      monthlyResults[monthKey] = {
        trades: [],
        wins: 0,
        losses: 0,
        totalPnl: 0,
        totalPnlUsd: 0,
      };
    }
    
    monthlyResults[monthKey].trades.push(trade);
    if (trade.pnlPct > 0) monthlyResults[monthKey].wins++;
    else monthlyResults[monthKey].losses++;
    monthlyResults[monthKey].totalPnl += trade.pnlPct;
    monthlyResults[monthKey].totalPnlUsd += trade.pnlUsd;
  }
  
  // Display results
  console.log('\n' + '═'.repeat(80));
  console.log('📅 PERFORMANCE MOIS PAR MOIS');
  console.log('═'.repeat(80));
  
  const months = Object.keys(monthlyResults).sort();
  let cumulativeReturn = 0;
  let cumulativeCapital = CONFIG.equityUsd;
  let allPositive = true;
  
  console.log(`
┌─────────────┬────────┬────────┬──────────┬──────────────┬──────────────┬──────────────┐
│    Mois     │ Trades │   WR   │  Return  │  PnL ($)     │  Cumulé (%)  │  Capital     │
├─────────────┼────────┼────────┼──────────┼──────────────┼──────────────┼──────────────┤`);
  
  for (const month of months) {
    const data = monthlyResults[month];
    const totalTrades = data.wins + data.losses;
    const winRate = totalTrades > 0 ? (data.wins / totalTrades * 100) : 0;
    
    // Calculate monthly return on capital
    const monthlyReturn = (data.totalPnlUsd / cumulativeCapital) * 100;
    cumulativeCapital += data.totalPnlUsd;
    cumulativeReturn = ((cumulativeCapital - CONFIG.equityUsd) / CONFIG.equityUsd) * 100;
    
    const isPositive = monthlyReturn >= 0;
    if (!isPositive) allPositive = false;
    
    const icon = isPositive ? '✅' : '❌';
    
    console.log(`│ ${month}   │ ${String(totalTrades).padStart(6)} │ ${winRate.toFixed(1).padStart(5)}% │ ${icon} ${monthlyReturn >= 0 ? '+' : ''}${monthlyReturn.toFixed(2).padStart(5)}% │ ${data.totalPnlUsd >= 0 ? '+' : ''}$${data.totalPnlUsd.toFixed(0).padStart(9)} │ ${cumulativeReturn >= 0 ? '+' : ''}${cumulativeReturn.toFixed(2).padStart(6)}%     │ $${cumulativeCapital.toFixed(0).padStart(10)} │`);
  }
  
  console.log(`└─────────────┴────────┴────────┴──────────┴──────────────┴──────────────┴──────────────┘`);
  
  // Summary
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSUMÉ');
  console.log('═'.repeat(80));
  
  const totalTrades = allTrades.length;
  const totalWins = allTrades.filter(t => t.pnlPct > 0).length;
  const overallWinRate = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;
  
  console.log(`\n   Total Trades: ${totalTrades}`);
  console.log(`   Win Rate Global: ${overallWinRate.toFixed(1)}%`);
  console.log(`   Return Total: ${cumulativeReturn >= 0 ? '+' : ''}${cumulativeReturn.toFixed(2)}%`);
  console.log(`   Capital Final: $${cumulativeCapital.toFixed(2)}`);
  console.log(`\n   🎯 Mois positifs: ${months.filter(m => monthlyResults[m].totalPnlUsd >= 0).length}/${months.length}`);
  
  if (allPositive) {
    console.log(`\n   ✅ STABILITÉ VALIDÉE: Tous les mois sont positifs!`);
  } else {
    console.log(`\n   ⚠️ ATTENTION: Certains mois sont négatifs - stratégie non stable`);
    console.log(`   Mois négatifs: ${months.filter(m => monthlyResults[m].totalPnlUsd < 0).join(', ')}`);
  }
  
  // Monthly average
  const avgMonthlyReturn = cumulativeReturn / months.length;
  console.log(`\n   📈 Return Moyen/Mois: ${avgMonthlyReturn >= 0 ? '+' : ''}${avgMonthlyReturn.toFixed(2)}%`);
  
  console.log('\n' + '═'.repeat(80));
  console.log('✅ ANALYSE TERMINÉE');
  console.log('═'.repeat(80));
}

main().catch(console.error);
