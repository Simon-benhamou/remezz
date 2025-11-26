#!/usr/bin/env node
/**
 * 📊 ANALYSE DE STABILITÉ - Période par période
 * 
 * Objectif: Comprendre pourquoi la stratégie n'est pas stable
 * et identifier les conditions de marché qui causent des pertes
 */

import ccxt from 'ccxt';

const CONFIG = {
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
  timeframe: '15m',
  totalDays: 60,
  periodDays: 15, // Analyser par périodes de 15 jours
  equityUsd: 10000,
  riskPerTrade: 0.01,
};

// Fetch with pagination
async function fetchHistoricalData(symbol, timeframe, days, endTimestamp = Date.now()) {
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  
  const timeframeMs = 15 * 60 * 1000;
  const totalCandles = Math.floor(days * 24 * 60 * 60 * 1000 / timeframeMs);
  const since = endTimestamp - days * 24 * 60 * 60 * 1000;
  
  try {
    let allCandles = [];
    let currentSince = since;
    const batchSize = 1000;
    
    while (allCandles.length < totalCandles) {
      const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, currentSince, batchSize);
      if (ohlcv.length === 0) break;
      
      // Filter candles that are before endTimestamp
      const filtered = ohlcv.filter(c => c[0] <= endTimestamp);
      allCandles = allCandles.concat(filtered);
      currentSince = ohlcv[ohlcv.length - 1][0] + timeframeMs;
      
      await new Promise(r => setTimeout(r, 100));
      if (ohlcv.length < batchSize) break;
    }
    
    return allCandles;
  } catch (error) {
    console.error(`   ❌ Failed: ${error.message}`);
    return [];
  }
}

// Calculate technical indicators
function calculateIndicators(candles) {
  if (candles.length < 100) return null;
  
  const closes = candles.map(c => c[4]);
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const volumes = candles.map(c => c[5]);
  const last = closes[closes.length - 1];
  const timestamp = candles[candles.length - 1][0];
  
  // EMA
  function ema(arr, period) {
    const k = 2 / (period + 1);
    let result = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      result.push(arr[i] * k + result[i-1] * (1 - k));
    }
    return result;
  }
  
  // RSI
  function rsi(arr, period = 14) {
    const changes = [];
    for (let i = 1; i < arr.length; i++) {
      changes.push(arr[i] - arr[i-1]);
    }
    let gains = changes.map(c => c > 0 ? c : 0);
    let losses = changes.map(c => c < 0 ? -c : 0);
    const avgGain = ema(gains, period);
    const avgLoss = ema(losses, period);
    return avgGain.map((g, i) => {
      const l = avgLoss[i];
      if (l === 0) return 100;
      const rs = g / l;
      return 100 - (100 / (1 + rs));
    });
  }
  
  // ATR
  function atr(highs, lows, closes, period = 14) {
    const tr = [];
    for (let i = 1; i < closes.length; i++) {
      const high = highs[i], low = lows[i], prevClose = closes[i-1];
      tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    return ema(tr, period);
  }
  
  // ADX
  function adx(highs, lows, closes, period = 14) {
    const tr = [], dmPlus = [], dmMinus = [];
    for (let i = 1; i < closes.length; i++) {
      const high = highs[i], low = lows[i], prevHigh = highs[i-1], prevLow = lows[i-1], prevClose = closes[i-1];
      tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
      const upMove = high - prevHigh, downMove = prevLow - low;
      dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0);
      dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }
    const atrVal = ema(tr, period);
    const diPlus = ema(dmPlus, period).map((d, i) => atrVal[i] ? (d / atrVal[i]) * 100 : 0);
    const diMinus = ema(dmMinus, period).map((d, i) => atrVal[i] ? (d / atrVal[i]) * 100 : 0);
    const dx = diPlus.map((dp, i) => {
      const sum = dp + diMinus[i];
      return sum ? Math.abs(dp - diMinus[i]) / sum * 100 : 0;
    });
    return ema(dx, period);
  }
  
  // CMF
  function cmf(highs, lows, closes, volumes, period = 20) {
    const mfv = [];
    for (let i = 0; i < closes.length; i++) {
      const range = highs[i] - lows[i];
      const mult = range > 0 ? ((closes[i] - lows[i]) - (highs[i] - closes[i])) / range : 0;
      mfv.push(mult * volumes[i]);
    }
    const result = [];
    for (let i = period - 1; i < mfv.length; i++) {
      const sumMfv = mfv.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      const sumVol = volumes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      result.push(sumVol ? sumMfv / sumVol : 0);
    }
    return result;
  }
  
  const emaArr = ema(closes, 20);
  const rsiArr = rsi(closes);
  const atrArr = atr(highs, lows, closes);
  const adxArr = adx(highs, lows, closes);
  const cmfArr = cmf(highs, lows, closes, volumes);
  
  const last50 = closes.slice(-50);
  const avgVol = volumes.slice(-50, -1).reduce((a, b) => a + b, 0) / 49;
  const currentVol = volumes[volumes.length - 1];
  
  // Calculate volatility regime
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.abs(closes[i] - closes[i-1]) / closes[i-1] * 100);
  }
  const avgReturn = returns.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const volatilityRegime = avgReturn > 0.5 ? 'HIGH' : avgReturn > 0.25 ? 'MEDIUM' : 'LOW';
  
  // Trend strength
  const ema20 = emaArr[emaArr.length - 1];
  const priceVsEma = (last - ema20) / ema20 * 100;
  const trendStrength = Math.abs(priceVsEma) > 2 ? 'STRONG' : Math.abs(priceVsEma) > 0.5 ? 'MODERATE' : 'WEAK';
  
  return {
    last,
    timestamp,
    ema20,
    rsi14: rsiArr[rsiArr.length - 1],
    atrPct: (atrArr[atrArr.length - 1] / last) * 100,
    adx14: adxArr[adxArr.length - 1],
    cmf20: cmfArr[cmfArr.length - 1],
    volumeRatio: currentVol / avgVol,
    trend: last > ema20 ? 1 : -1,
    priceVsEma,
    volatilityRegime,
    trendStrength,
    change1h: (last - closes[closes.length - 5]) / closes[closes.length - 5] * 100,
  };
}

// Simplified decision for analysis
function makeDecision(ind, useImprovedFilters = false) {
  const { rsi14, adx14, cmf20, volumeRatio, trend, atrPct, change1h, volatilityRegime, trendStrength } = ind;
  
  let decision = 'NO_TRADE';
  let confidence = 0;
  let reasons = [];
  
  // Base RSI healthy range
  const rsiHealthy = rsi14 >= 32 && rsi14 <= 68;
  
  // 🆕 IMPROVED FILTERS - Only trade when market conditions are favorable
  if (useImprovedFilters) {
    // FILTER 1: Skip low volatility (ranging) markets - waste of capital
    if (volatilityRegime === 'LOW' && adx14 < 20) {
      return { decision: 'NO_TRADE', confidence: 0, reasons: ['LOW_VOL_SKIP'] };
    }
    
    // FILTER 2: Skip weak trends with low ADX
    if (trendStrength === 'WEAK' && adx14 < 18) {
      return { decision: 'NO_TRADE', confidence: 0, reasons: ['WEAK_TREND_SKIP'] };
    }
    
    // FILTER 3: Require stronger volume confirmation
    if (volumeRatio < 1.3) {
      return { decision: 'NO_TRADE', confidence: 0, reasons: ['LOW_VOL_SKIP'] };
    }
  }
  
  const hasLongMomentum = change1h > 0.1;
  const hasShortMomentum = change1h < -0.1;
  
  // TREND FOLLOW
  if (adx14 >= 22 && rsiHealthy) {
    if (trend > 0 && cmf20 > 0.05 && hasLongMomentum) {
      decision = 'LONG';
      confidence = 0.60;
      reasons.push('TREND_FOLLOW');
    } else if (trend < 0 && cmf20 < -0.05 && hasShortMomentum) {
      decision = 'SHORT';
      confidence = 0.62;
      reasons.push('TREND_FOLLOW');
    }
  }
  
  // VOLUME SURGE
  if (volumeRatio >= 1.5 && adx14 >= 17) {
    if (trend > 0 && cmf20 > 0.03 && hasLongMomentum && rsiHealthy) {
      if (decision === 'NO_TRADE') {
        decision = 'LONG';
        confidence = 0.58;
      } else {
        confidence += 0.12;
      }
      reasons.push('VOLUME_SURGE');
    } else if (trend < 0 && cmf20 < -0.02 && hasShortMomentum && rsiHealthy) {
      if (decision === 'NO_TRADE') {
        decision = 'SHORT';
        confidence = 0.62;
      } else {
        confidence += 0.12;
      }
      reasons.push('VOLUME_SURGE');
    }
  }
  
  // SQUEEZE BREAKOUT
  if (atrPct < 2.0 && volumeRatio >= 1.5 && adx14 >= 20) {
    const cmfConfirms = (trend > 0 && cmf20 > 0.05) || (trend < 0 && cmf20 < -0.05);
    if (cmfConfirms) {
      if (trend > 0 && hasLongMomentum && rsi14 >= 40 && rsi14 < 68) {
        if (decision === 'NO_TRADE') {
          decision = 'LONG';
          confidence = 0.58;
        } else {
          confidence += 0.10;
        }
        reasons.push('SQUEEZE_BREAKOUT');
      } else if (trend < 0 && hasShortMomentum && rsi14 > 32 && rsi14 <= 60) {
        if (decision === 'NO_TRADE') {
          decision = 'SHORT';
          confidence = 0.60;
        } else {
          confidence += 0.10;
        }
        reasons.push('SQUEEZE_BREAKOUT');
      }
    }
  }
  
  // MOMENTUM BREAKOUT
  if (Math.abs(change1h) > 0.3 && volumeRatio >= 1.5) {
    if (change1h > 0.3 && cmf20 > 0.05 && rsi14 >= 35 && rsi14 < 68 && trend > 0) {
      if (decision === 'NO_TRADE') {
        decision = 'LONG';
        confidence = 0.60;
        reasons.push('MOMENTUM_BREAKOUT');
      } else {
        confidence += 0.10;
        reasons.push('MOMENTUM_BREAKOUT');
      }
    } else if (change1h < -0.3 && cmf20 < -0.05 && rsi14 > 32 && rsi14 <= 65 && trend < 0) {
      if (decision === 'NO_TRADE') {
        decision = 'SHORT';
        confidence = 0.62;
        reasons.push('MOMENTUM_BREAKOUT');
      } else {
        confidence += 0.10;
        reasons.push('MOMENTUM_BREAKOUT');
      }
    }
  }
  
  return { decision, confidence, reasons };
}

// Simulate trade
function simulateTrade(ind, futureCandles, side, atrPct) {
  if (!futureCandles || futureCandles.length < 10) return null;
  
  const entryPrice = ind.last;
  const stopDistance = atrPct * 1.5;
  const tp1Distance = atrPct * 2.0;
  const tp2Distance = atrPct * 4.0;
  
  const stopPrice = side === 'LONG' 
    ? entryPrice * (1 - stopDistance / 100)
    : entryPrice * (1 + stopDistance / 100);
  const tp1Price = side === 'LONG'
    ? entryPrice * (1 + tp1Distance / 100)
    : entryPrice * (1 - tp1Distance / 100);
  const tp2Price = side === 'LONG'
    ? entryPrice * (1 + tp2Distance / 100)
    : entryPrice * (1 - tp2Distance / 100);
  
  let exitPrice = null;
  let exitReason = null;
  let holdBars = 0;
  let hitTp1 = false;
  
  for (let i = 0; i < futureCandles.length && i < 96; i++) {
    const candle = futureCandles[i];
    const high = candle[2];
    const low = candle[3];
    holdBars++;
    
    // Check stop
    if (side === 'LONG' && low <= stopPrice) {
      exitPrice = stopPrice;
      exitReason = 'STOP_LOSS';
      break;
    }
    if (side === 'SHORT' && high >= stopPrice) {
      exitPrice = stopPrice;
      exitReason = 'STOP_LOSS';
      break;
    }
    
    // Check TP1
    if (!hitTp1) {
      if (side === 'LONG' && high >= tp1Price) {
        hitTp1 = true;
      }
      if (side === 'SHORT' && low <= tp1Price) {
        hitTp1 = true;
      }
    }
    
    // Trailing stop after TP1
    if (hitTp1) {
      const trailingStop = side === 'LONG' 
        ? tp1Price - (stopDistance * 0.5 * entryPrice / 100)
        : tp1Price + (stopDistance * 0.5 * entryPrice / 100);
      
      if (side === 'LONG' && low <= trailingStop) {
        exitPrice = trailingStop;
        exitReason = 'TRAILING_STOP_AFTER_TP1';
        break;
      }
      if (side === 'SHORT' && high >= trailingStop) {
        exitPrice = trailingStop;
        exitReason = 'TRAILING_STOP_AFTER_TP1';
        break;
      }
    }
    
    // Check TP2
    if (side === 'LONG' && high >= tp2Price) {
      exitPrice = tp2Price;
      exitReason = 'TP2_RUNNER';
      break;
    }
    if (side === 'SHORT' && low <= tp2Price) {
      exitPrice = tp2Price;
      exitReason = 'TP2_RUNNER';
      break;
    }
  }
  
  if (!exitPrice && futureCandles.length > 0) {
    exitPrice = futureCandles[Math.min(holdBars - 1, futureCandles.length - 1)][4];
    exitReason = 'TIME_EXIT';
  }
  
  if (!exitPrice) return null;
  
  const pnlPct = side === 'LONG'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  return { side, pnlPct, exitReason, holdBars };
}

// Run backtest on a period
async function backtestPeriod(symbol, candles, useImprovedFilters = false) {
  const trades = [];
  const lookback = 100;
  
  for (let i = lookback; i < candles.length - 96; i++) {
    const historyCandles = candles.slice(i - lookback, i + 1);
    const futureCandles = candles.slice(i + 1, i + 97);
    
    const indicators = calculateIndicators(historyCandles);
    if (!indicators) continue;
    
    let { decision, confidence, reasons } = makeDecision(indicators, useImprovedFilters);
    
    if (decision === 'NO_TRADE' || confidence < 0.50) continue;
    
    const result = simulateTrade(indicators, futureCandles, decision, indicators.atrPct);
    if (!result) continue;
    
    trades.push({
      ...result,
      reasons,
      volatilityRegime: indicators.volatilityRegime,
      trendStrength: indicators.trendStrength,
      adx: indicators.adx14,
    });
    
    i += Math.max(4, Math.floor(result.holdBars * 0.5));
  }
  
  return trades;
}

// Analyze results
function analyzeResults(trades, label) {
  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct < 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const totalReturn = trades.reduce((sum, t) => sum + t.pnlPct, 0);
  const avgPnl = trades.length > 0 ? totalReturn / trades.length : 0;
  
  // Analyze by volatility regime
  const byVolatility = {};
  for (const t of trades) {
    if (!byVolatility[t.volatilityRegime]) {
      byVolatility[t.volatilityRegime] = { wins: 0, losses: 0, pnl: 0 };
    }
    if (t.pnlPct > 0) byVolatility[t.volatilityRegime].wins++;
    else byVolatility[t.volatilityRegime].losses++;
    byVolatility[t.volatilityRegime].pnl += t.pnlPct;
  }
  
  // Analyze by trend strength
  const byTrend = {};
  for (const t of trades) {
    if (!byTrend[t.trendStrength]) {
      byTrend[t.trendStrength] = { wins: 0, losses: 0, pnl: 0 };
    }
    if (t.pnlPct > 0) byTrend[t.trendStrength].wins++;
    else byTrend[t.trendStrength].losses++;
    byTrend[t.trendStrength].pnl += t.pnlPct;
  }
  
  return {
    label,
    totalTrades: trades.length,
    winRate,
    totalReturn,
    avgPnl,
    byVolatility,
    byTrend,
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 ANALYSE DE STABILITÉ - Comparaison Stratégie Actuelle vs Améliorée');
  console.log('═'.repeat(80));
  
  const periods = [
    { label: 'Période 1 (il y a 45-60j)', daysAgo: 60, duration: 15 },
    { label: 'Période 2 (il y a 30-45j)', daysAgo: 45, duration: 15 },
    { label: 'Période 3 (il y a 15-30j)', daysAgo: 30, duration: 15 },
    { label: 'Période 4 (derniers 15j)', daysAgo: 15, duration: 15 },
  ];
  
  const resultsOriginal = [];
  const resultsImproved = [];
  
  for (const symbol of CONFIG.symbols) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`📈 ${symbol}`);
    console.log('─'.repeat(70));
    
    // Fetch all data
    const now = Date.now();
    console.log(`📥 Fetching 60 days of data...`);
    const allCandles = await fetchHistoricalData(symbol, CONFIG.timeframe, 60);
    console.log(`   ✅ Got ${allCandles.length} candles`);
    
    for (const period of periods) {
      // Calculate period boundaries
      const endTime = now - (period.daysAgo - period.duration) * 24 * 60 * 60 * 1000;
      const startTime = now - period.daysAgo * 24 * 60 * 60 * 1000;
      
      const periodCandles = allCandles.filter(c => c[0] >= startTime && c[0] <= endTime);
      
      if (periodCandles.length < 200) {
        console.log(`   ⚠️ ${period.label}: Not enough candles (${periodCandles.length})`);
        continue;
      }
      
      // Test with original strategy
      const tradesOriginal = await backtestPeriod(symbol, periodCandles, false);
      const analysisOriginal = analyzeResults(tradesOriginal, `${symbol} - ${period.label} (Original)`);
      resultsOriginal.push({ ...analysisOriginal, symbol, period: period.label });
      
      // Test with improved filters
      const tradesImproved = await backtestPeriod(symbol, periodCandles, true);
      const analysisImproved = analyzeResults(tradesImproved, `${symbol} - ${period.label} (Improved)`);
      resultsImproved.push({ ...analysisImproved, symbol, period: period.label });
      
      console.log(`   ${period.label}:`);
      console.log(`      Original: ${tradesOriginal.length} trades, ${analysisOriginal.winRate.toFixed(1)}% WR, ${analysisOriginal.totalReturn.toFixed(2)}%`);
      console.log(`      Improved: ${tradesImproved.length} trades, ${analysisImproved.winRate.toFixed(1)}% WR, ${analysisImproved.totalReturn.toFixed(2)}%`);
    }
  }
  
  // Aggregate results
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSUMÉ PAR PÉRIODE');
  console.log('═'.repeat(80));
  
  for (const period of periods) {
    const origPeriod = resultsOriginal.filter(r => r.period === period.label);
    const impPeriod = resultsImproved.filter(r => r.period === period.label);
    
    const origTrades = origPeriod.reduce((s, r) => s + r.totalTrades, 0);
    const origWins = origPeriod.reduce((s, r) => s + Math.round(r.totalTrades * r.winRate / 100), 0);
    const origReturn = origPeriod.reduce((s, r) => s + r.totalReturn, 0);
    
    const impTrades = impPeriod.reduce((s, r) => s + r.totalTrades, 0);
    const impWins = impPeriod.reduce((s, r) => s + Math.round(r.totalTrades * r.winRate / 100), 0);
    const impReturn = impPeriod.reduce((s, r) => s + r.totalReturn, 0);
    
    console.log(`\n📅 ${period.label}:`);
    console.log(`   Original: ${origTrades} trades, ${origTrades > 0 ? (origWins/origTrades*100).toFixed(1) : 0}% WR, ${origReturn.toFixed(2)}%`);
    console.log(`   Improved: ${impTrades} trades, ${impTrades > 0 ? (impWins/impTrades*100).toFixed(1) : 0}% WR, ${impReturn.toFixed(2)}%`);
  }
  
  // Overall comparison
  console.log('\n' + '═'.repeat(80));
  console.log('📈 COMPARAISON GLOBALE (60 jours)');
  console.log('═'.repeat(80));
  
  const totalOrigTrades = resultsOriginal.reduce((s, r) => s + r.totalTrades, 0);
  const totalOrigWins = resultsOriginal.reduce((s, r) => s + Math.round(r.totalTrades * r.winRate / 100), 0);
  const totalOrigReturn = resultsOriginal.reduce((s, r) => s + r.totalReturn, 0);
  
  const totalImpTrades = resultsImproved.reduce((s, r) => s + r.totalTrades, 0);
  const totalImpWins = resultsImproved.reduce((s, r) => s + Math.round(r.totalTrades * r.winRate / 100), 0);
  const totalImpReturn = resultsImproved.reduce((s, r) => s + r.totalReturn, 0);
  
  console.log(`\n🔴 Stratégie ORIGINALE:`);
  console.log(`   Total Trades: ${totalOrigTrades}`);
  console.log(`   Win Rate: ${totalOrigTrades > 0 ? (totalOrigWins/totalOrigTrades*100).toFixed(1) : 0}%`);
  console.log(`   Total Return: ${totalOrigReturn.toFixed(2)}%`);
  
  console.log(`\n🟢 Stratégie AMÉLIORÉE (filtres de stabilité):`);
  console.log(`   Total Trades: ${totalImpTrades}`);
  console.log(`   Win Rate: ${totalImpTrades > 0 ? (totalImpWins/totalImpTrades*100).toFixed(1) : 0}%`);
  console.log(`   Total Return: ${totalImpReturn.toFixed(2)}%`);
  
  console.log(`\n📊 Amélioration:`);
  console.log(`   Trades: ${totalOrigTrades} → ${totalImpTrades} (${totalImpTrades - totalOrigTrades > 0 ? '+' : ''}${totalImpTrades - totalOrigTrades})`);
  console.log(`   Return: ${totalOrigReturn.toFixed(2)}% → ${totalImpReturn.toFixed(2)}% (${totalImpReturn - totalOrigReturn > 0 ? '+' : ''}${(totalImpReturn - totalOrigReturn).toFixed(2)}%)`);
  
  // Analyze by volatility regime
  console.log('\n' + '═'.repeat(80));
  console.log('📊 ANALYSE PAR RÉGIME DE VOLATILITÉ');
  console.log('═'.repeat(80));
  
  const volRegimes = ['LOW', 'MEDIUM', 'HIGH'];
  for (const regime of volRegimes) {
    let origStats = { trades: 0, wins: 0, pnl: 0 };
    let impStats = { trades: 0, wins: 0, pnl: 0 };
    
    for (const r of resultsOriginal) {
      if (r.byVolatility[regime]) {
        origStats.trades += r.byVolatility[regime].wins + r.byVolatility[regime].losses;
        origStats.wins += r.byVolatility[regime].wins;
        origStats.pnl += r.byVolatility[regime].pnl;
      }
    }
    
    for (const r of resultsImproved) {
      if (r.byVolatility[regime]) {
        impStats.trades += r.byVolatility[regime].wins + r.byVolatility[regime].losses;
        impStats.wins += r.byVolatility[regime].wins;
        impStats.pnl += r.byVolatility[regime].pnl;
      }
    }
    
    console.log(`\n${regime} VOLATILITY:`);
    console.log(`   Original: ${origStats.trades} trades, ${origStats.trades > 0 ? (origStats.wins/origStats.trades*100).toFixed(1) : 0}% WR, ${origStats.pnl.toFixed(2)}%`);
    console.log(`   Improved: ${impStats.trades} trades, ${impStats.trades > 0 ? (impStats.wins/impStats.trades*100).toFixed(1) : 0}% WR, ${impStats.pnl.toFixed(2)}%`);
  }
  
  console.log('\n' + '═'.repeat(80));
  console.log('✅ ANALYSE TERMINÉE');
  console.log('═'.repeat(80));
}

main().catch(console.error);
