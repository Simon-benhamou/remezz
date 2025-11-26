/**
 * 📊 BACKTEST 12 MOIS - SIGNAL VOL3X + 5 CANDLES
 * 
 * Test sur la période maximale disponible
 * Avec estimation réaliste: frais, leverage, 4 agents
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];
const TIMEFRAME = '15m';
const DAYS = 365; // 12 mois
const CANDLES_PER_DAY = 96;
const TOTAL_CANDLES = DAYS * CANDLES_PER_DAY; // ~35000 candles

const CONFIG = {
  initialCapital: 10000,
  riskPerTrade: 0.01,      // 1% risk per trade
  tpPercent: 0.02,          // 2% TP
  slPercent: 0.01,          // 1% SL (R:R 2:1)
  fees: { roundTrip: 0.0006 }, // 0.06% roundtrip (taker entry + maker exit)
  
  // Leverage par symbol
  leverage: {
    'BTC/USDT:USDT': 3,
    'ETH/USDT:USDT': 4,
    'SOL/USDT:USDT': 5,
    'XRP/USDT:USDT': 5,
  },
};

async function fetchAllCandles(symbol) {
  console.log(`📥 Fetching ${symbol} (max 12 mois)...`);
  
  const allCandles = [];
  const now = Date.now();
  const candleDuration = 15 * 60 * 1000;
  let since = now - TOTAL_CANDLES * candleDuration;
  
  while (true) {
    try {
      const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, since, 1000);
      if (candles.length === 0) break;
      
      allCandles.push(...candles);
      since = candles[candles.length - 1][0] + candleDuration;
      
      if (allCandles.length % 5000 === 0) {
        process.stdout.write(`   ${allCandles.length} candles...\r`);
      }
      
      await new Promise(r => setTimeout(r, 50));
      
      if (candles.length < 1000) break;
      if (allCandles.length >= TOTAL_CANDLES) break;
    } catch (e) {
      console.log(`   ⚠️ Error: ${e.message}, retrying...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  console.log(`   ✅ ${allCandles.length} candles (${(allCandles.length / CANDLES_PER_DAY).toFixed(0)} jours)`);
  return allCandles;
}

function getAvgVolume(c, i, period = 20) {
  return c.slice(i - period, i).reduce((s, x) => s + x[5], 0) / period;
}

// Signal: Volume 3x + 5 bougies même direction
function detectSignal(candles, i) {
  if (i < 10) return null;
  
  const vol = candles[i][5];
  const avgVol = getAvgVolume(candles, i);
  
  // Volume doit être 3x la moyenne
  if (vol < avgVol * 3) return null;
  
  // Les 5 dernières bougies doivent être dans la même direction
  const last5 = candles.slice(i - 5, i);
  const allUp = last5.every(x => x[4] > x[1]);
  const allDown = last5.every(x => x[4] < x[1]);
  
  if (allUp) return 'LONG';
  if (allDown) return 'SHORT';
  return null;
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 BACKTEST 12 MOIS - SIGNAL VOL3X + 5 CANDLES');
  console.log('═'.repeat(80));
  
  // Fetch all data
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  // Determine actual date range
  const allDates = [];
  for (const candles of Object.values(allCandles)) {
    if (candles.length > 0) {
      allDates.push(candles[0][0], candles[candles.length - 1][0]);
    }
  }
  const startDate = new Date(Math.max(...Object.values(allCandles).map(c => c[0]?.[0] || 0)));
  const endDate = new Date(Math.min(...Object.values(allCandles).map(c => c[c.length - 1]?.[0] || Date.now())));
  const actualDays = Math.floor((endDate - startDate) / (24 * 60 * 60 * 1000));
  
  console.log(`\n📅 Période: ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]}`);
  console.log(`   Durée: ${actualDays} jours (~${(actualDays / 30).toFixed(1)} mois)`);
  
  // Collect all signals
  const allSignals = [];
  
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 60; i < candles.length - 50; i++) {
      const direction = detectSignal(candles, i);
      if (!direction) continue;
      
      allSignals.push({
        symbol,
        candleIndex: i,
        timestamp: candles[i][0],
        direction,
        entry: candles[i][4],
        candles
      });
    }
  }
  
  allSignals.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`\n📊 Total signaux: ${allSignals.length}`);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // SIMULATION AVEC FRAIS RÉELS
  // ═══════════════════════════════════════════════════════════════════════════
  
  let capital = CONFIG.initialCapital;
  const monthlyStats = {};
  let totalFees = 0;
  let wins = 0, losses = 0;
  
  for (const signal of allSignals) {
    const leverage = CONFIG.leverage[signal.symbol] || 4;
    const entry = signal.entry;
    const candles = signal.candles;
    
    // Calculate TP/SL
    const tp = signal.direction === 'LONG' 
      ? entry * (1 + CONFIG.tpPercent) 
      : entry * (1 - CONFIG.tpPercent);
    const sl = signal.direction === 'LONG' 
      ? entry * (1 - CONFIG.slPercent) 
      : entry * (1 + CONFIG.slPercent);
    
    // Simulate trade
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
    
    // Position sizing with leverage
    const riskAmount = capital * CONFIG.riskPerTrade;
    const positionSize = riskAmount / CONFIG.slPercent;
    
    // Fees on notional position (with leverage effect)
    const fees = positionSize * CONFIG.fees.roundTrip;
    totalFees += fees;
    
    // P&L calculation
    const grossPnL = outcome === 'WIN' 
      ? positionSize * CONFIG.tpPercent 
      : -positionSize * CONFIG.slPercent;
    const netPnL = grossPnL - fees;
    
    capital += netPnL;
    
    // Monthly tracking
    if (!monthlyStats[monthKey]) {
      monthlyStats[monthKey] = { 
        startCapital: capital - netPnL, 
        pnl: 0, 
        trades: 0, 
        wins: 0,
        fees: 0,
        bySymbol: {}
      };
    }
    monthlyStats[monthKey].pnl += netPnL;
    monthlyStats[monthKey].trades++;
    monthlyStats[monthKey].fees += fees;
    if (outcome === 'WIN') monthlyStats[monthKey].wins++;
    
    // Per symbol tracking
    if (!monthlyStats[monthKey].bySymbol[signal.symbol]) {
      monthlyStats[monthKey].bySymbol[signal.symbol] = { trades: 0, wins: 0 };
    }
    monthlyStats[monthKey].bySymbol[signal.symbol].trades++;
    if (outcome === 'WIN') monthlyStats[monthKey].bySymbol[signal.symbol].wins++;
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // RÉSULTATS
  // ═══════════════════════════════════════════════════════════════════════════
  
  const totalTrades = wins + losses;
  const totalPnL = capital - CONFIG.initialCapital;
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS GLOBAUX');
  console.log('═'.repeat(80));
  
  console.log(`\n📈 Performance:`);
  console.log(`   Trades: ${totalTrades}`);
  console.log(`   Trades/jour: ${(totalTrades / actualDays).toFixed(2)}`);
  console.log(`   Win Rate: ${(wins / totalTrades * 100).toFixed(1)}%`);
  console.log(`   Capital initial: $${CONFIG.initialCapital.toLocaleString()}`);
  console.log(`   Capital final: $${capital.toFixed(2)}`);
  console.log(`   P&L net: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`);
  console.log(`   ROI total: ${totalPnL >= 0 ? '+' : ''}${(totalPnL / CONFIG.initialCapital * 100).toFixed(1)}%`);
  console.log(`   ROI mensuel moyen: ${(totalPnL / (actualDays / 30) / CONFIG.initialCapital * 100).toFixed(2)}%`);
  
  console.log(`\n💰 Frais:`);
  console.log(`   Frais totaux: $${totalFees.toFixed(2)}`);
  console.log(`   Frais par trade: $${(totalFees / totalTrades).toFixed(2)}`);
  
  // Monthly breakdown
  console.log('\n' + '═'.repeat(80));
  console.log('📅 PERFORMANCE MENSUELLE');
  console.log('═'.repeat(80));
  
  const months = Object.keys(monthlyStats).sort();
  let positiveMonths = 0;
  
  console.log('\n┌────────────┬─────────┬───────────┬──────────────┬──────────────┬──────────┐');
  console.log('│    Mois    │ Trades  │  Win Rate │    Frais     │    P&L %     │  Status  │');
  console.log('├────────────┼─────────┼───────────┼──────────────┼──────────────┼──────────┤');
  
  for (const month of months) {
    const m = monthlyStats[month];
    const wr = (m.wins / m.trades * 100).toFixed(1);
    const pnlPct = (m.pnl / m.startCapital * 100).toFixed(2);
    const status = m.pnl >= 0 ? '✅' : '❌';
    
    if (m.pnl >= 0) positiveMonths++;
    
    console.log(`│ ${month}   │   ${String(m.trades).padStart(4)}  │   ${wr.padStart(5)}%  │   $${m.fees.toFixed(0).padStart(8)}  │ ${(m.pnl >= 0 ? '+' : '')}${pnlPct.padStart(10)}% │    ${status}    │`);
  }
  
  console.log('└────────────┴─────────┴───────────┴──────────────┴──────────────┴──────────┘');
  
  console.log(`\n🎯 Mois positifs: ${positiveMonths}/${months.length} (${(positiveMonths / months.length * 100).toFixed(0)}%)`);
  
  // Per symbol analysis
  console.log('\n' + '═'.repeat(80));
  console.log('📊 PERFORMANCE PAR SYMBOL');
  console.log('═'.repeat(80));
  
  const symbolStats = {};
  for (const signal of allSignals) {
    if (!symbolStats[signal.symbol]) {
      symbolStats[signal.symbol] = { trades: 0, wins: 0 };
    }
  }
  
  for (const m of Object.values(monthlyStats)) {
    for (const [sym, stats] of Object.entries(m.bySymbol)) {
      if (!symbolStats[sym]) symbolStats[sym] = { trades: 0, wins: 0 };
      symbolStats[sym].trades += stats.trades;
      symbolStats[sym].wins += stats.wins;
    }
  }
  
  console.log('\n┌────────────────────┬─────────┬───────────┐');
  console.log('│      Symbol        │ Trades  │  Win Rate │');
  console.log('├────────────────────┼─────────┼───────────┤');
  
  for (const [sym, stats] of Object.entries(symbolStats)) {
    const wr = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1) : 0;
    console.log(`│ ${sym.padEnd(18)} │   ${String(stats.trades).padStart(4)}  │   ${String(wr).padStart(5)}%  │`);
  }
  
  console.log('└────────────────────┴─────────┴───────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════════
  // ESTIMATION AVEC LEVERAGE RÉEL
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('💰 ESTIMATION REVENUS RÉELS AVEC LEVERAGE');
  console.log('═'.repeat(80));
  
  // Recalculate with leverage amplification
  const avgLeverage = (CONFIG.leverage['BTC/USDT:USDT'] + CONFIG.leverage['ETH/USDT:USDT'] + 
                       CONFIG.leverage['SOL/USDT:USDT'] + CONFIG.leverage['XRP/USDT:USDT']) / 4;
  
  const monthlyROI = totalPnL / (actualDays / 30) / CONFIG.initialCapital * 100;
  const annualROI = totalPnL / CONFIG.initialCapital * 100 * (365 / actualDays);
  
  console.log(`\n📊 Configuration:`);
  console.log(`   Capital initial: $${CONFIG.initialCapital.toLocaleString()}`);
  console.log(`   Leverage moyen: ${avgLeverage.toFixed(1)}x`);
  console.log(`   Risk par trade: ${CONFIG.riskPerTrade * 100}%`);
  console.log(`   TP/SL: ${CONFIG.tpPercent * 100}% / ${CONFIG.slPercent * 100}% (R:R ${(CONFIG.tpPercent / CONFIG.slPercent).toFixed(0)}:1)`);
  
  console.log(`\n💵 Revenus (basé sur ${actualDays} jours de données):`);
  console.log(`   ROI mensuel moyen: ${monthlyROI >= 0 ? '+' : ''}${monthlyROI.toFixed(2)}%`);
  console.log(`   Profit mensuel moyen: ${monthlyROI >= 0 ? '+' : ''}$${(CONFIG.initialCapital * monthlyROI / 100).toFixed(0)}`);
  console.log(`   ROI annuel projeté: ${annualROI >= 0 ? '+' : ''}${annualROI.toFixed(1)}%`);
  console.log(`   Profit annuel projeté: ${annualROI >= 0 ? '+' : ''}$${(CONFIG.initialCapital * annualROI / 100).toFixed(0)}`);
  
  // Projection avec différents capitaux
  console.log('\n📈 Projections selon le capital initial:');
  console.log('\n┌──────────────────┬────────────────┬────────────────┬────────────────┐');
  console.log('│  Capital Initial │ Profit/Mois    │ Profit/An      │ Capital 1 an   │');
  console.log('├──────────────────┼────────────────┼────────────────┼────────────────┤');
  
  for (const cap of [1000, 5000, 10000, 25000, 50000, 100000]) {
    const monthlyProfit = cap * monthlyROI / 100;
    const yearlyProfit = cap * annualROI / 100;
    const capitalAfter1Year = cap + yearlyProfit;
    
    console.log(`│ $${cap.toLocaleString().padEnd(15)} │ ${monthlyProfit >= 0 ? '+' : ''}$${monthlyProfit.toFixed(0).padStart(12)} │ ${yearlyProfit >= 0 ? '+' : ''}$${yearlyProfit.toFixed(0).padStart(12)} │ $${capitalAfter1Year.toFixed(0).padStart(13)} │`);
  }
  
  console.log('└──────────────────┴────────────────┴────────────────┴────────────────┘');
  
  // Verdict final
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 VERDICT FINAL');
  console.log('═'.repeat(80));
  
  const isViable = positiveMonths >= months.length * 0.6 && totalPnL > 0;
  
  if (isViable) {
    console.log(`
✅ STRATÉGIE VIABLE SUR ${months.length} MOIS!

📊 Résumé:
   - ${totalTrades} trades (${(totalTrades / actualDays).toFixed(1)}/jour)
   - ${(wins / totalTrades * 100).toFixed(1)}% win rate
   - ${positiveMonths}/${months.length} mois positifs (${(positiveMonths / months.length * 100).toFixed(0)}%)
   - ROI total: ${totalPnL >= 0 ? '+' : ''}${(totalPnL / CONFIG.initialCapital * 100).toFixed(0)}%

💡 Cette stratégie peut être implémentée dans l'agent.
`);
  } else {
    console.log(`
⚠️ STRATÉGIE À RISQUE

📊 Résumé:
   - ${positiveMonths}/${months.length} mois positifs seulement
   - P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}

💡 Considérer des ajustements ou une autre approche.
`);
  }
}

main().catch(console.error);
