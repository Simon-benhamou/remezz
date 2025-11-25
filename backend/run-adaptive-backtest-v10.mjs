#!/usr/bin/env node
/**
 * 📊 STRATÉGIE ADAPTATIVE V10 - RÉGIME DE MARCHÉ GLOBAL
 * 
 * OBJECTIF: Chaque mois doit être positif
 * 
 * INNOVATION: Détection du régime de marché GLOBAL
 * - TRENDING: Marché directionnel → Trade momentum
 * - RANGING: Marché sans direction → Trade mean-reversion ou skip
 * - CHOPPY: Marché chaotique → NE PAS TRADER
 * 
 * Le problème d'Août-Sept 2025: Marché choppy, beaucoup de faux signaux
 * → Solution: Détecter et éviter ces périodes
 */

import ccxt from 'ccxt';

const CONFIG = {
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
  timeframe: '15m',
  days: 120,
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

// Helper functions
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

/**
 * 🎯 DÉTECTION DU RÉGIME DE MARCHÉ GLOBAL
 * 
 * Analyse sur les 7 derniers jours (672 candles de 15min)
 * pour déterminer si le marché est favorable au trading
 */
function detectMarketRegime(candles, lookback = 672) {
  if (candles.length < lookback) return { regime: 'UNKNOWN', tradeable: false };
  
  const recentCandles = candles.slice(-lookback);
  const closes = recentCandles.map(c => c[4]);
  const highs = recentCandles.map(c => c[2]);
  const lows = recentCandles.map(c => c[3]);
  
  // 1. TREND STRENGTH - Est-ce que le marché a une direction claire?
  const startPrice = closes[0];
  const endPrice = closes[closes.length - 1];
  const netMove = ((endPrice - startPrice) / startPrice) * 100;
  const absNetMove = Math.abs(netMove);
  
  // 2. VOLATILITY - Quelle est la volatilité moyenne?
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.abs((closes[i] - closes[i-1]) / closes[i-1]) * 100);
  }
  const avgVolatility = returns.reduce((a, b) => a + b, 0) / returns.length;
  
  // 3. EFFICIENCY RATIO - Mouvement net vs mouvement total
  // Si ER proche de 1 = trending, si proche de 0 = choppy
  let totalMove = 0;
  for (let i = 1; i < closes.length; i++) {
    totalMove += Math.abs(closes[i] - closes[i-1]);
  }
  const netMoveAbs = Math.abs(closes[closes.length - 1] - closes[0]);
  const efficiencyRatio = totalMove > 0 ? netMoveAbs / totalMove : 0;
  
  // 4. HIGHER HIGHS / LOWER LOWS - Structure de marché
  const periodLength = Math.floor(lookback / 7); // 7 périodes de ~1 jour
  let higherHighs = 0;
  let lowerLows = 0;
  let prevHigh = Math.max(...highs.slice(0, periodLength));
  let prevLow = Math.min(...lows.slice(0, periodLength));
  
  for (let i = 1; i < 7; i++) {
    const start = i * periodLength;
    const end = Math.min((i + 1) * periodLength, highs.length);
    const periodHigh = Math.max(...highs.slice(start, end));
    const periodLow = Math.min(...lows.slice(start, end));
    
    if (periodHigh > prevHigh) higherHighs++;
    if (periodLow < prevLow) lowerLows++;
    
    prevHigh = periodHigh;
    prevLow = periodLow;
  }
  
  // 5. ADX moyen - Force de la tendance
  const { adx: adxArr } = adx(highs, lows, closes, 14);
  const avgADX = adxArr.slice(-96).reduce((a, b) => a + b, 0) / 96; // Dernières 24h
  
  // 6. RSI mean reversion - RSI trop volatile = choppy
  const rsiArr = rsi(closes, 14);
  const recentRsi = rsiArr.slice(-96);
  const rsiStd = Math.sqrt(
    recentRsi.reduce((sum, val) => {
      const mean = recentRsi.reduce((a, b) => a + b, 0) / recentRsi.length;
      return sum + Math.pow(val - mean, 2);
    }, 0) / recentRsi.length
  );
  
  // 7. Win probability estimation
  // Compte combien de "trades hypothétiques" auraient gagné
  let hypotheticalWins = 0;
  let hypotheticalLosses = 0;
  
  for (let i = 100; i < closes.length - 20; i += 20) {
    const entryPrice = closes[i];
    const futureHigh = Math.max(...highs.slice(i + 1, i + 20));
    const futureLow = Math.min(...lows.slice(i + 1, i + 20));
    const futureClose = closes[Math.min(i + 19, closes.length - 1)];
    
    // Long hypothétique
    const longProfit = (futureHigh - entryPrice) / entryPrice * 100;
    const longLoss = (entryPrice - futureLow) / entryPrice * 100;
    
    if (longProfit > longLoss * 1.5) hypotheticalWins++;
    else if (longLoss > longProfit * 1.2) hypotheticalLosses++;
  }
  
  const hypotheticalWR = hypotheticalWins + hypotheticalLosses > 0 
    ? hypotheticalWins / (hypotheticalWins + hypotheticalLosses) 
    : 0.5;
  
  // CLASSIFICATION DU RÉGIME
  let regime, tradeable, confidence, reason;
  
  // TRENDING UP - Forte tendance haussière
  if (
    netMove > 3 &&
    efficiencyRatio > 0.15 &&
    avgADX > 22 &&
    higherHighs >= 3
  ) {
    regime = 'TRENDING_UP';
    tradeable = true;
    confidence = Math.min(0.9, 0.6 + efficiencyRatio + (avgADX - 20) / 100);
    reason = `Strong uptrend: +${netMove.toFixed(1)}%, ER=${efficiencyRatio.toFixed(2)}, ADX=${avgADX.toFixed(0)}`;
  }
  // TRENDING DOWN - Forte tendance baissière
  else if (
    netMove < -3 &&
    efficiencyRatio > 0.15 &&
    avgADX > 22 &&
    lowerLows >= 3
  ) {
    regime = 'TRENDING_DOWN';
    tradeable = true;
    confidence = Math.min(0.9, 0.6 + efficiencyRatio + (avgADX - 20) / 100);
    reason = `Strong downtrend: ${netMove.toFixed(1)}%, ER=${efficiencyRatio.toFixed(2)}, ADX=${avgADX.toFixed(0)}`;
  }
  // HIGH VOLATILITY MOMENTUM - Marché très volatile mais avec direction
  else if (
    avgVolatility > 0.5 &&
    absNetMove > 2 &&
    efficiencyRatio > 0.10 &&
    hypotheticalWR > 0.45
  ) {
    regime = 'HIGH_VOL_MOMENTUM';
    tradeable = true;
    confidence = 0.55 + hypotheticalWR * 0.3;
    reason = `High vol momentum: vol=${avgVolatility.toFixed(2)}%, net=${netMove.toFixed(1)}%, hypWR=${(hypotheticalWR*100).toFixed(0)}%`;
  }
  // RANGING - Marché en range, faible volatilité
  else if (
    avgVolatility < 0.35 &&
    absNetMove < 2 &&
    avgADX < 20
  ) {
    regime = 'RANGING';
    tradeable = false;  // Trop risqué
    confidence = 0.3;
    reason = `Low vol range: vol=${avgVolatility.toFixed(2)}%, net=${netMove.toFixed(1)}%, ADX=${avgADX.toFixed(0)}`;
  }
  // CHOPPY - Marché chaotique, à éviter
  else if (
    efficiencyRatio < 0.08 ||
    rsiStd > 15 ||
    hypotheticalWR < 0.35
  ) {
    regime = 'CHOPPY';
    tradeable = false;
    confidence = 0.2;
    reason = `Choppy: ER=${efficiencyRatio.toFixed(2)}, RSI_std=${rsiStd.toFixed(1)}, hypWR=${(hypotheticalWR*100).toFixed(0)}%`;
  }
  // NEUTRAL - Pas assez d'info, prudence
  else {
    regime = 'NEUTRAL';
    tradeable = avgADX > 18 && hypotheticalWR > 0.42;
    confidence = 0.4 + hypotheticalWR * 0.2;
    reason = `Neutral: ADX=${avgADX.toFixed(0)}, ER=${efficiencyRatio.toFixed(2)}, hypWR=${(hypotheticalWR*100).toFixed(0)}%`;
  }
  
  return {
    regime,
    tradeable,
    confidence,
    reason,
    metrics: {
      netMove,
      avgVolatility,
      efficiencyRatio,
      avgADX,
      higherHighs,
      lowerLows,
      rsiStd,
      hypotheticalWR,
    },
  };
}

// Calculate indicators (identique à V8)
function calculateIndicators(candles) {
  if (candles.length < 100) return null;
  
  const closes = candles.map(c => c[4]);
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const volumes = candles.map(c => c[5]);
  const last = closes[closes.length - 1];
  const timestamp = candles[candles.length - 1][0];
  
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
  
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.abs(closes[i] - closes[i-1]) / closes[i-1] * 100);
  }
  const avgReturn = returns.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const recentReturn = returns.slice(-10).reduce((a, b) => a + b, 0) / 10;
  
  let volatilityRegime;
  if (avgReturn > 0.5 || recentReturn > 0.6) {
    volatilityRegime = 'HIGH';
  } else if (avgReturn > 0.25 || recentReturn > 0.35) {
    volatilityRegime = 'MEDIUM';
  } else {
    volatilityRegime = 'LOW';
  }
  
  const currentCandle = candles[candles.length - 1];
  const candleBody = Math.abs(currentCandle[4] - currentCandle[1]);
  const candleRange = currentCandle[2] - currentCandle[3];
  const bodyRatio = candleRange > 0 ? candleBody / candleRange : 0;
  
  const htfTrend = (closes[closes.length - 1] - closes[closes.length - 17]) / closes[closes.length - 17] * 100;
  
  const change15m = (last - closes[closes.length - 2]) / closes[closes.length - 2] * 100;
  const change1h = (last - closes[closes.length - 5]) / closes[closes.length - 5] * 100;
  const change4h = (last - closes[closes.length - 17]) / closes[closes.length - 17] * 100;
  
  const ema9 = ema9Arr[ema9Arr.length - 1];
  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema50 = ema50Arr[ema50Arr.length - 1];
  const bb = bbArr[bbArr.length - 1];
  
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
    volatilityRegime,
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
  };
}

/**
 * 🎯 STRATÉGIE ADAPTATIVE V10 - BASÉE SUR LE RÉGIME DE MARCHÉ
 */
function makeAdaptiveDecision(ind, marketRegime) {
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
  
  // ═══════════════════════════════════════════════════════════════
  // FILTRE GLOBAL: Ne pas trader si marché défavorable
  // ═══════════════════════════════════════════════════════════════
  if (!marketRegime.tradeable) {
    return { 
      decision: 'NO_TRADE', 
      confidence: 0, 
      reasons: [`SKIP_${marketRegime.regime}`], 
      strategy: 'REGIME_FILTER',
      riskMultiplier: 0,
    };
  }
  
  // ═══════════════════════════════════════════════════════════════
  // RÉGIME: TRENDING UP - Favoriser les LONGS
  // ═══════════════════════════════════════════════════════════════
  if (marketRegime.regime === 'TRENDING_UP') {
    strategy = 'TREND_FOLLOW_UP';
    riskMultiplier = 1.2;  // Plus de risque dans tendance claire
    
    // LONG: Pullback dans uptrend
    if (
      trendAlignment === 1 &&
      rsi14 >= 40 && rsi14 <= 60 &&
      bbPosition >= 0.3 && bbPosition <= 0.65 &&
      cmf20 > 0.02 &&
      volumeRatio >= 1.1 &&
      isBullishCandle &&
      change15m > 0
    ) {
      decision = 'LONG';
      confidence = 0.65 + marketRegime.confidence * 0.1;
      reasons.push('TREND_PULLBACK_LONG');
      
      if (emaStack === 1) confidence += 0.05;
      if (adx14 >= 25) confidence += 0.03;
    }
    // LONG: Breakout continuation
    else if (
      change1h > 0.4 &&
      cmf20 > 0.05 &&
      trend > 0 &&
      volumeRatio >= 1.5 &&
      isBullishCandle &&
      bodyRatio >= 0.5
    ) {
      decision = 'LONG';
      confidence = 0.62 + marketRegime.confidence * 0.1;
      reasons.push('TREND_BREAKOUT_LONG');
    }
    
    // SHORT: ÉVITER dans uptrend sauf conditions extrêmes
    // (pas de short dans ce régime)
  }
  
  // ═══════════════════════════════════════════════════════════════
  // RÉGIME: TRENDING DOWN - Favoriser les SHORTS
  // ═══════════════════════════════════════════════════════════════
  else if (marketRegime.regime === 'TRENDING_DOWN') {
    strategy = 'TREND_FOLLOW_DOWN';
    riskMultiplier = 1.2;
    
    // SHORT: Pullback dans downtrend
    if (
      trendAlignment === -1 &&
      rsi14 >= 40 && rsi14 <= 60 &&
      bbPosition >= 0.35 && bbPosition <= 0.7 &&
      cmf20 < -0.02 &&
      volumeRatio >= 1.1 &&
      isBearishCandle &&
      change15m < 0
    ) {
      decision = 'SHORT';
      confidence = 0.67 + marketRegime.confidence * 0.1;
      reasons.push('TREND_PULLBACK_SHORT');
      
      if (emaStack === -1) confidence += 0.05;
      if (adx14 >= 25) confidence += 0.03;
    }
    // SHORT: Breakdown continuation
    else if (
      change1h < -0.4 &&
      cmf20 < -0.05 &&
      trend < 0 &&
      volumeRatio >= 1.5 &&
      isBearishCandle &&
      bodyRatio >= 0.5
    ) {
      decision = 'SHORT';
      confidence = 0.64 + marketRegime.confidence * 0.1;
      reasons.push('TREND_BREAKDOWN_SHORT');
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // RÉGIME: HIGH VOL MOMENTUM - Momentum agressif
  // ═══════════════════════════════════════════════════════════════
  else if (marketRegime.regime === 'HIGH_VOL_MOMENTUM') {
    strategy = 'HIGH_VOL_MOMENTUM';
    riskMultiplier = 0.8;  // Réduire risque car plus volatile
    
    // Momentum LONG
    if (
      change1h >= 0.5 &&
      cmf20 > 0.05 &&
      trend > 0 &&
      volumeRatio >= 1.6 &&
      isBullishCandle &&
      bodyRatio >= 0.5 &&
      adx14 >= 20
    ) {
      decision = 'LONG';
      confidence = 0.60;
      reasons.push('MOMENTUM_BURST_LONG');
      
      if (trendAlignment === 1) confidence += 0.06;
      if (volumeRatio >= 2.5) confidence += 0.05;
    }
    // Momentum SHORT
    else if (
      change1h <= -0.5 &&
      cmf20 < -0.05 &&
      trend < 0 &&
      volumeRatio >= 1.6 &&
      isBearishCandle &&
      bodyRatio >= 0.5 &&
      adx14 >= 20
    ) {
      decision = 'SHORT';
      confidence = 0.62;
      reasons.push('MOMENTUM_BURST_SHORT');
      
      if (trendAlignment === -1) confidence += 0.06;
      if (volumeRatio >= 2.5) confidence += 0.05;
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // RÉGIME: NEUTRAL - Très sélectif
  // ═══════════════════════════════════════════════════════════════
  else if (marketRegime.regime === 'NEUTRAL') {
    strategy = 'NEUTRAL_SELECTIVE';
    riskMultiplier = 0.5;  // Réduire risque significativement
    
    // Seulement les setups parfaits
    if (
      adx14 >= 28 &&
      volumeRatio >= 2.0 &&
      bodyRatio >= 0.6 &&
      Math.abs(change1h) >= 0.5
    ) {
      if (
        trendAlignment === 1 &&
        cmf20 > 0.08 &&
        diPlus > diMinus * 1.4 &&
        isBullishCandle
      ) {
        decision = 'LONG';
        confidence = 0.58;
        reasons.push('NEUTRAL_STRONG_SIGNAL_LONG');
      }
      else if (
        trendAlignment === -1 &&
        cmf20 < -0.08 &&
        diMinus > diPlus * 1.4 &&
        isBearishCandle
      ) {
        decision = 'SHORT';
        confidence = 0.60;
        reasons.push('NEUTRAL_STRONG_SIGNAL_SHORT');
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // FILTRES UNIVERSELS
  // ═══════════════════════════════════════════════════════════════
  
  if (decision === 'LONG' && rsi14 > 72) confidence -= 0.10;
  if (decision === 'SHORT' && rsi14 < 28) confidence -= 0.10;
  
  if (decision !== 'NO_TRADE' && volumeRatio >= 3.0) {
    confidence += 0.04;
    reasons.push('EXCEPTIONAL_VOLUME');
  }
  
  // Seuil minimum selon le régime
  const minConfidence = marketRegime.regime.includes('TRENDING') ? 0.55
    : marketRegime.regime === 'HIGH_VOL_MOMENTUM' ? 0.58
    : 0.55;
  
  if (confidence < minConfidence) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['LOW_CONFIDENCE'], strategy, riskMultiplier };
  }
  
  return { decision, confidence, reasons, strategy, riskMultiplier };
}

// Simulate trade (identique)
function simulateTrade(ind, futureCandles, side, atrPct, marketRegime) {
  if (!futureCandles || futureCandles.length < 10) return null;
  
  const entryPrice = ind.last;
  const { volatilityRegime } = ind;
  
  // Adapter les stops selon le régime de marché
  let stopMult, tp1Mult, tp2Mult, maxHold;
  
  if (marketRegime.regime.includes('TRENDING')) {
    // Tendance: stops larges, laisser courir
    stopMult = 1.6;
    tp1Mult = 2.5;
    tp2Mult = 4.5;
    maxHold = 96;
  } else if (marketRegime.regime === 'HIGH_VOL_MOMENTUM') {
    // Momentum: stops moyens, TP rapides
    stopMult = 1.4;
    tp1Mult = 2.0;
    tp2Mult = 3.5;
    maxHold = 64;
  } else {
    // Neutral: stops serrés
    stopMult = 1.2;
    tp1Mult = 1.8;
    tp2Mult = 2.8;
    maxHold = 48;
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
    
    if (!hitTp1) {
      if ((side === 'LONG' && high >= tp1Price) || (side === 'SHORT' && low <= tp1Price)) {
        hitTp1 = true;
      }
    }
    
    if (hitTp1) {
      const trailMult = marketRegime.regime.includes('TRENDING') ? 0.6 : 0.4;
      const trailingStop = side === 'LONG' 
        ? tp1Price - (stopDistance * trailMult * entryPrice / 100)
        : tp1Price + (stopDistance * trailMult * entryPrice / 100);
      
      if ((side === 'LONG' && low <= trailingStop) || (side === 'SHORT' && high >= trailingStop)) {
        exitPrice = trailingStop;
        exitReason = 'TRAILING_STOP_AFTER_TP1';
        break;
      }
    }
    
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
  
  return { side, pnlPct, exitReason, holdBars, volatilityRegime, marketRegime: marketRegime.regime };
}

// Backtest
async function backtestSymbol(symbol, candles) {
  const trades = [];
  let equity = CONFIG.equityUsd;
  let peakEquity = equity;
  let maxDrawdown = 0;
  
  const byRegime = {
    TRENDING_UP: { wins: 0, losses: 0, pnl: 0 },
    TRENDING_DOWN: { wins: 0, losses: 0, pnl: 0 },
    HIGH_VOL_MOMENTUM: { wins: 0, losses: 0, pnl: 0 },
    NEUTRAL: { wins: 0, losses: 0, pnl: 0 },
    SKIP: { count: 0 },
  };
  
  const lookback = 100;
  const regimeLookback = 672; // 7 jours pour régime
  
  // Cache du régime de marché (recalculé toutes les 4h = 16 candles)
  let cachedMarketRegime = null;
  let lastRegimeUpdate = 0;
  
  for (let i = Math.max(lookback, regimeLookback); i < candles.length - 96; i++) {
    // Mettre à jour le régime toutes les 4h
    if (i - lastRegimeUpdate >= 16 || !cachedMarketRegime) {
      const regimeCandles = candles.slice(Math.max(0, i - regimeLookback), i + 1);
      cachedMarketRegime = detectMarketRegime(regimeCandles, regimeLookback);
      lastRegimeUpdate = i;
    }
    
    const historyCandles = candles.slice(i - lookback, i + 1);
    const futureCandles = candles.slice(i + 1, i + 97);
    
    const indicators = calculateIndicators(historyCandles);
    if (!indicators) continue;
    
    const { decision, confidence, reasons, strategy, riskMultiplier } = makeAdaptiveDecision(indicators, cachedMarketRegime);
    
    if (decision === 'NO_TRADE') {
      if (reasons[0]?.startsWith('SKIP_')) {
        byRegime.SKIP.count++;
      }
      continue;
    }
    
    const result = simulateTrade(indicators, futureCandles, decision, indicators.atrPct, cachedMarketRegime);
    if (!result) continue;
    
    // Position sizing
    const riskAmount = equity * CONFIG.riskPerTrade * riskMultiplier;
    const stopMult = cachedMarketRegime.regime.includes('TRENDING') ? 1.6 : 1.4;
    const stopDistance = indicators.atrPct * stopMult;
    const positionSize = riskAmount / (indicators.last * (stopDistance / 100));
    const pnlUsd = positionSize * indicators.last * (result.pnlPct / 100);
    equity += pnlUsd;
    
    // Track regime stats
    const regimeKey = result.marketRegime;
    if (byRegime[regimeKey]) {
      if (result.pnlPct > 0) byRegime[regimeKey].wins++;
      else byRegime[regimeKey].losses++;
      byRegime[regimeKey].pnl += result.pnlPct;
    }
    
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = (peakEquity - equity) / peakEquity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    
    trades.push({
      timestamp: indicators.timestamp,
      date: new Date(indicators.timestamp),
      symbol,
      side: result.side,
      pnlPct: result.pnlPct,
      pnlUsd,
      equity,
      volatilityRegime: result.volatilityRegime,
      marketRegime: result.marketRegime,
      strategy,
      confidence,
    });
    
    // Skip after trade
    const skipMult = cachedMarketRegime.regime.includes('TRENDING') ? 0.6 : 0.5;
    i += Math.max(4, Math.floor(result.holdBars * skipMult));
  }
  
  return { symbol, trades, equity, maxDrawdown, byRegime };
}

// Main
async function main() {
  console.log('═'.repeat(80));
  console.log('📊 STRATÉGIE ADAPTATIVE V10 - RÉGIME DE MARCHÉ GLOBAL');
  console.log('═'.repeat(80));
  console.log(`📅 Période: ${CONFIG.days} jours (${Math.round(CONFIG.days/30)} mois)`);
  console.log(`💰 Capital: $${CONFIG.equityUsd.toLocaleString()}`);
  console.log('═'.repeat(80));
  
  const allTrades = [];
  const globalByRegime = {
    TRENDING_UP: { wins: 0, losses: 0, pnl: 0 },
    TRENDING_DOWN: { wins: 0, losses: 0, pnl: 0 },
    HIGH_VOL_MOMENTUM: { wins: 0, losses: 0, pnl: 0 },
    NEUTRAL: { wins: 0, losses: 0, pnl: 0 },
    SKIP: { count: 0 },
  };
  
  for (const symbol of CONFIG.symbols) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🔍 ${symbol}`);
    console.log('─'.repeat(60));
    
    const candles = await fetchHistoricalData(symbol, CONFIG.timeframe, CONFIG.days);
    if (candles.length < 700) continue;
    
    const result = await backtestSymbol(symbol, candles);
    allTrades.push(...result.trades);
    
    // Aggregate regime stats
    for (const regime of ['TRENDING_UP', 'TRENDING_DOWN', 'HIGH_VOL_MOMENTUM', 'NEUTRAL']) {
      globalByRegime[regime].wins += result.byRegime[regime].wins;
      globalByRegime[regime].losses += result.byRegime[regime].losses;
      globalByRegime[regime].pnl += result.byRegime[regime].pnl;
    }
    globalByRegime.SKIP.count += result.byRegime.SKIP.count;
    
    const wins = result.trades.filter(t => t.pnlPct > 0).length;
    const winRate = result.trades.length > 0 ? (wins / result.trades.length) * 100 : 0;
    const totalReturn = ((result.equity - CONFIG.equityUsd) / CONFIG.equityUsd) * 100;
    
    console.log(`   Trades: ${result.trades.length} | WR: ${winRate.toFixed(1)}% | Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`);
  }
  
  // Sort by timestamp
  allTrades.sort((a, b) => a.timestamp - b.timestamp);
  
  // Group by month
  const monthlyResults = {};
  
  for (const trade of allTrades) {
    const monthKey = `${trade.date.getFullYear()}-${String(trade.date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!monthlyResults[monthKey]) {
      monthlyResults[monthKey] = { trades: [], wins: 0, losses: 0, totalPnl: 0, totalPnlUsd: 0 };
    }
    
    monthlyResults[monthKey].trades.push(trade);
    if (trade.pnlPct > 0) monthlyResults[monthKey].wins++;
    else monthlyResults[monthKey].losses++;
    monthlyResults[monthKey].totalPnl += trade.pnlPct;
    monthlyResults[monthKey].totalPnlUsd += trade.pnlUsd;
  }
  
  // Display monthly results
  console.log('\n' + '═'.repeat(80));
  console.log('📅 PERFORMANCE MOIS PAR MOIS');
  console.log('═'.repeat(80));
  
  const months = Object.keys(monthlyResults).sort();
  let cumulativeCapital = CONFIG.equityUsd;
  let allPositive = true;
  
  console.log(`
┌───────────┬────────┬────────┬───────────┬────────────────┬──────────────┐
│   Mois    │ Trades │   WR   │  Return   │     PnL ($)    │  Capital     │
├───────────┼────────┼────────┼───────────┼────────────────┼──────────────┤`);
  
  for (const month of months) {
    const data = monthlyResults[month];
    const totalTrades = data.wins + data.losses;
    const winRate = totalTrades > 0 ? (data.wins / totalTrades * 100) : 0;
    
    const monthlyReturn = (data.totalPnlUsd / cumulativeCapital) * 100;
    cumulativeCapital += data.totalPnlUsd;
    
    const isPositive = monthlyReturn >= 0;
    if (!isPositive) allPositive = false;
    
    const icon = isPositive ? '✅' : '❌';
    
    console.log(`│ ${month} │ ${String(totalTrades).padStart(6)} │ ${winRate.toFixed(1).padStart(5)}% │ ${icon} ${monthlyReturn >= 0 ? '+' : ''}${monthlyReturn.toFixed(2).padStart(5)}% │ ${data.totalPnlUsd >= 0 ? '+' : ''}$${data.totalPnlUsd.toFixed(0).padStart(12)} │ $${cumulativeCapital.toFixed(0).padStart(10)} │`);
  }
  
  console.log(`└───────────┴────────┴────────┴───────────┴────────────────┴──────────────┘`);
  
  // Regime breakdown
  console.log('\n' + '═'.repeat(80));
  console.log('📊 PERFORMANCE PAR RÉGIME DE MARCHÉ');
  console.log('═'.repeat(80));
  
  for (const regime of ['TRENDING_UP', 'TRENDING_DOWN', 'HIGH_VOL_MOMENTUM', 'NEUTRAL']) {
    const r = globalByRegime[regime];
    const total = r.wins + r.losses;
    const wr = total > 0 ? (r.wins / total * 100).toFixed(1) : 0;
    const avgPnl = total > 0 ? (r.pnl / total).toFixed(3) : 0;
    console.log(`   ${regime.padEnd(18)}: ${String(total).padStart(3)} trades | ${String(wr).padStart(5)}% WR | ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2).padStart(7)}% | Avg: ${avgPnl}%`);
  }
  console.log(`   ${'SKIPPED (BAD MKT)'.padEnd(18)}: ${globalByRegime.SKIP.count} opportunities filtered`);
  
  // Summary
  const totalTrades = allTrades.length;
  const totalWins = allTrades.filter(t => t.pnlPct > 0).length;
  const overallWinRate = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;
  const cumulativeReturn = ((cumulativeCapital - CONFIG.equityUsd) / CONFIG.equityUsd * 100);
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSUMÉ FINAL');
  console.log('═'.repeat(80));
  
  console.log(`\n   Total Trades: ${totalTrades}`);
  console.log(`   Win Rate Global: ${overallWinRate.toFixed(1)}%`);
  console.log(`   Return Total: ${cumulativeReturn >= 0 ? '+' : ''}${cumulativeReturn.toFixed(2)}%`);
  console.log(`   Capital Final: $${cumulativeCapital.toFixed(2)}`);
  
  const positiveMonths = months.filter(m => monthlyResults[m].totalPnlUsd >= 0).length;
  console.log(`\n   🎯 Mois positifs: ${positiveMonths}/${months.length}`);
  
  if (allPositive) {
    console.log(`\n   ✅ STABILITÉ VALIDÉE: Tous les mois sont positifs!`);
  } else {
    console.log(`\n   ⚠️ ATTENTION: Certains mois sont négatifs`);
    console.log(`   Mois négatifs: ${months.filter(m => monthlyResults[m].totalPnlUsd < 0).join(', ')}`);
  }
  
  const avgMonthlyReturn = cumulativeReturn / months.length;
  console.log(`\n   📈 Return Moyen/Mois: ${avgMonthlyReturn >= 0 ? '+' : ''}${avgMonthlyReturn.toFixed(2)}%`);
  
  console.log('\n' + '═'.repeat(80));
  console.log('✅ BACKTEST V10 TERMINÉ');
  console.log('═'.repeat(80));
}

main().catch(console.error);
