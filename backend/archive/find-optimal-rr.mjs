/**
 * 📊 RECHERCHE DU R:R OPTIMAL - V33 AVEC FRAIS
 * 
 * Problème: Avec TP/SL 1:1, les frais mangent tout le profit
 * Solution: Trouver le bon ratio R:R pour être rentable
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
  fees: { roundTrip: 0.0006 },  // 0.06% roundtrip
  leverage: 4,
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

function detectV33Signal(candles, i) {
  if (i < 15) return null;
  
  const c = candles;
  const vol = c[i][5];
  const avgVol = c.slice(i-20, i).reduce((s, x) => s + x[5], 0) / 20;
  
  if (vol < avgVol * 1.2) return null;
  
  const close = c[i][4];
  const close4 = c[i-4][4];
  const close12 = c[i-12][4];
  
  const trend1 = close > c[i-1][4] ? 'UP' : 'DOWN';
  const trend4 = close > close4 ? 'UP' : 'DOWN';
  const trend12 = close > close12 ? 'UP' : 'DOWN';
  
  if (trend1 === 'UP' && trend4 === 'UP' && trend12 === 'UP') return 'LONG';
  if (trend1 === 'DOWN' && trend4 === 'DOWN' && trend12 === 'DOWN') return 'SHORT';
  
  return null;
}

async function simulateWithRR(allCandles, allSignals, tpPct, slPct) {
  let capital = CONFIG.initialCapital;
  const monthlyStats = {};
  let totalFees = 0;
  let wins = 0, losses = 0, timeouts = 0;
  
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
        // Check SL first (safer)
        if (low <= sl) { outcome = 'LOSS'; break; }
        if (high >= tp) { outcome = 'WIN'; break; }
      } else {
        if (high >= sl) { outcome = 'LOSS'; break; }
        if (low <= tp) { outcome = 'WIN'; break; }
      }
    }
    
    if (!outcome) { timeouts++; continue; }
    
    if (outcome === 'WIN') wins++;
    else losses++;
    
    const date = new Date(signal.timestamp);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    // Position sizing
    const riskAmount = capital * CONFIG.riskPerTrade;
    const positionSize = riskAmount / slPct;
    
    // Fees
    const fees = positionSize * CONFIG.fees.roundTrip;
    totalFees += fees;
    
    // P&L
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
    capital,
    pnl: capital - CONFIG.initialCapital,
    totalTrades,
    wins,
    losses,
    timeouts,
    winRate: totalTrades > 0 ? (wins / totalTrades * 100) : 0,
    totalFees,
    positiveMonths,
    totalMonths: months.length,
    monthlyStats
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 RECHERCHE DU R:R OPTIMAL POUR V33');
  console.log('═'.repeat(80));
  
  console.log('\n💡 Problème: Avec TP/SL 1%, les frais mangent le profit');
  console.log('   Solution: Trouver le bon R:R pour couvrir les frais');
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 Fetching ${symbol}...`);
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  // Collect signals
  const allSignals = [];
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 60; i < candles.length - 50; i++) {
      const direction = detectV33Signal(candles, i);
      if (!direction) continue;
      allSignals.push({ symbol, candleIndex: i, timestamp: candles[i][0], direction, entry: candles[i][4], candles });
    }
  }
  allSignals.sort((a, b) => a.timestamp - b.timestamp);
  
  console.log(`\n📊 Signaux: ${allSignals.length}`);
  
  // Test different R:R ratios
  const rrConfigs = [
    { tp: 0.005, sl: 0.005, name: '0.5:0.5' },
    { tp: 0.01, sl: 0.01, name: '1:1' },
    { tp: 0.015, sl: 0.01, name: '1.5:1' },
    { tp: 0.02, sl: 0.01, name: '2:1' },
    { tp: 0.025, sl: 0.01, name: '2.5:1' },
    { tp: 0.03, sl: 0.01, name: '3:1' },
    { tp: 0.02, sl: 0.015, name: '2:1.5' },
    { tp: 0.03, sl: 0.015, name: '3:1.5' },
    { tp: 0.015, sl: 0.005, name: '1.5:0.5' },
    { tp: 0.02, sl: 0.005, name: '2:0.5' },
  ];
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS PAR R:R');
  console.log('═'.repeat(80));
  
  console.log('\n┌────────────┬─────────┬───────────┬──────────────┬──────────────┬──────────┬──────────┐');
  console.log('│    R:R     │ Trades  │  Win Rate │   Frais $    │    P&L $     │  Mois +  │  Status  │');
  console.log('├────────────┼─────────┼───────────┼──────────────┼──────────────┼──────────┼──────────┤');
  
  let bestConfig = null;
  let bestScore = -Infinity;
  
  for (const config of rrConfigs) {
    const result = await simulateWithRR(allCandles, allSignals, config.tp, config.sl);
    
    const status = result.positiveMonths === result.totalMonths ? '🏆' : 
                   result.pnl > 0 ? '✅' : '❌';
    
    console.log(`│ ${config.name.padEnd(10)} │   ${String(result.totalTrades).padStart(4)}  │   ${result.winRate.toFixed(1).padStart(5)}%  │   $${result.totalFees.toFixed(0).padStart(8)}  │ ${(result.pnl >= 0 ? '+' : '')}$${result.pnl.toFixed(0).padStart(9)}  │   ${result.positiveMonths}/${result.totalMonths}    │    ${status}    │`);
    
    // Score: prioritize all positive months, then profit
    const score = (result.positiveMonths === result.totalMonths ? 10000 : 0) + 
                  (result.pnl > 0 ? 1000 : 0) + 
                  result.pnl / 100;
    
    if (score > bestScore) {
      bestScore = score;
      bestConfig = { ...config, result };
    }
  }
  
  console.log('└────────────┴─────────┴───────────┴──────────────┴──────────────┴──────────┴──────────┘');
  
  // Best config details
  if (bestConfig) {
    console.log('\n' + '═'.repeat(80));
    console.log('🏆 MEILLEURE CONFIGURATION');
    console.log('═'.repeat(80));
    
    const r = bestConfig.result;
    console.log(`\n📌 R:R ${bestConfig.name} (TP: ${bestConfig.tp * 100}%, SL: ${bestConfig.sl * 100}%)`);
    console.log(`   Trades: ${r.totalTrades} (${(r.totalTrades/DAYS).toFixed(1)}/jour)`);
    console.log(`   Win Rate: ${r.winRate.toFixed(1)}%`);
    console.log(`   P&L net: ${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(0)} (${(r.pnl/CONFIG.initialCapital*100).toFixed(0)}%)`);
    console.log(`   Mois positifs: ${r.positiveMonths}/${r.totalMonths}`);
    
    console.log('\n📅 Détail mensuel:');
    const months = Object.keys(r.monthlyStats).sort();
    for (const month of months) {
      const m = r.monthlyStats[month];
      const wr = (m.wins / m.trades * 100).toFixed(1);
      const pnlPct = (m.pnl / m.startCapital * 100).toFixed(1);
      console.log(`   ${month}: ${m.trades} trades, ${wr}% WR, ${m.pnl >= 0 ? '+' : ''}${pnlPct}% ${m.pnl >= 0 ? '✅' : '❌'}`);
    }
    
    // Recommandation
    if (r.positiveMonths === r.totalMonths && r.pnl > 0) {
      console.log(`
═══════════════════════════════════════════════════════════════════════════════
✅ CONFIGURATION VIABLE TROUVÉE !
═══════════════════════════════════════════════════════════════════════════════

📊 Paramètres optimaux:
   - TP: ${bestConfig.tp * 100}%
   - SL: ${bestConfig.sl * 100}%
   - R:R: ${(bestConfig.tp / bestConfig.sl).toFixed(1)}:1

💰 Performance sur 4 mois:
   - Capital: $${CONFIG.initialCapital} → $${r.capital.toFixed(0)}
   - Profit: +$${r.pnl.toFixed(0)} (+${(r.pnl/CONFIG.initialCapital*100).toFixed(0)}%)
   - ROI mensuel moyen: +${(r.pnl/4/CONFIG.initialCapital*100).toFixed(1)}%

📈 Cette configuration peut être implémentée dans l'agent !
`);
    } else {
      console.log(`\n⚠️ Aucune configuration ne donne ${r.totalMonths}/${r.totalMonths} mois positifs avec profit`);
    }
  }
}

main().catch(console.error);
