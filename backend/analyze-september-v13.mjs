#!/usr/bin/env node
/**
 * 🔍 ANALYSE DÉTAILLÉE DE SEPTEMBRE (V13)
 * 
 * V13 = 3/4 mois positifs, mais septembre -1.59%
 * On veut comprendre EXACTEMENT quels trades ont perdu en septembre
 */

import ccxt from 'ccxt';

const CONFIG = {
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
  timeframe: '15m',
  days: 120,
  equityUsd: 10000,
  riskPerTrade: 0.01,
  
  trendFilter: {
    lookbackBars: 72,
    minTrendPct: 1.5,
    updateEvery: 16,
  },
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
  
  const hasTrend = absMove >= CONFIG.trendFilter.minTrendPct && efficiency >= 0.08;
  
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
  
  if (!trendInfo.hasTrend) {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['NO_TREND'], strategy: 'FILTER', riskMultiplier: 0 };
  }
  
  const trendBonus = 0.03;
  
  if (volatilityRegime === 'LOW') {
    return { decision: 'NO_TRADE', confidence: 0, reasons: ['LOW_VOL'], strategy: 'SKIP', riskMultiplier: 0 };
  }
  
  if (volatilityRegime === 'MEDIUM') {
    strategy = 'MED';
    riskMultiplier = 0.5;
    
    if (adx14 >= 25 && volumeRatio >= 1.5 && bodyRatio >= 0.5) {
      if (trendInfo.direction === 1 && trendAlignment === 1 && cmf20 > 0.06 && rsi14 >= 45 && rsi14 <= 65 && isBullishCandle && change1h > 0.2) {
        decision = 'LONG';
        confidence = 0.60 + trendBonus;
        reasons.push('MED_TREND_L');
      }
      else if (trendInfo.direction === -1 && trendAlignment === -1 && cmf20 < -0.06 && rsi14 >= 35 && rsi14 <= 55 && isBearishCandle && change1h < -0.2) {
        decision = 'SHORT';
        confidence = 0.62 + trendBonus;
        reasons.push('MED_TREND_S');
      }
    }
  }
  
  else if (volatilityRegime === 'HIGH') {
    strategy = 'HIGH';
    
    if (Math.abs(change1h) >= 0.35 && volumeRatio >= 1.4) {
      if (change1h > 0.35 && cmf20 > 0.04 && trend > 0 && isBullishCandle && bodyRatio >= 0.45) {
        decision = 'LONG';
        confidence = 0.63;
        reasons.push('MOM_L');
        if (trendInfo.direction === 1) confidence += trendBonus;
        if (trendAlignment === 1) confidence += 0.04;
        if (adx14 >= 25) confidence += 0.03;
        if (volumeRatio >= 2.0) confidence += 0.04;
      }
      else if (change1h < -0.35 && cmf20 < -0.04 && trend < 0 && isBearishCandle && bodyRatio >= 0.45) {
        decision = 'SHORT';
        confidence = 0.65;
        reasons.push('MOM_S');
        if (trendInfo.direction === -1) confidence += trendBonus;
        if (trendAlignment === -1) confidence += 0.04;
        if (adx14 >= 25) confidence += 0.03;
        if (volumeRatio >= 2.0) confidence += 0.04;
      }
    }
    
    if (decision === 'NO_TRADE' && adx14 >= 20) {
      if (trendInfo.direction === 1 && trendAlignment === 1 && cmf20 > 0.05 && rsi14 >= 45 && rsi14 <= 70 && change4h > 0.35 && volumeRatio >= 1.15 && isBullishCandle) {
        decision = 'LONG';
        confidence = 0.61 + trendBonus;
        reasons.push('TREND_L');
        if (emaStack === 1) confidence += 0.04;
      }
      else if (trendInfo.direction === -1 && trendAlignment === -1 && cmf20 < -0.05 && rsi14 <= 55 && rsi14 >= 30 && change4h < -0.35 && volumeRatio >= 1.15 && isBearishCandle) {
        decision = 'SHORT';
        confidence = 0.63 + trendBonus;
        reasons.push('TREND_S');
        if (emaStack === -1) confidence += 0.04;
      }
    }
    
    if (decision === 'NO_TRADE' && volumeRatio >= 1.7 && bodyRatio >= 0.5) {
      if (trendInfo.direction === 1 && last > bbUpper * 0.998 && cmf20 > 0.04 && change15m > 0.12 && trend > 0) {
        decision = 'LONG';
        confidence = 0.58 + trendBonus;
        reasons.push('BB_L');
      }
      else if (trendInfo.direction === -1 && last < bbLower * 1.002 && cmf20 < -0.04 && change15m < -0.12 && trend < 0) {
        decision = 'SHORT';
        confidence = 0.60 + trendBonus;
        reasons.push('BB_S');
      }
    }
    
    if (decision === 'NO_TRADE' && Math.abs(htfTrend) > 0.7 && volumeRatio >= 1.2) {
      if (trendInfo.direction === 1 && htfTrend > 0.7 && trendAlignment === 1 && rsi14 >= 38 && rsi14 <= 55 && bbPosition >= 0.25 && bbPosition <= 0.55 && cmf20 > 0.02 && isBullishCandle) {
        decision = 'LONG';
        confidence = 0.58 + trendBonus;
        reasons.push('PB_L');
      }
      else if (trendInfo.direction === -1 && htfTrend < -0.7 && trendAlignment === -1 && rsi14 >= 45 && rsi14 <= 62 && bbPosition >= 0.45 && bbPosition <= 0.75 && cmf20 < -0.02 && isBearishCandle) {
        decision = 'SHORT';
        confidence = 0.60 + trendBonus;
        reasons.push('PB_S');
      }
    }
  }
  
  if (decision === 'LONG' && rsi14 > 75) confidence -= 0.10;
  if (decision === 'SHORT' && rsi14 < 25) confidence -= 0.10;
  if (decision !== 'NO_TRADE' && volumeRatio >= 2.5) confidence += 0.04;
  
  if (trendInfo.strength > 3) riskMultiplier *= 1.2;
  else if (trendInfo.strength < 2) riskMultiplier *= 0.8;
  
  const minConfidence = 0.58;
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

async function main() {
  console.log('═'.repeat(80));
  console.log('🔍 ANALYSE DÉTAILLÉE DES TRADES DE SEPTEMBRE');
  console.log('═'.repeat(80));
  
  const septemberTrades = [];
  
  for (const symbol of CONFIG.symbols) {
    console.log(`\n🔍 ${symbol}`);
    
    const candles = await fetchHistoricalData(symbol, CONFIG.timeframe, CONFIG.days);
    if (candles.length < 200) continue;
    
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
      
      const date = new Date(indicators.timestamp);
      const month = date.getMonth() + 1;
      
      // Only look at September
      if (month !== 9) continue;
      
      const { decision, confidence, reasons, strategy, riskMultiplier } = makeAdaptiveDecision(indicators, cachedTrend);
      
      if (decision === 'NO_TRADE') continue;
      
      const result = simulateTrade(indicators, futureCandles, decision, indicators.atrPct);
      if (!result) continue;
      
      septemberTrades.push({
        date: date.toISOString().split('T')[0] + ' ' + date.toISOString().split('T')[1].slice(0, 5),
        symbol: symbol.split('/')[0],
        side: decision,
        strategy: reasons[0],
        volatilityRegime: indicators.volatilityRegime,
        trendStrength: cachedTrend.strength.toFixed(2),
        trendEfficiency: cachedTrend.efficiency.toFixed(3),
        rsi: indicators.rsi14.toFixed(1),
        adx: indicators.adx14.toFixed(1),
        cmf: indicators.cmf20.toFixed(3),
        volRatio: indicators.volumeRatio.toFixed(2),
        pnlPct: result.pnlPct.toFixed(2),
        exitReason: result.exitReason,
        win: result.pnlPct > 0,
      });
      
      i += Math.max(4, Math.floor(result.holdBars * 0.6));
    }
  }
  
  console.log('\n' + '═'.repeat(100));
  console.log('📋 TRADES DE SEPTEMBRE - DÉTAIL');
  console.log('═'.repeat(100));
  
  console.log('\n┌──────────────────┬───────┬───────┬──────────┬────────┬─────────┬───────┬───────┬───────┬────────┬────────┬───────┐');
  console.log('│       Date       │ Asset │ Side  │ Strategy │ Regime │ TrStrng │  RSI  │  ADX  │  CMF  │ VolRat │  PnL%  │ Exit  │');
  console.log('├──────────────────┼───────┼───────┼──────────┼────────┼─────────┼───────┼───────┼───────┼────────┼────────┼───────┤');
  
  for (const t of septemberTrades) {
    const winIcon = t.win ? '✅' : '❌';
    console.log(`│ ${t.date} │ ${t.symbol.padEnd(5)} │ ${t.side.padEnd(5)} │ ${t.strategy.padEnd(8)} │ ${t.volatilityRegime.padEnd(6)} │ ${t.trendStrength.padStart(7)} │ ${t.rsi.padStart(5)} │ ${t.adx.padStart(5)} │ ${t.cmf.padStart(5)} │ ${t.volRatio.padStart(6)} │ ${winIcon}${t.pnlPct.padStart(5)} │ ${t.exitReason.padEnd(5)} │`);
  }
  
  console.log('└──────────────────┴───────┴───────┴──────────┴────────┴─────────┴───────┴───────┴───────┴────────┴────────┴───────┘');
  
  // Summary
  const wins = septemberTrades.filter(t => t.win).length;
  const totalPnl = septemberTrades.reduce((s, t) => s + parseFloat(t.pnlPct), 0);
  
  console.log(`\n📊 RÉSUMÉ SEPTEMBRE:`);
  console.log(`   Trades: ${septemberTrades.length}`);
  console.log(`   Wins: ${wins} (${((wins/septemberTrades.length)*100).toFixed(1)}%)`);
  console.log(`   PnL Total: ${totalPnl.toFixed(2)}%`);
  
  // Analyze losing trades
  const losers = septemberTrades.filter(t => !t.win);
  console.log(`\n📉 TRADES PERDANTS (${losers.length}):`);
  for (const t of losers) {
    console.log(`   - ${t.date} ${t.symbol} ${t.side} (${t.strategy}): ${t.pnlPct}% | TrStr=${t.trendStrength} Eff=${t.trendEfficiency} RSI=${t.rsi} ADX=${t.adx}`);
  }
  
  // Pattern analysis
  console.log(`\n🔍 PATTERNS DES PERDANTS:`);
  const avgTrendStrengthLosers = losers.reduce((s, t) => s + parseFloat(t.trendStrength), 0) / losers.length;
  const avgTrendStrengthWinners = septemberTrades.filter(t => t.win).reduce((s, t) => s + parseFloat(t.trendStrength), 0) / wins || 0;
  console.log(`   Trend Strength Moyen - Perdants: ${avgTrendStrengthLosers.toFixed(2)}% vs Winners: ${avgTrendStrengthWinners.toFixed(2)}%`);
  
  const avgEffLosers = losers.reduce((s, t) => s + parseFloat(t.trendEfficiency), 0) / losers.length;
  const avgEffWinners = septemberTrades.filter(t => t.win).reduce((s, t) => s + parseFloat(t.trendEfficiency), 0) / wins || 0;
  console.log(`   Trend Efficiency Moyen - Perdants: ${avgEffLosers.toFixed(3)} vs Winners: ${avgEffWinners.toFixed(3)}`);
  
  console.log('\n' + '═'.repeat(80));
}

main().catch(console.error);
