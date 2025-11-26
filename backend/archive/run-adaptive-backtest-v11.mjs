#!/usr/bin/env node
/**
 * 📊 STRATÉGIE ADAPTATIVE V11 - MARKET QUALITY SCORE
 * 
 * OBJECTIF: Chaque mois doit être positif
 * 
 * APPROCHE SIMPLE:
 * Au lieu de classifier en régimes complexes, on calcule un 
 * "Market Quality Score" (MQS) de 0-100 qui indique si c'est
 * un bon moment pour trader.
 * 
 * MQS < 30 → Ne pas trader (trop risqué)
 * MQS 30-50 → Trading minimal (risque réduit)
 * MQS 50-70 → Trading normal
 * MQS > 70 → Trading agressif
 * 
 * Le MQS est basé sur:
 * - Efficiency Ratio (direction vs noise)
 * - ADX (force de tendance)
 * - Volume consistency
 * - Win rate hypothétique récent
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
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  }
  return ema(tr, period);
}

function adx(highs, lows, closes, period = 14) {
  const tr = [], dmPlus = [], dmMinus = [];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
    const upMove = highs[i] - highs[i-1], downMove = lows[i-1] - lows[i];
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
 * 🎯 MARKET QUALITY SCORE (MQS)
 * Score de 0-100 indiquant la qualité du marché pour trader
 */
function calculateMQS(candles, lookback = 288) { // 3 jours
  if (candles.length < lookback) return { score: 0, tradeable: false, reason: 'Not enough data' };
  
  const recentCandles = candles.slice(-lookback);
  const closes = recentCandles.map(c => c[4]);
  const highs = recentCandles.map(c => c[2]);
  const lows = recentCandles.map(c => c[3]);
  const volumes = recentCandles.map(c => c[5]);
  
  let score = 50; // Start neutral
  let factors = [];
  
  // 1. EFFICIENCY RATIO (0-20 points)
  // High = trending, low = choppy
  let totalMove = 0;
  for (let i = 1; i < closes.length; i++) {
    totalMove += Math.abs(closes[i] - closes[i-1]);
  }
  const netMoveAbs = Math.abs(closes[closes.length - 1] - closes[0]);
  const efficiencyRatio = totalMove > 0 ? netMoveAbs / totalMove : 0;
  
  const erScore = Math.min(20, efficiencyRatio * 150);
  score += erScore - 10; // -10 to +10
  factors.push(`ER=${efficiencyRatio.toFixed(3)} (+${(erScore - 10).toFixed(0)})`);
  
  // 2. ADX STRENGTH (0-20 points)
  const { adx: adxArr } = adx(highs, lows, closes, 14);
  const recentADX = adxArr.slice(-48).reduce((a, b) => a + b, 0) / 48;
  
  const adxScore = recentADX > 30 ? 15 : recentADX > 22 ? 10 : recentADX > 15 ? 5 : 0;
  score += adxScore - 7.5;
  factors.push(`ADX=${recentADX.toFixed(1)} (+${(adxScore - 7.5).toFixed(0)})`);
  
  // 3. VOLATILITY QUALITY (0-15 points)
  // On veut de la volatilité MAIS pas trop
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.abs((closes[i] - closes[i-1]) / closes[i-1]) * 100);
  }
  const avgVol = returns.reduce((a, b) => a + b, 0) / returns.length;
  
  let volScore;
  if (avgVol >= 0.3 && avgVol <= 0.8) {
    volScore = 15; // Sweet spot
  } else if (avgVol >= 0.2 && avgVol <= 1.0) {
    volScore = 10;
  } else if (avgVol >= 0.15 || avgVol <= 1.2) {
    volScore = 5;
  } else {
    volScore = 0;
  }
  score += volScore - 7.5;
  factors.push(`VOL=${avgVol.toFixed(3)}% (+${(volScore - 7.5).toFixed(0)})`);
  
  // 4. VOLUME CONSISTENCY (0-10 points)
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  let volumeSpikes = 0;
  for (const v of volumes) {
    if (v > avgVolume * 1.5) volumeSpikes++;
  }
  const spikeRatio = volumeSpikes / volumes.length;
  
  const volConsScore = spikeRatio >= 0.1 && spikeRatio <= 0.3 ? 10 : spikeRatio > 0 ? 5 : 0;
  score += volConsScore - 5;
  factors.push(`VOL_SPIKES=${(spikeRatio*100).toFixed(0)}% (+${(volConsScore - 5).toFixed(0)})`);
  
  // 5. DIRECTIONAL BIAS (0-15 points)
  // On veut que le marché ait une direction
  const netMove = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  const absNetMove = Math.abs(netMove);
  
  const dirScore = absNetMove > 4 ? 15 : absNetMove > 2 ? 10 : absNetMove > 1 ? 5 : 0;
  score += dirScore - 7.5;
  factors.push(`DIR=${netMove.toFixed(2)}% (+${(dirScore - 7.5).toFixed(0)})`);
  
  // 6. RECENT WIN RATE SIMULATION (0-20 points)
  // Simule des trades courts pour voir si le marché "récompense" les bons setups
  let wins = 0;
  let losses = 0;
  
  for (let i = 50; i < closes.length - 16; i += 8) {
    const entry = closes[i];
    const futureHigh = Math.max(...highs.slice(i + 1, i + 16));
    const futureLow = Math.min(...lows.slice(i + 1, i + 16));
    
    const upPotential = (futureHigh - entry) / entry * 100;
    const downPotential = (entry - futureLow) / entry * 100;
    
    // Check if a momentum trade would work
    const prev4hChange = (closes[i] - closes[Math.max(0, i - 16)]) / closes[Math.max(0, i - 16)] * 100;
    
    if (prev4hChange > 0.3) {
      // Long signal
      if (upPotential > downPotential * 1.3) wins++;
      else if (downPotential > upPotential) losses++;
    } else if (prev4hChange < -0.3) {
      // Short signal
      if (downPotential > upPotential * 1.3) wins++;
      else if (upPotential > downPotential) losses++;
    }
  }
  
  const hypotheticalWR = wins + losses > 0 ? wins / (wins + losses) : 0.5;
  const wrScore = hypotheticalWR > 0.55 ? 20 : hypotheticalWR > 0.48 ? 12 : hypotheticalWR > 0.42 ? 6 : 0;
  score += wrScore - 10;
  factors.push(`HYP_WR=${(hypotheticalWR*100).toFixed(0)}% (+${(wrScore - 10).toFixed(0)})`);
  
  // Normalize score to 0-100
  score = Math.max(0, Math.min(100, score));
  
  // Determine tradeability
  let tradeable = score >= 40;
  let riskLevel = 'SKIP';
  
  if (score >= 65) {
    riskLevel = 'AGGRESSIVE';
  } else if (score >= 55) {
    riskLevel = 'NORMAL';
  } else if (score >= 40) {
    riskLevel = 'CONSERVATIVE';
  }
  
  return {
    score,
    tradeable,
    riskLevel,
    factors,
    metrics: {
      efficiencyRatio,
      recentADX,
      avgVol,
      netMove,
      hypotheticalWR,
    },
  };
}

// Calculate indicators
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
    last, timestamp, ema9, ema20, ema50,
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
    change15m, change1h, change4h, htfTrend, bodyRatio,
    isBullishCandle: currentCandle[4] > currentCandle[1],
    isBearishCandle: currentCandle[4] < currentCandle[1],
  };
}

/**
 * 🎯 STRATÉGIE ADAPTATIVE V11 - BASÉE SUR MQS
 */
function makeAdaptiveDecision(ind, mqs) {
  const { 
    rsi14, adx14, diPlus, diMinus, cmf20, volumeRatio, 
    trend, trendAlignment, emaStack, atrPct, 
    change15m, change1h, change4h, htfTrend,
    volatilityRegime, bbWidth, bbPosition, bbUpper, bbLower,
    bodyRatio, isBullishCandle, isBearishCandle, last,
  } = ind;
  
  let decision = 'NO_TRADE';
  let confidence = 0;
  let reasons = [];
  let strategy = '';
  let riskMultiplier = 1.0;
  
  // Skip if MQS too low
  if (!mqs.tradeable) {
    return { 
      decision: 'NO_TRADE', 
      confidence: 0, 
      reasons: [`MQS_${mqs.score.toFixed(0)}_SKIP`], 
      strategy: 'MQS_FILTER',
      riskMultiplier: 0,
    };
  }
  
  // Adjust risk based on MQS
  if (mqs.riskLevel === 'AGGRESSIVE') {
    riskMultiplier = 1.3;
  } else if (mqs.riskLevel === 'NORMAL') {
    riskMultiplier = 1.0;
  } else if (mqs.riskLevel === 'CONSERVATIVE') {
    riskMultiplier = 0.6;
  }
  
  // Minimum signal strength based on MQS
  const signalMultiplier = mqs.score >= 60 ? 0.85 : mqs.score >= 50 ? 1.0 : 1.2;
  
  // ═══════════════════════════════════════════════════════════════
  // STRATEGY 1: MOMENTUM BREAKOUT
  // ═══════════════════════════════════════════════════════════════
  const momentumThreshold = 0.35 * signalMultiplier;
  
  if (Math.abs(change1h) >= momentumThreshold && volumeRatio >= 1.3) {
    if (
      change1h > momentumThreshold &&
      cmf20 > 0.03 &&
      trend > 0 &&
      isBullishCandle &&
      bodyRatio >= 0.4
    ) {
      decision = 'LONG';
      confidence = 0.58 + (mqs.score - 50) / 200;
      reasons.push('MOMENTUM_LONG');
      strategy = 'MOMENTUM';
      
      if (trendAlignment === 1) confidence += 0.05;
      if (adx14 >= 22) confidence += 0.03;
      if (volumeRatio >= 2.0) confidence += 0.04;
    }
    else if (
      change1h < -momentumThreshold &&
      cmf20 < -0.03 &&
      trend < 0 &&
      isBearishCandle &&
      bodyRatio >= 0.4
    ) {
      decision = 'SHORT';
      confidence = 0.60 + (mqs.score - 50) / 200;
      reasons.push('MOMENTUM_SHORT');
      strategy = 'MOMENTUM';
      
      if (trendAlignment === -1) confidence += 0.05;
      if (adx14 >= 22) confidence += 0.03;
      if (volumeRatio >= 2.0) confidence += 0.04;
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // STRATEGY 2: TREND CONTINUATION
  // ═══════════════════════════════════════════════════════════════
  if (decision === 'NO_TRADE' && adx14 >= 20) {
    if (
      trendAlignment === 1 &&
      cmf20 > 0.05 &&
      rsi14 >= 45 && rsi14 <= 68 &&
      change4h > 0.3 * signalMultiplier &&
      volumeRatio >= 1.1 &&
      isBullishCandle
    ) {
      decision = 'LONG';
      confidence = 0.56 + (mqs.score - 50) / 200;
      reasons.push('TREND_CONT_LONG');
      strategy = 'TREND';
      
      if (emaStack === 1) confidence += 0.04;
      if (htfTrend > 0.5) confidence += 0.03;
    }
    else if (
      trendAlignment === -1 &&
      cmf20 < -0.05 &&
      rsi14 >= 32 && rsi14 <= 55 &&
      change4h < -0.3 * signalMultiplier &&
      volumeRatio >= 1.1 &&
      isBearishCandle
    ) {
      decision = 'SHORT';
      confidence = 0.58 + (mqs.score - 50) / 200;
      reasons.push('TREND_CONT_SHORT');
      strategy = 'TREND';
      
      if (emaStack === -1) confidence += 0.04;
      if (htfTrend < -0.5) confidence += 0.03;
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // STRATEGY 3: PULLBACK
  // ═══════════════════════════════════════════════════════════════
  if (decision === 'NO_TRADE' && Math.abs(htfTrend) > 0.6 * signalMultiplier && volumeRatio >= 1.2) {
    if (
      htfTrend > 0.6 &&
      trendAlignment === 1 &&
      rsi14 >= 38 && rsi14 <= 52 &&
      bbPosition >= 0.25 && bbPosition <= 0.55 &&
      cmf20 > 0.02 &&
      isBullishCandle
    ) {
      decision = 'LONG';
      confidence = 0.55 + (mqs.score - 50) / 200;
      reasons.push('PULLBACK_LONG');
      strategy = 'PULLBACK';
    }
    else if (
      htfTrend < -0.6 &&
      trendAlignment === -1 &&
      rsi14 >= 48 && rsi14 <= 62 &&
      bbPosition >= 0.45 && bbPosition <= 0.75 &&
      cmf20 < -0.02 &&
      isBearishCandle
    ) {
      decision = 'SHORT';
      confidence = 0.57 + (mqs.score - 50) / 200;
      reasons.push('PULLBACK_SHORT');
      strategy = 'PULLBACK';
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // STRATEGY 4: BB BREAKOUT (High MQS only)
  // ═══════════════════════════════════════════════════════════════
  if (decision === 'NO_TRADE' && mqs.score >= 55 && volumeRatio >= 1.6 && bodyRatio >= 0.5) {
    if (
      last > bbUpper * 0.998 &&
      cmf20 > 0.04 &&
      change15m > 0.12 &&
      trend > 0
    ) {
      decision = 'LONG';
      confidence = 0.54 + (mqs.score - 50) / 150;
      reasons.push('BB_BREAKOUT_LONG');
      strategy = 'BB_BREAK';
    }
    else if (
      last < bbLower * 1.002 &&
      cmf20 < -0.04 &&
      change15m < -0.12 &&
      trend < 0
    ) {
      decision = 'SHORT';
      confidence = 0.56 + (mqs.score - 50) / 150;
      reasons.push('BB_BREAKOUT_SHORT');
      strategy = 'BB_BREAK';
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // FILTERS
  // ═══════════════════════════════════════════════════════════════
  
  if (decision === 'LONG' && rsi14 > 72) confidence -= 0.08;
  if (decision === 'SHORT' && rsi14 < 28) confidence -= 0.08;
  
  if (decision !== 'NO_TRADE' && volumeRatio >= 2.5) {
    confidence += 0.03;
    reasons.push('HIGH_VOL');
  }
  
  // Minimum confidence based on MQS
  const minConf = mqs.score >= 60 ? 0.52 : mqs.score >= 50 ? 0.55 : 0.58;
  
  if (confidence < minConf) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['LOW_CONF'], strategy, riskMultiplier };
  }
  
  return { decision, confidence, reasons, strategy, riskMultiplier };
}

// Simulate trade
function simulateTrade(ind, futureCandles, side, atrPct, mqs) {
  if (!futureCandles || futureCandles.length < 10) return null;
  
  const entryPrice = ind.last;
  
  // Adapter les stops selon MQS
  let stopMult, tp1Mult, tp2Mult, maxHold;
  
  if (mqs.score >= 65) {
    // High quality: wider stops, let winners run
    stopMult = 1.5;
    tp1Mult = 2.2;
    tp2Mult = 4.0;
    maxHold = 80;
  } else if (mqs.score >= 50) {
    // Normal: balanced
    stopMult = 1.3;
    tp1Mult = 1.9;
    tp2Mult = 3.2;
    maxHold = 64;
  } else {
    // Conservative: tighter stops
    stopMult = 1.1;
    tp1Mult = 1.6;
    tp2Mult = 2.5;
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
    const high = futureCandles[i][2];
    const low = futureCandles[i][3];
    holdBars++;
    
    if (side === 'LONG' && low <= stopPrice) {
      exitPrice = stopPrice;
      exitReason = 'SL';
      break;
    }
    if (side === 'SHORT' && high >= stopPrice) {
      exitPrice = stopPrice;
      exitReason = 'SL';
      break;
    }
    
    if (!hitTp1) {
      if ((side === 'LONG' && high >= tp1Price) || (side === 'SHORT' && low <= tp1Price)) {
        hitTp1 = true;
      }
    }
    
    if (hitTp1) {
      const trailMult = mqs.score >= 60 ? 0.5 : 0.4;
      const trailingStop = side === 'LONG' 
        ? tp1Price - (stopDistance * trailMult * entryPrice / 100)
        : tp1Price + (stopDistance * trailMult * entryPrice / 100);
      
      if ((side === 'LONG' && low <= trailingStop) || (side === 'SHORT' && high >= trailingStop)) {
        exitPrice = trailingStop;
        exitReason = 'TRAIL_TP1';
        break;
      }
    }
    
    if ((side === 'LONG' && high >= tp2Price) || (side === 'SHORT' && low <= tp2Price)) {
      exitPrice = tp2Price;
      exitReason = 'TP2';
      break;
    }
  }
  
  if (!exitPrice && futureCandles.length > 0) {
    exitPrice = futureCandles[Math.min(holdBars - 1, futureCandles.length - 1)][4];
    exitReason = 'TIME';
  }
  
  if (!exitPrice) return null;
  
  const pnlPct = side === 'LONG'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  return { side, pnlPct, exitReason, holdBars, mqsScore: mqs.score };
}

// Backtest
async function backtestSymbol(symbol, candles) {
  const trades = [];
  let equity = CONFIG.equityUsd;
  let peakEquity = equity;
  let maxDrawdown = 0;
  
  const byMQS = {
    HIGH: { wins: 0, losses: 0, pnl: 0 },      // MQS >= 65
    NORMAL: { wins: 0, losses: 0, pnl: 0 },    // MQS 50-65
    CONSERVATIVE: { wins: 0, losses: 0, pnl: 0 }, // MQS 40-50
    SKIP: { count: 0 },
  };
  
  const lookback = 100;
  const mqsLookback = 288;
  
  // Cache MQS (update every 2h = 8 candles)
  let cachedMQS = null;
  let lastMQSUpdate = 0;
  
  for (let i = Math.max(lookback, mqsLookback); i < candles.length - 96; i++) {
    // Update MQS every 2h
    if (i - lastMQSUpdate >= 8 || !cachedMQS) {
      const mqsCandles = candles.slice(Math.max(0, i - mqsLookback), i + 1);
      cachedMQS = calculateMQS(mqsCandles, mqsLookback);
      lastMQSUpdate = i;
    }
    
    const historyCandles = candles.slice(i - lookback, i + 1);
    const futureCandles = candles.slice(i + 1, i + 97);
    
    const indicators = calculateIndicators(historyCandles);
    if (!indicators) continue;
    
    const { decision, confidence, reasons, strategy, riskMultiplier } = makeAdaptiveDecision(indicators, cachedMQS);
    
    if (decision === 'NO_TRADE') {
      if (reasons[0]?.includes('MQS')) {
        byMQS.SKIP.count++;
      }
      continue;
    }
    
    const result = simulateTrade(indicators, futureCandles, decision, indicators.atrPct, cachedMQS);
    if (!result) continue;
    
    // Position sizing
    const riskAmount = equity * CONFIG.riskPerTrade * riskMultiplier;
    const stopMult = cachedMQS.score >= 65 ? 1.5 : cachedMQS.score >= 50 ? 1.3 : 1.1;
    const stopDistance = indicators.atrPct * stopMult;
    const positionSize = riskAmount / (indicators.last * (stopDistance / 100));
    const pnlUsd = positionSize * indicators.last * (result.pnlPct / 100);
    equity += pnlUsd;
    
    // Track by MQS level
    const mqsLevel = cachedMQS.score >= 65 ? 'HIGH' : cachedMQS.score >= 50 ? 'NORMAL' : 'CONSERVATIVE';
    if (result.pnlPct > 0) byMQS[mqsLevel].wins++;
    else byMQS[mqsLevel].losses++;
    byMQS[mqsLevel].pnl += result.pnlPct;
    
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
      mqsScore: cachedMQS.score,
      strategy,
      confidence,
    });
    
    // Skip after trade
    i += Math.max(4, Math.floor(result.holdBars * 0.5));
  }
  
  return { symbol, trades, equity, maxDrawdown, byMQS };
}

// Main
async function main() {
  console.log('═'.repeat(80));
  console.log('📊 STRATÉGIE ADAPTATIVE V11 - MARKET QUALITY SCORE');
  console.log('═'.repeat(80));
  console.log(`📅 Période: ${CONFIG.days} jours (${Math.round(CONFIG.days/30)} mois)`);
  console.log(`💰 Capital: $${CONFIG.equityUsd.toLocaleString()}`);
  console.log('═'.repeat(80));
  
  const allTrades = [];
  const globalByMQS = {
    HIGH: { wins: 0, losses: 0, pnl: 0 },
    NORMAL: { wins: 0, losses: 0, pnl: 0 },
    CONSERVATIVE: { wins: 0, losses: 0, pnl: 0 },
    SKIP: { count: 0 },
  };
  
  for (const symbol of CONFIG.symbols) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🔍 ${symbol}`);
    console.log('─'.repeat(60));
    
    const candles = await fetchHistoricalData(symbol, CONFIG.timeframe, CONFIG.days);
    if (candles.length < 400) continue;
    
    const result = await backtestSymbol(symbol, candles);
    allTrades.push(...result.trades);
    
    for (const level of ['HIGH', 'NORMAL', 'CONSERVATIVE']) {
      globalByMQS[level].wins += result.byMQS[level].wins;
      globalByMQS[level].losses += result.byMQS[level].losses;
      globalByMQS[level].pnl += result.byMQS[level].pnl;
    }
    globalByMQS.SKIP.count += result.byMQS.SKIP.count;
    
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
  
  // MQS breakdown
  console.log('\n' + '═'.repeat(80));
  console.log('📊 PERFORMANCE PAR NIVEAU MQS');
  console.log('═'.repeat(80));
  
  for (const level of ['HIGH', 'NORMAL', 'CONSERVATIVE']) {
    const r = globalByMQS[level];
    const total = r.wins + r.losses;
    const wr = total > 0 ? (r.wins / total * 100).toFixed(1) : 0;
    const avgPnl = total > 0 ? (r.pnl / total).toFixed(3) : 0;
    const levelDesc = level === 'HIGH' ? '(MQS≥65)' : level === 'NORMAL' ? '(MQS 50-65)' : '(MQS 40-50)';
    console.log(`   ${(level + ' ' + levelDesc).padEnd(25)}: ${String(total).padStart(3)} trades | ${String(wr).padStart(5)}% WR | ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2).padStart(7)}% | Avg: ${avgPnl}%`);
  }
  console.log(`   ${'SKIPPED (MQS<40)'.padEnd(25)}: ${globalByMQS.SKIP.count} opportunities filtered`);
  
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
    console.log(`\n   ⚠️ Mois négatifs: ${months.filter(m => monthlyResults[m].totalPnlUsd < 0).join(', ')}`);
  }
  
  const avgMonthlyReturn = cumulativeReturn / Math.max(1, months.length);
  console.log(`\n   📈 Return Moyen/Mois: ${avgMonthlyReturn >= 0 ? '+' : ''}${avgMonthlyReturn.toFixed(2)}%`);
  
  console.log('\n' + '═'.repeat(80));
}

main().catch(console.error);
