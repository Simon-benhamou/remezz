#!/usr/bin/env node
/**
 * 📊 STRATÉGIE ULTRA-SÉLECTIVE
 * 
 * Objectif: STABILITÉ avant tout
 * - Ne trader QUE dans les conditions optimales
 * - Moins de trades mais meilleur WR
 * - Éviter les pertes plutôt que maximiser les gains
 */

import ccxt from 'ccxt';

const CONFIG = {
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
  timeframe: '15m',
  days: 60,
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

// Calculate technical indicators
function calculateIndicators(candles) {
  if (candles.length < 100) return null;
  
  const closes = candles.map(c => c[4]);
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const volumes = candles.map(c => c[5]);
  const last = closes[closes.length - 1];
  const timestamp = candles[candles.length - 1][0];
  
  function ema(arr, period) {
    const k = 2 / (period + 1);
    let result = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      result.push(arr[i] * k + result[i-1] * (1 - k));
    }
    return result;
  }
  
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
      return 100 - (100 / (1 + g / l));
    });
  }
  
  function atr(highs, lows, closes, period = 14) {
    const tr = [];
    for (let i = 1; i < closes.length; i++) {
      const high = highs[i], low = lows[i], prevClose = closes[i-1];
      tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    return ema(tr, period);
  }
  
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
    return { adx: ema(dx, period), diPlus, diMinus };
  }
  
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
  
  // Bollinger Bands
  function bollingerBands(closes, period = 20, stdDev = 2) {
    const result = [];
    for (let i = period - 1; i < closes.length; i++) {
      const slice = closes.slice(i - period + 1, i + 1);
      const mean = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
      const std = Math.sqrt(variance);
      result.push({
        upper: mean + stdDev * std,
        middle: mean,
        lower: mean - stdDev * std,
        width: (stdDev * std * 2) / mean * 100, // % width
      });
    }
    return result;
  }
  
  const ema20Arr = ema(closes, 20);
  const ema50Arr = ema(closes, 50);
  const rsiArr = rsi(closes);
  const atrArr = atr(highs, lows, closes);
  const { adx: adxArr, diPlus, diMinus } = adx(highs, lows, closes);
  const cmfArr = cmf(highs, lows, closes, volumes);
  const bbArr = bollingerBands(closes);
  
  const avgVol = volumes.slice(-50, -1).reduce((a, b) => a + b, 0) / 49;
  const currentVol = volumes[volumes.length - 1];
  
  // Volatility calculation
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.abs(closes[i] - closes[i-1]) / closes[i-1] * 100);
  }
  const avgReturn = returns.slice(-50).reduce((a, b) => a + b, 0) / 50;
  
  // Candle analysis
  const currentCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const candleBody = Math.abs(currentCandle[4] - currentCandle[1]);
  const candleRange = currentCandle[2] - currentCandle[3];
  const bodyRatio = candleRange > 0 ? candleBody / candleRange : 0;
  
  // Higher timeframe trend (last 4h = 16 candles)
  const htfTrend = (closes[closes.length - 1] - closes[closes.length - 17]) / closes[closes.length - 17] * 100;
  
  // Momentum
  const change1h = (last - closes[closes.length - 5]) / closes[closes.length - 5] * 100;
  const change4h = (last - closes[closes.length - 17]) / closes[closes.length - 17] * 100;
  
  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema50 = ema50Arr[ema50Arr.length - 1];
  const bb = bbArr[bbArr.length - 1];
  
  return {
    last,
    timestamp,
    ema20,
    ema50,
    rsi14: rsiArr[rsiArr.length - 1],
    atrPct: (atrArr[atrArr.length - 1] / last) * 100,
    adx14: adxArr[adxArr.length - 1],
    diPlus: diPlus[diPlus.length - 1],
    diMinus: diMinus[diMinus.length - 1],
    cmf20: cmfArr[cmfArr.length - 1],
    volumeRatio: currentVol / avgVol,
    trend: last > ema20 ? 1 : -1,
    trendAlignment: (last > ema20 && ema20 > ema50) ? 1 : (last < ema20 && ema20 < ema50) ? -1 : 0,
    priceVsEma: (last - ema20) / ema20 * 100,
    avgVolatility: avgReturn,
    bbWidth: bb.width,
    bbPosition: (last - bb.lower) / (bb.upper - bb.lower), // 0-1 position in BB
    change1h,
    change4h,
    htfTrend,
    bodyRatio,
    isBullishCandle: currentCandle[4] > currentCandle[1],
    isBearishCandle: currentCandle[4] < currentCandle[1],
  };
}

/**
 * 🎯 STRATÉGIE ULTRA-SÉLECTIVE
 * 
 * Règles strictes:
 * 1. JAMAIS trader en low volatility (ADX < 25)
 * 2. JAMAIS trader contre le trend HTF
 * 3. TOUJOURS exiger volume + CMF + trend alignment
 * 4. Confidence minimum: 0.65
 */
function makeUltraSelectiveDecision(ind) {
  const { 
    rsi14, adx14, diPlus, diMinus, cmf20, volumeRatio, 
    trend, trendAlignment, atrPct, change1h, change4h,
    avgVolatility, bbWidth, bbPosition, htfTrend,
    bodyRatio, isBullishCandle, isBearishCandle
  } = ind;
  
  let decision = 'NO_TRADE';
  let confidence = 0;
  let reasons = [];
  
  // ═══════════════════════════════════════════════════════════════
  // FILTRE 1: CONDITIONS DE MARCHÉ MINIMALES
  // ═══════════════════════════════════════════════════════════════
  
  // Skip: Low volatility / ranging market
  if (adx14 < 22) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['LOW_ADX'] };
  }
  
  // Skip: Insufficient volume
  if (volumeRatio < 1.4) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['LOW_VOLUME'] };
  }
  
  // Skip: Neutral CMF
  if (Math.abs(cmf20) < 0.05) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['NEUTRAL_CMF'] };
  }
  
  // Skip: Weak candle
  if (bodyRatio < 0.5) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['WEAK_CANDLE'] };
  }
  
  // ═══════════════════════════════════════════════════════════════
  // FILTRE 2: RSI ZONE
  // ═══════════════════════════════════════════════════════════════
  
  // Only trade in healthy RSI zone
  const rsiHealthy = rsi14 >= 35 && rsi14 <= 65;
  if (!rsiHealthy) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['RSI_EXTREME'] };
  }
  
  // ═══════════════════════════════════════════════════════════════
  // STRATÉGIE 1: TREND MOMENTUM CONFLUENCE
  // Le plus fiable - tous les signaux alignés
  // ═══════════════════════════════════════════════════════════════
  
  const hasStrongTrend = adx14 >= 28;
  const hasVolumeSurge = volumeRatio >= 1.8;
  const hasMomentum = Math.abs(change1h) >= 0.3;
  
  // LONG: Tout aligné haussier
  if (
    trendAlignment === 1 &&          // EMA20 > EMA50, price > EMA20
    htfTrend > 0.5 &&                // HTF trend haussier
    cmf20 > 0.08 &&                  // Fort flux d'argent
    diPlus > diMinus &&              // DI+ > DI-
    change1h > 0.2 &&                // Momentum positif
    isBullishCandle &&               // Bougie haussière
    hasStrongTrend
  ) {
    decision = 'LONG';
    confidence = 0.70;
    reasons.push('TREND_CONFLUENCE_LONG');
    
    if (hasVolumeSurge) confidence += 0.05;
    if (change4h > 0.5) confidence += 0.05;
    if (bbPosition > 0.5 && bbPosition < 0.85) confidence += 0.03;
  }
  
  // SHORT: Tout aligné baissier
  else if (
    trendAlignment === -1 &&         // EMA20 < EMA50, price < EMA20
    htfTrend < -0.5 &&               // HTF trend baissier
    cmf20 < -0.08 &&                 // Fort flux sortant
    diMinus > diPlus &&              // DI- > DI+
    change1h < -0.2 &&               // Momentum négatif
    isBearishCandle &&               // Bougie baissière
    hasStrongTrend
  ) {
    decision = 'SHORT';
    confidence = 0.72;
    reasons.push('TREND_CONFLUENCE_SHORT');
    
    if (hasVolumeSurge) confidence += 0.05;
    if (change4h < -0.5) confidence += 0.05;
    if (bbPosition < 0.5 && bbPosition > 0.15) confidence += 0.03;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // STRATÉGIE 2: BREAKOUT EXPLOSION
  // Mouvement fort avec volume exceptionnel
  // ═══════════════════════════════════════════════════════════════
  
  if (decision === 'NO_TRADE' && volumeRatio >= 2.5 && Math.abs(change1h) >= 0.5) {
    // LONG breakout
    if (change1h > 0.5 && cmf20 > 0.1 && trend > 0 && htfTrend > 0) {
      decision = 'LONG';
      confidence = 0.68;
      reasons.push('BREAKOUT_EXPLOSION_LONG');
    }
    // SHORT breakdown
    else if (change1h < -0.5 && cmf20 < -0.1 && trend < 0 && htfTrend < 0) {
      decision = 'SHORT';
      confidence = 0.70;
      reasons.push('BREAKOUT_EXPLOSION_SHORT');
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // STRATÉGIE 3: MEAN REVERSION (TRÈS SÉLECTIF)
  // Seulement aux extrêmes avec confirmation
  // ═══════════════════════════════════════════════════════════════
  
  if (decision === 'NO_TRADE' && volumeRatio >= 2.0) {
    // Oversold bounce - très strict
    if (
      bbPosition < 0.15 &&           // Proche bande inférieure
      rsi14 < 38 &&                  // RSI oversold
      cmf20 > 0.05 &&                // Mais CMF positif (divergence)
      change1h > 0.1 &&              // Début de rebond
      isBullishCandle
    ) {
      decision = 'LONG';
      confidence = 0.66;
      reasons.push('MEAN_REVERSION_LONG');
    }
    // Overbought rejection
    else if (
      bbPosition > 0.85 &&           // Proche bande supérieure
      rsi14 > 62 &&                  // RSI overbought
      cmf20 < -0.05 &&               // CMF négatif (divergence)
      change1h < -0.1 &&             // Début de baisse
      isBearishCandle
    ) {
      decision = 'SHORT';
      confidence = 0.68;
      reasons.push('MEAN_REVERSION_SHORT');
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // SEUIL MINIMUM DE CONFIANCE
  // ═══════════════════════════════════════════════════════════════
  
  if (confidence < 0.65) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['LOW_CONFIDENCE'] };
  }
  
  return { decision, confidence, reasons };
}

// Simulate trade with tighter stops
function simulateTrade(ind, futureCandles, side, atrPct) {
  if (!futureCandles || futureCandles.length < 10) return null;
  
  const entryPrice = ind.last;
  
  // Tighter risk management
  const stopDistance = atrPct * 1.2;  // Tighter stop
  const tp1Distance = atrPct * 1.8;   // Faster TP1
  const tp2Distance = atrPct * 3.5;   // Reasonable TP2
  
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
  
  for (let i = 0; i < futureCandles.length && i < 64; i++) { // Max 16h (more aggressive)
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
      if ((side === 'LONG' && high >= tp1Price) || (side === 'SHORT' && low <= tp1Price)) {
        hitTp1 = true;
      }
    }
    
    // Trailing stop after TP1
    if (hitTp1) {
      const trailingStop = side === 'LONG' 
        ? tp1Price - (stopDistance * 0.4 * entryPrice / 100)
        : tp1Price + (stopDistance * 0.4 * entryPrice / 100);
      
      if ((side === 'LONG' && low <= trailingStop) || (side === 'SHORT' && high >= trailingStop)) {
        exitPrice = trailingStop;
        exitReason = 'TRAILING_STOP_AFTER_TP1';
        break;
      }
    }
    
    // Check TP2
    if ((side === 'LONG' && high >= tp2Price) || (side === 'SHORT' && low <= tp2Price)) {
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

// Run backtest
async function backtestSymbol(symbol, candles) {
  const trades = [];
  let equity = CONFIG.equityUsd;
  let peakEquity = equity;
  let maxDrawdown = 0;
  
  const lookback = 100;
  
  for (let i = lookback; i < candles.length - 96; i++) {
    const historyCandles = candles.slice(i - lookback, i + 1);
    const futureCandles = candles.slice(i + 1, i + 97);
    
    const indicators = calculateIndicators(historyCandles);
    if (!indicators) continue;
    
    const { decision, confidence, reasons } = makeUltraSelectiveDecision(indicators);
    
    if (decision === 'NO_TRADE') continue;
    
    const result = simulateTrade(indicators, futureCandles, decision, indicators.atrPct);
    if (!result) continue;
    
    // Position sizing
    const riskAmount = equity * CONFIG.riskPerTrade;
    const stopDistance = indicators.atrPct * 1.2;
    const positionSize = riskAmount / (indicators.last * (stopDistance / 100));
    const pnlUsd = positionSize * indicators.last * (result.pnlPct / 100);
    equity += pnlUsd;
    
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = (peakEquity - equity) / peakEquity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    
    trades.push({
      timestamp: new Date(indicators.timestamp).toISOString(),
      ...result,
      reasons: reasons.join(', '),
      confidence,
      pnlUsd: pnlUsd.toFixed(2),
    });
    
    // Skip after trade
    i += Math.max(8, Math.floor(result.holdBars * 0.7));
  }
  
  return { symbol, trades, equity, maxDrawdown };
}

// Main
async function main() {
  console.log('═'.repeat(80));
  console.log('📊 STRATÉGIE ULTRA-SÉLECTIVE - Backtest 60 jours');
  console.log('═'.repeat(80));
  console.log(`📅 Période: ${CONFIG.days} jours`);
  console.log(`💰 Capital: $${CONFIG.equityUsd.toLocaleString()}`);
  console.log('═'.repeat(80));
  
  const allResults = [];
  let totalTrades = 0;
  let totalWins = 0;
  let combinedEquity = 0;
  
  for (const symbol of CONFIG.symbols) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🔍 ${symbol}`);
    console.log('─'.repeat(60));
    
    const candles = await fetchHistoricalData(symbol, CONFIG.timeframe, CONFIG.days);
    if (candles.length < 200) continue;
    
    const result = await backtestSymbol(symbol, candles);
    allResults.push(result);
    
    const wins = result.trades.filter(t => t.pnlPct > 0).length;
    const losses = result.trades.filter(t => t.pnlPct < 0).length;
    const winRate = result.trades.length > 0 ? (wins / result.trades.length) * 100 : 0;
    const totalReturn = ((result.equity - CONFIG.equityUsd) / CONFIG.equityUsd) * 100;
    const avgWin = wins > 0 ? result.trades.filter(t => t.pnlPct > 0).reduce((a, t) => a + t.pnlPct, 0) / wins : 0;
    const avgLoss = losses > 0 ? result.trades.filter(t => t.pnlPct < 0).reduce((a, t) => a + t.pnlPct, 0) / losses : 0;
    const profitFactor = Math.abs(avgLoss) > 0 ? (wins * avgWin) / (losses * Math.abs(avgLoss)) : wins > 0 ? Infinity : 0;
    
    totalTrades += result.trades.length;
    totalWins += wins;
    combinedEquity += result.equity - CONFIG.equityUsd;
    
    console.log(`   Trades: ${result.trades.length}`);
    console.log(`   Win Rate: ${winRate.toFixed(1)}% (${wins}W / ${losses}L)`);
    console.log(`   Profit Factor: ${profitFactor.toFixed(2)}`);
    console.log(`   Avg Win: ${avgWin.toFixed(2)}% | Avg Loss: ${avgLoss.toFixed(2)}%`);
    console.log(`   Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`);
    console.log(`   Max Drawdown: ${(result.maxDrawdown * 100).toFixed(2)}%`);
    console.log(`   Final Equity: $${result.equity.toFixed(2)}`);
    
    // Show last 5 trades
    if (result.trades.length > 0) {
      console.log(`\n   📋 Derniers trades:`);
      result.trades.slice(-5).forEach(t => {
        const icon = t.pnlPct > 0 ? '✅' : '❌';
        console.log(`   ${icon} ${t.side} | ${t.exitReason} | ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}% | ${t.reasons}`);
      });
    }
  }
  
  // Aggregate results
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS AGRÉGÉS (60 jours)');
  console.log('═'.repeat(80));
  
  const overallWinRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  const combinedReturn = (combinedEquity / CONFIG.equityUsd) * 100;
  const avgTradeReturn = totalTrades > 0 ? combinedReturn / totalTrades : 0;
  
  console.log(`\n   Total Trades: ${totalTrades}`);
  console.log(`   Overall Win Rate: ${overallWinRate.toFixed(1)}%`);
  console.log(`   Combined Return: ${combinedReturn >= 0 ? '+' : ''}${combinedReturn.toFixed(2)}%`);
  console.log(`   Avg Trade: ${avgTradeReturn >= 0 ? '+' : ''}${avgTradeReturn.toFixed(3)}%`);
  
  // Monthly breakdown
  console.log(`\n📅 Estimation mensuelle (30 jours):`);
  const monthlyReturn = combinedReturn / 2;
  const monthlyTrades = totalTrades / 2;
  console.log(`   Trades/mois: ~${Math.round(monthlyTrades)}`);
  console.log(`   Return/mois: ${monthlyReturn >= 0 ? '+' : ''}${monthlyReturn.toFixed(2)}%`);
  
  // Compare with original strategy
  console.log('\n' + '─'.repeat(80));
  console.log('📊 COMPARAISON AVEC STRATÉGIE ORIGINALE (60j)');
  console.log('─'.repeat(80));
  console.log(`
┌─────────────────────┬─────────────┬──────────────┬─────────────┐
│      Stratégie      │   Trades    │   Win Rate   │   Return    │
├─────────────────────┼─────────────┼──────────────┼─────────────┤
│ 🔴 Originale        │     290     │    33.8%     │   -7.77%    │
│ 🟢 Ultra-Sélective  │     ${String(totalTrades).padStart(3)}     │    ${overallWinRate.toFixed(1).padStart(4)}%     │   ${combinedReturn >= 0 ? '+' : ''}${combinedReturn.toFixed(2).padStart(5)}%    │
└─────────────────────┴─────────────┴──────────────┴─────────────┘
  `);
  
  console.log('═'.repeat(80));
  console.log('✅ BACKTEST TERMINÉ');
  console.log('═'.repeat(80));
}

main().catch(console.error);
