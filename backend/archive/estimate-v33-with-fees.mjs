/**
 * 📊 ESTIMATION RÉALISTE V33 - AVEC FRAIS ET LEVERAGE
 * 
 * V33 Strong Trend: 52 trades/jour, 52.4% WR, TP/SL 1%
 * 
 * Questions:
 * 1. Avec les frais Binance Futures, est-ce toujours rentable?
 * 2. Quel est le profit réel après frais?
 * 3. Quel capital final sur 4 mois?
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

// Configuration
const CONFIG = {
  initialCapital: 10000,
  riskPerTrade: 0.01,      // 1% du capital
  tpPercent: 0.01,         // 1% TP
  slPercent: 0.01,         // 1% SL
  
  // Leverage par asset
  leverage: {
    'BTC/USDT:USDT': 3,
    'ETH/USDT:USDT': 4,
    'SOL/USDT:USDT': 5,
    'XRP/USDT:USDT': 5,
  },
  
  // Frais Binance Futures (VIP 0)
  fees: {
    maker: 0.0002,    // 0.02% maker
    taker: 0.0004,    // 0.04% taker (market orders)
    // On assume 70% taker (entrée market) + 50% taker (sortie TP/SL limit qui devient market)
    avgFeeRate: 0.00035,  // ~0.035% par ordre
  },
  
  // Funding rate (toutes les 8h, peut être + ou -)
  fundingRate: 0.0001,  // 0.01% toutes les 8h (moyenne)
  avgHoldTime: 2,       // heures de hold moyen (estimé pour TP/SL 1%)
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
  console.log('📊 ESTIMATION V33 - AVEC FRAIS RÉELS ET LEVERAGE');
  console.log('═'.repeat(80));
  
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
  console.log(`\n📊 Total signaux: ${allSignals.length} (${(allSignals.length/DAYS).toFixed(1)}/jour)`);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // SIMULATION SANS FRAIS (référence)
  // ═══════════════════════════════════════════════════════════════════════════
  
  let capitalNoFees = CONFIG.initialCapital;
  let capitalWithFees = CONFIG.initialCapital;
  let capitalWithFeesAndLeverage = CONFIG.initialCapital;
  
  const monthlyStats = {
    noFees: {},
    withFees: {},
    withFeesAndLeverage: {}
  };
  
  let totalFeesPaid = 0;
  let totalTradesExecuted = 0;
  let wins = 0, losses = 0;
  
  for (const signal of allSignals) {
    const leverage = CONFIG.leverage[signal.symbol] || 4;
    const entry = signal.entry;
    
    // Simulate trade outcome
    const candles = signal.candles;
    let outcome = null;
    let holdBars = 0;
    
    for (let j = signal.candleIndex + 1; j < Math.min(signal.candleIndex + 30, candles.length); j++) {
      holdBars++;
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
    
    totalTradesExecuted++;
    if (outcome === 'WIN') wins++;
    else losses++;
    
    const date = new Date(signal.timestamp);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    // ─────────────────────────────────────────────────────────────────────────
    // 1. SANS FRAIS (référence)
    // ─────────────────────────────────────────────────────────────────────────
    const riskAmount1 = capitalNoFees * CONFIG.riskPerTrade;
    const pnl1 = outcome === 'WIN' ? riskAmount1 : -riskAmount1;
    capitalNoFees += pnl1;
    
    if (!monthlyStats.noFees[monthKey]) {
      monthlyStats.noFees[monthKey] = { startCapital: capitalNoFees - pnl1, pnl: 0, trades: 0, wins: 0 };
    }
    monthlyStats.noFees[monthKey].pnl += pnl1;
    monthlyStats.noFees[monthKey].trades++;
    if (outcome === 'WIN') monthlyStats.noFees[monthKey].wins++;
    
    // ─────────────────────────────────────────────────────────────────────────
    // 2. AVEC FRAIS (sans leverage)
    // ─────────────────────────────────────────────────────────────────────────
    const riskAmount2 = capitalWithFees * CONFIG.riskPerTrade;
    const positionSize2 = riskAmount2 / CONFIG.slPercent;
    
    // Frais d'entrée + sortie
    const entryFee2 = positionSize2 * CONFIG.fees.avgFeeRate;
    const exitFee2 = positionSize2 * CONFIG.fees.avgFeeRate;
    const totalFees2 = entryFee2 + exitFee2;
    
    const grossPnl2 = outcome === 'WIN' ? riskAmount2 : -riskAmount2;
    const netPnl2 = grossPnl2 - totalFees2;
    capitalWithFees += netPnl2;
    
    if (!monthlyStats.withFees[monthKey]) {
      monthlyStats.withFees[monthKey] = { startCapital: capitalWithFees - netPnl2, pnl: 0, trades: 0, wins: 0, fees: 0 };
    }
    monthlyStats.withFees[monthKey].pnl += netPnl2;
    monthlyStats.withFees[monthKey].trades++;
    monthlyStats.withFees[monthKey].fees += totalFees2;
    if (outcome === 'WIN') monthlyStats.withFees[monthKey].wins++;
    
    // ─────────────────────────────────────────────────────────────────────────
    // 3. AVEC FRAIS ET LEVERAGE
    // ─────────────────────────────────────────────────────────────────────────
    const riskAmount3 = capitalWithFeesAndLeverage * CONFIG.riskPerTrade;
    const marginRequired = riskAmount3 / CONFIG.slPercent / leverage; // Margin = position / leverage
    const positionSize3 = marginRequired * leverage;
    
    // Frais sur la position leveragée
    const entryFee3 = positionSize3 * CONFIG.fees.avgFeeRate;
    const exitFee3 = positionSize3 * CONFIG.fees.avgFeeRate;
    
    // Funding (si hold > 8h)
    const holdHours = holdBars * 0.25; // 15min = 0.25h
    const fundingPeriods = Math.floor(holdHours / 8);
    const fundingFee3 = positionSize3 * CONFIG.fundingRate * fundingPeriods;
    
    const totalFees3 = entryFee3 + exitFee3 + fundingFee3;
    totalFeesPaid += totalFees3;
    
    // PnL avec leverage
    const grossPnl3 = outcome === 'WIN' 
      ? positionSize3 * CONFIG.tpPercent 
      : -positionSize3 * CONFIG.slPercent;
    const netPnl3 = grossPnl3 - totalFees3;
    
    // Protection: ne pas perdre plus que le margin
    const cappedPnl3 = Math.max(netPnl3, -marginRequired);
    capitalWithFeesAndLeverage += cappedPnl3;
    
    if (!monthlyStats.withFeesAndLeverage[monthKey]) {
      monthlyStats.withFeesAndLeverage[monthKey] = { 
        startCapital: capitalWithFeesAndLeverage - cappedPnl3, 
        pnl: 0, trades: 0, wins: 0, fees: 0 
      };
    }
    monthlyStats.withFeesAndLeverage[monthKey].pnl += cappedPnl3;
    monthlyStats.withFeesAndLeverage[monthKey].trades++;
    monthlyStats.withFeesAndLeverage[monthKey].fees += totalFees3;
    if (outcome === 'WIN') monthlyStats.withFeesAndLeverage[monthKey].wins++;
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // RÉSULTATS
  // ═══════════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 COMPARAISON DES SCÉNARIOS');
  console.log('═'.repeat(80));
  
  console.log(`\n📈 Trades exécutés: ${totalTradesExecuted}`);
  console.log(`   Win Rate: ${(wins / totalTradesExecuted * 100).toFixed(1)}%`);
  console.log(`   Trades/jour: ${(totalTradesExecuted / DAYS).toFixed(1)}`);
  
  console.log('\n┌────────────────────────────────┬──────────────┬──────────────┬──────────────┐');
  console.log('│         Scénario               │ Capital Final│    P&L %     │   Frais $    │');
  console.log('├────────────────────────────────┼──────────────┼──────────────┼──────────────┤');
  
  const pnlNoFees = capitalNoFees - CONFIG.initialCapital;
  const pnlWithFees = capitalWithFees - CONFIG.initialCapital;
  const pnlWithLeverage = capitalWithFeesAndLeverage - CONFIG.initialCapital;
  
  console.log(`│ 1️⃣  Sans frais (référence)     │  $${capitalNoFees.toFixed(0).padStart(9)} │  ${(pnlNoFees/CONFIG.initialCapital*100 >= 0 ? '+' : '')}${(pnlNoFees/CONFIG.initialCapital*100).toFixed(1).padStart(9)}% │          N/A │`);
  console.log(`│ 2️⃣  Avec frais (1x leverage)   │  $${capitalWithFees.toFixed(0).padStart(9)} │  ${(pnlWithFees/CONFIG.initialCapital*100 >= 0 ? '+' : '')}${(pnlWithFees/CONFIG.initialCapital*100).toFixed(1).padStart(9)}% │  $${Object.values(monthlyStats.withFees).reduce((s, m) => s + m.fees, 0).toFixed(0).padStart(8)} │`);
  console.log(`│ 3️⃣  Avec frais + leverage (4x) │  $${capitalWithFeesAndLeverage.toFixed(0).padStart(9)} │  ${(pnlWithLeverage/CONFIG.initialCapital*100 >= 0 ? '+' : '')}${(pnlWithLeverage/CONFIG.initialCapital*100).toFixed(1).padStart(9)}% │  $${totalFeesPaid.toFixed(0).padStart(8)} │`);
  console.log('└────────────────────────────────┴──────────────┴──────────────┴──────────────┘');
  
  // Détail mensuel
  console.log('\n' + '─'.repeat(80));
  console.log('📅 DÉTAIL MENSUEL - AVEC FRAIS + LEVERAGE');
  console.log('─'.repeat(80));
  
  const months = Object.keys(monthlyStats.withFeesAndLeverage).sort();
  let positiveMonths = 0;
  
  console.log('\n┌────────────┬─────────┬───────────┬──────────────┬──────────────┬──────────┐');
  console.log('│    Mois    │ Trades  │  Win Rate │    Frais $   │    P&L %     │  Status  │');
  console.log('├────────────┼─────────┼───────────┼──────────────┼──────────────┼──────────┤');
  
  for (const month of months) {
    const m = monthlyStats.withFeesAndLeverage[month];
    const wr = (m.wins / m.trades * 100).toFixed(1);
    const pnlPct = (m.pnl / m.startCapital * 100).toFixed(2);
    const status = m.pnl >= 0 ? '✅' : '❌';
    
    if (m.pnl >= 0) positiveMonths++;
    
    console.log(`│ ${month}   │   ${String(m.trades).padStart(4)}  │   ${wr.padStart(5)}%  │   $${m.fees.toFixed(0).padStart(8)}  │ ${(m.pnl >= 0 ? '+' : '')}${pnlPct.padStart(10)}% │    ${status}    │`);
  }
  
  console.log('└────────────┴─────────┴───────────┴──────────────┴──────────────┴──────────┘');
  
  console.log(`\n🎯 VERDICT: ${positiveMonths}/${months.length} mois positifs ${positiveMonths === months.length ? '🏆' : ''}`);
  
  // Analyse des frais
  console.log('\n' + '═'.repeat(80));
  console.log('💰 ANALYSE DES FRAIS');
  console.log('═'.repeat(80));
  
  const avgFeePerTrade = totalFeesPaid / totalTradesExecuted;
  const feesPercentOfCapital = totalFeesPaid / CONFIG.initialCapital * 100;
  
  console.log(`\n📊 Statistiques des frais:`);
  console.log(`   Frais totaux sur 4 mois: $${totalFeesPaid.toFixed(2)}`);
  console.log(`   Frais moyens par trade: $${avgFeePerTrade.toFixed(2)}`);
  console.log(`   Frais en % du capital initial: ${feesPercentOfCapital.toFixed(1)}%`);
  console.log(`   Frais en % du P&L brut: ${(totalFeesPaid / (pnlNoFees > 0 ? pnlNoFees : 1) * 100).toFixed(1)}%`);
  
  // Recommandation
  console.log('\n' + '═'.repeat(80));
  console.log('💡 RECOMMANDATION');
  console.log('═'.repeat(80));
  
  if (positiveMonths === months.length && pnlWithLeverage > 0) {
    console.log(`
✅ LA STRATÉGIE V33 EST RENTABLE MÊME AVEC LES FRAIS!

📊 Résultats sur 4 mois:
   - Capital: $${CONFIG.initialCapital} → $${capitalWithFeesAndLeverage.toFixed(0)}
   - Profit net: +$${pnlWithLeverage.toFixed(0)} (+${(pnlWithLeverage/CONFIG.initialCapital*100).toFixed(0)}%)
   - Frais payés: $${totalFeesPaid.toFixed(0)}
   - ${positiveMonths}/${months.length} mois positifs

💰 Estimation mensuelle:
   - Profit moyen/mois: +$${(pnlWithLeverage / 4).toFixed(0)}
   - ROI mensuel: +${(pnlWithLeverage / 4 / CONFIG.initialCapital * 100).toFixed(1)}%

⚠️ Points d'attention:
   - 52 trades/jour nécessite un bot 100% automatisé
   - Leverage amplifie les gains ET les pertes
   - Les frais de funding peuvent varier
`);
  } else {
    console.log(`
⚠️ ATTENTION: La stratégie n'est pas profitable avec les frais!
   - P&L net: ${pnlWithLeverage >= 0 ? '+' : ''}$${pnlWithLeverage.toFixed(0)}
   - Mois positifs: ${positiveMonths}/${months.length}
`);
  }
}

main().catch(console.error);
