/**
 * STRATÉGIE ADAPTATIVE V17 - MOMENTUM SCORE 3-4 ONLY
 * 
 * V16 a révélé:
 * - Score 2: -35.43% (trop faible)
 * - Score 3: +17.42% ✅
 * - Score 4: +40.47% ✅ (LE MEILLEUR!)
 * - Score 5: -17.30% (trop restrictif = trades forcés)
 * 
 * V17: Trade UNIQUEMENT les scores 3 et 4
 */

import ccxt from 'ccxt';

// Configuration
const INITIAL_CAPITAL = 10000;
const DAYS = 120;
const TIMEFRAME = '15m';
const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];

// Trend filter parameters
const TREND_LOOKBACK = 72;
const MIN_TREND_MOVE = 0.015;

// ONLY scores 3 and 4
const MIN_MOMENTUM_SCORE = 3;
const MAX_MOMENTUM_SCORE = 4;

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
  
  if (upMove >= MIN_TREND_MOVE || downMove >= MIN_TREND_MOVE) {
    const firstClose = closes[0];
    const direction = currentClose > firstClose ? 'UP' : 'DOWN';
    return { hasTrend: true, direction, strength: Math.max(upMove, downMove) };
  }
  
  return { hasTrend: false };
}

function getVolatilityRegime(atr, close) {
  const ratio = (atr / close) * 100;
  if (ratio < 1.5) return 'LOW';
  if (ratio < 3) return 'MEDIUM';
  return 'HIGH';
}

function getMomentumScore(closes, rsi, macd, bb, ema20, ema50, direction) {
  let score = 0;
  const currentClose = closes[closes.length - 1];
  
  if (direction === 'LONG') {
    if (currentClose > ema20 && ema20 > ema50) score++;
    if (rsi > 50 && rsi < 70) score++;
    if (macd.histogram > 0 && macd.macd > macd.signal) score++;
    if (bb.percentB < 0.85) score++;
    const last5 = closes.slice(-5);
    if (last5[4] > last5[0]) score++;
  } else {
    if (currentClose < ema20 && ema20 < ema50) score++;
    if (rsi < 50 && rsi > 30) score++;
    if (macd.histogram < 0 && macd.macd < macd.signal) score++;
    if (bb.percentB > 0.15) score++;
    const last5 = closes.slice(-5);
    if (last5[4] < last5[0]) score++;
  }
  
  return score;
}

function detectSignal(candles, idx) {
  if (idx < 100) return null;
  
  const trendResult = hasClearTrend(candles, idx);
  if (!trendResult.hasTrend) {
    return { signal: null, skipReason: 'NO_TREND' };
  }
  
  const closes = candles.slice(0, idx + 1).map(c => c[4]);
  const currentClose = closes[closes.length - 1];
  
  const ema20 = EMA(closes.slice(-40), 20);
  const ema50 = EMA(closes.slice(-100), 50);
  const rsi = RSI(closes, 14);
  const macd = MACD(closes);
  const bb = BBANDS(closes);
  const atr = ATR(candles.slice(0, idx + 1), 14);
  const regime = getVolatilityRegime(atr, currentClose);
  
  let potentialDirection = null;
  if (trendResult.direction === 'UP' && currentClose > ema20) {
    potentialDirection = 'LONG';
  } else if (trendResult.direction === 'DOWN' && currentClose < ema20) {
    potentialDirection = 'SHORT';
  }
  
  if (!potentialDirection) return { signal: null };
  
  const momentumScore = getMomentumScore(closes, rsi, macd, bb, ema20, ema50, potentialDirection);
  
  // ONLY scores 3-4
  if (momentumScore < MIN_MOMENTUM_SCORE || momentumScore > MAX_MOMENTUM_SCORE) {
    return { signal: null, skipReason: momentumScore < MIN_MOMENTUM_SCORE ? 'LOW_SCORE' : 'HIGH_SCORE' };
  }
  
  return { 
    signal: potentialDirection, 
    confidence: momentumScore / 5, 
    regime, 
    atr,
    momentumScore
  };
}

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

async function main() {
  console.log('════════════════════════════════════════════════════════════════════════════════');
  console.log('📊 STRATÉGIE ADAPTATIVE V17 - MOMENTUM SCORE 3-4 ONLY');
  console.log('════════════════════════════════════════════════════════════════════════════════');
  console.log(`📅 Période: ${DAYS} jours (${Math.floor(DAYS / 30)} mois)`);
  console.log(`💰 Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log(`📈 Trend Min: ${(MIN_TREND_MOVE * 100).toFixed(1)}% sur ${TREND_LOOKBACK} bars`);
  console.log(`🎯 Momentum Score: ${MIN_MOMENTUM_SCORE}-${MAX_MOMENTUM_SCORE} UNIQUEMENT`);
  console.log('════════════════════════════════════════════════════════════════════════════════\n');
  
  const allTrades = [];
  const regimeStats = { LOW: { trades: 0, wins: 0, pnl: 0 }, MEDIUM: { trades: 0, wins: 0, pnl: 0 }, HIGH: { trades: 0, wins: 0, pnl: 0 } };
  let noTrendSkips = 0;
  let lowScoreSkips = 0;
  let highScoreSkips = 0;
  
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
    let symbolLowScore = 0;
    let symbolHighScore = 0;
    
    for (let i = 100; i < allCandles.length - 96; i++) {
      if (i - lastTradeIdx < 16) continue;
      
      const result = detectSignal(allCandles, i);
      
      if (result && result.skipReason === 'NO_TREND') {
        symbolNoTrend++;
        continue;
      }
      if (result && result.skipReason === 'LOW_SCORE') {
        symbolLowScore++;
        continue;
      }
      if (result && result.skipReason === 'HIGH_SCORE') {
        symbolHighScore++;
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
    lowScoreSkips += symbolLowScore;
    highScoreSkips += symbolHighScore;
    
    const symbolWins = trades.filter(t => t.win).length;
    const symbolPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
    console.log(`   Trades: ${trades.length} | WR: ${trades.length ? ((symbolWins / trades.length) * 100).toFixed(1) : 0}% | Return: ${symbolPnL >= 0 ? '+' : ''}${symbolPnL.toFixed(2)}%`);
    console.log(`   📈 Skips: ${symbolNoTrend} no-trend, ${symbolLowScore} low-score, ${symbolHighScore} high-score`);
    
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
  console.log(`   SKIPPED: ${noTrendSkips} no-trend, ${lowScoreSkips} low-score, ${highScoreSkips} high-score`);
  
  // Momentum score breakdown
  const scoreGroups = { 3: [], 4: [] };
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
