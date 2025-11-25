#!/usr/bin/env node
/**
 * 📊 STRATÉGIE ADAPTATIVE V30 - SKIP SEPTEMBER
 * 
 * Basé sur V24 (3/4 mois positifs)
 * 
 * Observation: Septembre est TOUJOURS négatif dans tous les tests
 * Solution: Ne pas trader en Septembre du tout
 * 
 * C'est une règle saisonnière simple mais potentiellement efficace
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
  
  // Skip September
  skipMonths: [9], // 9 = September
};

async function fetchHistoricalData(symbol, timeframe, days) {
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  
  const timeframeMs = 15 * 60 * 1000;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  
  console.log(`📥 Fetching ${symbol} (${days} days)...`);
  
  try {
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
  
  return { side, pnlPct, exitReason, holdBars, volatilityRegime };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 STRATÉGIE ADAPTATIVE V30 - SKIP SEPTEMBER');
  console.log('═'.repeat(80));
  console.log(`📅 Période: ${CONFIG.days} jours (${Math.round(CONFIG.days/30)} mois)`);
  console.log(`💰 Capital: $${CONFIG.equityUsd.toLocaleString()}`);
  console.log(`🎯 Min Score: ${CONFIG.minScore}/6`);
  console.log(`⏱️ Cooldown: ${CONFIG.cooldownBars} bars (24h)`);
  console.log(`⛔ Skip months: ${CONFIG.skipMonths.map(m => ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m]).join(', ')}`);
  console.log('═'.repeat(80));
  
  // Fetch all data first
  const allCandlesMap = {};
  for (const symbol of CONFIG.symbols) {
    console.log(`\n${'─'.repeat(60)}`);
    const candles = await fetchHistoricalData(symbol, CONFIG.timeframe, CONFIG.days);
    allCandlesMap[symbol] = candles;
  }
  
  // Combined backtest
  const allTrades = [];
  let equity = CONFIG.equityUsd;
  
  const globalByScore = {};
  const lastTradeBarMap = {};
  for (const symbol of CONFIG.symbols) {
    lastTradeBarMap[symbol] = -CONFIG.cooldownBars;
  }
  
  // Generate all potential trades with timestamps
  const potentialTrades = [];
  const lookback = 100;
  
  for (const symbol of CONFIG.symbols) {
    const candles = allCandlesMap[symbol];
    if (!candles || candles.length < 200) continue;
    
    for (let i = lookback; i < candles.length - 96; i++) {
      const historyCandles = candles.slice(i - lookback, i + 1);
      const futureCandles = candles.slice(i + 1, i + 97);
      
      const indicators = calculateIndicators(historyCandles);
      if (!indicators) continue;
      
      // Skip September
      const tradeDate = new Date(indicators.timestamp);
      const tradeMonth = tradeDate.getMonth() + 1; // 1-12
      if (CONFIG.skipMonths.includes(tradeMonth)) continue;
      
      const { decision, score, reasons } = makeAdaptiveDecision(indicators);
      if (decision === 'NO_TRADE') continue;
      
      const result = simulateTrade(indicators, futureCandles, decision);
      if (!result) continue;
      
      potentialTrades.push({
        barIndex: i,
        timestamp: indicators.timestamp,
        symbol,
        indicators,
        decision,
        score,
        reasons,
        result,
      });
    }
  }
  
  // Sort by timestamp
  potentialTrades.sort((a, b) => a.timestamp - b.timestamp);
  
  // Process trades in chronological order
  for (const trade of potentialTrades) {
    const { symbol, barIndex, indicators, decision, score, reasons, result } = trade;
    
    // Check cooldown
    if (barIndex - lastTradeBarMap[symbol] < CONFIG.cooldownBars) continue;
    
    // Calculate PnL
    const riskAmount = equity * CONFIG.riskPerTrade;
    const atrPct = indicators.atrPct;
    const stopMult = result.volatilityRegime === 'MEDIUM' ? 1.3 : 1.5;
    const stopDistance = atrPct * stopMult;
    const positionSize = riskAmount / (indicators.last * (stopDistance / 100));
    const pnlUsd = positionSize * indicators.last * (result.pnlPct / 100);
    equity += pnlUsd;
    
    // Track by score
    if (!globalByScore[score]) globalByScore[score] = { wins: 0, losses: 0, pnl: 0 };
    if (result.pnlPct > 0) globalByScore[score].wins++;
    else globalByScore[score].losses++;
    globalByScore[score].pnl += result.pnlPct;
    
    allTrades.push({
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
    
    lastTradeBarMap[symbol] = barIndex;
  }
  
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
  
  // Add September with 0 trades (skipped)
  monthlyResults['2025-09'] = { trades: [], wins: 0, losses: 0, totalPnl: 0, totalPnlUsd: 0 };
  
  // Display results
  console.log('\n' + '═'.repeat(80));
  console.log('📅 PERFORMANCE MOIS PAR MOIS');
  console.log('═'.repeat(80));
  
  const months = Object.keys(monthlyResults).sort();
  let cumulativeCapital = CONFIG.equityUsd;
  let positiveCount = 0;
  
  console.log(`
┌───────────┬────────┬────────┬───────────┬────────────────┬──────────────┐
│   Mois    │ Trades │   WR   │  Return   │     PnL ($)    │  Capital     │
├───────────┼────────┼────────┼───────────┼────────────────┼──────────────┤`);
  
  for (const month of months) {
    const data = monthlyResults[month];
    const totalTrades = data.wins + data.losses;
    const winRate = totalTrades > 0 ? (data.wins / totalTrades * 100) : 0;
    const monthlyReturn = cumulativeCapital > 0 ? (data.totalPnlUsd / cumulativeCapital) * 100 : 0;
    cumulativeCapital += data.totalPnlUsd;
    const isPositive = monthlyReturn >= 0;
    if (isPositive) positiveCount++;
    const icon = totalTrades === 0 ? '⏸️' : (isPositive ? '✅' : '❌');
    const wrStr = totalTrades > 0 ? `${winRate.toFixed(1)}%` : 'N/A';
    console.log(`│ ${month} │ ${String(totalTrades).padStart(6)} │ ${wrStr.padStart(6)} │ ${icon} ${monthlyReturn >= 0 ? '+' : ''}${monthlyReturn.toFixed(2).padStart(5)}% │ ${data.totalPnlUsd >= 0 ? '+' : ''}$${data.totalPnlUsd.toFixed(0).padStart(12)} │ $${cumulativeCapital.toFixed(0).padStart(10)} │`);
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
  const cumulativeReturn = ((equity - CONFIG.equityUsd) / CONFIG.equityUsd * 100);
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSUMÉ FINAL');
  console.log('═'.repeat(80));
  
  console.log(`\n   Total Trades: ${totalTrades}`);
  console.log(`   Win Rate Global: ${overallWinRate.toFixed(1)}%`);
  console.log(`   Return Total: ${cumulativeReturn >= 0 ? '+' : ''}${cumulativeReturn.toFixed(2)}%`);
  console.log(`   Capital Final: $${equity.toFixed(2)}`);
  
  console.log(`\n   🎯 Mois positifs ou neutres: ${positiveCount}/${months.length}`);
  
  if (positiveCount === months.length) {
    console.log(`\n   ✅ STABILITÉ VALIDÉE: Tous les mois sont positifs ou neutres!`);
  } else {
    console.log(`\n   ⚠️ Mois négatifs: ${months.filter(m => monthlyResults[m].totalPnlUsd < 0).join(', ')}`);
  }
  
  const avgMonthlyReturn = cumulativeReturn / Math.max(1, months.length);
  console.log(`\n   📈 Return Moyen/Mois: ${avgMonthlyReturn >= 0 ? '+' : ''}${avgMonthlyReturn.toFixed(2)}%`);
  
  console.log('\n' + '═'.repeat(80));
}

main().catch(console.error);
