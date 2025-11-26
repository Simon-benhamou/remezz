/**
 * 📊 ESTIMATION CORRIGÉE V33 - AVEC FRAIS ET LEVERAGE
 * 
 * Correction: Les frais sont sur la position, pas multipliés par le capital
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
  riskPerTrade: 0.01,      // 1% du capital risqué
  tpPercent: 0.01,         // 1% TP
  slPercent: 0.01,         // 1% SL
  
  // Leverage par asset
  leverage: {
    'BTC/USDT:USDT': 3,
    'ETH/USDT:USDT': 4,
    'SOL/USDT:USDT': 5,
    'XRP/USDT:USDT': 5,
  },
  
  // Frais Binance Futures VIP0
  fees: {
    maker: 0.0002,    // 0.02%
    taker: 0.0004,    // 0.04%
    // Moyenne: entry taker + exit limit = 0.04% + 0.02% = 0.06% par trade roundtrip
    roundTrip: 0.0006,
  },
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

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 ESTIMATION CORRIGÉE V33 - AVEC FRAIS RÉELS');
  console.log('═'.repeat(80));
  
  console.log('\n💡 Modèle de calcul:');
  console.log('   - Risk per trade: 1% du capital');
  console.log('   - Position size: risk / SL% (ex: $100 / 1% = $10,000 position)');
  console.log('   - Avec 4x leverage: margin = $2,500');
  console.log('   - Frais roundtrip: 0.06% de la position');
  console.log('   - Si position $10k: frais = $6 par trade');
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 Fetching ${symbol}...`);
    allCandles[symbol] = await fetchAllCandles(symbol);
  }
  
  // Collect all signals
  const allSignals = [];
  for (const [symbol, candles] of Object.entries(allCandles)) {
    for (let i = 60; i < candles.length - 30; i++) {
      const direction = detectV33Signal(candles, i);
      if (!direction) continue;
      
      allSignals.push({
        symbol, candleIndex: i, timestamp: candles[i][0],
        direction, entry: candles[i][4], candles
      });
    }
  }
  
  allSignals.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`\n📊 Total signaux: ${allSignals.length}`);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // SIMULATION AVEC FRAIS CORRECTS
  // ═══════════════════════════════════════════════════════════════════════════
  
  let capital = CONFIG.initialCapital;
  const monthlyStats = {};
  let totalFees = 0;
  let totalWins = 0, totalLosses = 0;
  
  for (const signal of allSignals) {
    const leverage = CONFIG.leverage[signal.symbol] || 4;
    const entry = signal.entry;
    
    // Simulate trade outcome
    const candles = signal.candles;
    let outcome = null;
    
    for (let j = signal.candleIndex + 1; j < Math.min(signal.candleIndex + 30, candles.length); j++) {
      const high = candles[j][2];
      const low = candles[j][3];
      
      if (signal.direction === 'LONG') {
        if (high >= entry * 1.01) { outcome = 'WIN'; break; }
        if (low <= entry * 0.99) { outcome = 'LOSS'; break; }
      } else {
        if (low <= entry * 0.99) { outcome = 'WIN'; break; }
        if (high >= entry * 1.01) { outcome = 'LOSS'; break; }
      }
    }
    
    if (!outcome) continue;
    
    if (outcome === 'WIN') totalWins++;
    else totalLosses++;
    
    const date = new Date(signal.timestamp);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    // Calcul correct des frais
    // Risk = 1% du capital
    const riskAmount = capital * CONFIG.riskPerTrade;
    
    // Position size = risk / SL% (pour avoir exactement riskAmount de perte si SL touché)
    // Mais avec leverage, on ne met que position/leverage en margin
    const positionSize = riskAmount / CONFIG.slPercent;
    const marginUsed = positionSize / leverage;
    
    // Frais = % de la position notionnelle
    const fees = positionSize * CONFIG.fees.roundTrip;
    totalFees += fees;
    
    // P&L brut (sans frais)
    const grossPnL = outcome === 'WIN' 
      ? positionSize * CONFIG.tpPercent  // +1% de la position
      : -positionSize * CONFIG.slPercent; // -1% de la position
    
    // P&L net (après frais)
    const netPnL = grossPnL - fees;
    
    capital += netPnL;
    
    if (!monthlyStats[monthKey]) {
      monthlyStats[monthKey] = { 
        startCapital: capital - netPnL, 
        pnl: 0, 
        trades: 0, 
        wins: 0, 
        fees: 0,
        grossPnL: 0
      };
    }
    monthlyStats[monthKey].pnl += netPnL;
    monthlyStats[monthKey].grossPnL += grossPnL;
    monthlyStats[monthKey].trades++;
    monthlyStats[monthKey].fees += fees;
    if (outcome === 'WIN') monthlyStats[monthKey].wins++;
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // RÉSULTATS
  // ═══════════════════════════════════════════════════════════════════════════
  
  const totalTrades = totalWins + totalLosses;
  const totalPnL = capital - CONFIG.initialCapital;
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS GLOBAUX');
  console.log('═'.repeat(80));
  
  console.log(`\n📈 Performance:`);
  console.log(`   Trades: ${totalTrades} (${(totalTrades/DAYS).toFixed(1)}/jour)`);
  console.log(`   Win Rate: ${(totalWins / totalTrades * 100).toFixed(1)}%`);
  console.log(`   Capital initial: $${CONFIG.initialCapital.toLocaleString()}`);
  console.log(`   Capital final: $${capital.toFixed(2).toLocaleString()}`);
  console.log(`   P&L net: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`);
  console.log(`   ROI: ${totalPnL >= 0 ? '+' : ''}${(totalPnL/CONFIG.initialCapital*100).toFixed(1)}%`);
  
  console.log(`\n💰 Frais:`);
  console.log(`   Frais totaux: $${totalFees.toFixed(2)}`);
  console.log(`   Frais par trade: $${(totalFees/totalTrades).toFixed(2)}`);
  console.log(`   Frais en % du capital: ${(totalFees/CONFIG.initialCapital*100).toFixed(1)}%`);
  
  // Détail mensuel
  console.log('\n' + '─'.repeat(80));
  console.log('📅 DÉTAIL MENSUEL');
  console.log('─'.repeat(80));
  
  const months = Object.keys(monthlyStats).sort();
  let positiveMonths = 0;
  
  console.log('\n┌────────────┬─────────┬───────────┬──────────────┬──────────────┬──────────────┬──────────┐');
  console.log('│    Mois    │ Trades  │  Win Rate │   Frais $    │   Brut %     │   Net %      │  Status  │');
  console.log('├────────────┼─────────┼───────────┼──────────────┼──────────────┼──────────────┼──────────┤');
  
  for (const month of months) {
    const m = monthlyStats[month];
    const wr = (m.wins / m.trades * 100).toFixed(1);
    const grossPct = (m.grossPnL / m.startCapital * 100).toFixed(2);
    const netPct = (m.pnl / m.startCapital * 100).toFixed(2);
    const status = m.pnl >= 0 ? '✅' : '❌';
    
    if (m.pnl >= 0) positiveMonths++;
    
    console.log(`│ ${month}   │   ${String(m.trades).padStart(4)}  │   ${wr.padStart(5)}%  │   $${m.fees.toFixed(0).padStart(8)}  │ ${(m.grossPnL >= 0 ? '+' : '')}${grossPct.padStart(10)}% │ ${(m.pnl >= 0 ? '+' : '')}${netPct.padStart(10)}% │    ${status}    │`);
  }
  
  console.log('└────────────┴─────────┴───────────┴──────────────┴──────────────┴──────────────┴──────────┘');
  
  console.log(`\n🎯 VERDICT: ${positiveMonths}/${months.length} mois positifs ${positiveMonths === months.length ? '🏆' : ''}`);
  
  // Analyse
  console.log('\n' + '═'.repeat(80));
  console.log('💡 ANALYSE');
  console.log('═'.repeat(80));
  
  const avgGrossPerTrade = (Object.values(monthlyStats).reduce((s, m) => s + m.grossPnL, 0)) / totalTrades;
  const avgFeePerTrade = totalFees / totalTrades;
  const avgNetPerTrade = avgGrossPerTrade - avgFeePerTrade;
  
  console.log(`\n📊 Par trade:`);
  console.log(`   P&L brut moyen: $${avgGrossPerTrade.toFixed(2)}`);
  console.log(`   Frais moyen: $${avgFeePerTrade.toFixed(2)}`);
  console.log(`   P&L net moyen: $${avgNetPerTrade.toFixed(2)}`);
  
  // Impact des frais
  const feeImpact = (avgFeePerTrade / Math.abs(avgGrossPerTrade)) * 100;
  console.log(`\n⚠️ Impact des frais: ${feeImpact.toFixed(1)}% du P&L brut`);
  
  if (positiveMonths === months.length) {
    console.log(`
✅ LA STRATÉGIE V33 EST VIABLE AVEC LES FRAIS!

📈 Résumé sur 4 mois:
   - Profit net: +$${totalPnL.toFixed(0)} (+${(totalPnL/CONFIG.initialCapital*100).toFixed(0)}%)
   - Frais payés: $${totalFees.toFixed(0)}
   - ${positiveMonths}/${months.length} mois positifs

💰 Par mois en moyenne:
   - Profit: +$${(totalPnL/4).toFixed(0)}
   - ROI: +${(totalPnL/4/CONFIG.initialCapital*100).toFixed(1)}%
`);
  } else {
    // Analyser pourquoi certains mois échouent
    console.log(`\n❌ Problème: ${months.length - positiveMonths} mois négatifs`);
    
    for (const month of months) {
      const m = monthlyStats[month];
      if (m.pnl < 0) {
        console.log(`   ${month}: WR ${(m.wins/m.trades*100).toFixed(0)}%, ${m.trades} trades, frais $${m.fees.toFixed(0)}`);
      }
    }
  }
}

main().catch(console.error);
