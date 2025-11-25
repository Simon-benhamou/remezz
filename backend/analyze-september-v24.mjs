#!/usr/bin/env node
/**
 * Analyse détaillée des trades de Septembre avec V24
 */

import ccxt from 'ccxt';

const CONFIG = {
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
  timeframe: '15m',
  days: 120,
  equityUsd: 10000,
  riskPerTrade: 0.01,
  cooldownBars: 96,
  minScore: 5,
};

async function fetchHistoricalData(symbol, timeframe, days) {
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  const timeframeMs = 15 * 60 * 1000;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  
  let allCandles = [];
  let currentSince = since;
  
  while (allCandles.length < days * 96) {
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, currentSince, 1000);
    if (ohlcv.length === 0) break;
    allCandles = allCandles.concat(ohlcv);
    currentSince = ohlcv[ohlcv.length - 1][0] + timeframeMs;
    await new Promise(r => setTimeout(r, 100));
    if (ohlcv.length < 1000) break;
  }
  
  return allCandles;
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
  for (let i = 1; i < arr.length; i++) changes.push(arr[i] - arr[i-1]);
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
  const { adx: adxArr } = adx(highs, lows, closes);
  const cmfArr = cmf(highs, lows, closes, volumes);
  
  const avgVol = volumes.slice(-50, -1).reduce((a, b) => a + b, 0) / 49;
  const currentVol = volumes[volumes.length - 1];
  
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.abs(closes[i] - closes[i-1]) / closes[i-1] * 100);
  }
  const avgReturn = returns.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const recentReturn = returns.slice(-10).reduce((a, b) => a + b, 0) / 10;
  
  let volatilityRegime;
  if (avgReturn > 0.5 || recentReturn > 0.6) volatilityRegime = 'HIGH';
  else if (avgReturn > 0.25 || recentReturn > 0.35) volatilityRegime = 'MEDIUM';
  else volatilityRegime = 'LOW';
  
  const currentCandle = candles[candles.length - 1];
  const candleBody = Math.abs(currentCandle[4] - currentCandle[1]);
  const candleRange = currentCandle[2] - currentCandle[3];
  const bodyRatio = candleRange > 0 ? candleBody / candleRange : 0;
  
  const change1h = (last - closes[closes.length - 5]) / closes[closes.length - 5] * 100;
  const change4h = (last - closes[closes.length - 17]) / closes[closes.length - 17] * 100;
  
  const ema9 = ema9Arr[ema9Arr.length - 1];
  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema50 = ema50Arr[ema50Arr.length - 1];
  
  const trend72 = candles.length >= 72 
    ? (closes[closes.length - 1] - closes[closes.length - 72]) / closes[closes.length - 72] * 100
    : 0;
  
  return {
    last, timestamp,
    rsi14: rsiArr[rsiArr.length - 1],
    atrPct: (atrArr[atrArr.length - 1] / last) * 100,
    adx14: adxArr[adxArr.length - 1],
    cmf20: cmfArr[cmfArr.length - 1],
    volumeRatio: currentVol / avgVol,
    trend: last > ema20 ? 1 : -1,
    emaStack: (ema9 > ema20 && ema20 > ema50) ? 1 : (ema9 < ema20 && ema20 < ema50) ? -1 : 0,
    volatilityRegime,
    change1h, change4h, trend72,
    bodyRatio,
    isBullishCandle: currentCandle[4] > currentCandle[1],
    isBearishCandle: currentCandle[4] < currentCandle[1],
  };
}

function calculateQualityScore(ind, side) {
  let score = 0;
  const reasons = [];
  
  if (side === 'LONG' && ind.trend72 >= 3) { score++; reasons.push('TREND+'); }
  else if (side === 'SHORT' && ind.trend72 <= -3) { score++; reasons.push('TREND-'); }
  
  if (ind.adx14 >= 30) { score++; reasons.push('ADX'); }
  if (ind.volumeRatio >= 2.0) { score++; reasons.push('VOL'); }
  
  if (side === 'LONG' && ind.cmf20 >= 0.1) { score++; reasons.push('CMF+'); }
  else if (side === 'SHORT' && ind.cmf20 <= -0.1) { score++; reasons.push('CMF-'); }
  
  if (side === 'LONG' && ind.emaStack === 1) { score++; reasons.push('EMA+'); }
  else if (side === 'SHORT' && ind.emaStack === -1) { score++; reasons.push('EMA-'); }
  
  if (ind.rsi14 >= 40 && ind.rsi14 <= 60) { score++; reasons.push('RSI_OK'); }
  
  return { score, reasons };
}

function makeAdaptiveDecision(ind) {
  if (ind.volatilityRegime === 'LOW') return { decision: 'NO_TRADE', score: 0 };
  if (ind.volumeRatio < 1.5 || ind.bodyRatio < 0.5) return { decision: 'NO_TRADE', score: 0 };
  
  if (ind.change1h > 0.3 && ind.change4h > 0.5 && ind.cmf20 > 0.05 && ind.trend > 0 && ind.isBullishCandle) {
    const { score, reasons } = calculateQualityScore(ind, 'LONG');
    if (score >= CONFIG.minScore) return { decision: 'LONG', score, reasons };
  }
  
  if (ind.change1h < -0.3 && ind.change4h < -0.5 && ind.cmf20 < -0.05 && ind.trend < 0 && ind.isBearishCandle) {
    const { score, reasons } = calculateQualityScore(ind, 'SHORT');
    if (score >= CONFIG.minScore) return { decision: 'SHORT', score, reasons };
  }
  
  return { decision: 'NO_TRADE', score: 0 };
}

function simulateTrade(ind, futureCandles, side) {
  if (!futureCandles || futureCandles.length < 10) return null;
  
  const entryPrice = ind.last;
  const atrPct = ind.atrPct;
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
  
  let exitPrice = null, exitReason = null, holdBars = 0, hitTp1 = false;
  
  for (let i = 0; i < futureCandles.length && i < maxHold; i++) {
    const high = futureCandles[i][2], low = futureCandles[i][3];
    holdBars++;
    
    if (side === 'LONG' && low <= stopPrice) { exitPrice = stopPrice; exitReason = 'SL'; break; }
    if (side === 'SHORT' && high >= stopPrice) { exitPrice = stopPrice; exitReason = 'SL'; break; }
    
    if (!hitTp1 && ((side === 'LONG' && high >= tp1Price) || (side === 'SHORT' && low <= tp1Price))) hitTp1 = true;
    
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
  
  return { side, pnlPct, exitReason, holdBars };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 ANALYSE DÉTAILLÉE SEPTEMBRE V24');
  console.log('═'.repeat(80));
  
  const septemberTrades = [];
  
  for (const symbol of CONFIG.symbols) {
    console.log(`\n🔍 ${symbol}`);
    
    const candles = await fetchHistoricalData(symbol, CONFIG.timeframe, CONFIG.days);
    if (candles.length < 200) continue;
    
    const lookback = 100;
    let lastTradeBar = -CONFIG.cooldownBars;
    
    for (let i = lookback; i < candles.length - 96; i++) {
      if (i - lastTradeBar < CONFIG.cooldownBars) continue;
      
      const timestamp = candles[i][0];
      const date = new Date(timestamp);
      
      // Only September
      if (date.getMonth() !== 8) continue;
      
      const historyCandles = candles.slice(i - lookback, i + 1);
      const futureCandles = candles.slice(i + 1, i + 97);
      
      const indicators = calculateIndicators(historyCandles);
      if (!indicators) continue;
      
      const { decision, score, reasons } = makeAdaptiveDecision(indicators);
      if (decision === 'NO_TRADE') continue;
      
      const result = simulateTrade(indicators, futureCandles, decision);
      if (!result) continue;
      
      septemberTrades.push({
        date: date.toISOString().slice(0, 10),
        symbol,
        side: decision,
        pnlPct: result.pnlPct,
        exitReason: result.exitReason,
        score,
        reasons,
        rsi: indicators.rsi14,
        adx: indicators.adx14,
        volumeRatio: indicators.volumeRatio,
        trend72: indicators.trend72,
        cmf: indicators.cmf20,
      });
      
      lastTradeBar = i;
    }
  }
  
  // Analyse
  septemberTrades.sort((a, b) => a.date.localeCompare(b.date));
  
  const winners = septemberTrades.filter(t => t.pnlPct > 0);
  const losers = septemberTrades.filter(t => t.pnlPct <= 0);
  
  console.log('\n' + '═'.repeat(80));
  console.log(`📈 TRADES GAGNANTS (${winners.length}):`);
  console.log('═'.repeat(80));
  
  for (const t of winners) {
    console.log(`${t.date} ${t.symbol.slice(0,3)} ${t.side}: ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}% | ${t.exitReason} | Score=${t.score} | RSI=${t.rsi.toFixed(0)} ADX=${t.adx.toFixed(0)} VOL=${t.volumeRatio.toFixed(1)} T72=${t.trend72.toFixed(1)}% CMF=${t.cmf.toFixed(2)}`);
  }
  
  console.log('\n' + '═'.repeat(80));
  console.log(`📉 TRADES PERDANTS (${losers.length}):`);
  console.log('═'.repeat(80));
  
  for (const t of losers) {
    console.log(`${t.date} ${t.symbol.slice(0,3)} ${t.side}: ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}% | ${t.exitReason} | Score=${t.score} | RSI=${t.rsi.toFixed(0)} ADX=${t.adx.toFixed(0)} VOL=${t.volumeRatio.toFixed(1)} T72=${t.trend72.toFixed(1)}% CMF=${t.cmf.toFixed(2)}`);
  }
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 PATTERNS PERDANTS:');
  console.log('═'.repeat(80));
  
  // Find patterns in losers
  const avgLoserRSI = losers.reduce((s, t) => s + t.rsi, 0) / losers.length;
  const avgLoserADX = losers.reduce((s, t) => s + t.adx, 0) / losers.length;
  const avgLoserVol = losers.reduce((s, t) => s + t.volumeRatio, 0) / losers.length;
  const avgLoserTrend = losers.reduce((s, t) => s + Math.abs(t.trend72), 0) / losers.length;
  const avgLoserCMF = losers.reduce((s, t) => s + Math.abs(t.cmf), 0) / losers.length;
  
  const avgWinnerRSI = winners.reduce((s, t) => s + t.rsi, 0) / (winners.length || 1);
  const avgWinnerADX = winners.reduce((s, t) => s + t.adx, 0) / (winners.length || 1);
  const avgWinnerVol = winners.reduce((s, t) => s + t.volumeRatio, 0) / (winners.length || 1);
  const avgWinnerTrend = winners.reduce((s, t) => s + Math.abs(t.trend72), 0) / (winners.length || 1);
  const avgWinnerCMF = winners.reduce((s, t) => s + Math.abs(t.cmf), 0) / (winners.length || 1);
  
  console.log(`RSI     : Perdants=${avgLoserRSI.toFixed(1)} | Gagnants=${avgWinnerRSI.toFixed(1)}`);
  console.log(`ADX     : Perdants=${avgLoserADX.toFixed(1)} | Gagnants=${avgWinnerADX.toFixed(1)}`);
  console.log(`Vol     : Perdants=${avgLoserVol.toFixed(1)} | Gagnants=${avgWinnerVol.toFixed(1)}`);
  console.log(`Trend72 : Perdants=${avgLoserTrend.toFixed(1)}% | Gagnants=${avgWinnerTrend.toFixed(1)}%`);
  console.log(`|CMF|   : Perdants=${avgLoserCMF.toFixed(2)} | Gagnants=${avgWinnerCMF.toFixed(2)}`);
  
  const totalPnl = septemberTrades.reduce((s, t) => s + t.pnlPct, 0);
  console.log(`\n📊 Total PnL Septembre: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%`);
  console.log(`   Trades: ${septemberTrades.length} | WR: ${(winners.length / septemberTrades.length * 100).toFixed(1)}%`);
}

main().catch(console.error);
