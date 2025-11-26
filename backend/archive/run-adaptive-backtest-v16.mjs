/**
 * STRATÉGIE ADAPTATIVE V16 - HYBRID APPROACH
 * 
 * V13 était le meilleur avec 3/4 mois positifs.
 * Problème: Septembre avait 6 trades à 33% WR = -1.59%
 * 
 * V16: 
 * 1. Garder le trend filter de V13
 * 2. Ajouter un filtre de momentum plus strict
 * 3. Réduire le nombre de trades mais améliorer la qualité
 */

import ccxt from 'ccxt';

// Configuration
const INITIAL_CAPITAL = 10000;
const DAYS = 120;
const TIMEFRAME = '15m';
const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];

// Trend filter parameters (from V13)
const TREND_LOOKBACK = 72; // 18 hours at 15min
const MIN_TREND_MOVE = 0.015; // 1.5% move required

// Additional quality filters
const MIN_MOMENTUM_SCORE = 2; // Must have at least 2 confirmations

// Exchange
const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

// Helpers
function EMA(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function SMA(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function RSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? -c : 0);
  const avgGain = SMA(gains.slice(-period));
  const avgLoss = SMA(losses.slice(-period));
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function ATR(candles, period = 14) {
  if (candles.length < period) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i][2];
    const low = candles[i][3];
    const prevClose = candles[i - 1][4];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  return SMA(trs.slice(-period));
}

function MACD(closes) {
  if (closes.length < 35) return { histogram: 0, macd: 0, signal: 0 };
  
  // Calculate proper MACD
  let emaFast = closes[0];
  let emaSlow = closes[0];
  const macdValues = [];
  
  for (let i = 0; i < closes.length; i++) {
    emaFast = closes[i] * (2/13) + emaFast * (1 - 2/13);
    emaSlow = closes[i] * (2/27) + emaSlow * (1 - 2/27);
    if (i >= 25) macdValues.push(emaFast - emaSlow);
  }
  
  if (macdValues.length < 9) return { histogram: 0, macd: 0, signal: 0 };
  
  let signal = macdValues[0];
  for (const m of macdValues) {
    signal = m * (2/10) + signal * (1 - 2/10);
  }
  
  const macd = macdValues[macdValues.length - 1];
  return { histogram: macd - signal, macd, signal };
}

function BBANDS(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return { upper: closes[closes.length - 1], middle: closes[closes.length - 1], lower: closes[closes.length - 1], percentB: 0.5 };
  const slice = closes.slice(-period);
  const sma = SMA(slice);
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  const upper = sma + stdDev * std;
  const lower = sma - stdDev * std;
  const percentB = (closes[closes.length - 1] - lower) / (upper - lower);
  return { upper, middle: sma, lower, percentB };
}

// Trend filter from V13
function hasClearTrend(candles, idx) {
  if (idx < TREND_LOOKBACK) return { hasTrend: false };
  
  const closes = candles.slice(idx - TREND_LOOKBACK, idx + 1).map(c => c[4]);
  const highs = candles.slice(idx - TREND_LOOKBACK, idx + 1).map(c => c[2]);
  const lows = candles.slice(idx - TREND_LOOKBACK, idx + 1).map(c => c[3]);
  
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const currentClose = closes[closes.length - 1];
  
  const upMove = (maxHigh - minLow) / minLow;
  const downMove = (maxHigh - minLow) / maxHigh;
  
  // Trend exists if we had a significant move
  if (upMove >= MIN_TREND_MOVE || downMove >= MIN_TREND_MOVE) {
    // Determine direction
    const firstClose = closes[0];
    const direction = currentClose > firstClose ? 'UP' : 'DOWN';
    return { hasTrend: true, direction, strength: Math.max(upMove, downMove) };
  }
  
  return { hasTrend: false };
}

// Get volatility regime
function getVolatilityRegime(atr, close) {
  const ratio = (atr / close) * 100;
  if (ratio < 1.5) return 'LOW';
  if (ratio < 3) return 'MEDIUM';
  return 'HIGH';
}

// Calculate momentum score - higher = better quality signal
function getMomentumScore(closes, rsi, macd, bb, ema20, ema50, direction) {
  let score = 0;
  const currentClose = closes[closes.length - 1];
  
  if (direction === 'LONG') {
    // EMA alignment (bullish)
    if (currentClose > ema20 && ema20 > ema50) score++;
    
    // RSI bullish momentum (not overbought)
    if (rsi > 50 && rsi < 70) score++;
    
    // MACD bullish
    if (macd.histogram > 0 && macd.macd > macd.signal) score++;
    
    // Price not at top of BB
    if (bb.percentB < 0.85) score++;
    
    // Recent momentum (last 5 closes rising)
    const last5 = closes.slice(-5);
    if (last5[4] > last5[0]) score++;
  } else {
    // EMA alignment (bearish)
    if (currentClose < ema20 && ema20 < ema50) score++;
    
    // RSI bearish momentum (not oversold)
    if (rsi < 50 && rsi > 30) score++;
    
    // MACD bearish
    if (macd.histogram < 0 && macd.macd < macd.signal) score++;
    
    // Price not at bottom of BB
    if (bb.percentB > 0.15) score++;
    
    // Recent momentum (last 5 closes falling)
    const last5 = closes.slice(-5);
    if (last5[4] < last5[0]) score++;
  }
  
  return score;
}

// Strategy signal detection
function detectSignal(candles, idx) {
  if (idx < 100) return null;
  
  // First check trend filter
  const trendResult = hasClearTrend(candles, idx);
  if (!trendResult.hasTrend) {
    return { signal: null, skipReason: 'NO_TREND' };
  }
  
  const closes = candles.slice(0, idx + 1).map(c => c[4]);
  const currentClose = closes[closes.length - 1];
  
  // Indicators
  const ema20 = EMA(closes.slice(-40), 20);
  const ema50 = EMA(closes.slice(-100), 50);
  const rsi = RSI(closes, 14);
  const macd = MACD(closes);
  const bb = BBANDS(closes);
  const atr = ATR(candles.slice(0, idx + 1), 14);
  const regime = getVolatilityRegime(atr, currentClose);
  
  // Determine potential signal direction from trend
  let potentialDirection = null;
  if (trendResult.direction === 'UP' && currentClose > ema20) {
    potentialDirection = 'LONG';
  } else if (trendResult.direction === 'DOWN' && currentClose < ema20) {
    potentialDirection = 'SHORT';
  }
  
  if (!potentialDirection) return { signal: null };
  
  // Calculate momentum score
  const momentumScore = getMomentumScore(closes, rsi, macd, bb, ema20, ema50, potentialDirection);
  
  // Require minimum momentum confirmations
  if (momentumScore < MIN_MOMENTUM_SCORE) {
    return { signal: null, skipReason: 'LOW_MOMENTUM' };
  }
  
  return { 
    signal: potentialDirection, 
    confidence: momentumScore / 5, 
    regime, 
    atr,
    momentumScore
  };
}

// Simulate trade
function simulateTrade(candles, entryIdx, signal, atrValue) {
  const entryPrice = candles[entryIdx][4];
  const slDistance = atrValue * 1.5;
  const tpDistance = atrValue * 2.5;
  
  let sl, tp;
  if (signal === 'LONG') {
    sl = entryPrice - slDistance;
    tp = entryPrice + tpDistance;
  } else {
    sl = entryPrice + slDistance;
    tp = entryPrice - tpDistance;
  }
  
  // Simulate forward
  for (let i = entryIdx + 1; i < Math.min(entryIdx + 96, candles.length); i++) {
    const high = candles[i][2];
    const low = candles[i][3];
    
    if (signal === 'LONG') {
      if (low <= sl) return { win: false, pnl: -1.2 };
      if (high >= tp) return { win: true, pnl: 2.0 };
    } else {
      if (high >= sl) return { win: false, pnl: -1.2 };
      if (low <= tp) return { win: true, pnl: 2.0 };
    }
  }
  
  // Timeout
  const exitPrice = candles[Math.min(entryIdx + 96, candles.length - 1)][4];
  const pnlPct = signal === 'LONG' 
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  return { win: pnlPct > 0, pnl: pnlPct };
}

function getYearMonth(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Main
async function main() {
  console.log('════════════════════════════════════════════════════════════════════════════════');
  console.log('📊 STRATÉGIE ADAPTATIVE V16 - TREND + MOMENTUM QUALITY');
  console.log('════════════════════════════════════════════════════════════════════════════════');
  console.log(`📅 Période: ${DAYS} jours (${Math.floor(DAYS / 30)} mois)`);
  console.log(`💰 Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log(`📈 Trend Min: ${(MIN_TREND_MOVE * 100).toFixed(1)}% sur ${TREND_LOOKBACK} bars`);
  console.log(`🎯 Momentum Score Min: ${MIN_MOMENTUM_SCORE}/5 confirmations`);
  console.log('════════════════════════════════════════════════════════════════════════════════\n');
  
  const allTrades = [];
  const regimeStats = { LOW: { trades: 0, wins: 0, pnl: 0 }, MEDIUM: { trades: 0, wins: 0, pnl: 0 }, HIGH: { trades: 0, wins: 0, pnl: 0 } };
  let noTrendSkips = 0;
  let lowMomentumSkips = 0;
  
  for (const symbol of SYMBOLS) {
    console.log('────────────────────────────────────────────────────────────────');
    console.log(`🔍 ${symbol}`);
    console.log('────────────────────────────────────────────────────────────────');
    
    const since = Date.now() - DAYS * 24 * 60 * 60 * 1000;
    console.log(`📥 Fetching ${symbol} (${DAYS} days)...`);
    
    let allCandles = [];
    let fetchSince = since;
    while (true) {
      const batch = await exchange.fetchOHLCV(symbol, TIMEFRAME, fetchSince, 1000);
      if (batch.length === 0) break;
      allCandles = allCandles.concat(batch);
      if (batch.length < 1000) break;
      fetchSince = batch[batch.length - 1][0] + 1;
      await new Promise(r => setTimeout(r, 100));
    }
    console.log(`   ✅ Got ${allCandles.length} candles`);
    
    const trades = [];
    let lastTradeIdx = -20;
    let symbolNoTrend = 0;
    let symbolLowMom = 0;
    
    for (let i = 100; i < allCandles.length - 96; i++) {
      if (i - lastTradeIdx < 16) continue;
      
      const result = detectSignal(allCandles, i);
      
      if (result && result.skipReason === 'NO_TREND') {
        symbolNoTrend++;
        continue;
      }
      if (result && result.skipReason === 'LOW_MOMENTUM') {
        symbolLowMom++;
        continue;
      }
      
      if (!result || !result.signal) continue;
      
      const trade = simulateTrade(allCandles, i, result.signal, result.atr);
      trades.push({
        ...trade,
        timestamp: allCandles[i][0],
        symbol,
        signal: result.signal,
        regime: result.regime,
        momentumScore: result.momentumScore
      });
      
      regimeStats[result.regime].trades++;
      if (trade.win) regimeStats[result.regime].wins++;
      regimeStats[result.regime].pnl += trade.pnl;
      
      lastTradeIdx = i;
    }
    
    noTrendSkips += symbolNoTrend;
    lowMomentumSkips += symbolLowMom;
    
    const symbolWins = trades.filter(t => t.win).length;
    const symbolPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
    console.log(`   Trades: ${trades.length} | WR: ${trades.length ? ((symbolWins / trades.length) * 100).toFixed(1) : 0}% | Return: ${symbolPnL >= 0 ? '+' : ''}${symbolPnL.toFixed(2)}%`);
    console.log(`   📈 Skips: ${symbolNoTrend} no-trend, ${symbolLowMom} low-momentum`);
    
    allTrades.push(...trades);
  }
  
  // Monthly breakdown
  const monthlyData = {};
  for (const trade of allTrades) {
    const month = getYearMonth(trade.timestamp);
    if (!monthlyData[month]) monthlyData[month] = { trades: 0, wins: 0, pnl: 0 };
    monthlyData[month].trades++;
    if (trade.win) monthlyData[month].wins++;
    monthlyData[month].pnl += trade.pnl;
  }
  
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('📅 PERFORMANCE MOIS PAR MOIS');
  console.log('════════════════════════════════════════════════════════════════════════════════\n');
  
  console.log('┌───────────┬────────┬────────┬───────────┬────────────────┬──────────────┐');
  console.log('│   Mois    │ Trades │   WR   │  Return   │     PnL ($)    │  Capital     │');
  console.log('├───────────┼────────┼────────┼───────────┼────────────────┼──────────────┤');
  
  let capital = INITIAL_CAPITAL;
  let positiveMonths = 0;
  let negativeMonths = [];
  const sortedMonths = Object.keys(monthlyData).sort();
  
  for (const month of sortedMonths) {
    const data = monthlyData[month];
    const wr = data.trades > 0 ? (data.wins / data.trades * 100).toFixed(1) : '0.0';
    const pnlPct = data.pnl;
    const pnlDollar = capital * (pnlPct / 100);
    capital += pnlDollar;
    
    const status = pnlPct >= 0 ? '✅' : '❌';
    if (pnlPct >= 0) positiveMonths++;
    else negativeMonths.push(month);
    
    console.log(`│ ${month} │ ${String(data.trades).padStart(6)} │ ${String(wr).padStart(5)}% │ ${status} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2).padStart(5)}% │ ${pnlPct >= 0 ? '+' : ''}$${Math.abs(pnlDollar).toFixed(0).padStart(10)} │ $${capital.toFixed(0).padStart(9)} │`);
  }
  
  console.log('└───────────┴────────┴────────┴───────────┴────────────────┴──────────────┘');
  
  // Regime stats
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('📊 PERFORMANCE PAR RÉGIME');
  console.log('════════════════════════════════════════════════════════════════════════════════');
  for (const [regime, stats] of Object.entries(regimeStats)) {
    if (stats.trades > 0) {
      const wr = (stats.wins / stats.trades * 100).toFixed(1);
      const avg = (stats.pnl / stats.trades).toFixed(3);
      console.log(`   ${regime.padEnd(8)}: ${String(stats.trades).padStart(3)} trades | ${wr.padStart(5)}% WR | ${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(2).padStart(6)}% | Avg: ${avg}%`);
    }
  }
  console.log(`   SKIPPED: ${noTrendSkips} no-trend, ${lowMomentumSkips} low-momentum`);
  
  // Momentum score analysis
  const scoreGroups = { 2: [], 3: [], 4: [], 5: [] };
  for (const t of allTrades) {
    if (scoreGroups[t.momentumScore]) scoreGroups[t.momentumScore].push(t);
  }
  console.log('\n   📊 Par Momentum Score:');
  for (const [score, trades] of Object.entries(scoreGroups)) {
    if (trades.length > 0) {
      const wins = trades.filter(t => t.win).length;
      const pnl = trades.reduce((s, t) => s + t.pnl, 0);
      console.log(`      Score ${score}: ${trades.length} trades | ${(wins/trades.length*100).toFixed(1)}% WR | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`);
    }
  }
  
  // Summary
  const totalTrades = allTrades.length;
  const totalWins = allTrades.filter(t => t.win).length;
  const totalPnL = allTrades.reduce((sum, t) => sum + t.pnl, 0);
  
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('📊 RÉSUMÉ FINAL');
  console.log('════════════════════════════════════════════════════════════════════════════════\n');
  
  console.log(`   Total Trades: ${totalTrades}`);
  console.log(`   Win Rate Global: ${totalTrades ? ((totalWins / totalTrades) * 100).toFixed(1) : 0}%`);
  console.log(`   Return Total: ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}%`);
  console.log(`   Capital Final: $${capital.toFixed(2)}`);
  
  console.log(`\n   🎯 Mois positifs: ${positiveMonths}/${sortedMonths.length}`);
  if (negativeMonths.length > 0) {
    console.log(`\n   ⚠️ Mois négatifs: ${negativeMonths.join(', ')}`);
  } else {
    console.log('\n   ✅ TOUS LES MOIS SONT POSITIFS!');
  }
  console.log(`\n   📈 Return Moyen/Mois: ${(totalPnL / sortedMonths.length).toFixed(2)}%`);
  
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
}

main().catch(console.error);
