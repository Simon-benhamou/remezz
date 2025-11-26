#!/usr/bin/env node
/**
 * 📊 STRATÉGIE ADAPTATIVE PAR RÉGIME DE VOLATILITÉ
 * 
 * Objectif: Avoir des règles DIFFÉRENTES selon le contexte
 * - LOW volatility: Stratégies de range/mean-reversion
 * - MEDIUM volatility: Stratégies mixtes
 * - HIGH volatility: Stratégies de momentum/breakout
 */

import ccxt from 'ccxt';

const CONFIG = {
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
  timeframe: '15m',
  days: 120,  // 4 mois de backtest
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
  
  function sma(arr, period) {
    const result = [];
    for (let i = period - 1; i < arr.length; i++) {
      result.push(arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
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
        width: (stdDev * std * 2) / mean * 100,
      });
    }
    return result;
  }
  
  const ema9Arr = ema(closes, 9);
  const ema20Arr = ema(closes, 20);
  const ema50Arr = ema(closes, 50);
  const rsiArr = rsi(closes);
  const atrArr = atr(highs, lows, closes);
  const { adx: adxArr, diPlus, diMinus } = adx(highs, lows, closes);
  const cmfArr = cmf(highs, lows, closes, volumes);
  const bbArr = bollingerBands(closes);
  
  const avgVol = volumes.slice(-50, -1).reduce((a, b) => a + b, 0) / 49;
  const currentVol = volumes[volumes.length - 1];
  
  // Volatility regime - more nuanced
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.abs(closes[i] - closes[i-1]) / closes[i-1] * 100);
  }
  const avgReturn = returns.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const recentReturn = returns.slice(-10).reduce((a, b) => a + b, 0) / 10;
  
  // Classify volatility regime
  let volatilityRegime;
  if (avgReturn > 0.5 || recentReturn > 0.6) {
    volatilityRegime = 'HIGH';
  } else if (avgReturn > 0.25 || recentReturn > 0.35) {
    volatilityRegime = 'MEDIUM';
  } else {
    volatilityRegime = 'LOW';
  }
  
  // Candle analysis
  const currentCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const candleBody = Math.abs(currentCandle[4] - currentCandle[1]);
  const candleRange = currentCandle[2] - currentCandle[3];
  const bodyRatio = candleRange > 0 ? candleBody / candleRange : 0;
  
  // Higher timeframe trend
  const htfTrend = (closes[closes.length - 1] - closes[closes.length - 17]) / closes[closes.length - 17] * 100;
  
  // Momentum at different scales
  const change15m = (last - closes[closes.length - 2]) / closes[closes.length - 2] * 100;
  const change1h = (last - closes[closes.length - 5]) / closes[closes.length - 5] * 100;
  const change4h = (last - closes[closes.length - 17]) / closes[closes.length - 17] * 100;
  
  const ema9 = ema9Arr[ema9Arr.length - 1];
  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema50 = ema50Arr[ema50Arr.length - 1];
  const bb = bbArr[bbArr.length - 1];
  
  // Support/Resistance levels (simple: recent highs/lows)
  const recentHighs = highs.slice(-20);
  const recentLows = lows.slice(-20);
  const resistance = Math.max(...recentHighs);
  const support = Math.min(...recentLows);
  const distanceToResistance = (resistance - last) / last * 100;
  const distanceToSupport = (last - support) / last * 100;
  
  return {
    last,
    timestamp,
    ema9,
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
    emaStack: (ema9 > ema20 && ema20 > ema50) ? 1 : (ema9 < ema20 && ema20 < ema50) ? -1 : 0,
    priceVsEma: (last - ema20) / ema20 * 100,
    volatilityRegime,
    avgVolatility: avgReturn,
    bbWidth: bb.width,
    bbPosition: (last - bb.lower) / (bb.upper - bb.lower),
    bbUpper: bb.upper,
    bbLower: bb.lower,
    bbMiddle: bb.middle,
    change15m,
    change1h,
    change4h,
    htfTrend,
    bodyRatio,
    isBullishCandle: currentCandle[4] > currentCandle[1],
    isBearishCandle: currentCandle[4] < currentCandle[1],
    resistance,
    support,
    distanceToResistance,
    distanceToSupport,
  };
}

/**
 * 🎯 STRATÉGIE ADAPTATIVE V8 - BASÉE SUR V4 (LA MEILLEURE)
 * 
 * V4 = +17.50% avec:
 * - LOW: 0 trades (évité)
 * - MEDIUM: 33 trades, 51.5% WR, -0.07% (breakeven)
 * - HIGH: 78 trades, 55.1% WR, +36.23%
 * 
 * V8: Identique à V4 + quelques trades LOW ultra-sélectifs
 */
function makeAdaptiveDecision(ind) {
  const { 
    rsi14, adx14, diPlus, diMinus, cmf20, volumeRatio, 
    trend, trendAlignment, emaStack, atrPct, 
    change15m, change1h, change4h, htfTrend,
    volatilityRegime, bbWidth, bbPosition, bbUpper, bbLower, bbMiddle,
    bodyRatio, isBullishCandle, isBearishCandle, last,
    distanceToResistance, distanceToSupport, ema9, ema20
  } = ind;
  
  let decision = 'NO_TRADE';
  let confidence = 0;
  let reasons = [];
  let strategy = '';
  let riskMultiplier = 1.0;
  
  // ═══════════════════════════════════════════════════════════════
  // RÉGIME LOW VOLATILITY - DIVERGENCE EXTRÊME UNIQUEMENT
  // Peu de trades mais très sélectifs
  // ═══════════════════════════════════════════════════════════════
  if (volatilityRegime === 'LOW') {
    strategy = 'LOW_VOL';
    riskMultiplier = 0.3;
    
    // Stratégie 1: DIVERGENCE aux extrêmes
    // LONG: RSI survendu + CMF positif (accumulation cachée)
    if (
      rsi14 < 30 &&
      cmf20 > 0.06 &&               // CMF positif (divergence)
      bbPosition < 0.15 &&
      volumeRatio >= 1.5 &&
      isBullishCandle &&
      bodyRatio >= 0.5 &&
      change15m > 0.05
    ) {
      decision = 'LONG';
      confidence = 0.62;
      reasons.push('LOW_DIVERGENCE_LONG');
      
      if (cmf20 > 0.10) confidence += 0.03;
      if (volumeRatio >= 2.0) confidence += 0.02;
    }
    // SHORT: RSI suracheté + CMF négatif
    else if (
      rsi14 > 70 &&
      cmf20 < -0.06 &&
      bbPosition > 0.85 &&
      volumeRatio >= 1.5 &&
      isBearishCandle &&
      bodyRatio >= 0.5 &&
      change15m < -0.05
    ) {
      decision = 'SHORT';
      confidence = 0.64;
      reasons.push('LOW_DIVERGENCE_SHORT');
      
      if (cmf20 < -0.10) confidence += 0.03;
      if (volumeRatio >= 2.0) confidence += 0.02;
    }
    
    // Stratégie 2: Squeeze breakout (BB très serrées + volume spike)
    if (decision === 'NO_TRADE' && bbWidth < 0.025 && volumeRatio >= 2.0) {
      if (
        change15m > 0.12 &&
        isBullishCandle &&
        bodyRatio >= 0.55 &&
        cmf20 > 0.03
      ) {
        decision = 'LONG';
        confidence = 0.60;
        reasons.push('LOW_SQUEEZE_BREAKOUT_LONG');
      }
      else if (
        change15m < -0.12 &&
        isBearishCandle &&
        bodyRatio >= 0.55 &&
        cmf20 < -0.03
      ) {
        decision = 'SHORT';
        confidence = 0.62;
        reasons.push('LOW_SQUEEZE_BREAKOUT_SHORT');
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // RÉGIME MEDIUM VOLATILITY - TRÈS STRICT (éviter les pertes)
  // ═══════════════════════════════════════════════════════════════
  else if (volatilityRegime === 'MEDIUM') {
    strategy = 'MED_VOL';
    riskMultiplier = 0.4;  // Réduire le risque
    
    // UNIQUEMENT les setups parfaits: ADX très fort + tout aligné
    if (adx14 >= 28 && volumeRatio >= 1.8 && bodyRatio >= 0.6) {
      // LONG: Confluence totale
      if (
        trendAlignment === 1 &&
        emaStack === 1 &&
        htfTrend > 0.6 &&
        cmf20 > 0.08 &&
        diPlus > diMinus * 1.3 &&
        rsi14 >= 48 && rsi14 <= 62 &&
        isBullishCandle &&
        change1h > 0.25
      ) {
        decision = 'LONG';
        confidence = 0.65;
        reasons.push('MED_PERFECT_UPTREND');
      }
      // SHORT: Confluence totale
      else if (
        trendAlignment === -1 &&
        emaStack === -1 &&
        htfTrend < -0.6 &&
        cmf20 < -0.08 &&
        diMinus > diPlus * 1.3 &&
        rsi14 >= 38 && rsi14 <= 52 &&
        isBearishCandle &&
        change1h < -0.25
      ) {
        decision = 'SHORT';
        confidence = 0.67;
        reasons.push('MED_PERFECT_DOWNTREND');
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // RÉGIME HIGH VOLATILITY - IDENTIQUE À V4 (FONCTIONNE)
  // ═══════════════════════════════════════════════════════════════
  else if (volatilityRegime === 'HIGH') {
    strategy = 'HIGH_VOL';
    riskMultiplier = 1.0;
    
    // Stratégie 1: MOMENTUM BREAKOUT
    if (Math.abs(change1h) >= 0.35 && volumeRatio >= 1.4) {
      if (
        change1h > 0.35 &&
        cmf20 > 0.04 &&
        trend > 0 &&
        isBullishCandle &&
        bodyRatio >= 0.45
      ) {
        decision = 'LONG';
        confidence = 0.65;
        reasons.push('HIGH_MOMENTUM_LONG');
        
        if (trendAlignment === 1) confidence += 0.05;
        if (adx14 >= 25) confidence += 0.03;
        if (volumeRatio >= 2.0) confidence += 0.05;
      }
      else if (
        change1h < -0.35 &&
        cmf20 < -0.04 &&
        trend < 0 &&
        isBearishCandle &&
        bodyRatio >= 0.45
      ) {
        decision = 'SHORT';
        confidence = 0.67;
        reasons.push('HIGH_MOMENTUM_SHORT');
        
        if (trendAlignment === -1) confidence += 0.05;
        if (adx14 >= 25) confidence += 0.03;
        if (volumeRatio >= 2.0) confidence += 0.05;
      }
    }
    
    // Stratégie 2: TREND CONTINUATION
    if (decision === 'NO_TRADE' && adx14 >= 22) {
      if (
        trendAlignment === 1 &&
        cmf20 > 0.06 &&
        rsi14 >= 48 && rsi14 <= 72 &&
        change4h > 0.4 &&
        volumeRatio >= 1.2 &&
        isBullishCandle
      ) {
        decision = 'LONG';
        confidence = 0.63;
        reasons.push('HIGH_TREND_CONTINUATION_LONG');
        
        if (emaStack === 1) confidence += 0.04;
      }
      else if (
        trendAlignment === -1 &&
        cmf20 < -0.06 &&
        rsi14 <= 52 && rsi14 >= 28 &&
        change4h < -0.4 &&
        volumeRatio >= 1.2 &&
        isBearishCandle
      ) {
        decision = 'SHORT';
        confidence = 0.65;
        reasons.push('HIGH_TREND_CONTINUATION_SHORT');
        
        if (emaStack === -1) confidence += 0.04;
      }
    }
    
    // Stratégie 3: BREAKOUT BB
    if (decision === 'NO_TRADE' && volumeRatio >= 1.8 && bodyRatio >= 0.55) {
      if (
        last > bbUpper * 0.997 &&
        cmf20 > 0.04 &&
        change15m > 0.15 &&
        trend > 0
      ) {
        decision = 'LONG';
        confidence = 0.60;
        reasons.push('HIGH_BB_BREAKOUT_LONG');
      }
      else if (
        last < bbLower * 1.003 &&
        cmf20 < -0.04 &&
        change15m < -0.15 &&
        trend < 0
      ) {
        decision = 'SHORT';
        confidence = 0.62;
        reasons.push('HIGH_BB_BREAKDOWN_SHORT');
      }
    }
    
    // Stratégie 4: PULLBACK dans fort trend
    if (decision === 'NO_TRADE' && Math.abs(htfTrend) > 0.8 && volumeRatio >= 1.3) {
      if (
        htfTrend > 0.8 &&
        trendAlignment === 1 &&
        rsi14 >= 40 && rsi14 <= 55 &&
        bbPosition >= 0.3 && bbPosition <= 0.6 &&
        cmf20 > 0.03 &&
        isBullishCandle
      ) {
        decision = 'LONG';
        confidence = 0.60;
        reasons.push('HIGH_PULLBACK_LONG');
      }
      else if (
        htfTrend < -0.8 &&
        trendAlignment === -1 &&
        rsi14 >= 45 && rsi14 <= 60 &&
        bbPosition >= 0.4 && bbPosition <= 0.7 &&
        cmf20 < -0.03 &&
        isBearishCandle
      ) {
        decision = 'SHORT';
        confidence = 0.62;
        reasons.push('HIGH_PULLBACK_SHORT');
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // FILTRES UNIVERSELS
  // ═══════════════════════════════════════════════════════════════
  
  if (decision === 'LONG' && rsi14 > 75) confidence -= 0.12;
  if (decision === 'SHORT' && rsi14 < 25) confidence -= 0.12;
  
  if (decision !== 'NO_TRADE' && volumeRatio >= 3.0) {
    confidence += 0.05;
    reasons.push('EXCEPTIONAL_VOLUME');
  }
  
  // Seuils identiques à V4
  const minConfidence = volatilityRegime === 'LOW' ? 0.60 
    : volatilityRegime === 'MEDIUM' ? 0.58 
    : 0.58;
  
  if (confidence < minConfidence) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['LOW_CONFIDENCE'], strategy, riskMultiplier };
  }
  
  return { decision, confidence, reasons, strategy, riskMultiplier };
}

// Simulate trade with regime-adapted stops
function simulateTrade(ind, futureCandles, side, atrPct) {
  if (!futureCandles || futureCandles.length < 10) return null;
  
  const entryPrice = ind.last;
  const { volatilityRegime } = ind;
  
  // Adapter les stops/TP selon le régime
  let stopMult, tp1Mult, tp2Mult, maxHold;
  
  if (volatilityRegime === 'LOW') {
    // Low vol: stops serrés, TP rapides
    stopMult = 1.0;
    tp1Mult = 1.2;
    tp2Mult = 2.0;
    maxHold = 48;  // 12h max
  } else if (volatilityRegime === 'MEDIUM') {
    // Medium vol: stops moyens
    stopMult = 1.3;
    tp1Mult = 1.8;
    tp2Mult = 3.0;
    maxHold = 64;  // 16h max
  } else {
    // High vol: stops larges, TP ambitieux
    stopMult = 1.5;
    tp1Mult = 2.2;
    tp2Mult = 4.0;
    maxHold = 96;  // 24h max
  }
  
  const stopDistance = atrPct * stopMult;
  const tp1Distance = atrPct * tp1Mult;
  const tp2Distance = atrPct * tp2Mult;
  
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
  
  for (let i = 0; i < futureCandles.length && i < maxHold; i++) {
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
      const trailMult = volatilityRegime === 'LOW' ? 0.3 : volatilityRegime === 'MEDIUM' ? 0.4 : 0.5;
      const trailingStop = side === 'LONG' 
        ? tp1Price - (stopDistance * trailMult * entryPrice / 100)
        : tp1Price + (stopDistance * trailMult * entryPrice / 100);
      
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
  
  return { side, pnlPct, exitReason, holdBars, volatilityRegime };
}

// Run backtest
async function backtestSymbol(symbol, candles) {
  const trades = [];
  let equity = CONFIG.equityUsd;
  let peakEquity = equity;
  let maxDrawdown = 0;
  
  // Track by regime
  const byRegime = {
    LOW: { wins: 0, losses: 0, pnl: 0 },
    MEDIUM: { wins: 0, losses: 0, pnl: 0 },
    HIGH: { wins: 0, losses: 0, pnl: 0 },
  };
  
  const lookback = 100;
  
  for (let i = lookback; i < candles.length - 96; i++) {
    const historyCandles = candles.slice(i - lookback, i + 1);
    const futureCandles = candles.slice(i + 1, i + 97);
    
    const indicators = calculateIndicators(historyCandles);
    if (!indicators) continue;
    
    const { decision, confidence, reasons, strategy } = makeAdaptiveDecision(indicators);
    
    if (decision === 'NO_TRADE') continue;
    
    const result = simulateTrade(indicators, futureCandles, decision, indicators.atrPct);
    if (!result) continue;
    
    // Position sizing
    const riskAmount = equity * CONFIG.riskPerTrade;
    const stopMult = result.volatilityRegime === 'LOW' ? 1.0 : result.volatilityRegime === 'MEDIUM' ? 1.3 : 1.5;
    const stopDistance = indicators.atrPct * stopMult;
    const positionSize = riskAmount / (indicators.last * (stopDistance / 100));
    const pnlUsd = positionSize * indicators.last * (result.pnlPct / 100);
    equity += pnlUsd;
    
    // Track regime stats
    const regime = result.volatilityRegime;
    if (result.pnlPct > 0) byRegime[regime].wins++;
    else byRegime[regime].losses++;
    byRegime[regime].pnl += result.pnlPct;
    
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = (peakEquity - equity) / peakEquity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    
    trades.push({
      timestamp: new Date(indicators.timestamp).toISOString(),
      ...result,
      reasons: reasons.join(', '),
      strategy,
      confidence,
    });
    
    // Skip after trade
    const skipMult = result.volatilityRegime === 'LOW' ? 0.5 : result.volatilityRegime === 'MEDIUM' ? 0.6 : 0.7;
    i += Math.max(4, Math.floor(result.holdBars * skipMult));
  }
  
  return { symbol, trades, equity, maxDrawdown, byRegime };
}

// Main
async function main() {
  console.log('═'.repeat(80));
  console.log('📊 STRATÉGIE ADAPTATIVE PAR VOLATILITÉ - Backtest 60 jours');
  console.log('═'.repeat(80));
  console.log(`📅 Période: ${CONFIG.days} jours`);
  console.log(`💰 Capital: $${CONFIG.equityUsd.toLocaleString()}`);
  console.log('═'.repeat(80));
  
  const allResults = [];
  let totalTrades = 0;
  let totalWins = 0;
  let combinedEquity = 0;
  
  const globalByRegime = {
    LOW: { wins: 0, losses: 0, pnl: 0 },
    MEDIUM: { wins: 0, losses: 0, pnl: 0 },
    HIGH: { wins: 0, losses: 0, pnl: 0 },
  };
  
  for (const symbol of CONFIG.symbols) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🔍 ${symbol}`);
    console.log('─'.repeat(60));
    
    const candles = await fetchHistoricalData(symbol, CONFIG.timeframe, CONFIG.days);
    if (candles.length < 200) continue;
    
    const result = await backtestSymbol(symbol, candles);
    allResults.push(result);
    
    // Aggregate regime stats
    for (const regime of ['LOW', 'MEDIUM', 'HIGH']) {
      globalByRegime[regime].wins += result.byRegime[regime].wins;
      globalByRegime[regime].losses += result.byRegime[regime].losses;
      globalByRegime[regime].pnl += result.byRegime[regime].pnl;
    }
    
    const wins = result.trades.filter(t => t.pnlPct > 0).length;
    const losses = result.trades.filter(t => t.pnlPct < 0).length;
    const winRate = result.trades.length > 0 ? (wins / result.trades.length) * 100 : 0;
    const totalReturn = ((result.equity - CONFIG.equityUsd) / CONFIG.equityUsd) * 100;
    
    totalTrades += result.trades.length;
    totalWins += wins;
    combinedEquity += result.equity - CONFIG.equityUsd;
    
    console.log(`   Trades: ${result.trades.length} | WR: ${winRate.toFixed(1)}% | Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`);
    console.log(`   Max DD: ${(result.maxDrawdown * 100).toFixed(2)}% | Final: $${result.equity.toFixed(2)}`);
    
    // Show regime breakdown
    console.log(`   📊 Par régime:`);
    for (const regime of ['LOW', 'MEDIUM', 'HIGH']) {
      const r = result.byRegime[regime];
      const total = r.wins + r.losses;
      const wr = total > 0 ? (r.wins / total * 100).toFixed(0) : 0;
      console.log(`      ${regime}: ${total} trades, ${wr}% WR, ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}%`);
    }
  }
  
  // Aggregate results
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS AGRÉGÉS (60 jours)');
  console.log('═'.repeat(80));
  
  const overallWinRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  const combinedReturn = (combinedEquity / CONFIG.equityUsd) * 100;
  
  console.log(`\n   Total Trades: ${totalTrades}`);
  console.log(`   Overall Win Rate: ${overallWinRate.toFixed(1)}%`);
  console.log(`   Combined Return: ${combinedReturn >= 0 ? '+' : ''}${combinedReturn.toFixed(2)}%`);
  
  // Global regime breakdown
  console.log('\n📊 PERFORMANCE PAR RÉGIME DE VOLATILITÉ:');
  console.log('─'.repeat(60));
  for (const regime of ['LOW', 'MEDIUM', 'HIGH']) {
    const r = globalByRegime[regime];
    const total = r.wins + r.losses;
    const wr = total > 0 ? (r.wins / total * 100).toFixed(1) : 0;
    const avgPnl = total > 0 ? (r.pnl / total).toFixed(3) : 0;
    console.log(`   ${regime.padEnd(6)}: ${String(total).padStart(3)} trades | ${String(wr).padStart(5)}% WR | ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2).padStart(7)}% | Avg: ${avgPnl}%`);
  }
  
  // Comparison
  console.log('\n' + '─'.repeat(80));
  console.log('📊 COMPARAISON');
  console.log('─'.repeat(80));
  console.log(`
┌─────────────────────┬─────────────┬──────────────┬─────────────┐
│      Stratégie      │   Trades    │   Win Rate   │   Return    │
├─────────────────────┼─────────────┼──────────────┼─────────────┤
│ 🔴 Originale        │     290     │    33.8%     │   -7.77%    │
│ 🟡 Ultra-Sélective  │      23     │    56.5%     │   +5.48%    │
│ 🟢 Adaptative       │     ${String(totalTrades).padStart(3)}     │    ${overallWinRate.toFixed(1).padStart(4)}%     │   ${combinedReturn >= 0 ? '+' : ''}${combinedReturn.toFixed(2).padStart(5)}%    │
└─────────────────────┴─────────────┴──────────────┴─────────────┘
  `);
  
  // Monthly estimate
  console.log('📅 Estimation mensuelle:');
  const monthlyReturn = combinedReturn / 2;
  const monthlyTrades = totalTrades / 2;
  console.log(`   Trades/mois: ~${Math.round(monthlyTrades)}`);
  console.log(`   Return/mois: ${monthlyReturn >= 0 ? '+' : ''}${monthlyReturn.toFixed(2)}%`);
  
  console.log('\n' + '═'.repeat(80));
  console.log('✅ BACKTEST TERMINÉ');
  console.log('═'.repeat(80));
}

main().catch(console.error);
