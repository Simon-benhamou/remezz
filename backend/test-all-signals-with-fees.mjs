/**
 * 📊 V38 - COMBINAISON DE SIGNAUX AVEC FRAIS
 * 
 * Approche: Combiner les meilleurs signaux pour améliorer le win rate
 * et réduire encore le nombre de trades
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

const CONFIG = {
  initialCapital: 10000,
  riskPerTrade: 0.01,
  fees: { roundTrip: 0.0006 },
};

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

// Helper functions
function calcSMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function getAvgVolume(c, i, period = 20) {
  return c.slice(i - period, i).reduce((s, x) => s + x[5], 0) / period;
}

// Signal detectors
const SIGNALS = {
  // Volume 3x + 5 bougies même direction
  vol3x_5candles: (c, i) => {
    if (i < 10) return null;
    const vol = c[i][5];
    const avgVol = getAvgVolume(c, i);
    if (vol < avgVol * 3) return null;
    
    const last5 = c.slice(i-5, i);
    const allUp = last5.every(x => x[4] > x[1]);
    const allDown = last5.every(x => x[4] < x[1]);
    
    if (allUp) return 'LONG';
    if (allDown) return 'SHORT';
    return null;
  },
  
  // Volume 2.5x + 4 bougies
  vol25x_4candles: (c, i) => {
    if (i < 8) return null;
    const vol = c[i][5];
    const avgVol = getAvgVolume(c, i);
    if (vol < avgVol * 2.5) return null;
    
    const last4 = c.slice(i-4, i);
    const allUp = last4.every(x => x[4] > x[1]);
    const allDown = last4.every(x => x[4] < x[1]);
    
    if (allUp) return 'LONG';
    if (allDown) return 'SHORT';
    return null;
  },
  
  // SMA cross + volume
  sma_cross: (c, i) => {
    if (i < 55) return null;
    const vol = c[i][5];
    const avgVol = getAvgVolume(c, i);
    if (vol < avgVol * 1.5) return null;
    
    const prices = c.slice(0, i + 1).map(x => x[4]);
    const prevPrices = c.slice(0, i).map(x => x[4]);
    
    const sma20 = calcSMA(prices, 20);
    const sma50 = calcSMA(prices, 50);
    const prevSma20 = calcSMA(prevPrices, 20);
    const prevSma50 = calcSMA(prevPrices, 50);
    
    if (prevSma20 <= prevSma50 && sma20 > sma50) return 'LONG';
    if (prevSma20 >= prevSma50 && sma20 < sma50) return 'SHORT';
    return null;
  },
  
  // Breakout 50 + volume 2x + trend
  breakout50_vol_trend: (c, i) => {
    if (i < 55) return null;
    const close = c[i][4];
    const vol = c[i][5];
    const avgVol = getAvgVolume(c, i);
    
    if (vol < avgVol * 2) return null;
    
    const high50 = Math.max(...c.slice(i-50, i).map(x => x[2]));
    const low50 = Math.min(...c.slice(i-50, i).map(x => x[3]));
    const close12 = c[i-12][4];
    
    if (close > high50 && close > close12) return 'LONG';
    if (close < low50 && close < close12) return 'SHORT';
    return null;
  },
  
  // Volume 4x seul
  vol4x: (c, i) => {
    if (i < 25) return null;
    const vol = c[i][5];
    const avgVol = getAvgVolume(c, i);
    
    if (vol < avgVol * 4) return null;
    
    if (c[i][4] > c[i][1]) return 'LONG';
    if (c[i][4] < c[i][1]) return 'SHORT';
    return null;
  },
  
  // Volume 3x + breakout 20
  vol3x_breakout20: (c, i) => {
    if (i < 25) return null;
    const close = c[i][4];
    const vol = c[i][5];
    const avgVol = getAvgVolume(c, i);
    
    if (vol < avgVol * 3) return null;
    
    const high20 = Math.max(...c.slice(i-20, i).map(x => x[2]));
    const low20 = Math.min(...c.slice(i-20, i).map(x => x[3]));
    
    if (close > high20) return 'LONG';
    if (close < low20) return 'SHORT';
    return null;
  },
};

async function simulateSignal(allCandles, detectFn, tpPct, slPct) {
  const allSignals = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 60; i < candles.length - 50; i++) {
      const direction = detectFn(candles, i);
      if (!direction) continue;
      allSignals.push({ 
        symbol, candleIndex: i, timestamp: candles[i][0], 
        direction, entry: candles[i][4], candles 
      });
    }
  }
  
  allSignals.sort((a, b) => a.timestamp - b.timestamp);
  
  let capital = CONFIG.initialCapital;
  const monthlyStats = {};
  let totalFees = 0, wins = 0, losses = 0;
  
  for (const signal of allSignals) {
    const entry = signal.entry;
    const candles = signal.candles;
    
    const tp = signal.direction === 'LONG' ? entry * (1 + tpPct) : entry * (1 - tpPct);
    const sl = signal.direction === 'LONG' ? entry * (1 - slPct) : entry * (1 + slPct);
    
    let outcome = null;
    for (let j = signal.candleIndex + 1; j < Math.min(signal.candleIndex + 50, candles.length); j++) {
      const high = candles[j][2];
      const low = candles[j][3];
      
      if (signal.direction === 'LONG') {
        if (low <= sl) { outcome = 'LOSS'; break; }
        if (high >= tp) { outcome = 'WIN'; break; }
      } else {
        if (high >= sl) { outcome = 'LOSS'; break; }
        if (low <= tp) { outcome = 'WIN'; break; }
      }
    }
    
    if (!outcome) continue;
    
    if (outcome === 'WIN') wins++;
    else losses++;
    
    const date = new Date(signal.timestamp);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    const riskAmount = capital * CONFIG.riskPerTrade;
    const positionSize = riskAmount / slPct;
    const fees = positionSize * CONFIG.fees.roundTrip;
    totalFees += fees;
    
    const grossPnL = outcome === 'WIN' ? positionSize * tpPct : -positionSize * slPct;
    const netPnL = grossPnL - fees;
    capital += netPnL;
    
    if (!monthlyStats[monthKey]) {
      monthlyStats[monthKey] = { startCapital: capital - netPnL, pnl: 0, trades: 0, wins: 0 };
    }
    monthlyStats[monthKey].pnl += netPnL;
    monthlyStats[monthKey].trades++;
    if (outcome === 'WIN') monthlyStats[monthKey].wins++;
  }
  
  const totalTrades = wins + losses;
  const months = Object.keys(monthlyStats).sort();
  let positiveMonths = 0;
  for (const m of months) {
    if (monthlyStats[m].pnl >= 0) positiveMonths++;
  }
  
  return {
    totalTrades, wins, losses,
    winRate: totalTrades > 0 ? (wins / totalTrades * 100) : 0,
    capital, pnl: capital - CONFIG.initialCapital,
    totalFees, positiveMonths, totalMonths: months.length,
    monthlyStats
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 V38 - TEST EXHAUSTIF DES SIGNAUX AVEC FRAIS');
  console.log('═'.repeat(80));
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 Fetching ${symbol}...`);
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  const results = [];
  
  // Test each signal with different R:R
  const rrConfigs = [
    { tp: 0.01, sl: 0.01, name: '1:1' },
    { tp: 0.015, sl: 0.01, name: '1.5:1' },
    { tp: 0.02, sl: 0.01, name: '2:1' },
    { tp: 0.025, sl: 0.01, name: '2.5:1' },
    { tp: 0.03, sl: 0.01, name: '3:1' },
    { tp: 0.02, sl: 0.015, name: '2:1.5' },
    { tp: 0.015, sl: 0.0075, name: '1.5:0.75' },
    { tp: 0.02, sl: 0.0075, name: '2:0.75' },
  ];
  
  console.log('\n🔄 Testing all combinations...\n');
  
  for (const [name, detectFn] of Object.entries(SIGNALS)) {
    for (const rr of rrConfigs) {
      const result = await simulateSignal(allCandles, detectFn, rr.tp, rr.sl);
      results.push({ signal: name, rr: rr.name, ...result });
    }
  }
  
  // Sort by: all months positive > profit > trades
  results.sort((a, b) => {
    const scoreA = (a.positiveMonths === a.totalMonths ? 100000 : a.positiveMonths * 10000) + 
                   (a.pnl > 0 ? 1000 : 0) + a.pnl;
    const scoreB = (b.positiveMonths === b.totalMonths ? 100000 : b.positiveMonths * 10000) + 
                   (b.pnl > 0 ? 1000 : 0) + b.pnl;
    return scoreB - scoreA;
  });
  
  // Show results
  console.log('═'.repeat(80));
  console.log('📊 TOP 15 CONFIGURATIONS (trié par mois positifs + profit)');
  console.log('═'.repeat(80));
  
  console.log('\n┌───────────────────────────┬─────────┬────────┬───────────┬──────────────┬────────┬──────────┐');
  console.log('│          Signal           │   R:R   │ Trades │  Win Rate │     P&L      │ Mois + │  Status  │');
  console.log('├───────────────────────────┼─────────┼────────┼───────────┼──────────────┼────────┼──────────┤');
  
  for (let i = 0; i < Math.min(15, results.length); i++) {
    const r = results[i];
    const status = r.positiveMonths === r.totalMonths && r.pnl > 0 ? '🏆' : 
                   r.positiveMonths >= 4 && r.pnl > 0 ? '🟡' :
                   r.pnl > 0 ? '✅' : '❌';
    const pnlStr = (r.pnl >= 0 ? '+' : '') + '$' + r.pnl.toFixed(0);
    
    console.log(`│ ${r.signal.padEnd(25).substring(0, 25)} │ ${r.rr.padEnd(7)} │ ${String(r.totalTrades).padStart(6)} │   ${r.winRate.toFixed(1).padStart(5)}%  │ ${pnlStr.padStart(12)} │  ${r.positiveMonths}/${r.totalMonths}   │    ${status}    │`);
  }
  
  console.log('└───────────────────────────┴─────────┴────────┴───────────┴──────────────┴────────┴──────────┘');
  
  // Show best configs that have 4+ positive months
  console.log('\n' + '═'.repeat(80));
  console.log('📈 CONFIGURATIONS AVEC 4+ MOIS POSITIFS ET PROFIT > 0');
  console.log('═'.repeat(80));
  
  const viable = results.filter(r => r.positiveMonths >= 4 && r.pnl > 0);
  
  if (viable.length === 0) {
    console.log('\n⚠️ Aucune configuration avec 4+ mois positifs et profit');
    
    // Show the best we have
    const bestProfit = results.filter(r => r.pnl > 0).sort((a, b) => b.pnl - a.pnl)[0];
    if (bestProfit) {
      console.log('\n📌 Meilleur profit (mais pas tous les mois positifs):');
      console.log(`   Signal: ${bestProfit.signal}`);
      console.log(`   R:R: ${bestProfit.rr}`);
      console.log(`   Trades: ${bestProfit.totalTrades} (${(bestProfit.totalTrades/DAYS).toFixed(1)}/jour)`);
      console.log(`   Win Rate: ${bestProfit.winRate.toFixed(1)}%`);
      console.log(`   P&L: +$${bestProfit.pnl.toFixed(0)}`);
      console.log(`   Mois positifs: ${bestProfit.positiveMonths}/${bestProfit.totalMonths}`);
      
      console.log('\n📅 Détail mensuel:');
      for (const [month, m] of Object.entries(bestProfit.monthlyStats).sort()) {
        const wr = m.trades > 0 ? (m.wins / m.trades * 100).toFixed(1) : 0;
        const pct = (m.pnl / m.startCapital * 100).toFixed(1);
        console.log(`   ${month}: ${m.trades} trades, ${wr}% WR, ${m.pnl >= 0 ? '+' : ''}${pct}% ${m.pnl >= 0 ? '✅' : '❌'}`);
      }
    }
  } else {
    for (const r of viable.slice(0, 3)) {
      console.log(`\n📌 ${r.signal} (${r.rr})`);
      console.log(`   Trades: ${r.totalTrades} (${(r.totalTrades/DAYS).toFixed(1)}/jour)`);
      console.log(`   Win Rate: ${r.winRate.toFixed(1)}%`);
      console.log(`   P&L: +$${r.pnl.toFixed(0)}`);
      console.log(`   Mois: ${r.positiveMonths}/${r.totalMonths}`);
      
      console.log('   Mensuel:');
      for (const [month, m] of Object.entries(r.monthlyStats).sort()) {
        const wr = m.trades > 0 ? (m.wins / m.trades * 100).toFixed(1) : 0;
        const pct = (m.pnl / m.startCapital * 100).toFixed(1);
        console.log(`     ${month}: ${m.trades}t, ${wr}% WR, ${m.pnl >= 0 ? '+' : ''}${pct}% ${m.pnl >= 0 ? '✅' : '❌'}`);
      }
    }
  }
  
  // Conclusion
  console.log('\n' + '═'.repeat(80));
  console.log('💡 CONCLUSION');
  console.log('═'.repeat(80));
  
  const allPositive = results.find(r => r.positiveMonths === r.totalMonths && r.pnl > 0);
  if (allPositive) {
    console.log(`
✅ CONFIGURATION OPTIMALE TROUVÉE!

Signal: ${allPositive.signal}
R:R: ${allPositive.rr}
Trades: ${allPositive.totalTrades} sur 120 jours
Profit: +$${allPositive.pnl.toFixed(0)} après frais
Tous les mois positifs!
`);
  } else {
    console.log(`
⚠️ Aucun signal ne donne 5/5 mois positifs avec les frais.

Options:
1. Accepter 3-4/5 mois positifs
2. Chercher d'autres types de signaux
3. Réduire les frais (VIP level, maker orders)
`);
  }
}

main().catch(console.error);
