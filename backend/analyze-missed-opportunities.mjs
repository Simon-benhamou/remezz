#!/usr/bin/env node
/**
 * 📊 ANALYSE APPROFONDIE - POURQUOI LA STRATÉGIE RATE LES BONS TRADES
 * 
 * Objectif: Comprendre les caractéristiques des trades gagnants vs perdants
 * pour améliorer la détection de signal
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

function calculateAllIndicators(candles) {
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
  const change24h = closes.length >= 97 ? (last - closes[closes.length - 97]) / closes[closes.length - 97] * 100 : 0;
  
  const ema9 = ema9Arr[ema9Arr.length - 1];
  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema50 = ema50Arr[ema50Arr.length - 1];
  
  const trend72 = candles.length >= 72 
    ? (closes[closes.length - 1] - closes[closes.length - 72]) / closes[closes.length - 72] * 100
    : 0;
  
  // Momentum indicators
  const momentum = closes[closes.length - 1] - closes[closes.length - 10];
  const momentumPct = (momentum / closes[closes.length - 10]) * 100;
  
  // Price position relative to range
  const high20 = Math.max(...highs.slice(-20));
  const low20 = Math.min(...lows.slice(-20));
  const pricePosition = (last - low20) / (high20 - low20);
  
  return {
    last, timestamp,
    rsi14: rsiArr[rsiArr.length - 1],
    atrPct: (atrArr[atrArr.length - 1] / last) * 100,
    adx14: adxArr[adxArr.length - 1],
    diPlus: diPlus[diPlus.length - 1],
    diMinus: diMinus[diMinus.length - 1],
    cmf20: cmfArr[cmfArr.length - 1],
    volumeRatio: currentVol / avgVol,
    trend: last > ema20 ? 1 : -1,
    emaStack: (ema9 > ema20 && ema20 > ema50) ? 1 : (ema9 < ema20 && ema20 < ema50) ? -1 : 0,
    volatilityRegime,
    change1h, change4h, change24h, trend72,
    bodyRatio,
    isBullishCandle: currentCandle[4] > currentCandle[1],
    isBearishCandle: currentCandle[4] < currentCandle[1],
    momentumPct,
    pricePosition,
    avgReturn,
    recentReturn,
  };
}

// Simuler un trade simple - juste voir si prix monte ou descend après 24h
function simulateSimpleTrade(candles, startIdx, direction) {
  const entryPrice = candles[startIdx][4];
  const futureCandles = candles.slice(startIdx + 1, startIdx + 97);
  
  if (futureCandles.length < 20) return null;
  
  // Regarder le prix après 4h, 8h, 24h
  const price4h = futureCandles[16] ? futureCandles[16][4] : entryPrice;
  const price8h = futureCandles[32] ? futureCandles[32][4] : entryPrice;
  const price24h = futureCandles[96] ? futureCandles[96][4] : futureCandles[futureCandles.length - 1][4];
  
  const pnl4h = direction === 'LONG' 
    ? ((price4h - entryPrice) / entryPrice) * 100
    : ((entryPrice - price4h) / entryPrice) * 100;
    
  const pnl8h = direction === 'LONG' 
    ? ((price8h - entryPrice) / entryPrice) * 100
    : ((entryPrice - price8h) / entryPrice) * 100;
    
  const pnl24h = direction === 'LONG' 
    ? ((price24h - entryPrice) / entryPrice) * 100
    : ((entryPrice - price24h) / entryPrice) * 100;
  
  // Max favorable et max adverse
  let maxFavorable = 0, maxAdverse = 0;
  for (const c of futureCandles.slice(0, 48)) { // 12h
    const high = c[2], low = c[3];
    if (direction === 'LONG') {
      maxFavorable = Math.max(maxFavorable, ((high - entryPrice) / entryPrice) * 100);
      maxAdverse = Math.min(maxAdverse, ((low - entryPrice) / entryPrice) * 100);
    } else {
      maxFavorable = Math.max(maxFavorable, ((entryPrice - low) / entryPrice) * 100);
      maxAdverse = Math.min(maxAdverse, ((entryPrice - high) / entryPrice) * 100);
    }
  }
  
  return { pnl4h, pnl8h, pnl24h, maxFavorable, maxAdverse };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 ANALYSE DES OPPORTUNITÉS MANQUÉES');
  console.log('═'.repeat(80));
  
  const allCandlesMap = {};
  for (const symbol of CONFIG.symbols) {
    const candles = await fetchHistoricalData(symbol, CONFIG.timeframe, CONFIG.days);
    allCandlesMap[symbol] = candles;
    console.log(`   ✅ ${symbol}: ${candles.length} candles`);
  }
  
  // Collecter TOUTES les opportunités potentielles
  const allOpportunities = [];
  const lookback = 100;
  
  for (const symbol of CONFIG.symbols) {
    const candles = allCandlesMap[symbol];
    if (!candles || candles.length < 200) continue;
    
    // Échantillonner toutes les 4h (16 bars)
    for (let i = lookback; i < candles.length - 100; i += 16) {
      const historyCandles = candles.slice(i - lookback, i + 1);
      const ind = calculateAllIndicators(historyCandles);
      if (!ind) continue;
      
      // Tester LONG
      const longResult = simulateSimpleTrade(candles, i, 'LONG');
      if (longResult) {
        allOpportunities.push({
          symbol,
          timestamp: ind.timestamp,
          direction: 'LONG',
          indicators: ind,
          ...longResult,
        });
      }
      
      // Tester SHORT
      const shortResult = simulateSimpleTrade(candles, i, 'SHORT');
      if (shortResult) {
        allOpportunities.push({
          symbol,
          timestamp: ind.timestamp,
          direction: 'SHORT',
          indicators: ind,
          ...shortResult,
        });
      }
    }
  }
  
  console.log(`\n📊 Total opportunités analysées: ${allOpportunities.length}`);
  
  // Classifier par résultat
  const bigWinners = allOpportunities.filter(o => o.pnl24h > 2); // > 2%
  const winners = allOpportunities.filter(o => o.pnl24h > 0.5 && o.pnl24h <= 2);
  const losers = allOpportunities.filter(o => o.pnl24h < -0.5);
  const bigLosers = allOpportunities.filter(o => o.pnl24h < -2);
  
  console.log(`\n🏆 Big Winners (>2%): ${bigWinners.length}`);
  console.log(`✅ Winners (0.5-2%): ${winners.length}`);
  console.log(`❌ Losers (<-0.5%): ${losers.length}`);
  console.log(`💀 Big Losers (<-2%): ${bigLosers.length}`);
  
  // Analyser les caractéristiques des big winners
  console.log('\n' + '═'.repeat(80));
  console.log('🏆 CARACTÉRISTIQUES DES BIG WINNERS (>2%)');
  console.log('═'.repeat(80));
  
  if (bigWinners.length > 0) {
    const avgRsi = bigWinners.reduce((s, o) => s + o.indicators.rsi14, 0) / bigWinners.length;
    const avgAdx = bigWinners.reduce((s, o) => s + o.indicators.adx14, 0) / bigWinners.length;
    const avgCmf = bigWinners.reduce((s, o) => s + o.indicators.cmf20, 0) / bigWinners.length;
    const avgVol = bigWinners.reduce((s, o) => s + o.indicators.volumeRatio, 0) / bigWinners.length;
    const avgMomentum = bigWinners.reduce((s, o) => s + o.indicators.momentumPct, 0) / bigWinners.length;
    const avgPricePos = bigWinners.reduce((s, o) => s + o.indicators.pricePosition, 0) / bigWinners.length;
    const avgChange1h = bigWinners.reduce((s, o) => s + Math.abs(o.indicators.change1h), 0) / bigWinners.length;
    const avgChange4h = bigWinners.reduce((s, o) => s + Math.abs(o.indicators.change4h), 0) / bigWinners.length;
    
    const regimes = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    bigWinners.forEach(o => regimes[o.indicators.volatilityRegime]++);
    
    const longCount = bigWinners.filter(o => o.direction === 'LONG').length;
    
    console.log(`   RSI moyen: ${avgRsi.toFixed(1)}`);
    console.log(`   ADX moyen: ${avgAdx.toFixed(1)}`);
    console.log(`   CMF moyen: ${avgCmf.toFixed(3)}`);
    console.log(`   Volume Ratio moyen: ${avgVol.toFixed(2)}x`);
    console.log(`   Momentum moyen: ${avgMomentum.toFixed(3)}%`);
    console.log(`   Price Position moyen: ${(avgPricePos * 100).toFixed(1)}%`);
    console.log(`   Change 1h moyen: ${avgChange1h.toFixed(3)}%`);
    console.log(`   Change 4h moyen: ${avgChange4h.toFixed(3)}%`);
    console.log(`   Régimes: HIGH=${regimes.HIGH} MEDIUM=${regimes.MEDIUM} LOW=${regimes.LOW}`);
    console.log(`   Direction: LONG=${longCount} SHORT=${bigWinners.length - longCount}`);
  }
  
  // Analyser les caractéristiques des big losers
  console.log('\n' + '═'.repeat(80));
  console.log('💀 CARACTÉRISTIQUES DES BIG LOSERS (<-2%)');
  console.log('═'.repeat(80));
  
  if (bigLosers.length > 0) {
    const avgRsi = bigLosers.reduce((s, o) => s + o.indicators.rsi14, 0) / bigLosers.length;
    const avgAdx = bigLosers.reduce((s, o) => s + o.indicators.adx14, 0) / bigLosers.length;
    const avgCmf = bigLosers.reduce((s, o) => s + o.indicators.cmf20, 0) / bigLosers.length;
    const avgVol = bigLosers.reduce((s, o) => s + o.indicators.volumeRatio, 0) / bigLosers.length;
    const avgMomentum = bigLosers.reduce((s, o) => s + o.indicators.momentumPct, 0) / bigLosers.length;
    const avgPricePos = bigLosers.reduce((s, o) => s + o.indicators.pricePosition, 0) / bigLosers.length;
    const avgChange1h = bigLosers.reduce((s, o) => s + Math.abs(o.indicators.change1h), 0) / bigLosers.length;
    const avgChange4h = bigLosers.reduce((s, o) => s + Math.abs(o.indicators.change4h), 0) / bigLosers.length;
    
    const regimes = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    bigLosers.forEach(o => regimes[o.indicators.volatilityRegime]++);
    
    console.log(`   RSI moyen: ${avgRsi.toFixed(1)}`);
    console.log(`   ADX moyen: ${avgAdx.toFixed(1)}`);
    console.log(`   CMF moyen: ${avgCmf.toFixed(3)}`);
    console.log(`   Volume Ratio moyen: ${avgVol.toFixed(2)}x`);
    console.log(`   Momentum moyen: ${avgMomentum.toFixed(3)}%`);
    console.log(`   Price Position moyen: ${(avgPricePos * 100).toFixed(1)}%`);
    console.log(`   Change 1h moyen: ${avgChange1h.toFixed(3)}%`);
    console.log(`   Change 4h moyen: ${avgChange4h.toFixed(3)}%`);
    console.log(`   Régimes: HIGH=${regimes.HIGH} MEDIUM=${regimes.MEDIUM} LOW=${regimes.LOW}`);
  }
  
  // Trouver les VRAIES différences
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 DIFFÉRENCES CLÉS WINNERS vs LOSERS');
  console.log('═'.repeat(80));
  
  if (bigWinners.length > 0 && bigLosers.length > 0) {
    const winAvg = {
      rsi: bigWinners.reduce((s, o) => s + o.indicators.rsi14, 0) / bigWinners.length,
      adx: bigWinners.reduce((s, o) => s + o.indicators.adx14, 0) / bigWinners.length,
      cmf: bigWinners.reduce((s, o) => s + o.indicators.cmf20, 0) / bigWinners.length,
      vol: bigWinners.reduce((s, o) => s + o.indicators.volumeRatio, 0) / bigWinners.length,
      pricePos: bigWinners.reduce((s, o) => s + o.indicators.pricePosition, 0) / bigWinners.length,
      momentum: bigWinners.reduce((s, o) => s + o.indicators.momentumPct, 0) / bigWinners.length,
    };
    
    const loseAvg = {
      rsi: bigLosers.reduce((s, o) => s + o.indicators.rsi14, 0) / bigLosers.length,
      adx: bigLosers.reduce((s, o) => s + o.indicators.adx14, 0) / bigLosers.length,
      cmf: bigLosers.reduce((s, o) => s + o.indicators.cmf20, 0) / bigLosers.length,
      vol: bigLosers.reduce((s, o) => s + o.indicators.volumeRatio, 0) / bigLosers.length,
      pricePos: bigLosers.reduce((s, o) => s + o.indicators.pricePosition, 0) / bigLosers.length,
      momentum: bigLosers.reduce((s, o) => s + o.indicators.momentumPct, 0) / bigLosers.length,
    };
    
    console.log(`
┌─────────────────┬─────────────┬─────────────┬─────────────┐
│   Indicateur    │   Winners   │   Losers    │   Delta     │
├─────────────────┼─────────────┼─────────────┼─────────────┤
│ RSI             │    ${winAvg.rsi.toFixed(1).padStart(6)}   │    ${loseAvg.rsi.toFixed(1).padStart(6)}   │  ${(winAvg.rsi - loseAvg.rsi).toFixed(1).padStart(7)}   │
│ ADX             │    ${winAvg.adx.toFixed(1).padStart(6)}   │    ${loseAvg.adx.toFixed(1).padStart(6)}   │  ${(winAvg.adx - loseAvg.adx).toFixed(1).padStart(7)}   │
│ CMF             │   ${winAvg.cmf.toFixed(3).padStart(7)}   │   ${loseAvg.cmf.toFixed(3).padStart(7)}   │ ${(winAvg.cmf - loseAvg.cmf).toFixed(3).padStart(8)}   │
│ Volume Ratio    │    ${winAvg.vol.toFixed(2).padStart(6)}x  │    ${loseAvg.vol.toFixed(2).padStart(6)}x  │  ${(winAvg.vol - loseAvg.vol).toFixed(2).padStart(7)}x  │
│ Price Position  │    ${(winAvg.pricePos*100).toFixed(1).padStart(5)}%  │    ${(loseAvg.pricePos*100).toFixed(1).padStart(5)}%  │  ${((winAvg.pricePos - loseAvg.pricePos)*100).toFixed(1).padStart(6)}%  │
│ Momentum        │   ${winAvg.momentum.toFixed(3).padStart(7)}% │   ${loseAvg.momentum.toFixed(3).padStart(7)}% │ ${(winAvg.momentum - loseAvg.momentum).toFixed(3).padStart(8)}% │
└─────────────────┴─────────────┴─────────────┴─────────────┘
    `);
  }
  
  // Calculer le win rate théorique optimal
  console.log('\n' + '═'.repeat(80));
  console.log('📊 POTENTIEL SI ON CAPTURAIT PARFAITEMENT LES BIG WINNERS');
  console.log('═'.repeat(80));
  
  const totalPnlBigWinners = bigWinners.reduce((s, o) => s + o.pnl24h, 0);
  const avgPnlBigWinners = bigWinners.length > 0 ? totalPnlBigWinners / bigWinners.length : 0;
  
  console.log(`\n   Big Winners: ${bigWinners.length} trades`);
  console.log(`   PnL moyen: +${avgPnlBigWinners.toFixed(2)}%`);
  console.log(`   PnL total potentiel: +${totalPnlBigWinners.toFixed(2)}%`);
  console.log(`   Trades/mois: ${(bigWinners.length / 4).toFixed(0)}`);
  
  // Analyser par mois
  console.log('\n   Par mois:');
  const byMonth = {};
  bigWinners.forEach(o => {
    const d = new Date(o.timestamp);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth[key]) byMonth[key] = { count: 0, pnl: 0 };
    byMonth[key].count++;
    byMonth[key].pnl += o.pnl24h;
  });
  
  for (const [month, data] of Object.entries(byMonth).sort()) {
    console.log(`   ${month}: ${data.count} trades, +${data.pnl.toFixed(2)}%`);
  }
  
  console.log('\n' + '═'.repeat(80));
}

main().catch(console.error);
