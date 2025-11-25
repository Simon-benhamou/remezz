/**
 * 📊 V37 - SIGNAL ULTRA SÉLECTIF AVEC FRAIS RÉALISTES
 * 
 * Objectif: Réduire à ~5-10 trades/jour pour que les frais soient gérables
 * Approche: Combiner plusieurs confirmations fortes
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

// Signaux ultra sélectifs
const SIGNAL_CONFIGS = [
  {
    name: 'Breakout 50 + Vol 2x + Trend',
    detect: (c, i) => {
      if (i < 55) return null;
      
      const close = c[i][4];
      const vol = c[i][5];
      const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
      
      // Volume forte
      if (vol < avgVol * 2) return null;
      
      // Breakout 50 périodes
      const high50 = Math.max(...c.slice(i-50, i).map(x => x[2]));
      const low50 = Math.min(...c.slice(i-50, i).map(x => x[3]));
      
      // Trend alignment
      const close12 = c[i-12][4];
      const trend12 = close > close12 ? 'UP' : 'DOWN';
      
      if (close > high50 && trend12 === 'UP') return 'LONG';
      if (close < low50 && trend12 === 'DOWN') return 'SHORT';
      return null;
    }
  },
  {
    name: 'Vol 3x + 5 Candles Same Dir',
    detect: (c, i) => {
      if (i < 10) return null;
      
      const vol = c[i][5];
      const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
      
      if (vol < avgVol * 3) return null;
      
      const last5 = c.slice(i-5, i);
      const allUp = last5.every(x => x[4] > x[1]);
      const allDown = last5.every(x => x[4] < x[1]);
      
      if (allUp) return 'LONG';
      if (allDown) return 'SHORT';
      return null;
    }
  },
  {
    name: 'ATR Breakout + Vol',
    detect: (c, i) => {
      if (i < 30) return null;
      
      const vol = c[i][5];
      const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
      if (vol < avgVol * 1.5) return null;
      
      // Calculate ATR
      let atrSum = 0;
      for (let j = i - 14; j < i; j++) {
        const tr = Math.max(c[j][2] - c[j][3], Math.abs(c[j][2] - c[j-1][4]), Math.abs(c[j][3] - c[j-1][4]));
        atrSum += tr;
      }
      const atr = atrSum / 14;
      
      // Current move > 2x ATR
      const move = Math.abs(c[i][4] - c[i][1]);
      if (move < atr * 2) return null;
      
      // Trend direction
      if (c[i][4] > c[i][1]) return 'LONG';
      if (c[i][4] < c[i][1]) return 'SHORT';
      return null;
    }
  },
  {
    name: 'Breakout 100 + Vol 2x',
    detect: (c, i) => {
      if (i < 105) return null;
      
      const close = c[i][4];
      const vol = c[i][5];
      const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
      
      if (vol < avgVol * 2) return null;
      
      const high100 = Math.max(...c.slice(i-100, i).map(x => x[2]));
      const low100 = Math.min(...c.slice(i-100, i).map(x => x[3]));
      
      if (close > high100) return 'LONG';
      if (close < low100) return 'SHORT';
      return null;
    }
  },
  {
    name: 'Strong Momentum (SMA cross)',
    detect: (c, i) => {
      if (i < 55) return null;
      
      const vol = c[i][5];
      const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
      if (vol < avgVol * 1.5) return null;
      
      // SMA 20 vs SMA 50
      const sma20 = c.slice(i-20, i).reduce((s, x) => s + x[4], 0) / 20;
      const sma50 = c.slice(i-50, i).reduce((s, x) => s + x[4], 0) / 50;
      const prevSma20 = c.slice(i-21, i-1).reduce((s, x) => s + x[4], 0) / 20;
      const prevSma50 = c.slice(i-51, i-1).reduce((s, x) => s + x[4], 0) / 50;
      
      // Cross
      if (prevSma20 <= prevSma50 && sma20 > sma50) return 'LONG';
      if (prevSma20 >= prevSma50 && sma20 < sma50) return 'SHORT';
      return null;
    }
  },
  {
    name: 'Vol 2x + Price > SMA20 + Candle bullish',
    detect: (c, i) => {
      if (i < 25) return null;
      
      const close = c[i][4];
      const open = c[i][1];
      const vol = c[i][5];
      const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
      
      if (vol < avgVol * 2) return null;
      
      const sma20 = c.slice(i-20, i).reduce((s, x) => s + x[4], 0) / 20;
      
      // Price above/below SMA + candle direction
      if (close > sma20 && close > open && close > c[i-1][4]) return 'LONG';
      if (close < sma20 && close < open && close < c[i-1][4]) return 'SHORT';
      return null;
    }
  },
  {
    name: 'Extreme Volume (4x) + Any Direction',
    detect: (c, i) => {
      if (i < 25) return null;
      
      const vol = c[i][5];
      const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
      
      if (vol < avgVol * 4) return null;
      
      if (c[i][4] > c[i][1]) return 'LONG';
      if (c[i][4] < c[i][1]) return 'SHORT';
      return null;
    }
  },
  {
    name: 'Breakout + Engulfing + Vol',
    detect: (c, i) => {
      if (i < 25) return null;
      
      const vol = c[i][5];
      const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
      if (vol < avgVol * 1.5) return null;
      
      // Engulfing pattern
      const curr = c[i];
      const prev = c[i-1];
      
      const bullEngulf = curr[4] > curr[1] && curr[1] < prev[4] && curr[4] > prev[1];
      const bearEngulf = curr[4] < curr[1] && curr[1] > prev[4] && curr[4] < prev[1];
      
      // Breakout 20
      const high20 = Math.max(...c.slice(i-20, i).map(x => x[2]));
      const low20 = Math.min(...c.slice(i-20, i).map(x => x[3]));
      
      if (bullEngulf && curr[4] > high20) return 'LONG';
      if (bearEngulf && curr[4] < low20) return 'SHORT';
      return null;
    }
  }
];

async function simulateSignal(allCandles, detectFn, tpPct, slPct) {
  const allSignals = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 110; i < candles.length - 50; i++) {
      const direction = detectFn(candles, i);
      if (!direction) continue;
      allSignals.push({ symbol, candleIndex: i, timestamp: candles[i][0], direction, entry: candles[i][4], candles });
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
    totalSignals: allSignals.length,
    totalTrades,
    wins,
    winRate: totalTrades > 0 ? (wins / totalTrades * 100) : 0,
    capital,
    pnl: capital - CONFIG.initialCapital,
    totalFees,
    positiveMonths,
    totalMonths: months.length,
    monthlyStats
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 V37 - RECHERCHE DU SIGNAL ULTRA SÉLECTIF');
  console.log('═'.repeat(80));
  
  console.log('\n💡 Objectif: ~5-10 trades/jour pour couvrir les frais');
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 Fetching ${symbol}...`);
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  // Test each signal with different R:R
  const rrConfigs = [
    { tp: 0.01, sl: 0.01, name: '1:1' },
    { tp: 0.015, sl: 0.01, name: '1.5:1' },
    { tp: 0.02, sl: 0.01, name: '2:1' },
  ];
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS');
  console.log('═'.repeat(80));
  
  const results = [];
  
  for (const signal of SIGNAL_CONFIGS) {
    for (const rr of rrConfigs) {
      const result = await simulateSignal(allCandles, signal.detect, rr.tp, rr.sl);
      
      results.push({
        signal: signal.name,
        rr: rr.name,
        ...result
      });
    }
  }
  
  // Sort by positive months, then by profit
  results.sort((a, b) => {
    const scoreA = (a.positiveMonths === a.totalMonths ? 10000 : 0) + (a.pnl > 0 ? 1000 : 0) + a.pnl;
    const scoreB = (b.positiveMonths === b.totalMonths ? 10000 : 0) + (b.pnl > 0 ? 1000 : 0) + b.pnl;
    return scoreB - scoreA;
  });
  
  // Show top 10
  console.log('\n🏆 TOP 10 CONFIGURATIONS:\n');
  console.log('┌─────────────────────────────────────┬────────┬────────┬───────────┬──────────────┬──────────┬──────────┐');
  console.log('│              Signal                 │  R:R   │ Trades │  Win Rate │     P&L      │  Mois +  │  Status  │');
  console.log('├─────────────────────────────────────┼────────┼────────┼───────────┼──────────────┼──────────┼──────────┤');
  
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    const status = r.positiveMonths === r.totalMonths && r.pnl > 0 ? '🏆' : r.pnl > 0 ? '✅' : '❌';
    const pnlStr = (r.pnl >= 0 ? '+' : '') + '$' + r.pnl.toFixed(0);
    
    console.log(`│ ${r.signal.padEnd(35).substring(0, 35)} │ ${r.rr.padEnd(6)} │ ${String(r.totalTrades).padStart(6)} │   ${r.winRate.toFixed(1).padStart(5)}%  │ ${pnlStr.padStart(12)} │   ${r.positiveMonths}/${r.totalMonths}    │    ${status}    │`);
  }
  
  console.log('└─────────────────────────────────────┴────────┴────────┴───────────┴──────────────┴──────────┴──────────┘');
  
  // Best result details
  const best = results[0];
  if (best.positiveMonths === best.totalMonths && best.pnl > 0) {
    console.log('\n' + '═'.repeat(80));
    console.log('✅ MEILLEURE CONFIGURATION TROUVÉE!');
    console.log('═'.repeat(80));
    
    console.log(`\n📌 Signal: ${best.signal}`);
    console.log(`   R:R: ${best.rr}`);
    console.log(`   Trades: ${best.totalTrades} (${(best.totalTrades/DAYS).toFixed(1)}/jour)`);
    console.log(`   Win Rate: ${best.winRate.toFixed(1)}%`);
    console.log(`   P&L: +$${best.pnl.toFixed(0)} (+${(best.pnl/CONFIG.initialCapital*100).toFixed(0)}%)`);
    console.log(`   Frais: $${best.totalFees.toFixed(0)}`);
    
    console.log('\n📅 Détail mensuel:');
    const months = Object.keys(best.monthlyStats).sort();
    for (const month of months) {
      const m = best.monthlyStats[month];
      const wr = m.trades > 0 ? (m.wins / m.trades * 100).toFixed(1) : 0;
      const pnlPct = (m.pnl / m.startCapital * 100).toFixed(1);
      console.log(`   ${month}: ${m.trades} trades, ${wr}% WR, ${m.pnl >= 0 ? '+' : ''}${pnlPct}% ${m.pnl >= 0 ? '✅' : '❌'}`);
    }
  } else {
    console.log('\n⚠️ Aucune configuration ne donne tous les mois positifs avec profit positif');
    console.log('   La meilleure a quand même:');
    console.log(`   - ${best.positiveMonths}/${best.totalMonths} mois positifs`);
    console.log(`   - P&L: ${best.pnl >= 0 ? '+' : ''}$${best.pnl.toFixed(0)}`);
  }
}

main().catch(console.error);
