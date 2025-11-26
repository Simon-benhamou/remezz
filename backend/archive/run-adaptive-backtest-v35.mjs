/**
 * BACKTEST V35 - STRONG TREND STRICT
 * Signal plus strict pour moins de trades mais meilleure qualité
 * - 3 timeframes alignés
 * - Volume > 1.5x (au lieu de 1.2x)
 * - Candle dans le sens du trend
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

function detectStrictSignal(candles, i, config) {
  if (i < 25) return null;
  
  const c = candles;
  const vol = c[i][5];
  const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
  
  // Volume filter
  if (vol < avgVol * config.volumeMultiplier) return null;
  
  // 3 timeframes alignment
  const close = c[i][4];
  const close4 = c[i-4][4];
  const close12 = c[i-12][4];
  
  const trend1 = close > c[i-1][4] ? 'UP' : 'DOWN';
  const trend4 = close > close4 ? 'UP' : 'DOWN';
  const trend12 = close > close12 ? 'UP' : 'DOWN';
  
  // Candle direction must match trend
  const candleUp = c[i][4] > c[i][1];
  const candleDown = c[i][4] < c[i][1];
  
  if (trend1 === 'UP' && trend4 === 'UP' && trend12 === 'UP' && candleUp) {
    return 'LONG';
  }
  if (trend1 === 'DOWN' && trend4 === 'DOWN' && trend12 === 'DOWN' && candleDown) {
    return 'SHORT';
  }
  
  return null;
}

async function runBacktest(config) {
  const allCandles = config.candles;
  const allSignals = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 60; i < candles.length - 30; i++) {
      const direction = detectStrictSignal(candles, i, config);
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
    losses: totalLosses,
    winRate: ((totalWins / (totalWins + totalLosses)) * 100).toFixed(1),
    totalPnL: capital - INITIAL_CAPITAL,
    positiveMonths,
    totalMonths: months.length,
    monthlyPnL
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 TEST DE DIFFÉRENTS NIVEAUX DE FILTRAGE');
  console.log('═'.repeat(80));
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 Fetching ${symbol}...`);
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  const configs = [
    { name: 'Volume 1.2x (original)', volumeMultiplier: 1.2 },
    { name: 'Volume 1.5x', volumeMultiplier: 1.5 },
    { name: 'Volume 1.8x', volumeMultiplier: 1.8 },
    { name: 'Volume 2.0x', volumeMultiplier: 2.0 },
    { name: 'Volume 2.5x', volumeMultiplier: 2.5 },
    { name: 'Volume 3.0x', volumeMultiplier: 3.0 },
  ];
  
  console.log('\n📊 COMPARAISON DES FILTRES:\n');
  console.log('┌──────────────────────────┬─────────┬───────────┬────────────┬──────────────┐');
  console.log('│         Config           │ Trades  │  Win Rate │  Mois +    │    P&L %     │');
  console.log('├──────────────────────────┼─────────┼───────────┼────────────┼──────────────┤');
  
  for (const config of configs) {
    config.candles = allCandles;
    const result = await runBacktest(config);
    
    const allPositive = result.positiveMonths === result.totalMonths;
    const status = allPositive ? '🏆' : '  ';
    const pnlPct = (result.totalPnL / INITIAL_CAPITAL * 100).toFixed(1);
    
    console.log(`│${status} ${config.name.padEnd(23)} │   ${String(result.totalTrades).padStart(4)}  │   ${result.winRate.padStart(5)}%  │   ${result.positiveMonths}/${result.totalMonths}      │ ${('+' + pnlPct + '%').padStart(12)} │`);
    
    if (allPositive && result.totalTrades < 2000) {
      console.log('└──────────────────────────┴─────────┴───────────┴────────────┴──────────────┘');
      console.log('\n✅ CONFIGURATION OPTIMALE TROUVÉE!\n');
      
      console.log('📅 Détails mensuels:');
      const months = Object.keys(result.monthlyPnL).sort();
      for (const month of months) {
        const m = result.monthlyPnL[month];
        const total = m.wins + m.losses;
        const wr = (m.wins / total * 100).toFixed(1);
        const pnlPct = (m.pnlAmount / m.startCapital * 100).toFixed(2);
        console.log(`   ${month}: ${total} trades, ${wr}% WR, ${m.pnlAmount >= 0 ? '+' : ''}${pnlPct}% ${m.pnlAmount >= 0 ? '✅' : '❌'}`);
      }
      return;
    }
  }
  
  console.log('└──────────────────────────┴─────────┴───────────┴────────────┴──────────────┘');
  
  // Test avec filtre supplémentaire: minimum de trades par jour
  console.log('\n' + '═'.repeat(80));
  console.log('🔬 TEST AVEC FILTRE DE FRÉQUENCE (1 trade max par symbol par jour)');
  console.log('═'.repeat(80));
  
  await testWithFrequencyLimit(allCandles);
}

async function testWithFrequencyLimit(allCandles) {
  const allSignals = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 60; i < candles.length - 30; i++) {
      const direction = detectStrictSignal(candles, i, { volumeMultiplier: 1.5 });
      if (!direction) continue;
      
      allSignals.push({
        symbol, candleIndex: i, timestamp: candles[i][0],
        direction, entry: candles[i][4], candles
      });
    }
  }
  
  allSignals.sort((a, b) => a.timestamp - b.timestamp);
  
  // Filter: max 1 trade per symbol per day
  const lastTradeDay = {};
  const filteredSignals = allSignals.filter(s => {
    const day = new Date(s.timestamp).toISOString().split('T')[0];
    const key = `${s.symbol}_${day}`;
    if (lastTradeDay[key]) return false;
    lastTradeDay[key] = true;
    return true;
  });
  
  console.log(`\n📊 Signaux: ${allSignals.length} → ${filteredSignals.length} (après filtre 1/jour/symbol)`);
  
  // Run backtest on filtered signals
  let capital = INITIAL_CAPITAL;
  const monthlyPnL = {};
  let totalWins = 0, totalLosses = 0;
  
  for (const signal of filteredSignals) {
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
  
  const totalTrades = totalWins + totalLosses;
  const winRate = ((totalWins / totalTrades) * 100).toFixed(1);
  const totalPnL = capital - INITIAL_CAPITAL;
  
  console.log(`\n📈 Résultat:`);
  console.log(`   Trades: ${totalTrades} (${(totalTrades/120).toFixed(1)}/jour)`);
  console.log(`   Win Rate: ${winRate}%`);
  console.log(`   P&L: +${(totalPnL/INITIAL_CAPITAL*100).toFixed(1)}%`);
  
  console.log('\n📅 Par mois:');
  const months = Object.keys(monthlyPnL).sort();
  let positiveMonths = 0;
  
  for (const month of months) {
    const m = monthlyPnL[month];
    const total = m.wins + m.losses;
    const wr = (m.wins / total * 100).toFixed(1);
    const pnlPct = (m.pnlAmount / m.startCapital * 100).toFixed(2);
    if (m.pnlAmount >= 0) positiveMonths++;
    console.log(`   ${month}: ${total} trades, ${wr}% WR, ${m.pnlAmount >= 0 ? '+' : ''}${pnlPct}% ${m.pnlAmount >= 0 ? '✅' : '❌'}`);
  }
  
  console.log(`\n🎯 VERDICT: ${positiveMonths}/${months.length} mois positifs ${positiveMonths === months.length ? '🏆' : ''}`);
}

main().catch(console.error);
