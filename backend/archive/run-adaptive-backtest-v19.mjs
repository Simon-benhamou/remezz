#!/usr/bin/env node
/**
 * 📊 STRATÉGIE ADAPTATIVE V19 - FILTRES ANTI-PERDANTS
 * 
 * Basé sur l'analyse des perdants de septembre:
 * - RSI extrêmes (16.7, 67.5) → Éviter RSI <25 ou >70
 * - ADX faible (20.1) → Exiger ADX >= 25
 * - Trend trop faible (1.85%) → Minimum 2.5%
 */

import ccxt from 'ccxt';

const CONFIG = {
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
  timeframe: '15m',
  days: 120,
  equityUsd: 10000,
  riskPerTrade: 0.01,
  
  // Trend Filter - PLUS STRICT
  trendFilter: {
    lookbackBars: 72,
    minTrendPct: 2.5,       // 2.5% au lieu de 1.5%
    minEfficiency: 0.12,    // Plus strict
    updateEvery: 16,
  },
  
  // Signal filters
  signalFilters: {
    minADX: 25,            // ADX minimum
    rsiMin: 28,            // Éviter oversold extrême
    rsiMax: 72,            // Éviter overbought extrême
  },
};

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

function detectTrend(candles, lookback) {
  if (candles.length < lookback) return { hasTrend: false, direction: 0, strength: 0 };
  
  const recent = candles.slice(-lookback);
  const startPrice = recent[0][4];
  const endPrice = recent[recent.length - 1][4];
  const move = ((endPrice - startPrice) / startPrice) * 100;
  const absMove = Math.abs(move);
  
  let totalMove = 0;
  for (let i = 1; i < recent.length; i++) {
    totalMove += Math.abs(recent[i][4] - recent[i-1][4]);
  }
  const netMove = Math.abs(endPrice - startPrice);
  const efficiency = totalMove > 0 ? netMove / totalMove : 0;
  
  const hasTrend = absMove >= CONFIG.trendFilter.minTrendPct && efficiency >= CONFIG.trendFilter.minEfficiency;
  
  return { hasTrend, direction: move > 0 ? 1 : -1, strength: absMove, efficiency, move };
}

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
    change15m, change1h, change4h, htfTrend, bodyRatio,
    isBullishCandle: currentCandle[4] > currentCandle[1],
    isBearishCandle: currentCandle[4] < currentCandle[1],
  };
}

function makeAdaptiveDecision(ind, trendInfo) {
  const { 
    rsi14, adx14, cmf20, volumeRatio, 
    trend, trendAlignment, emaStack, 
    change15m, change1h, change4h, htfTrend,
    volatilityRegime, bbPosition, bbUpper, bbLower,
    bodyRatio, isBullishCandle, isBearishCandle, last,
  } = ind;
  
  let decision = 'NO_TRADE';
  let confidence = 0;
  let reasons = [];
  let strategy = '';
  let riskMultiplier = 1.0;
  
  // ═══════════════════════════════════════════════════════════════
  // FILTRE 1: Trend
  // ═══════════════════════════════════════════════════════════════
  if (!trendInfo.hasTrend) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['NO_TREND'], strategy: 'FILTER', riskMultiplier: 0 };
  }
  
  // ═══════════════════════════════════════════════════════════════
  // FILTRE 2: RSI extrêmes
  // ═══════════════════════════════════════════════════════════════
  if (rsi14 < CONFIG.signalFilters.rsiMin || rsi14 > CONFIG.signalFilters.rsiMax) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['RSI_EXTREME'], strategy: 'FILTER', riskMultiplier: 0 };
  }
  
  // ═══════════════════════════════════════════════════════════════
  // FILTRE 3: ADX minimum
  // ═══════════════════════════════════════════════════════════════
  if (adx14 < CONFIG.signalFilters.minADX) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['ADX_LOW'], strategy: 'FILTER', riskMultiplier: 0 };
  }
  
  const trendBonus = 0.03;
  
  // ═══════════════════════════════════════════════════════════════
  // LOW VOLATILITY - Skip
  // ═══════════════════════════════════════════════════════════════
  if (volatilityRegime === 'LOW') {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['LOW_VOL'], strategy: 'SKIP', riskMultiplier: 0 };
  }
  
  // ═══════════════════════════════════════════════════════════════
  // MEDIUM VOLATILITY
  // ═══════════════════════════════════════════════════════════════
  if (volatilityRegime === 'MEDIUM') {
    strategy = 'MED';
    riskMultiplier = 0.5;
    
    if (volumeRatio >= 1.5 && bodyRatio >= 0.5) {
      if (trendInfo.direction === 1 && trendAlignment === 1 && cmf20 > 0.06 && rsi14 >= 48 && rsi14 <= 62 && isBullishCandle && change1h > 0.25) {
        decision = 'LONG';
        confidence = 0.62 + trendBonus;
        reasons.push('MED_TREND_L');
      }
      else if (trendInfo.direction === -1 && trendAlignment === -1 && cmf20 < -0.06 && rsi14 >= 38 && rsi14 <= 52 && isBearishCandle && change1h < -0.25) {
        decision = 'SHORT';
        confidence = 0.64 + trendBonus;
        reasons.push('MED_TREND_S');
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // HIGH VOLATILITY
  // ═══════════════════════════════════════════════════════════════
  else if (volatilityRegime === 'HIGH') {
    strategy = 'HIGH';
    
    // Momentum breakout
    if (Math.abs(change1h) >= 0.4 && volumeRatio >= 1.5) {
      if (change1h > 0.4 && cmf20 > 0.05 && trend > 0 && isBullishCandle && bodyRatio >= 0.5) {
        decision = 'LONG';
        confidence = 0.65;
        reasons.push('MOM_L');
        if (trendInfo.direction === 1) confidence += trendBonus;
        if (trendAlignment === 1) confidence += 0.04;
        if (volumeRatio >= 2.0) confidence += 0.04;
      }
      else if (change1h < -0.4 && cmf20 < -0.05 && trend < 0 && isBearishCandle && bodyRatio >= 0.5) {
        decision = 'SHORT';
        confidence = 0.67;
        reasons.push('MOM_S');
        if (trendInfo.direction === -1) confidence += trendBonus;
        if (trendAlignment === -1) confidence += 0.04;
        if (volumeRatio >= 2.0) confidence += 0.04;
      }
    }
    
    // Trend continuation
    if (decision === 'NO_TRADE') {
      if (trendInfo.direction === 1 && trendAlignment === 1 && cmf20 > 0.06 && rsi14 >= 48 && rsi14 <= 65 && change4h > 0.4 && volumeRatio >= 1.2 && isBullishCandle) {
        decision = 'LONG';
        confidence = 0.63 + trendBonus;
        reasons.push('TREND_L');
        if (emaStack === 1) confidence += 0.04;
      }
      else if (trendInfo.direction === -1 && trendAlignment === -1 && cmf20 < -0.06 && rsi14 <= 52 && rsi14 >= 35 && change4h < -0.4 && volumeRatio >= 1.2 && isBearishCandle) {
        decision = 'SHORT';
        confidence = 0.65 + trendBonus;
        reasons.push('TREND_S');
        if (emaStack === -1) confidence += 0.04;
      }
    }
    
    // BB breakout
    if (decision === 'NO_TRADE' && volumeRatio >= 1.8 && bodyRatio >= 0.55) {
      if (trendInfo.direction === 1 && last > bbUpper * 0.998 && cmf20 > 0.05 && change15m > 0.15 && trend > 0) {
        decision = 'LONG';
        confidence = 0.60 + trendBonus;
        reasons.push('BB_L');
      }
      else if (trendInfo.direction === -1 && last < bbLower * 1.002 && cmf20 < -0.05 && change15m < -0.15 && trend < 0) {
        decision = 'SHORT';
        confidence = 0.62 + trendBonus;
        reasons.push('BB_S');
      }
    }
    
    // Pullback
    if (decision === 'NO_TRADE' && Math.abs(htfTrend) > 0.8 && volumeRatio >= 1.3) {
      if (trendInfo.direction === 1 && htfTrend > 0.8 && trendAlignment === 1 && rsi14 >= 42 && rsi14 <= 55 && bbPosition >= 0.30 && bbPosition <= 0.55 && cmf20 > 0.03 && isBullishCandle) {
        decision = 'LONG';
        confidence = 0.60 + trendBonus;
        reasons.push('PB_L');
      }
      else if (trendInfo.direction === -1 && htfTrend < -0.8 && trendAlignment === -1 && rsi14 >= 45 && rsi14 <= 58 && bbPosition >= 0.45 && bbPosition <= 0.70 && cmf20 < -0.03 && isBearishCandle) {
        decision = 'SHORT';
        confidence = 0.62 + trendBonus;
        reasons.push('PB_S');
      }
    }
  }
  
  if (decision !== 'NO_TRADE' && volumeRatio >= 2.5) confidence += 0.04;
  
  if (trendInfo.strength > 4) riskMultiplier *= 1.2;
  else if (trendInfo.strength < 3) riskMultiplier *= 0.8;
  
  const minConfidence = 0.60;
  if (confidence < minConfidence) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['LOW_CONF'], strategy, riskMultiplier };
  }
  
  return { decision, confidence, reasons, strategy, riskMultiplier };
}

function simulateTrade(ind, futureCandles, side, atrPct) {
  if (!futureCandles || futureCandles.length < 10) return null;
  
  const entryPrice = ind.last;
  const { volatilityRegime } = ind;
  
  let stopMult, tp1Mult, tp2Mult, maxHold;
  if (volatilityRegime === 'MEDIUM') {
    stopMult = 1.3; tp1Mult = 1.8; tp2Mult = 3.0; maxHold = 64;
  } else {
    stopMult = 1.5; tp1Mult = 2.2; tp2Mult = 4.0; maxHold = 96;
  }
  
  const stopDistance = atrPct * stopMult;
  const tp1Distance = atrPct * tp1Mult;
  const tp2Distance = atrPct * tp2Mult;
  
  const stopPrice = side === 'LONG' ? entryPrice * (1 - stopDistance / 100) : entryPrice * (1 + stopDistance / 100);
  const tp1Price = side === 'LONG' ? entryPrice * (1 + tp1Distance / 100) : entryPrice * (1 - tp1Distance / 100);
  const tp2Price = side === 'LONG' ? entryPrice * (1 + tp2Distance / 100) : entryPrice * (1 - tp2Distance / 100);
  
  let exitPrice = null;
  let exitReason = null;
  let holdBars = 0;
  let hitTp1 = false;
  
  for (let i = 0; i < futureCandles.length && i < maxHold; i++) {
    const high = futureCandles[i][2];
    const low = futureCandles[i][3];
    holdBars++;
    
    if (side === 'LONG' && low <= stopPrice) { exitPrice = stopPrice; exitReason = 'SL'; break; }
    if (side === 'SHORT' && high >= stopPrice) { exitPrice = stopPrice; exitReason = 'SL'; break; }
    
    if (!hitTp1 && ((side === 'LONG' && high >= tp1Price) || (side === 'SHORT' && low <= tp1Price))) {
      hitTp1 = true;
    }
    
    if (hitTp1) {
      const trailMult = volatilityRegime === 'MEDIUM' ? 0.4 : 0.5;
      const trailingStop = side === 'LONG' 
        ? tp1Price - (stopDistance * trailMult * entryPrice / 100)
        : tp1Price + (stopDistance * trailMult * entryPrice / 100);
      
      if ((side === 'LONG' && low <= trailingStop) || (side === 'SHORT' && high >= trailingStop)) {
        exitPrice = trailingStop; exitReason = 'TRAIL'; break;
      }
    }
    
    if ((side === 'LONG' && high >= tp2Price) || (side === 'SHORT' && low <= tp2Price)) {
      exitPrice = tp2Price; exitReason = 'TP2'; break;
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
  
  return { side, pnlPct, exitReason, holdBars, volatilityRegime };
}

async function backtestSymbol(symbol, candles) {
  const trades = [];
  let equity = CONFIG.equityUsd;
  
  const byVolRegime = {
    MEDIUM: { wins: 0, losses: 0, pnl: 0 },
    HIGH: { wins: 0, losses: 0, pnl: 0 },
  };
  
  const skipStats = { noTrend: 0, rsiExtreme: 0, adxLow: 0, lowVol: 0, lowConf: 0 };
  
  const lookback = 100;
  const { lookbackBars, updateEvery } = CONFIG.trendFilter;
  
  let cachedTrend = null;
  let lastTrendUpdate = 0;
  
  for (let i = Math.max(lookback, lookbackBars); i < candles.length - 96; i++) {
    if (i - lastTrendUpdate >= updateEvery || !cachedTrend) {
      const trendCandles = candles.slice(i - lookbackBars, i + 1);
      cachedTrend = detectTrend(trendCandles, lookbackBars);
      lastTrendUpdate = i;
    }
    
    const historyCandles = candles.slice(i - lookback, i + 1);
    const futureCandles = candles.slice(i + 1, i + 97);
    
    const indicators = calculateIndicators(historyCandles);
    if (!indicators) continue;
    
    const { decision, confidence, reasons, strategy, riskMultiplier } = makeAdaptiveDecision(indicators, cachedTrend);
    
    if (decision === 'NO_TRADE') {
      if (reasons[0] === 'NO_TREND') skipStats.noTrend++;
      else if (reasons[0] === 'RSI_EXTREME') skipStats.rsiExtreme++;
      else if (reasons[0] === 'ADX_LOW') skipStats.adxLow++;
      else if (reasons[0] === 'LOW_VOL') skipStats.lowVol++;
      else if (reasons[0] === 'LOW_CONF') skipStats.lowConf++;
      continue;
    }
    
    const result = simulateTrade(indicators, futureCandles, decision, indicators.atrPct);
    if (!result) continue;
    
    const riskAmount = equity * CONFIG.riskPerTrade * riskMultiplier;
    const stopMult = result.volatilityRegime === 'MEDIUM' ? 1.3 : 1.5;
    const stopDistance = indicators.atrPct * stopMult;
    const positionSize = riskAmount / (indicators.last * (stopDistance / 100));
    const pnlUsd = positionSize * indicators.last * (result.pnlPct / 100);
    equity += pnlUsd;
    
    const regime = result.volatilityRegime;
    if (byVolRegime[regime]) {
      if (result.pnlPct > 0) byVolRegime[regime].wins++;
      else byVolRegime[regime].losses++;
      byVolRegime[regime].pnl += result.pnlPct;
    }
    
    trades.push({
      timestamp: indicators.timestamp,
      date: new Date(indicators.timestamp),
      symbol,
      side: result.side,
      pnlPct: result.pnlPct,
      pnlUsd,
      equity,
      volatilityRegime: result.volatilityRegime,
      strategy,
      trendStrength: cachedTrend.strength,
    });
    
    i += Math.max(4, Math.floor(result.holdBars * 0.6));
  }
  
  return { symbol, trades, equity, byVolRegime, skipStats };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 STRATÉGIE ADAPTATIVE V19 - FILTRES ANTI-PERDANTS');
  console.log('═'.repeat(80));
  console.log(`📅 Période: ${CONFIG.days} jours (${Math.round(CONFIG.days/30)} mois)`);
  console.log(`💰 Capital: $${CONFIG.equityUsd.toLocaleString()}`);
  console.log(`📈 Trend Min: ${CONFIG.trendFilter.minTrendPct}% / Eff: ${CONFIG.trendFilter.minEfficiency}`);
  console.log(`🎯 RSI: ${CONFIG.signalFilters.rsiMin}-${CONFIG.signalFilters.rsiMax} | ADX >= ${CONFIG.signalFilters.minADX}`);
  console.log('═'.repeat(80));
  
  const allTrades = [];
  const globalByRegime = {
    MEDIUM: { wins: 0, losses: 0, pnl: 0 },
    HIGH: { wins: 0, losses: 0, pnl: 0 },
  };
  const globalSkips = { noTrend: 0, rsiExtreme: 0, adxLow: 0, lowVol: 0, lowConf: 0 };
  
  for (const symbol of CONFIG.symbols) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🔍 ${symbol}`);
    console.log('─'.repeat(60));
    
    const candles = await fetchHistoricalData(symbol, CONFIG.timeframe, CONFIG.days);
    if (candles.length < 200) continue;
    
    const result = await backtestSymbol(symbol, candles);
    allTrades.push(...result.trades);
    
    for (const regime of ['MEDIUM', 'HIGH']) {
      globalByRegime[regime].wins += result.byVolRegime[regime].wins;
      globalByRegime[regime].losses += result.byVolRegime[regime].losses;
      globalByRegime[regime].pnl += result.byVolRegime[regime].pnl;
    }
    
    for (const key of Object.keys(globalSkips)) {
      globalSkips[key] += result.skipStats[key];
    }
    
    const wins = result.trades.filter(t => t.pnlPct > 0).length;
    const winRate = result.trades.length > 0 ? (wins / result.trades.length) * 100 : 0;
    const totalReturn = ((result.equity - CONFIG.equityUsd) / CONFIG.equityUsd) * 100;
    
    console.log(`   Trades: ${result.trades.length} | WR: ${winRate.toFixed(1)}% | Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`);
    console.log(`   📈 Skips: ${result.skipStats.noTrend} no-trend, ${result.skipStats.rsiExtreme} RSI, ${result.skipStats.adxLow} ADX`);
  }
  
  allTrades.sort((a, b) => a.timestamp - b.timestamp);
  
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
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 PERFORMANCE PAR RÉGIME');
  console.log('═'.repeat(80));
  
  for (const regime of ['MEDIUM', 'HIGH']) {
    const r = globalByRegime[regime];
    const total = r.wins + r.losses;
    const wr = total > 0 ? (r.wins / total * 100).toFixed(1) : 0;
    const avgPnl = total > 0 ? (r.pnl / total).toFixed(3) : 0;
    console.log(`   ${regime.padEnd(8)}: ${String(total).padStart(3)} trades | ${String(wr).padStart(5)}% WR | ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2).padStart(7)}% | Avg: ${avgPnl}%`);
  }
  
  console.log('\n   📊 Skips:');
  console.log(`      NO_TREND: ${globalSkips.noTrend}`);
  console.log(`      RSI_EXTREME: ${globalSkips.rsiExtreme}`);
  console.log(`      ADX_LOW: ${globalSkips.adxLow}`);
  console.log(`      LOW_VOL: ${globalSkips.lowVol}`);
  console.log(`      LOW_CONF: ${globalSkips.lowConf}`);
  
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
    console.log(`\n   ✅ TOUS LES MOIS SONT POSITIFS!`);
  } else {
    console.log(`\n   ⚠️ Mois négatifs: ${months.filter(m => monthlyResults[m].totalPnlUsd < 0).join(', ')}`);
  }
  
  const avgMonthlyReturn = cumulativeReturn / Math.max(1, months.length);
  console.log(`\n   📈 Return Moyen/Mois: ${avgMonthlyReturn >= 0 ? '+' : ''}${avgMonthlyReturn.toFixed(2)}%`);
  
  console.log('\n' + '═'.repeat(80));
}

main().catch(console.error);
