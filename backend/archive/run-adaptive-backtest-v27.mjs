#!/usr/bin/env node
/**
 * 📊 STRATÉGIE ADAPTATIVE V27 - BTC FILTER
 * 
 * V24 était 3/4 mois positifs. Le problème est Septembre.
 * 
 * Nouvelle approche: Utiliser BTC comme filtre global
 * - Si BTC est en downtrend (trend72 < 0), ne pas prendre de LONG sur altcoins
 * - Si BTC est en uptrend (trend72 > 0), ne pas prendre de SHORT sur altcoins
 * 
 * L'idée: Les altcoins suivent souvent BTC
 */

import ccxt from 'ccxt';

const CONFIG = {
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
  timeframe: '15m',
  days: 120,
  equityUsd: 10000,
  riskPerTrade: 0.01,
  
  // V24 settings
  cooldownBars: 96,
  minScore: 5,
};

// Fetch with pagination
async function fetchHistoricalData(symbol, timeframe, days) {
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  
  const timeframeMs = 15 * 60 * 1000;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  
  console.log(`📥 Fetching ${symbol} (${days} days)...`);
  
  try {
    let allCandles = [];
    let currentSince = since;
    const batchSize = 1000;
    
    while (allCandles.length < days * 96) {
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

function makeAdaptiveDecision(ind, btcTrend) {
  if (ind.volatilityRegime === 'LOW') return { decision: 'NO_TRADE', score: 0 };
  if (ind.volumeRatio < 1.5 || ind.bodyRatio < 0.5) return { decision: 'NO_TRADE', score: 0 };
  
  // Check LONG
  if (ind.change1h > 0.3 && ind.change4h > 0.5 && ind.cmf20 > 0.05 && ind.trend > 0 && ind.isBullishCandle) {
    // BTC Filter: si BTC est en downtrend fort, éviter les LONG sur altcoins
    if (btcTrend < -2) return { decision: 'NO_TRADE', score: 0, reason: 'BTC_DOWN' };
    
    const { score, reasons } = calculateQualityScore(ind, 'LONG');
    if (score >= CONFIG.minScore) return { decision: 'LONG', score, reasons, confidence: 0.62 + score * 0.03 };
  }
  
  // Check SHORT
  if (ind.change1h < -0.3 && ind.change4h < -0.5 && ind.cmf20 < -0.05 && ind.trend < 0 && ind.isBearishCandle) {
    // BTC Filter: si BTC est en uptrend fort, éviter les SHORT sur altcoins
    if (btcTrend > 2) return { decision: 'NO_TRADE', score: 0, reason: 'BTC_UP' };
    
    const { score, reasons } = calculateQualityScore(ind, 'SHORT');
    if (score >= CONFIG.minScore) return { decision: 'SHORT', score, reasons, confidence: 0.64 + score * 0.03 };
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
  
  return { side, pnlPct, exitReason, holdBars, volatilityRegime };
}

// Calculate BTC trend at a given bar index
function getBtcTrend(btcCandles, barIndex) {
  if (barIndex < 72 || !btcCandles || btcCandles.length < barIndex + 1) return 0;
  
  const closes = btcCandles.slice(0, barIndex + 1).map(c => c[4]);
  if (closes.length < 72) return 0;
  
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 72];
  return ((current - past) / past) * 100;
}

async function backtestWithBtcFilter(symbol, candles, btcCandles, isBtc) {
  const trades = [];
  let equity = CONFIG.equityUsd;
  let peakEquity = equity;
  let maxDrawdown = 0;
  
  const byScore = {};
  
  const lookback = 100;
  let lastTradeBar = -CONFIG.cooldownBars;
  
  for (let i = lookback; i < candles.length - 96; i++) {
    if (i - lastTradeBar < CONFIG.cooldownBars) continue;
    
    const historyCandles = candles.slice(i - lookback, i + 1);
    const futureCandles = candles.slice(i + 1, i + 97);
    
    const indicators = calculateIndicators(historyCandles);
    if (!indicators) continue;
    
    // Get BTC trend for this bar (pour les altcoins)
    const btcTrend = isBtc ? indicators.trend72 : getBtcTrend(btcCandles, i);
    
    const { decision, score, reasons, confidence } = makeAdaptiveDecision(indicators, btcTrend);
    if (decision === 'NO_TRADE') continue;
    
    const result = simulateTrade(indicators, futureCandles, decision);
    if (!result) continue;
    
    const riskAmount = equity * CONFIG.riskPerTrade;
    const stopMult = result.volatilityRegime === 'MEDIUM' ? 1.3 : 1.5;
    const stopDistance = indicators.atrPct * stopMult;
    const positionSize = riskAmount / (indicators.last * (stopDistance / 100));
    const pnlUsd = positionSize * indicators.last * (result.pnlPct / 100);
    equity += pnlUsd;
    
    if (!byScore[score]) byScore[score] = { wins: 0, losses: 0, pnl: 0 };
    if (result.pnlPct > 0) byScore[score].wins++;
    else byScore[score].losses++;
    byScore[score].pnl += result.pnlPct;
    
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
      score,
      reasons,
    });
    
    lastTradeBar = i;
  }
  
  return { symbol, trades, equity, maxDrawdown, byScore };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 STRATÉGIE ADAPTATIVE V27 - BTC FILTER');
  console.log('═'.repeat(80));
  console.log(`📅 Période: ${CONFIG.days} jours (${Math.round(CONFIG.days/30)} mois)`);
  console.log(`💰 Capital: $${CONFIG.equityUsd.toLocaleString()}`);
  console.log(`🎯 Min Score: ${CONFIG.minScore}/6`);
  console.log(`⏱️ Cooldown: ${CONFIG.cooldownBars} bars (24h)`);
  console.log(`₿ BTC Filter: Avoid LONG when BTC down, avoid SHORT when BTC up`);
  console.log('═'.repeat(80));
  
  // First fetch BTC candles
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🔍 Fetching BTC for filter...`);
  const btcCandles = await fetchHistoricalData('BTC/USDT:USDT', CONFIG.timeframe, CONFIG.days);
  
  const allTrades = [];
  const globalByScore = {};
  
  for (const symbol of CONFIG.symbols) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🔍 ${symbol}`);
    console.log('─'.repeat(60));
    
    const candles = symbol === 'BTC/USDT:USDT' ? btcCandles : await fetchHistoricalData(symbol, CONFIG.timeframe, CONFIG.days);
    if (candles.length < 200) continue;
    
    const isBtc = symbol === 'BTC/USDT:USDT';
    const result = await backtestWithBtcFilter(symbol, candles, btcCandles, isBtc);
    allTrades.push(...result.trades);
    
    for (const [score, data] of Object.entries(result.byScore)) {
      if (!globalByScore[score]) globalByScore[score] = { wins: 0, losses: 0, pnl: 0 };
      globalByScore[score].wins += data.wins;
      globalByScore[score].losses += data.losses;
      globalByScore[score].pnl += data.pnl;
    }
    
    const wins = result.trades.filter(t => t.pnlPct > 0).length;
    const winRate = result.trades.length > 0 ? (wins / result.trades.length) * 100 : 0;
    const totalReturn = ((result.equity - CONFIG.equityUsd) / CONFIG.equityUsd) * 100;
    
    console.log(`   Trades: ${result.trades.length} | WR: ${winRate.toFixed(1)}% | Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`);
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
  console.log('📊 PERFORMANCE PAR SCORE DE QUALITÉ');
  console.log('═'.repeat(80));
  
  for (const score of Object.keys(globalByScore).sort((a, b) => Number(b) - Number(a))) {
    const r = globalByScore[score];
    const total = r.wins + r.losses;
    const wr = total > 0 ? (r.wins / total * 100).toFixed(1) : 0;
    const avgPnl = total > 0 ? (r.pnl / total).toFixed(3) : 0;
    console.log(`   Score ${score}/6: ${String(total).padStart(3)} trades | ${String(wr).padStart(5)}% WR | ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2).padStart(7)}% | Avg: ${avgPnl}%`);
  }
  
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
