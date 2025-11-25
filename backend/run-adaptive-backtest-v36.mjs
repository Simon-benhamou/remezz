/**
 * BACKTEST V36 - STRONG TREND + QUALITY FILTER
 * Signal: Strong Trend + filtres de qualité additionnels
 * Objectif: Moins de trades mais 5/5 mois positifs
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];
const TIMEFRAME = '15m';
const DAYS = 120;
const CANDLES_PER_DAY = 96;
const TOTAL_CANDLES = DAYS * CANDLES_PER_DAY;

const INITIAL_CAPITAL = 10000;
const RISK_PER_TRADE = 0.01;
const TP_PERCENT = 0.01;
const SL_PERCENT = 0.01;

async function fetchAllCandles(symbol) {
  const allCandles = [];
  const now = Date.now();
  const candleDuration = 15 * 60 * 1000;
  let since = now - TOTAL_CANDLES * candleDuration;
  
  while (allCandles.length < TOTAL_CANDLES) {
    const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, since, 1000);
    if (candles.length === 0) break;
    allCandles.push(...candles);
    since = candles[candles.length - 1][0] + candleDuration;
    await new Promise(r => setTimeout(r, 50));
  }
  
  return allCandles.slice(-TOTAL_CANDLES);
}

function detectQualitySignal(candles, i, config) {
  if (i < 60) return null;
  
  const c = candles;
  const close = c[i][4];
  const open = c[i][1];
  const high = c[i][2];
  const low = c[i][3];
  const vol = c[i][5];
  
  // Volume check
  const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
  if (vol < avgVol * config.volumeMin) return null;
  
  // 3 timeframes alignment
  const close4 = c[i-4][4];
  const close12 = c[i-12][4];
  
  const trend1 = close > c[i-1][4] ? 'UP' : 'DOWN';
  const trend4 = close > close4 ? 'UP' : 'DOWN';
  const trend12 = close > close12 ? 'UP' : 'DOWN';
  
  if (trend1 !== trend4 || trend4 !== trend12) return null;
  
  // Additional quality filters based on config
  
  // 1. Candle body size (not too small)
  const bodySize = Math.abs(close - open) / open;
  if (config.minBodySize && bodySize < config.minBodySize) return null;
  
  // 2. Not at extreme (not hitting resistance/support)
  if (config.checkExtremes) {
    const high20 = Math.max(...c.slice(i-20, i).map(x => x[2]));
    const low20 = Math.min(...c.slice(i-20, i).map(x => x[3]));
    const range20 = high20 - low20;
    
    // For LONG: don't enter if already at 80% of range
    // For SHORT: don't enter if already at 20% of range
    const position = (close - low20) / range20;
    if (trend1 === 'UP' && position > 0.85) return null;
    if (trend1 === 'DOWN' && position < 0.15) return null;
  }
  
  // 3. Momentum check (price acceleration)
  if (config.checkMomentum) {
    const change1 = (close - c[i-1][4]) / c[i-1][4];
    const change4 = (c[i-1][4] - c[i-4][4]) / c[i-4][4];
    
    // For LONG: recent change should be stronger than previous
    // For SHORT: same logic but negative
    if (trend1 === 'UP' && change1 < change4 * 0.5) return null;
    if (trend1 === 'DOWN' && change1 > change4 * 0.5) return null;
  }
  
  // 4. Volume confirmation (increasing volume)
  if (config.checkVolumeTrend) {
    const avgVol5 = c.slice(i-5, i).reduce((s, x) => s + x[5], 0) / 5;
    const avgVol10 = c.slice(i-10, i-5).reduce((s, x) => s + x[5], 0) / 5;
    
    // Volume should be increasing
    if (avgVol5 < avgVol10) return null;
  }
  
  return trend1 === 'UP' ? 'LONG' : 'SHORT';
}

async function runBacktest(allCandles, config) {
  const allSignals = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 60; i < candles.length - 30; i++) {
      const direction = detectQualitySignal(candles, i, config);
      if (!direction) continue;
      
      allSignals.push({
        symbol, candleIndex: i, timestamp: candles[i][0],
        direction, entry: candles[i][4], candles
      });
    }
  }
  
  allSignals.sort((a, b) => a.timestamp - b.timestamp);
  
  let capital = INITIAL_CAPITAL;
  const monthlyPnL = {};
  let totalWins = 0, totalLosses = 0;
  
  for (const signal of allSignals) {
    const entry = signal.entry;
    const riskAmount = capital * RISK_PER_TRADE;
    const stopDistance = entry * SL_PERCENT;
    const positionSize = riskAmount / stopDistance;
    
    const tp = signal.direction === 'LONG' ? entry * 1.01 : entry * 0.99;
    const sl = signal.direction === 'LONG' ? entry * 0.99 : entry * 1.01;
    
    const candles = signal.candles;
    let outcome = null;
    
    for (let j = signal.candleIndex + 1; j < Math.min(signal.candleIndex + 30, candles.length); j++) {
      const high = candles[j][2];
      const low = candles[j][3];
      
      if (signal.direction === 'LONG') {
        if (high >= tp) { outcome = 'WIN'; break; }
        if (low <= sl) { outcome = 'LOSS'; break; }
      } else {
        if (low <= tp) { outcome = 'WIN'; break; }
        if (high >= sl) { outcome = 'LOSS'; break; }
      }
    }
    
    if (!outcome) continue;
    
    const pnlAmount = positionSize * stopDistance * (outcome === 'WIN' ? 1 : -1);
    capital += pnlAmount;
    
    const date = new Date(signal.timestamp);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!monthlyPnL[monthKey]) monthlyPnL[monthKey] = { wins: 0, losses: 0, pnlAmount: 0, startCapital: capital - pnlAmount };
    
    if (outcome === 'WIN') { monthlyPnL[monthKey].wins++; totalWins++; }
    else { monthlyPnL[monthKey].losses++; totalLosses++; }
    monthlyPnL[monthKey].pnlAmount += pnlAmount;
  }
  
  const months = Object.keys(monthlyPnL).sort();
  let positiveMonths = 0;
  for (const m of months) {
    if (monthlyPnL[m].pnlAmount >= 0) positiveMonths++;
  }
  
  return {
    totalTrades: totalWins + totalLosses,
    wins: totalWins,
    winRate: totalWins + totalLosses > 0 ? ((totalWins / (totalWins + totalLosses)) * 100).toFixed(1) : 0,
    totalPnL: capital - INITIAL_CAPITAL,
    positiveMonths,
    totalMonths: months.length,
    monthlyPnL
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 RECHERCHE DE LA CONFIGURATION OPTIMALE');
  console.log('═'.repeat(80));
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 Fetching ${symbol}...`);
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  // Test different configurations
  const configs = [
    { name: 'Base (Vol 1.2x)', volumeMin: 1.2 },
    { name: 'Vol 1.2x + Body 0.1%', volumeMin: 1.2, minBodySize: 0.001 },
    { name: 'Vol 1.2x + Body 0.2%', volumeMin: 1.2, minBodySize: 0.002 },
    { name: 'Vol 1.2x + Extremes', volumeMin: 1.2, checkExtremes: true },
    { name: 'Vol 1.2x + Momentum', volumeMin: 1.2, checkMomentum: true },
    { name: 'Vol 1.2x + Vol Trend', volumeMin: 1.2, checkVolumeTrend: true },
    { name: 'Vol 1.3x + Extremes', volumeMin: 1.3, checkExtremes: true },
    { name: 'Vol 1.3x + All Filters', volumeMin: 1.3, checkExtremes: true, checkMomentum: true },
    { name: 'Vol 1.4x + Extremes', volumeMin: 1.4, checkExtremes: true },
    { name: 'Best combo attempt', volumeMin: 1.25, checkExtremes: true, minBodySize: 0.001 },
  ];
  
  console.log('\n📊 RÉSULTATS:\n');
  console.log('┌────────────────────────────────┬─────────┬───────────┬────────────┬──────────────┐');
  console.log('│           Config               │ Trades  │  Win Rate │  Mois +    │    P&L %     │');
  console.log('├────────────────────────────────┼─────────┼───────────┼────────────┼──────────────┤');
  
  let bestConfig = null;
  let bestScore = 0;
  
  for (const config of configs) {
    const result = await runBacktest(allCandles, config);
    
    const allPositive = result.positiveMonths === result.totalMonths;
    const status = allPositive ? '🏆' : '  ';
    const pnlPct = (result.totalPnL / INITIAL_CAPITAL * 100).toFixed(1);
    
    console.log(`│${status} ${config.name.padEnd(29)} │   ${String(result.totalTrades).padStart(4)}  │   ${String(result.winRate).padStart(5)}%  │   ${result.positiveMonths}/${result.totalMonths}      │ ${('+' + pnlPct + '%').padStart(12)} │`);
    
    // Score: prioritize 5/5 months, then trades < 3000, then PnL
    const score = (result.positiveMonths === result.totalMonths ? 1000 : 0) + 
                  (result.totalTrades < 3000 ? 100 : 0) + 
                  result.totalPnL / 1000;
    
    if (score > bestScore) {
      bestScore = score;
      bestConfig = { config, result };
    }
  }
  
  console.log('└────────────────────────────────┴─────────┴───────────┴────────────┴──────────────┘');
  
  if (bestConfig && bestConfig.result.positiveMonths === bestConfig.result.totalMonths) {
    console.log('\n' + '═'.repeat(80));
    console.log('🏆 MEILLEURE CONFIGURATION:');
    console.log('═'.repeat(80));
    console.log(`\n📌 ${bestConfig.config.name}`);
    console.log(`   Trades: ${bestConfig.result.totalTrades} (${(bestConfig.result.totalTrades/120).toFixed(1)}/jour)`);
    console.log(`   Win Rate: ${bestConfig.result.winRate}%`);
    console.log(`   P&L: +${(bestConfig.result.totalPnL/INITIAL_CAPITAL*100).toFixed(1)}%`);
    
    console.log('\n📅 Détails mensuels:');
    const months = Object.keys(bestConfig.result.monthlyPnL).sort();
    for (const month of months) {
      const m = bestConfig.result.monthlyPnL[month];
      const total = m.wins + m.losses;
      const wr = (m.wins / total * 100).toFixed(1);
      const pnlPct = (m.pnlAmount / m.startCapital * 100).toFixed(2);
      console.log(`   ${month}: ${total} trades, ${wr}% WR, ${m.pnlAmount >= 0 ? '+' : ''}${pnlPct}% ${m.pnlAmount >= 0 ? '✅' : '❌'}`);
    }
  }
}

main().catch(console.error);
