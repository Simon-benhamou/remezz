#!/usr/bin/env node
/**
 * 📊 RECHERCHE DE SIGNAUX PRÉDICTIFS
 * 
 * Les indicateurs classiques ne fonctionnent pas.
 * Testons des approches différentes :
 * 
 * 1. STRUCTURE DE PRIX (breakouts, support/résistance)
 * 2. ORDRE DES CANDLES (patterns)
 * 3. MOMENTUM MULTI-TIMEFRAME
 * 4. DIVERGENCES
 * 5. VOLUME PROFILE
 */

import ccxt from 'ccxt';

const CONFIG = {
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
  timeframe: '15m',
  days: 120,
};

async function fetchHistoricalData(symbol, timeframe, days) {
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();
  
  const timeframeMs = 15 * 60 * 1000;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  
  console.log(`📥 Fetching ${symbol}...`);
  
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
    
    return allCandles;
  } catch (error) {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// NOUVEAUX INDICATEURS PRÉDICTIFS
// ═══════════════════════════════════════════════════════════════

function calculateAdvancedIndicators(candles) {
  if (candles.length < 100) return null;
  
  const closes = candles.map(c => c[4]);
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const opens = candles.map(c => c[1]);
  const volumes = candles.map(c => c[5]);
  const last = closes[closes.length - 1];
  const timestamp = candles[candles.length - 1][0];
  
  // 1. BREAKOUT DETECTION
  const high20 = Math.max(...highs.slice(-21, -1));  // Excluding current
  const low20 = Math.min(...lows.slice(-21, -1));
  const high50 = Math.max(...highs.slice(-51, -1));
  const low50 = Math.min(...lows.slice(-51, -1));
  
  const breakoutUp20 = last > high20;
  const breakoutDown20 = last < low20;
  const breakoutUp50 = last > high50;
  const breakoutDown50 = last < low50;
  
  // Distance from breakout level
  const distanceFromHigh20 = ((last - high20) / high20) * 100;
  const distanceFromLow20 = ((low20 - last) / low20) * 100;
  
  // 2. CANDLE PATTERNS (last 3 candles)
  const c1 = candles[candles.length - 1];
  const c2 = candles[candles.length - 2];
  const c3 = candles[candles.length - 3];
  
  const body1 = c1[4] - c1[1];
  const body2 = c2[4] - c2[1];
  const body3 = c3[4] - c3[1];
  
  const range1 = c1[2] - c1[3];
  const range2 = c2[2] - c2[3];
  const range3 = c3[2] - c3[3];
  
  // Bullish engulfing
  const bullishEngulfing = body2 < 0 && body1 > 0 && Math.abs(body1) > Math.abs(body2) * 1.5;
  // Bearish engulfing
  const bearishEngulfing = body2 > 0 && body1 < 0 && Math.abs(body1) > Math.abs(body2) * 1.5;
  
  // 3 soldiers / 3 crows
  const threeSoldiers = body1 > 0 && body2 > 0 && body3 > 0 && c1[4] > c2[4] && c2[4] > c3[4];
  const threeCrows = body1 < 0 && body2 < 0 && body3 < 0 && c1[4] < c2[4] && c2[4] < c3[4];
  
  // Momentum bar (very large body)
  const avgRange = (range1 + range2 + range3) / 3;
  const momentumBar = range1 > avgRange * 2 && Math.abs(body1) / range1 > 0.7;
  
  // 3. HIGHER HIGHS / LOWER LOWS (Trend structure)
  const highs5 = highs.slice(-5);
  const lows5 = lows.slice(-5);
  
  let higherHighs = 0, lowerLows = 0;
  for (let i = 1; i < highs5.length; i++) {
    if (highs5[i] > highs5[i-1]) higherHighs++;
    if (lows5[i] < lows5[i-1]) lowerLows++;
  }
  
  // 4. VOLUME CONFIRMATION
  const avgVol20 = volumes.slice(-21, -1).reduce((a,b) => a+b, 0) / 20;
  const currentVol = volumes[volumes.length - 1];
  const prevVol = volumes[volumes.length - 2];
  
  const volumeSpike = currentVol > avgVol20 * 2;
  const volumeIncreasing = currentVol > prevVol && prevVol > volumes[volumes.length - 3];
  
  // 5. SUPPORT/RESISTANCE PROXIMITY
  // Find recent pivots
  const pivotHighs = [], pivotLows = [];
  for (let i = 10; i < candles.length - 10; i++) {
    const h = highs[i];
    const l = lows[i];
    const isHighPivot = highs.slice(i-5, i).every(x => x <= h) && highs.slice(i+1, i+6).every(x => x <= h);
    const isLowPivot = lows.slice(i-5, i).every(x => x >= l) && lows.slice(i+1, i+6).every(x => x >= l);
    if (isHighPivot) pivotHighs.push(h);
    if (isLowPivot) pivotLows.push(l);
  }
  
  // Nearest resistance and support
  const resistance = pivotHighs.filter(p => p > last).sort((a,b) => a-b)[0] || last * 1.1;
  const support = pivotLows.filter(p => p < last).sort((a,b) => b-a)[0] || last * 0.9;
  
  const distanceToResistance = ((resistance - last) / last) * 100;
  const distanceToSupport = ((last - support) / last) * 100;
  const riskRewardToResistance = distanceToResistance / Math.max(distanceToSupport, 0.1);
  
  // 6. CONSECUTIVE CANDLES
  let consecutiveUp = 0, consecutiveDown = 0;
  for (let i = closes.length - 1; i > 0; i--) {
    if (closes[i] > closes[i-1]) {
      if (consecutiveDown > 0) break;
      consecutiveUp++;
    } else {
      if (consecutiveUp > 0) break;
      consecutiveDown++;
    }
  }
  
  // 7. PRICE COMPRESSION (Bollinger Band squeeze)
  const sma20 = closes.slice(-20).reduce((a,b) => a+b, 0) / 20;
  const std20 = Math.sqrt(closes.slice(-20).map(c => Math.pow(c - sma20, 2)).reduce((a,b) => a+b, 0) / 20);
  const bbWidth = (std20 * 2 / sma20) * 100;
  
  const sma20_prev = closes.slice(-40, -20).reduce((a,b) => a+b, 0) / 20;
  const std20_prev = Math.sqrt(closes.slice(-40, -20).map(c => Math.pow(c - sma20_prev, 2)).reduce((a,b) => a+b, 0) / 20);
  const bbWidth_prev = (std20_prev * 2 / sma20_prev) * 100;
  
  const squeeze = bbWidth < bbWidth_prev * 0.7;
  const expansion = bbWidth > bbWidth_prev * 1.3;
  
  // 8. RELATIVE STRENGTH vs BTC (pour altcoins)
  // (Sera calculé séparément)
  
  return {
    timestamp, last,
    // Breakouts
    breakoutUp20, breakoutDown20, breakoutUp50, breakoutDown50,
    distanceFromHigh20, distanceFromLow20,
    // Patterns
    bullishEngulfing, bearishEngulfing, threeSoldiers, threeCrows, momentumBar,
    // Trend structure
    higherHighs, lowerLows,
    // Volume
    volumeSpike, volumeIncreasing, volumeRatio: currentVol / avgVol20,
    // S/R
    distanceToResistance, distanceToSupport, riskRewardToResistance,
    // Consecutive
    consecutiveUp, consecutiveDown,
    // Compression
    bbWidth, squeeze, expansion,
  };
}

function simulateSimpleTrade(candles, startIdx, direction) {
  const entryPrice = candles[startIdx][4];
  const futureCandles = candles.slice(startIdx + 1, startIdx + 97);
  
  if (futureCandles.length < 20) return null;
  
  const price24h = futureCandles[95] ? futureCandles[95][4] : futureCandles[futureCandles.length - 1][4];
  
  const pnl24h = direction === 'LONG' 
    ? ((price24h - entryPrice) / entryPrice) * 100
    : ((entryPrice - price24h) / entryPrice) * 100;
  
  return { pnl24h };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 RECHERCHE DE SIGNAUX PRÉDICTIFS AVANCÉS');
  console.log('═'.repeat(80));
  
  const allCandlesMap = {};
  for (const symbol of CONFIG.symbols) {
    const candles = await fetchHistoricalData(symbol, CONFIG.timeframe, CONFIG.days);
    allCandlesMap[symbol] = candles;
    console.log(`   ✅ ${symbol}: ${candles.length} candles`);
  }
  
  // Collecter toutes les opportunités avec les nouveaux indicateurs
  const opportunities = [];
  const lookback = 100;
  
  for (const symbol of CONFIG.symbols) {
    const candles = allCandlesMap[symbol];
    if (!candles || candles.length < 200) continue;
    
    for (let i = lookback; i < candles.length - 100; i += 8) { // Toutes les 2h
      const historyCandles = candles.slice(i - lookback, i + 1);
      const ind = calculateAdvancedIndicators(historyCandles);
      if (!ind) continue;
      
      // Tester LONG
      const longResult = simulateSimpleTrade(candles, i, 'LONG');
      if (longResult) {
        opportunities.push({ symbol, direction: 'LONG', indicators: ind, ...longResult });
      }
      
      // Tester SHORT
      const shortResult = simulateSimpleTrade(candles, i, 'SHORT');
      if (shortResult) {
        opportunities.push({ symbol, direction: 'SHORT', indicators: ind, ...shortResult });
      }
    }
  }
  
  console.log(`\n📊 Total samples: ${opportunities.length}`);
  
  // Séparer winners et losers
  const bigWinners = opportunities.filter(o => o.pnl24h > 2);
  const bigLosers = opportunities.filter(o => o.pnl24h < -2);
  
  console.log(`🏆 Big Winners (>2%): ${bigWinners.length}`);
  console.log(`💀 Big Losers (<-2%): ${bigLosers.length}`);
  
  // Analyser chaque nouveau signal
  console.log('\n' + '═'.repeat(80));
  console.log('🔍 ANALYSE DES NOUVEAUX SIGNAUX');
  console.log('═'.repeat(80));
  
  const signals = [
    { name: 'Breakout Up 20', filter: o => o.indicators.breakoutUp20 && o.direction === 'LONG' },
    { name: 'Breakout Down 20', filter: o => o.indicators.breakoutDown20 && o.direction === 'SHORT' },
    { name: 'Breakout Up 50', filter: o => o.indicators.breakoutUp50 && o.direction === 'LONG' },
    { name: 'Breakout Down 50', filter: o => o.indicators.breakoutDown50 && o.direction === 'SHORT' },
    { name: 'Bullish Engulfing', filter: o => o.indicators.bullishEngulfing && o.direction === 'LONG' },
    { name: 'Bearish Engulfing', filter: o => o.indicators.bearishEngulfing && o.direction === 'SHORT' },
    { name: 'Three Soldiers', filter: o => o.indicators.threeSoldiers && o.direction === 'LONG' },
    { name: 'Three Crows', filter: o => o.indicators.threeCrows && o.direction === 'SHORT' },
    { name: 'Momentum Bar Up', filter: o => o.indicators.momentumBar && o.direction === 'LONG' },
    { name: 'Momentum Bar Down', filter: o => o.indicators.momentumBar && o.direction === 'SHORT' },
    { name: 'Volume Spike', filter: o => o.indicators.volumeSpike },
    { name: 'Squeeze + Breakout Up', filter: o => o.indicators.squeeze && o.indicators.breakoutUp20 && o.direction === 'LONG' },
    { name: 'Squeeze + Breakout Down', filter: o => o.indicators.squeeze && o.indicators.breakoutDown20 && o.direction === 'SHORT' },
    { name: 'Higher Highs (4/4)', filter: o => o.indicators.higherHighs >= 4 && o.direction === 'LONG' },
    { name: 'Lower Lows (4/4)', filter: o => o.indicators.lowerLows >= 4 && o.direction === 'SHORT' },
    { name: 'Good R:R (>2)', filter: o => o.indicators.riskRewardToResistance > 2 && o.direction === 'LONG' },
    { name: 'Volume + Breakout Up', filter: o => o.indicators.volumeSpike && o.indicators.breakoutUp20 && o.direction === 'LONG' },
    { name: 'Volume + Breakout Down', filter: o => o.indicators.volumeSpike && o.indicators.breakoutDown20 && o.direction === 'SHORT' },
    { name: 'Consec Up ≥3', filter: o => o.indicators.consecutiveUp >= 3 && o.direction === 'LONG' },
    { name: 'Consec Down ≥3', filter: o => o.indicators.consecutiveDown >= 3 && o.direction === 'SHORT' },
    { name: 'Expansion Phase', filter: o => o.indicators.expansion },
  ];
  
  console.log(`
┌──────────────────────────────┬─────────┬─────────┬─────────┬──────────┬──────────┐
│           Signal             │ Trades  │ Win Rate│ Avg PnL │ Total PnL│  Edge?   │
├──────────────────────────────┼─────────┼─────────┼─────────┼──────────┼──────────┤`);
  
  const goodSignals = [];
  
  for (const signal of signals) {
    const matches = opportunities.filter(signal.filter);
    if (matches.length < 10) continue;
    
    const winners = matches.filter(o => o.pnl24h > 0).length;
    const winRate = (winners / matches.length) * 100;
    const avgPnl = matches.reduce((s, o) => s + o.pnl24h, 0) / matches.length;
    const totalPnl = matches.reduce((s, o) => s + o.pnl24h, 0);
    
    const edge = winRate > 55 || avgPnl > 0.3 ? '✅' : (winRate > 50 && avgPnl > 0 ? '🟡' : '❌');
    
    if (winRate > 53 && avgPnl > 0.1) {
      goodSignals.push({ ...signal, winRate, avgPnl, totalPnl, count: matches.length });
    }
    
    console.log(`│ ${signal.name.padEnd(28)} │ ${String(matches.length).padStart(7)} │ ${winRate.toFixed(1).padStart(6)}% │ ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2).padStart(6)}% │ ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(0).padStart(7)}% │    ${edge}     │`);
  }
  
  console.log(`└──────────────────────────────┴─────────┴─────────┴─────────┴──────────┴──────────┘`);
  
  // Combiner les meilleurs signaux
  if (goodSignals.length > 0) {
    console.log('\n' + '═'.repeat(80));
    console.log('🎯 SIGNAUX PROMETTEURS (WR > 53% ET Avg PnL > 0.1%)');
    console.log('═'.repeat(80));
    
    goodSignals.sort((a, b) => b.avgPnl - a.avgPnl);
    
    for (const sig of goodSignals) {
      console.log(`   ${sig.name}: ${sig.count} trades, ${sig.winRate.toFixed(1)}% WR, +${sig.avgPnl.toFixed(2)}% avg`);
    }
    
    // Tester une combinaison
    console.log('\n' + '═'.repeat(80));
    console.log('🔬 TEST: COMBINAISON DES MEILLEURS SIGNAUX');
    console.log('═'.repeat(80));
    
    // Breakout + Volume + Direction trend
    const combinedLong = opportunities.filter(o => 
      o.direction === 'LONG' &&
      o.indicators.breakoutUp20 &&
      o.indicators.volumeRatio > 1.5 &&
      o.indicators.higherHighs >= 2
    );
    
    const combinedShort = opportunities.filter(o => 
      o.direction === 'SHORT' &&
      o.indicators.breakoutDown20 &&
      o.indicators.volumeRatio > 1.5 &&
      o.indicators.lowerLows >= 2
    );
    
    const combined = [...combinedLong, ...combinedShort];
    
    if (combined.length > 0) {
      const winnersComb = combined.filter(o => o.pnl24h > 0).length;
      const wrComb = (winnersComb / combined.length) * 100;
      const avgPnlComb = combined.reduce((s, o) => s + o.pnl24h, 0) / combined.length;
      const totalPnlComb = combined.reduce((s, o) => s + o.pnl24h, 0);
      
      console.log(`\n   BREAKOUT + VOLUME + TREND STRUCTURE:`);
      console.log(`   Trades: ${combined.length}`);
      console.log(`   Win Rate: ${wrComb.toFixed(1)}%`);
      console.log(`   Avg PnL: ${avgPnlComb >= 0 ? '+' : ''}${avgPnlComb.toFixed(2)}%`);
      console.log(`   Total PnL: ${totalPnlComb >= 0 ? '+' : ''}${totalPnlComb.toFixed(1)}%`);
      
      // Par mois
      console.log('\n   Par mois:');
      const byMonth = {};
      combined.forEach(o => {
        const d = new Date(o.indicators.timestamp);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!byMonth[key]) byMonth[key] = { count: 0, pnl: 0, wins: 0 };
        byMonth[key].count++;
        byMonth[key].pnl += o.pnl24h;
        if (o.pnl24h > 0) byMonth[key].wins++;
      });
      
      for (const [month, data] of Object.entries(byMonth).sort()) {
        const wr = data.count > 0 ? (data.wins / data.count * 100).toFixed(0) : 0;
        const icon = data.pnl >= 0 ? '✅' : '❌';
        console.log(`   ${month}: ${data.count} trades, ${wr}% WR, ${icon} ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(1)}%`);
      }
    }
  }
  
  console.log('\n' + '═'.repeat(80));
}

main().catch(console.error);
