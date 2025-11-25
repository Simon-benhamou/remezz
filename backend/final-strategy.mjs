#!/usr/bin/env node
/**
 * 🎯 STRATÉGIE FINALE - Combinaison de tous les filtres optimaux
 * 
 * Signal: Vol 3x + Bullish + Above MA20
 * Jours: Dim, Lun, Mer, Jeu
 * Heures: 13-14h UTC (meilleures) + éviter 12h (pire)
 * Exit: Time-based 4h avec SL 1.5%
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ enableRateLimit: true });
const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];

async function fetchCandles(symbol, days = 120) {
  const limit = days * 96;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  
  let allCandles = [];
  let fetchSince = since;
  
  while (allCandles.length < limit) {
    const candles = await exchange.fetchOHLCV(symbol, '15m', fetchSince, 1000);
    if (candles.length === 0) break;
    allCandles = allCandles.concat(candles);
    fetchSince = candles[candles.length - 1][0] + 1;
    if (candles.length < 1000) break;
  }
  
  return allCandles.slice(0, limit);
}

function calculateFeatures(candles, i) {
  if (i < 50) return null;
  
  const lookback = candles.slice(Math.max(0, i - 50), i + 1);
  if (lookback.length < 21) return null;
  
  const closes = lookback.map(c => c[4]);
  const volumes = lookback.map(c => c[5]);
  const opens = lookback.map(c => c[1]);
  
  const close = closes[closes.length - 1];
  const open = opens[opens.length - 1];
  const volume = volumes[volumes.length - 1];
  
  const len = Math.min(20, volumes.length - 1);
  const avgVol20 = volumes.slice(-len - 1, -1).reduce((a, b) => a + b, 0) / len;
  const volRatio = volume / avgVol20;
  
  const ma20len = Math.min(20, closes.length);
  const ma20 = closes.slice(-ma20len).reduce((a, b) => a + b, 0) / ma20len;
  
  return {
    volRatio,
    priceAboveMa20: close > ma20,
    isBullish: close > open,
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 STRATÉGIE FINALE - Combinaison optimale');
  console.log('═'.repeat(80));
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 ${symbol}...`);
    allCandles[symbol] = await fetchCandles(symbol, 120);
  }
  
  const CAPITAL = 10000;
  const RISK = 0.01;
  const FEES = 0.0006;
  
  // Configurations à tester
  const configs = [
    {
      name: 'Base: Vol 3x + Bull + MA20',
      signal: f => f.volRatio > 3 && f.isBullish && f.priceAboveMa20,
      dayFilter: () => true,
      hourFilter: () => true,
    },
    {
      name: 'Jours rentables (Dim,Lun,Mer,Jeu)',
      signal: f => f.volRatio > 3 && f.isBullish && f.priceAboveMa20,
      dayFilter: d => [0, 1, 3, 4].includes(d), // Dim=0, Lun=1, Mer=3, Jeu=4
      hourFilter: () => true,
    },
    {
      name: 'Éviter 12h UTC',
      signal: f => f.volRatio > 3 && f.isBullish && f.priceAboveMa20,
      dayFilter: () => true,
      hourFilter: h => h !== 12,
    },
    {
      name: 'Jours + Éviter 12h',
      signal: f => f.volRatio > 3 && f.isBullish && f.priceAboveMa20,
      dayFilter: d => [0, 1, 3, 4].includes(d),
      hourFilter: h => h !== 12,
    },
    {
      name: 'Jours + Meilleures heures (13-14h)',
      signal: f => f.volRatio > 3 && f.isBullish && f.priceAboveMa20,
      dayFilter: d => [0, 1, 3, 4].includes(d),
      hourFilter: h => h >= 13 && h <= 14,
    },
    {
      name: 'Jours + Bonnes heures (3-4h, 13-14h, 22h)',
      signal: f => f.volRatio > 3 && f.isBullish && f.priceAboveMa20,
      dayFilter: d => [0, 1, 3, 4].includes(d),
      hourFilter: h => [3, 4, 13, 14, 22].includes(h),
    },
    {
      name: 'Vol 4x + Jours',
      signal: f => f.volRatio > 4 && f.isBullish && f.priceAboveMa20,
      dayFilter: d => [0, 1, 3, 4].includes(d),
      hourFilter: () => true,
    },
    {
      name: 'Vol 5x + Jours',
      signal: f => f.volRatio > 5 && f.isBullish && f.priceAboveMa20,
      dayFilter: d => [0, 1, 3, 4].includes(d),
      hourFilter: () => true,
    },
    {
      name: 'Vol 4x + Jours + Éviter 12h',
      signal: f => f.volRatio > 4 && f.isBullish && f.priceAboveMa20,
      dayFilter: d => [0, 1, 3, 4].includes(d),
      hourFilter: h => h !== 12,
    },
  ];
  
  const allResults = [];
  
  for (const config of configs) {
    const trades = [];
    const monthlyPnL = {};
    
    for (const symbol of SYMBOLS) {
      const candles = allCandles[symbol];
      
      for (let i = 50; i < candles.length - 20; i++) {
        const features = calculateFeatures(candles, i);
        if (!features || !config.signal(features)) continue;
        
        const date = new Date(candles[i][0]);
        const dayOfWeek = date.getDay();
        const hour = date.getUTCHours();
        
        if (!config.dayFilter(dayOfWeek) || !config.hourFilter(hour)) continue;
        
        const entry = candles[i][4];
        const sl = 1.5;
        const stopPrice = entry * (1 - sl / 100);
        const holdPeriod = 16;
        
        let exitPrice = entry;
        let hitStop = false;
        
        for (let j = 1; j <= holdPeriod; j++) {
          if (i + j >= candles.length) break;
          if (candles[i + j][3] <= stopPrice) {
            exitPrice = stopPrice;
            hitStop = true;
            break;
          }
        }
        
        if (!hitStop && i + holdPeriod < candles.length) {
          exitPrice = candles[i + holdPeriod][4];
        }
        
        const pnlPct = (exitPrice - entry) / entry * 100;
        const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        
        const posSize = CAPITAL * RISK / (sl / 100);
        const fees = posSize * FEES;
        const netPnl = posSize * (pnlPct / 100) - fees;
        
        trades.push({ month, netPnl, symbol, date });
        
        if (!monthlyPnL[month]) monthlyPnL[month] = 0;
        monthlyPnL[month] += netPnl;
        
        i += 4;
      }
    }
    
    if (trades.length === 0) continue;
    
    const wins = trades.filter(t => t.netPnl > 0).length;
    const totalPnL = trades.reduce((s, t) => s + t.netPnl, 0);
    const months = Object.keys(monthlyPnL).sort();
    const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
    
    allResults.push({
      name: config.name,
      trades: trades.length,
      winRate: wins / trades.length * 100,
      totalPnL,
      positiveMonths,
      totalMonths: months.length,
      monthlyPnL,
    });
  }
  
  // Trier par mois positifs puis P&L
  allResults.sort((a, b) => {
    const ratioA = a.positiveMonths / a.totalMonths;
    const ratioB = b.positiveMonths / b.totalMonths;
    if (ratioB !== ratioA) return ratioB - ratioA;
    return b.totalPnL - a.totalPnL;
  });
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS');
  console.log('═'.repeat(80));
  
  console.log('\n┌───────────────────────────────────────┬────────┬─────────┬──────────┬────────┐');
  console.log('│            Configuration              │ Trades │   WR    │   P&L    │ Mois   │');
  console.log('├───────────────────────────────────────┼────────┼─────────┼──────────┼────────┤');
  
  for (const r of allResults) {
    const name = r.name.slice(0, 37).padEnd(37);
    const trades = String(r.trades).padStart(6);
    const wr = (r.winRate.toFixed(1) + '%').padStart(7);
    const pnl = (r.totalPnL >= 0 ? '+$' : '-$') + Math.abs(r.totalPnL).toFixed(0).padStart(5);
    const months = `${r.positiveMonths}/${r.totalMonths}`;
    const status = r.positiveMonths >= r.totalMonths * 0.8 ? '✅' : (r.positiveMonths >= r.totalMonths * 0.6 ? '⚠️' : '❌');
    
    console.log(`│ ${name} │ ${trades} │ ${wr} │ ${pnl} │ ${months} ${status}│`);
  }
  console.log('└───────────────────────────────────────┴────────┴─────────┴──────────┴────────┘');
  
  // Détail des meilleurs
  const best = allResults.filter(r => r.positiveMonths >= 3);
  
  console.log('\n' + '═'.repeat(80));
  console.log('🏆 DÉTAIL DES MEILLEURES CONFIGS');
  console.log('═'.repeat(80));
  
  for (const r of best.slice(0, 3)) {
    console.log(`\n📊 ${r.name}`);
    console.log(`   Trades: ${r.trades} | WR: ${r.winRate.toFixed(1)}%`);
    console.log(`   P&L Total: ${r.totalPnL >= 0 ? '+' : ''}$${r.totalPnL.toFixed(0)}`);
    console.log(`   ROI: ${(r.totalPnL / CAPITAL * 100).toFixed(1)}%`);
    console.log(`   Mensuel:`);
    
    const months = Object.keys(r.monthlyPnL).sort();
    for (const month of months) {
      const pnl = r.monthlyPnL[month];
      console.log(`      ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${pnl > 0 ? '✅' : '❌'}`);
    }
  }
  
  // Calcul des revenus projetés
  const bestConfig = allResults[0];
  if (bestConfig && bestConfig.totalPnL > 0) {
    console.log('\n' + '═'.repeat(80));
    console.log('💰 PROJECTION REVENUS - Meilleure Config');
    console.log('═'.repeat(80));
    
    const monthlyAvg = bestConfig.totalPnL / bestConfig.totalMonths;
    const roiMonthly = monthlyAvg / CAPITAL * 100;
    
    console.log(`\n📊 Stratégie: ${bestConfig.name}`);
    console.log(`   ROI mensuel moyen: ${roiMonthly.toFixed(1)}%`);
    console.log(`   Trades/mois: ${(bestConfig.trades / bestConfig.totalMonths).toFixed(1)}`);
    
    console.log('\n┌──────────────────┬────────────────┬────────────────┬────────────────┐');
    console.log('│  Capital Initial │ Profit/Mois    │ Profit/An      │ ROI Annuel     │');
    console.log('├──────────────────┼────────────────┼────────────────┼────────────────┤');
    
    for (const cap of [5000, 10000, 25000, 50000, 100000]) {
      const mult = cap / CAPITAL;
      const profitMois = monthlyAvg * mult;
      const profitAn = profitMois * 12;
      const roi = (profitAn / cap * 100).toFixed(1);
      
      console.log(`│ $${String(cap).padStart(15)} │ ${(profitMois >= 0 ? '+$' : '-$') + Math.abs(profitMois).toFixed(0).padStart(12)} │ ${(profitAn >= 0 ? '+$' : '-$') + Math.abs(profitAn).toFixed(0).padStart(12)} │ ${(parseFloat(roi) >= 0 ? '+' : '') + roi + '%'.padStart(13)} │`);
    }
    
    console.log('└──────────────────┴────────────────┴────────────────┴────────────────┘');
    
    // Avec leverage
    console.log('\n📈 Avec Leverage (5x):');
    const leveragedRoi = roiMonthly * 5;
    console.log(`   ROI mensuel: ${leveragedRoi.toFixed(1)}%`);
    console.log(`   ROI annuel: ${(leveragedRoi * 12).toFixed(1)}%`);
    console.log(`   Sur $10k: +$${(10000 * leveragedRoi * 12 / 100).toFixed(0)}/an`);
  }
  
  // Test supplémentaire: combiner plusieurs signaux
  console.log('\n' + '═'.repeat(80));
  console.log('🔬 TEST: COMBINAISON MULTI-SIGNAUX');
  console.log('═'.repeat(80));
  
  // Ajouter un signal de confirmation
  const multiSignalTrades = [];
  const multiSignalMonthly = {};
  
  for (const symbol of SYMBOLS) {
    const candles = allCandles[symbol];
    
    for (let i = 50; i < candles.length - 20; i++) {
      const features = calculateFeatures(candles, i);
      if (!features) continue;
      
      // Signal 1: Vol 3x + Bullish + MA20
      const signal1 = features.volRatio > 3 && features.isBullish && features.priceAboveMa20;
      
      // Signal 2: Confirmation - la bougie précédente aussi bullish
      const prevCandle = candles[i - 1];
      const signal2 = prevCandle[4] > prevCandle[1]; // Previous aussi bullish
      
      // Signal 3: Volume croissant
      const prevFeatures = calculateFeatures(candles, i - 1);
      const signal3 = prevFeatures && features.volRatio > prevFeatures.volRatio;
      
      // Filtre jour
      const date = new Date(candles[i][0]);
      const dayOfWeek = date.getDay();
      if (![0, 1, 3, 4].includes(dayOfWeek)) continue;
      
      // Combinaison: Signal1 + (Signal2 OU Signal3)
      if (!signal1 || !(signal2 || signal3)) continue;
      
      const entry = candles[i][4];
      const sl = 1.5;
      const stopPrice = entry * (1 - sl / 100);
      
      let exitPrice = entry;
      for (let j = 1; j <= 16; j++) {
        if (i + j >= candles.length) break;
        if (candles[i + j][3] <= stopPrice) {
          exitPrice = stopPrice;
          break;
        }
      }
      if (exitPrice === entry && i + 16 < candles.length) {
        exitPrice = candles[i + 16][4];
      }
      
      const pnlPct = (exitPrice - entry) / entry * 100;
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      const posSize = CAPITAL * RISK / (sl / 100);
      const fees = posSize * FEES;
      const netPnl = posSize * (pnlPct / 100) - fees;
      
      multiSignalTrades.push({ month, netPnl });
      
      if (!multiSignalMonthly[month]) multiSignalMonthly[month] = 0;
      multiSignalMonthly[month] += netPnl;
      
      i += 4;
    }
  }
  
  if (multiSignalTrades.length > 0) {
    const wins = multiSignalTrades.filter(t => t.netPnl > 0).length;
    const totalPnL = multiSignalTrades.reduce((s, t) => s + t.netPnl, 0);
    const months = Object.keys(multiSignalMonthly).sort();
    const positiveMonths = months.filter(m => multiSignalMonthly[m] > 0).length;
    
    console.log(`\n📊 Multi-Signal (Vol3x + MA20 + Confirmation)`);
    console.log(`   Trades: ${multiSignalTrades.length} | WR: ${(wins/multiSignalTrades.length*100).toFixed(1)}%`);
    console.log(`   P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}`);
    console.log(`   Mois: ${positiveMonths}/${months.length}`);
    
    for (const month of months) {
      const pnl = multiSignalMonthly[month];
      console.log(`      ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${pnl > 0 ? '✅' : '❌'}`);
    }
  }
}

main().catch(console.error);
