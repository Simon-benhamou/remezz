#!/usr/bin/env node
/**
 * 🎯 VALIDATION 12 MOIS - Vol 5x + Jours (Dim,Lun,Mer,Jeu)
 * 
 * Signal trouvé: Vol > 5x moyenne + Bullish + Above MA20
 * Filtre: Dimanche, Lundi, Mercredi, Jeudi seulement
 * Exit: Time-based 4h avec SL 1.5%
 * 
 * Résultats 4 mois: 62.8% WR, 3/4 mois positifs, +27% ROI
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ enableRateLimit: true });
const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];

async function fetchCandles(symbol, days = 365) {
  const limit = Math.min(days * 96, 35000);
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
  console.log('🎯 VALIDATION 12 MOIS - Vol 5x + Jours Rentables');
  console.log('═'.repeat(80));
  console.log('\n📊 Signal: Vol > 5x + Bullish + Above MA20');
  console.log('📅 Filtre: Dim, Lun, Mer, Jeu uniquement');
  console.log('⏱️ Exit: 4h time-based avec SL 1.5%');
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`\n📥 ${symbol}...`);
    allCandles[symbol] = await fetchCandles(symbol, 365);
    console.log(`   ✅ ${allCandles[symbol].length} candles`);
  }
  
  const firstDate = new Date(Math.max(...Object.values(allCandles).map(c => c[0][0])));
  const lastDate = new Date(Math.min(...Object.values(allCandles).map(c => c[c.length - 1][0])));
  const days = Math.floor((lastDate - firstDate) / (24 * 60 * 60 * 1000));
  console.log(`\n📅 Période: ${firstDate.toISOString().slice(0, 10)} → ${lastDate.toISOString().slice(0, 10)} (${days} jours)`);
  
  const CAPITAL = 10000;
  const RISK = 0.01;
  const FEES = 0.0006;
  const SL = 1.5;
  const HOLD_PERIOD = 16; // 4h en bougies 15min
  
  const trades = [];
  const monthlyPnL = {};
  const symbolStats = {};
  
  for (const symbol of SYMBOLS) {
    symbolStats[symbol] = { trades: 0, wins: 0, pnl: 0 };
    const candles = allCandles[symbol];
    
    for (let i = 50; i < candles.length - HOLD_PERIOD - 1; i++) {
      const features = calculateFeatures(candles, i);
      if (!features) continue;
      
      // Signal: Vol 5x + Bullish + Above MA20
      if (features.volRatio < 5 || !features.isBullish || !features.priceAboveMa20) continue;
      
      // Filtre jour: Dim(0), Lun(1), Mer(3), Jeu(4)
      const date = new Date(candles[i][0]);
      const dayOfWeek = date.getDay();
      if (![0, 1, 3, 4].includes(dayOfWeek)) continue;
      
      const entry = candles[i][4];
      const stopPrice = entry * (1 - SL / 100);
      
      let exitPrice = entry;
      let hitStop = false;
      let exitBar = HOLD_PERIOD;
      
      for (let j = 1; j <= HOLD_PERIOD; j++) {
        if (i + j >= candles.length) break;
        if (candles[i + j][3] <= stopPrice) {
          exitPrice = stopPrice;
          hitStop = true;
          exitBar = j;
          break;
        }
      }
      
      if (!hitStop && i + HOLD_PERIOD < candles.length) {
        exitPrice = candles[i + HOLD_PERIOD][4];
      }
      
      const pnlPct = (exitPrice - entry) / entry * 100;
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      const posSize = CAPITAL * RISK / (SL / 100);
      const fees = posSize * FEES;
      const netPnl = posSize * (pnlPct / 100) - fees;
      const win = netPnl > 0;
      
      trades.push({ 
        date, 
        month, 
        symbol, 
        entry, 
        exitPrice, 
        pnlPct, 
        netPnl, 
        win, 
        hitStop,
        volRatio: features.volRatio,
      });
      
      if (!monthlyPnL[month]) monthlyPnL[month] = 0;
      monthlyPnL[month] += netPnl;
      
      symbolStats[symbol].trades++;
      if (win) symbolStats[symbol].wins++;
      symbolStats[symbol].pnl += netPnl;
      
      i += 4; // Skip 1h pour éviter overlap
    }
  }
  
  // Statistiques globales
  const totalTrades = trades.length;
  const wins = trades.filter(t => t.win).length;
  const totalPnL = trades.reduce((s, t) => s + t.netPnl, 0);
  const totalFees = trades.length * CAPITAL * RISK / (SL / 100) * FEES;
  const months = Object.keys(monthlyPnL).sort();
  const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS GLOBAUX');
  console.log('═'.repeat(80));
  
  console.log(`\n📈 Performance:`);
  console.log(`   Trades: ${totalTrades} (${(totalTrades / (days / 30)).toFixed(1)}/mois)`);
  console.log(`   Win Rate: ${(wins / totalTrades * 100).toFixed(1)}%`);
  console.log(`   P&L Net Total: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}`);
  console.log(`   Frais Totaux: $${totalFees.toFixed(0)}`);
  console.log(`   ROI Total: ${(totalPnL / CAPITAL * 100).toFixed(1)}%`);
  console.log(`   ROI Mensuel Moyen: ${(totalPnL / CAPITAL * 100 / months.length).toFixed(1)}%`);
  
  console.log(`\n🎯 Mois Positifs: ${positiveMonths}/${months.length} (${(positiveMonths/months.length*100).toFixed(0)}%)`);
  
  // Détail mensuel
  console.log('\n' + '═'.repeat(80));
  console.log('📅 PERFORMANCE MENSUELLE');
  console.log('═'.repeat(80));
  
  console.log('\n┌────────────┬─────────┬───────────┬──────────────┬──────────┐');
  console.log('│    Mois    │ Trades  │  Win Rate │     P&L      │  Status  │');
  console.log('├────────────┼─────────┼───────────┼──────────────┼──────────┤');
  
  for (const month of months) {
    const monthTrades = trades.filter(t => t.month === month);
    const monthWins = monthTrades.filter(t => t.win).length;
    const monthPnL = monthlyPnL[month];
    
    const m = month.padEnd(10);
    const tr = String(monthTrades.length).padStart(7);
    const wr = (monthWins / monthTrades.length * 100).toFixed(1).padStart(8) + '%';
    const pnl = (monthPnL >= 0 ? '+$' : '-$') + Math.abs(monthPnL).toFixed(0).padStart(8);
    const status = monthPnL > 0 ? '✅' : '❌';
    
    console.log(`│ ${m} │ ${tr} │ ${wr}  │ ${pnl}  │    ${status}    │`);
  }
  
  console.log('└────────────┴─────────┴───────────┴──────────────┴──────────┘');
  
  // Performance par symbol
  console.log('\n' + '═'.repeat(80));
  console.log('📊 PERFORMANCE PAR SYMBOL');
  console.log('═'.repeat(80));
  
  console.log('\n┌────────────────────┬─────────┬───────────┬──────────────┐');
  console.log('│      Symbol        │ Trades  │  Win Rate │     P&L      │');
  console.log('├────────────────────┼─────────┼───────────┼──────────────┤');
  
  for (const [symbol, stats] of Object.entries(symbolStats)) {
    const s = symbol.padEnd(18);
    const tr = String(stats.trades).padStart(7);
    const wr = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1).padStart(8) + '%' : '    N/A  ';
    const pnl = (stats.pnl >= 0 ? '+$' : '-$') + Math.abs(stats.pnl).toFixed(0).padStart(8);
    
    console.log(`│ ${s} │ ${tr} │ ${wr}  │ ${pnl}  │`);
  }
  
  console.log('└────────────────────┴─────────┴───────────┴──────────────┘');
  
  // Projection revenus
  console.log('\n' + '═'.repeat(80));
  console.log('💰 PROJECTION REVENUS');
  console.log('═'.repeat(80));
  
  const monthlyAvg = totalPnL / months.length;
  const roiMonthly = monthlyAvg / CAPITAL * 100;
  
  console.log(`\n📊 Statistiques:`);
  console.log(`   ROI mensuel moyen: ${roiMonthly >= 0 ? '+' : ''}${roiMonthly.toFixed(1)}%`);
  console.log(`   Trades/mois: ${(totalTrades / months.length).toFixed(1)}`);
  
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
  
  // Verdict
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 VERDICT');
  console.log('═'.repeat(80));
  
  const minMonthsPositive = 0.7; // 70% des mois
  const isViable = totalPnL > 0 && positiveMonths >= months.length * minMonthsPositive;
  
  if (isViable) {
    console.log(`\n✅ STRATÉGIE VALIDÉE`);
    console.log(`   ${positiveMonths}/${months.length} mois positifs (${(positiveMonths/months.length*100).toFixed(0)}%)`);
    console.log(`   ROI annuel projeté: ${(roiMonthly * 12).toFixed(1)}%`);
  } else if (totalPnL > 0) {
    console.log(`\n⚠️ STRATÉGIE RENTABLE MAIS INSTABLE`);
    console.log(`   ${positiveMonths}/${months.length} mois positifs (${(positiveMonths/months.length*100).toFixed(0)}%)`);
    console.log(`   < 70% de mois positifs requis`);
  } else {
    console.log(`\n❌ STRATÉGIE NON VIABLE`);
    console.log(`   P&L négatif: $${totalPnL.toFixed(0)}`);
  }
  
  // Analyse des pertes
  if (positiveMonths < months.length) {
    console.log(`\n📉 Mois négatifs:`);
    for (const month of months) {
      if (monthlyPnL[month] < 0) {
        const monthTrades = trades.filter(t => t.month === month);
        const stopped = monthTrades.filter(t => t.hitStop).length;
        console.log(`   ${month}: $${monthlyPnL[month].toFixed(0)} (${monthTrades.length} trades, ${stopped} stoppés)`);
      }
    }
  }
}

main().catch(console.error);
