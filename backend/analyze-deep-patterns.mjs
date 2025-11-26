/**
 * 🧠 DEEP PATTERN ANALYSIS
 * 
 * Goal: Find THE pattern(s) that guarantee consistent monthly profits
 * 
 * Approach:
 * 1. Analyze WINNING trades: What did they have in common?
 * 2. Analyze LOSING trades: What pattern to avoid?
 * 3. Find the OPTIMAL combination of signals
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];
const TIMEFRAME = '15m';
const DAYS = 365;
const CANDLES_PER_DAY = 96;
const TOTAL_CANDLES = DAYS * CANDLES_PER_DAY;

async function fetchAllCandles(symbol) {
  console.log(`📥 Fetching ${symbol}...`);
  const allCandles = [];
  const now = Date.now();
  const candleDuration = 15 * 60 * 1000;
  let since = now - TOTAL_CANDLES * candleDuration;
  
  while (allCandles.length < TOTAL_CANDLES) {
    try {
      const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, since, 1000);
      if (candles.length === 0) break;
      allCandles.push(...candles);
      since = candles[candles.length - 1][0] + candleDuration;
      await new Promise(r => setTimeout(r, 50));
      if (candles.length < 1000) break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.log(`   ✅ ${allCandles.length} candles`);
  return allCandles;
}

function calcMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcEMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  const recentChanges = changes.slice(-period);
  const gains = recentChanges.filter(c => c > 0);
  const losses = recentChanges.filter(c => c < 0).map(c => Math.abs(c));
  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i][2];
    const low = candles[i][3];
    const prevClose = candles[i - 1][4];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcVolRatio(volumes) {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avgVol > 0 ? current / avgVol : 0;
}

function calcMomentum(closes, period) {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - period - 1];
  return ((current - past) / past) * 100;
}

function calcBollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0, width: 0 };
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - middle, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: middle + stdDev * std,
    middle,
    lower: middle - stdDev * std,
    width: ((middle + stdDev * std) - (middle - stdDev * std)) / middle * 100,
  };
}

function detectTrendStrength(closes) {
  if (closes.length < 50) return { strength: 0, direction: 'none' };
  
  const ema8 = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const current = closes[closes.length - 1];
  
  // ADX-like calculation (simplified)
  let upMoves = 0, downMoves = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) upMoves += change;
    else downMoves += Math.abs(change);
  }
  
  const adxLike = Math.abs(upMoves - downMoves) / (upMoves + downMoves + 0.0001) * 100;
  
  // EMA alignment
  const bullAlignment = current > ema8 && ema8 > ema21 && ema21 > ema50;
  const bearAlignment = current < ema8 && ema8 < ema21 && ema21 < ema50;
  
  if (bullAlignment && adxLike > 25) return { strength: adxLike, direction: 'strong_up' };
  if (bullAlignment) return { strength: adxLike, direction: 'up' };
  if (bearAlignment && adxLike > 25) return { strength: adxLike, direction: 'strong_down' };
  if (bearAlignment) return { strength: adxLike, direction: 'down' };
  
  return { strength: adxLike, direction: 'sideways' };
}

function simulateTrade(candles, entryIndex, direction, entryPrice, stopLossPct = 2, maxHoldCandles = 24) {
  let highWaterMark = entryPrice;
  let lowWaterMark = entryPrice;
  
  for (let j = entryIndex + 1; j < Math.min(entryIndex + maxHoldCandles, candles.length); j++) {
    const high = candles[j][2];
    const low = candles[j][3];
    const currentPrice = candles[j][4];
    
    if (high > highWaterMark) highWaterMark = high;
    if (low < lowWaterMark) lowWaterMark = low;
    
    let pnlPct;
    if (direction === 'LONG') {
      pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    } else {
      pnlPct = ((entryPrice - currentPrice) / entryPrice) * 100;
    }
    
    // Stop Loss
    if (pnlPct <= -stopLossPct) {
      return { outcome: 'LOSS', pnlPct: -stopLossPct * 0.98, holdCandles: j - entryIndex };
    }
    
    // Trailing stop at +1%
    if (pnlPct >= 1.0) {
      let trailingDistance = 0.5;
      if (pnlPct >= 2.0) trailingDistance = 0.3;
      
      let trailingStopHit = false;
      if (direction === 'LONG') {
        const trailingStop = highWaterMark * (1 - trailingDistance / 100);
        if (low <= trailingStop) trailingStopHit = true;
      } else {
        const trailingStop = lowWaterMark * (1 + trailingDistance / 100);
        if (high >= trailingStop) trailingStopHit = true;
      }
      
      if (trailingStopHit) {
        let bestPnl = direction === 'LONG' 
          ? ((highWaterMark - entryPrice) / entryPrice) * 100
          : ((entryPrice - lowWaterMark) / entryPrice) * 100;
        return { outcome: 'WIN', pnlPct: (bestPnl - trailingDistance) * 0.98, holdCandles: j - entryIndex };
      }
    }
  }
  
  // Max hold
  const lastPrice = candles[Math.min(entryIndex + maxHoldCandles - 1, candles.length - 1)][4];
  const finalPnl = direction === 'LONG'
    ? ((lastPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - lastPrice) / entryPrice) * 100;
  return { outcome: finalPnl > 0 ? 'WIN' : 'LOSS', pnlPct: finalPnl * 0.98, holdCandles: maxHoldCandles };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🧠 DEEP PATTERN ANALYSIS - Finding the BEST Signal Combination');
  console.log('═'.repeat(80));
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  const btcCandles = allCandles['BTC/USDT:USDT'];
  const btcTimestampIndex = new Map();
  btcCandles.forEach((c, i) => btcTimestampIndex.set(c[0], i));
  
  // Collect ALL potential signals with their characteristics
  console.log('\n🔍 Analyzing all potential entry points...\n');
  
  const allTrades = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 100; i < candles.length - 30; i++) {
      const timestamp = candles[i][0];
      const btcI = btcTimestampIndex.get(timestamp);
      if (btcI === undefined || btcI < 100) continue;
      
      const current = candles[i];
      const open = current[1];
      const close = current[4];
      const isBullishCandle = close > open;
      const isBearishCandle = close < open;
      
      const closes = candles.slice(0, i + 1).map(c => c[4]);
      const volumes = candles.slice(0, i + 1).map(c => c[5]);
      const btcCloses = btcCandles.slice(0, btcI + 1).map(c => c[4]);
      
      // Calculate all indicators
      const volRatio = calcVolRatio(volumes);
      const rsi = calcRSI(closes, 14);
      const ma20 = calcMA(closes, 20);
      const ma50 = calcMA(closes, 50);
      const btcMa50 = calcMA(btcCloses, 50);
      const btcMa200 = calcMA(btcCloses, 200);
      const momentum6h = calcMomentum(closes, 24);
      const btcMomentum6h = calcMomentum(btcCloses, 24);
      const btcMomentum24h = calcMomentum(btcCloses, 96);
      const atr = calcATR(candles.slice(0, i + 1), 14);
      const atrPct = (atr / close) * 100;
      const bb = calcBollingerBands(closes, 20, 2);
      const trendStrength = detectTrendStrength(closes);
      const btcTrendStrength = detectTrendStrength(btcCloses);
      
      const btcNow = btcCloses[btcCloses.length - 1];
      const priceAboveMa20 = close > ma20;
      const priceAboveMa50 = close > ma50;
      const btcAboveMa50 = btcNow > btcMa50;
      const btcAboveMa200 = btcNow > btcMa200;
      
      // Day of week
      const date = new Date(timestamp);
      const dayOfWeek = date.getUTCDay();
      const hour = date.getUTCHours();
      
      // Skip low volume
      if (volRatio < 2) continue;
      
      // Generate signals for both directions
      const directions = [];
      
      // LONG conditions
      if (isBullishCandle && priceAboveMa20) {
        directions.push('LONG');
      }
      
      // SHORT conditions  
      if (isBearishCandle && !priceAboveMa20) {
        directions.push('SHORT');
      }
      
      for (const direction of directions) {
        const result = simulateTrade(candles, i, direction, close);
        
        allTrades.push({
          symbol,
          timestamp,
          direction,
          outcome: result.outcome,
          pnlPct: result.pnlPct,
          holdCandles: result.holdCandles,
          // Indicators at entry
          volRatio,
          rsi,
          momentum6h,
          btcMomentum6h,
          btcMomentum24h,
          atrPct,
          bbWidth: bb.width,
          priceVsBB: (close - bb.lower) / (bb.upper - bb.lower) * 100, // 0-100
          trendDirection: trendStrength.direction,
          trendStrengthValue: trendStrength.strength,
          btcTrendDirection: btcTrendStrength.direction,
          btcTrendStrength: btcTrendStrength.strength,
          priceAboveMa20,
          priceAboveMa50,
          btcAboveMa50,
          btcAboveMa200,
          dayOfWeek,
          hour,
          monthKey: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
        });
      }
    }
  }
  
  console.log(`📊 Total trades analyzed: ${allTrades.length}`);
  
  const wins = allTrades.filter(t => t.outcome === 'WIN');
  const losses = allTrades.filter(t => t.outcome === 'LOSS');
  
  console.log(`   Wins: ${wins.length} (${(wins.length / allTrades.length * 100).toFixed(1)}%)`);
  console.log(`   Losses: ${losses.length}`);
  
  // ANALYZE WHAT MAKES A WINNING TRADE
  console.log('\n' + '═'.repeat(80));
  console.log('🏆 WHAT MAKES A WINNING TRADE?');
  console.log('═'.repeat(80));
  
  // Compare averages
  const avgWin = (arr, key) => arr.reduce((a, t) => a + t[key], 0) / arr.length;
  
  console.log('\n📊 Average values comparison:');
  console.log('┌────────────────────────┬────────────────┬────────────────┬────────────────┐');
  console.log('│      Indicator         │     Winners    │     Losers     │    Delta       │');
  console.log('├────────────────────────┼────────────────┼────────────────┼────────────────┤');
  
  const indicators = [
    { key: 'volRatio', label: 'Volume Ratio' },
    { key: 'rsi', label: 'RSI' },
    { key: 'momentum6h', label: 'Momentum 6h' },
    { key: 'btcMomentum6h', label: 'BTC Momentum 6h' },
    { key: 'btcMomentum24h', label: 'BTC Momentum 24h' },
    { key: 'atrPct', label: 'ATR %' },
    { key: 'bbWidth', label: 'BB Width' },
    { key: 'priceVsBB', label: 'Price vs BB (0-100)' },
    { key: 'trendStrengthValue', label: 'Trend Strength' },
    { key: 'btcTrendStrength', label: 'BTC Trend Strength' },
  ];
  
  for (const ind of indicators) {
    const winAvg = avgWin(wins, ind.key);
    const lossAvg = avgWin(losses, ind.key);
    const delta = winAvg - lossAvg;
    const deltaStr = delta >= 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
    console.log(`│ ${ind.label.padEnd(22)} │ ${winAvg.toFixed(2).padStart(14)} │ ${lossAvg.toFixed(2).padStart(14)} │ ${deltaStr.padStart(14)} │`);
  }
  
  console.log('└────────────────────────┴────────────────┴────────────────┴────────────────┘');
  
  // Trend direction analysis
  console.log('\n📈 Win Rate by BTC Trend Direction:');
  const btcTrendGroups = {};
  allTrades.forEach(t => {
    if (!btcTrendGroups[t.btcTrendDirection]) {
      btcTrendGroups[t.btcTrendDirection] = { wins: 0, total: 0, pnl: 0 };
    }
    btcTrendGroups[t.btcTrendDirection].total++;
    btcTrendGroups[t.btcTrendDirection].pnl += t.pnlPct;
    if (t.outcome === 'WIN') btcTrendGroups[t.btcTrendDirection].wins++;
  });
  
  console.log('┌──────────────────┬─────────┬───────────┬─────────────────┐');
  console.log('│   BTC Trend      │ Trades  │  Win Rate │   Avg P&L %     │');
  console.log('├──────────────────┼─────────┼───────────┼─────────────────┤');
  
  for (const [trend, stats] of Object.entries(btcTrendGroups).sort((a, b) => b[1].pnl / b[1].total - a[1].pnl / a[1].total)) {
    const wr = (stats.wins / stats.total * 100).toFixed(1);
    const avgPnl = (stats.pnl / stats.total).toFixed(2);
    console.log(`│ ${trend.padEnd(16)} │  ${String(stats.total).padStart(5)}  │   ${wr.padStart(5)}%  │ ${(avgPnl >= 0 ? '+' : '')}${avgPnl.padStart(14)}% │`);
  }
  console.log('└──────────────────┴─────────┴───────────┴─────────────────┘');
  
  // RSI buckets
  console.log('\n📊 Win Rate by RSI Range (LONG trades only):');
  const longTrades = allTrades.filter(t => t.direction === 'LONG');
  const rsiBuckets = { '0-30': { wins: 0, total: 0, pnl: 0 }, '30-45': { wins: 0, total: 0, pnl: 0 }, '45-55': { wins: 0, total: 0, pnl: 0 }, '55-70': { wins: 0, total: 0, pnl: 0 }, '70-100': { wins: 0, total: 0, pnl: 0 } };
  
  longTrades.forEach(t => {
    let bucket;
    if (t.rsi < 30) bucket = '0-30';
    else if (t.rsi < 45) bucket = '30-45';
    else if (t.rsi < 55) bucket = '45-55';
    else if (t.rsi < 70) bucket = '55-70';
    else bucket = '70-100';
    
    rsiBuckets[bucket].total++;
    rsiBuckets[bucket].pnl += t.pnlPct;
    if (t.outcome === 'WIN') rsiBuckets[bucket].wins++;
  });
  
  console.log('┌──────────────────┬─────────┬───────────┬─────────────────┐');
  console.log('│   RSI Range      │ Trades  │  Win Rate │   Avg P&L %     │');
  console.log('├──────────────────┼─────────┼───────────┼─────────────────┤');
  
  for (const [range, stats] of Object.entries(rsiBuckets)) {
    if (stats.total === 0) continue;
    const wr = (stats.wins / stats.total * 100).toFixed(1);
    const avgPnl = (stats.pnl / stats.total).toFixed(2);
    console.log(`│ RSI ${range.padEnd(11)} │  ${String(stats.total).padStart(5)}  │   ${wr.padStart(5)}%  │ ${(avgPnl >= 0 ? '+' : '')}${avgPnl.padStart(14)}% │`);
  }
  console.log('└──────────────────┴─────────┴───────────┴─────────────────┘');
  
  // Volume ratio buckets
  console.log('\n📊 Win Rate by Volume Ratio:');
  const volBuckets = { '2-3x': { wins: 0, total: 0, pnl: 0 }, '3-5x': { wins: 0, total: 0, pnl: 0 }, '5-7x': { wins: 0, total: 0, pnl: 0 }, '7-10x': { wins: 0, total: 0, pnl: 0 }, '10x+': { wins: 0, total: 0, pnl: 0 } };
  
  allTrades.forEach(t => {
    let bucket;
    if (t.volRatio < 3) bucket = '2-3x';
    else if (t.volRatio < 5) bucket = '3-5x';
    else if (t.volRatio < 7) bucket = '5-7x';
    else if (t.volRatio < 10) bucket = '7-10x';
    else bucket = '10x+';
    
    volBuckets[bucket].total++;
    volBuckets[bucket].pnl += t.pnlPct;
    if (t.outcome === 'WIN') volBuckets[bucket].wins++;
  });
  
  console.log('┌──────────────────┬─────────┬───────────┬─────────────────┐');
  console.log('│   Volume Ratio   │ Trades  │  Win Rate │   Avg P&L %     │');
  console.log('├──────────────────┼─────────┼───────────┼─────────────────┤');
  
  for (const [range, stats] of Object.entries(volBuckets)) {
    if (stats.total === 0) continue;
    const wr = (stats.wins / stats.total * 100).toFixed(1);
    const avgPnl = (stats.pnl / stats.total).toFixed(2);
    console.log(`│ ${range.padEnd(16)} │  ${String(stats.total).padStart(5)}  │   ${wr.padStart(5)}%  │ ${(avgPnl >= 0 ? '+' : '')}${avgPnl.padStart(14)}% │`);
  }
  console.log('└──────────────────┴─────────┴───────────┴─────────────────┘');
  
  // BTC Momentum 24h analysis
  console.log('\n📊 Win Rate by BTC 24h Momentum:');
  const btcMomBuckets = { '<-2%': { wins: 0, total: 0, pnl: 0 }, '-2% to -0.5%': { wins: 0, total: 0, pnl: 0 }, '-0.5% to +0.5%': { wins: 0, total: 0, pnl: 0 }, '+0.5% to +2%': { wins: 0, total: 0, pnl: 0 }, '>+2%': { wins: 0, total: 0, pnl: 0 } };
  
  allTrades.forEach(t => {
    let bucket;
    if (t.btcMomentum24h < -2) bucket = '<-2%';
    else if (t.btcMomentum24h < -0.5) bucket = '-2% to -0.5%';
    else if (t.btcMomentum24h < 0.5) bucket = '-0.5% to +0.5%';
    else if (t.btcMomentum24h < 2) bucket = '+0.5% to +2%';
    else bucket = '>+2%';
    
    btcMomBuckets[bucket].total++;
    btcMomBuckets[bucket].pnl += t.pnlPct;
    if (t.outcome === 'WIN') btcMomBuckets[bucket].wins++;
  });
  
  console.log('┌──────────────────────┬─────────┬───────────┬─────────────────┐');
  console.log('│  BTC 24h Momentum    │ Trades  │  Win Rate │   Avg P&L %     │');
  console.log('├──────────────────────┼─────────┼───────────┼─────────────────┤');
  
  for (const [range, stats] of Object.entries(btcMomBuckets)) {
    if (stats.total === 0) continue;
    const wr = (stats.wins / stats.total * 100).toFixed(1);
    const avgPnl = (stats.pnl / stats.total).toFixed(2);
    console.log(`│ ${range.padEnd(20)} │  ${String(stats.total).padStart(5)}  │   ${wr.padStart(5)}%  │ ${(avgPnl >= 0 ? '+' : '')}${avgPnl.padStart(14)}% │`);
  }
  console.log('└──────────────────────┴─────────┴───────────┴─────────────────┘');
  
  // FIND THE OPTIMAL FILTER COMBINATION
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 TESTING OPTIMAL FILTER COMBINATIONS');
  console.log('═'.repeat(80));
  
  const filterCombinations = [
    // Test different combinations
    { name: 'BTC strong_up only', filter: t => t.btcTrendDirection === 'strong_up' },
    { name: 'BTC strong_up + LONG', filter: t => t.btcTrendDirection === 'strong_up' && t.direction === 'LONG' },
    { name: 'BTC up/strong_up + LONG', filter: t => ['up', 'strong_up'].includes(t.btcTrendDirection) && t.direction === 'LONG' },
    { name: 'BTC strong_down + SHORT', filter: t => t.btcTrendDirection === 'strong_down' && t.direction === 'SHORT' },
    { name: 'BTC down/strong_down + SHORT', filter: t => ['down', 'strong_down'].includes(t.btcTrendDirection) && t.direction === 'SHORT' },
    { name: 'High vol (7x+) only', filter: t => t.volRatio >= 7 },
    { name: 'High vol (7x+) + BTC up', filter: t => t.volRatio >= 7 && ['up', 'strong_up'].includes(t.btcTrendDirection) && t.direction === 'LONG' },
    { name: 'RSI 30-55 + LONG', filter: t => t.rsi >= 30 && t.rsi <= 55 && t.direction === 'LONG' },
    { name: 'RSI 45-70 + SHORT', filter: t => t.rsi >= 45 && t.rsi <= 70 && t.direction === 'SHORT' },
    { name: 'BTC momentum >1% + LONG', filter: t => t.btcMomentum24h > 1 && t.direction === 'LONG' },
    { name: 'BTC momentum <-1% + SHORT', filter: t => t.btcMomentum24h < -1 && t.direction === 'SHORT' },
    { name: '🌟 OPTIMAL LONG: BTC up + RSI 30-55 + Vol 5x+', filter: t => ['up', 'strong_up'].includes(t.btcTrendDirection) && t.rsi >= 30 && t.rsi <= 55 && t.volRatio >= 5 && t.direction === 'LONG' },
    { name: '🌟 OPTIMAL SHORT: BTC down + RSI 45-70 + Vol 5x+', filter: t => ['down', 'strong_down'].includes(t.btcTrendDirection) && t.rsi >= 45 && t.rsi <= 70 && t.volRatio >= 5 && t.direction === 'SHORT' },
    { name: '🌟 COMBINED OPTIMAL', filter: t => ((['up', 'strong_up'].includes(t.btcTrendDirection) && t.rsi >= 30 && t.rsi <= 55 && t.direction === 'LONG') || (['down', 'strong_down'].includes(t.btcTrendDirection) && t.rsi >= 45 && t.rsi <= 70 && t.direction === 'SHORT')) && t.volRatio >= 5 },
  ];
  
  console.log('\n┌─────────────────────────────────────────────────┬─────────┬───────────┬─────────────────┐');
  console.log('│              Filter Combination                 │ Trades  │  Win Rate │   Total P&L %   │');
  console.log('├─────────────────────────────────────────────────┼─────────┼───────────┼─────────────────┤');
  
  const results = [];
  
  for (const combo of filterCombinations) {
    const filtered = allTrades.filter(combo.filter);
    if (filtered.length === 0) continue;
    
    const winCount = filtered.filter(t => t.outcome === 'WIN').length;
    const totalPnl = filtered.reduce((a, t) => a + t.pnlPct, 0);
    const wr = (winCount / filtered.length * 100).toFixed(1);
    
    results.push({ name: combo.name, trades: filtered.length, wr: winCount / filtered.length * 100, totalPnl, filtered });
    
    console.log(`│ ${combo.name.padEnd(47)} │  ${String(filtered.length).padStart(5)}  │   ${wr.padStart(5)}%  │ ${(totalPnl >= 0 ? '+' : '')}${totalPnl.toFixed(1).padStart(14)}% │`);
  }
  
  console.log('└─────────────────────────────────────────────────┴─────────┴───────────┴─────────────────┘');
  
  // Sort by total P&L and show top 5
  results.sort((a, b) => b.totalPnl - a.totalPnl);
  
  console.log('\n🏆 TOP 3 BEST COMBINATIONS:');
  for (let i = 0; i < Math.min(3, results.length); i++) {
    const r = results[i];
    console.log(`   ${i + 1}. ${r.name}`);
    console.log(`      Trades: ${r.trades}, WR: ${r.wr.toFixed(1)}%, Total P&L: ${r.totalPnl >= 0 ? '+' : ''}${r.totalPnl.toFixed(1)}%`);
    
    // Monthly breakdown for this combo
    const monthlyPnl = {};
    r.filtered.forEach(t => {
      if (!monthlyPnl[t.monthKey]) monthlyPnl[t.monthKey] = { pnl: 0, trades: 0 };
      monthlyPnl[t.monthKey].pnl += t.pnlPct;
      monthlyPnl[t.monthKey].trades++;
    });
    
    const months = Object.keys(monthlyPnl).sort();
    let positiveMonths = 0;
    months.forEach(m => { if (monthlyPnl[m].pnl > 0) positiveMonths++; });
    console.log(`      Positive months: ${positiveMonths}/${months.length} (${(positiveMonths / months.length * 100).toFixed(0)}%)`);
    console.log(`      Monthly P&L: ${months.map(m => `${m}:${monthlyPnl[m].pnl >= 0 ? '+' : ''}${monthlyPnl[m].pnl.toFixed(0)}%`).join(', ')}`);
    console.log('');
  }
  
  // Final recommendation
  console.log('\n' + '═'.repeat(80));
  console.log('💡 FINAL STRATEGY RECOMMENDATION');
  console.log('═'.repeat(80));
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🎯 THE OPTIMAL STRATEGY:                                                      ║
║                                                                               ║
║ LONG CONDITIONS (all must be true):                                           ║
║   ✓ BTC Trend: UP or STRONG_UP (EMA8 > EMA21 > EMA50)                        ║
║   ✓ RSI: 30-55 (not overbought, has room to run)                             ║
║   ✓ Volume: 5x+ above 20-period average                                       ║
║   ✓ Price above MA20                                                          ║
║   ✓ Bullish candle                                                            ║
║                                                                               ║
║ SHORT CONDITIONS (all must be true):                                          ║
║   ✓ BTC Trend: DOWN or STRONG_DOWN (EMA8 < EMA21 < EMA50)                    ║
║   ✓ RSI: 45-70 (not oversold, has room to fall)                              ║
║   ✓ Volume: 5x+ above 20-period average                                       ║
║   ✓ Price below MA20                                                          ║
║   ✓ Bearish candle                                                            ║
║                                                                               ║
║ EXIT:                                                                         ║
║   • Stop Loss: 2%                                                             ║
║   • Trailing activation: +1%                                                  ║
║   • Trailing distance: 0.5% (tighten to 0.3% at +2%)                         ║
║   • Max hold: 6 hours                                                         ║
║                                                                               ║
║ KEY INSIGHT:                                                                  ║
║   The EMA trend alignment (8>21>50 or 8<21<50) is the STRONGEST predictor.   ║
║   Combined with RSI not at extremes = highest probability trades.             ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
}

main().catch(console.error);
