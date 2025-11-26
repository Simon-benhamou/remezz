#!/usr/bin/env node
/**
 * 🔬 ANALYSE DEEP - Pourquoi certains mois perdent?
 * 
 * Hypothèse: Le signal fonctionne en bull/range mais pas en bear
 * Test: Ajouter un filtre de tendance macro (BTC)
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
  if (i < 100) return null;
  
  const lookback = candles.slice(i - 100, i + 1);
  const closes = lookback.map(c => c[4]);
  const volumes = lookback.map(c => c[5]);
  const opens = lookback.map(c => c[1]);
  
  const close = closes[closes.length - 1];
  const open = opens[opens.length - 1];
  const volume = volumes[volumes.length - 1];
  
  const avgVol20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volRatio = volume / avgVol20;
  
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const ma100 = closes.slice(-100).reduce((a, b) => a + b, 0) / 100;
  
  // Trend indicators
  const momentum7d = closes.length >= 97 ? (close - closes[closes.length - 97]) / closes[closes.length - 97] * 100 : 0;
  const momentum30d = closes.length >= 97 ? (ma20 - closes.slice(-97, -77).reduce((a, b) => a + b, 0) / 20) / (closes.slice(-97, -77).reduce((a, b) => a + b, 0) / 20) * 100 : 0;
  
  // MA Trend
  const ma20Trend = ma20 > closes.slice(-25, -20).reduce((a, b) => a + b, 0) / 5;
  const ma50Trend = ma50 > closes.slice(-55, -50).reduce((a, b) => a + b, 0) / 5;
  
  return {
    volRatio,
    priceAboveMa20: close > ma20,
    priceAboveMa50: close > ma50,
    priceAboveMa100: close > ma100,
    isBullish: close > open,
    momentum7d,
    momentum30d,
    ma20Trend,
    ma50Trend,
    ma20,
    ma50,
    ma100,
    close,
  };
}

// Calculer le régime de marché BTC
function getBtcRegime(btcFeatures) {
  if (!btcFeatures) return 'UNKNOWN';
  
  // Bull: Prix > MA50, MA20 montante, momentum positif
  if (btcFeatures.priceAboveMa50 && btcFeatures.ma20Trend && btcFeatures.momentum7d > -2) {
    return 'BULL';
  }
  
  // Bear: Prix < MA50, momentum très négatif
  if (!btcFeatures.priceAboveMa50 && btcFeatures.momentum7d < -5) {
    return 'BEAR';
  }
  
  // Strong Bull: Prix > MA100, tout aligned
  if (btcFeatures.priceAboveMa100 && btcFeatures.priceAboveMa50 && btcFeatures.ma20Trend && btcFeatures.momentum7d > 2) {
    return 'STRONG_BULL';
  }
  
  return 'RANGE';
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 ANALYSE DEEP - Impact du régime de marché BTC');
  console.log('═'.repeat(80));
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 ${symbol}...`);
    allCandles[symbol] = await fetchCandles(symbol, 365);
  }
  
  const btcCandles = allCandles['BTC/USDT:USDT'];
  
  const CAPITAL = 10000;
  const RISK = 0.01;
  const FEES = 0.0006;
  const SL = 1.5;
  const HOLD_PERIOD = 16;
  
  // Signal de base
  const baseSignal = f => f.volRatio > 5 && f.isBullish && f.priceAboveMa20;
  const dayFilter = d => [0, 1, 3, 4].includes(d);
  
  // Collecter tous les trades avec leur régime BTC
  const allTrades = [];
  
  for (const symbol of SYMBOLS) {
    const candles = allCandles[symbol];
    
    for (let i = 100; i < candles.length - HOLD_PERIOD - 1; i++) {
      const features = calculateFeatures(candles, i);
      if (!features || !baseSignal(features)) continue;
      
      const date = new Date(candles[i][0]);
      if (!dayFilter(date.getDay())) continue;
      
      // Régime BTC à ce moment
      const btcFeatures = calculateFeatures(btcCandles, i);
      const btcRegime = getBtcRegime(btcFeatures);
      
      const entry = candles[i][4];
      const stopPrice = entry * (1 - SL / 100);
      
      let exitPrice = entry;
      for (let j = 1; j <= HOLD_PERIOD; j++) {
        if (i + j >= candles.length) break;
        if (candles[i + j][3] <= stopPrice) {
          exitPrice = stopPrice;
          break;
        }
      }
      if (exitPrice === entry && i + HOLD_PERIOD < candles.length) {
        exitPrice = candles[i + HOLD_PERIOD][4];
      }
      
      const pnlPct = (exitPrice - entry) / entry * 100;
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      const posSize = CAPITAL * RISK / (SL / 100);
      const fees = posSize * FEES;
      const netPnl = posSize * (pnlPct / 100) - fees;
      
      allTrades.push({
        date,
        month,
        symbol,
        netPnl,
        win: netPnl > 0,
        btcRegime,
        btcMomentum: btcFeatures?.momentum7d || 0,
        btcAboveMa50: btcFeatures?.priceAboveMa50 || false,
      });
      
      i += 4;
    }
  }
  
  // Analyser par régime BTC
  console.log('\n' + '═'.repeat(80));
  console.log('📊 PERFORMANCE PAR RÉGIME BTC');
  console.log('═'.repeat(80));
  
  const regimes = ['STRONG_BULL', 'BULL', 'RANGE', 'BEAR', 'UNKNOWN'];
  
  console.log('\n┌───────────────┬─────────┬───────────┬──────────────┐');
  console.log('│    Régime     │ Trades  │  Win Rate │     P&L      │');
  console.log('├───────────────┼─────────┼───────────┼──────────────┤');
  
  for (const regime of regimes) {
    const regimeTrades = allTrades.filter(t => t.btcRegime === regime);
    if (regimeTrades.length === 0) continue;
    
    const wins = regimeTrades.filter(t => t.win).length;
    const pnl = regimeTrades.reduce((s, t) => s + t.netPnl, 0);
    
    const r = regime.padEnd(13);
    const tr = String(regimeTrades.length).padStart(7);
    const wr = (wins / regimeTrades.length * 100).toFixed(1).padStart(8) + '%';
    const pnlStr = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(0).padStart(8);
    const status = pnl > 0 ? '✅' : '❌';
    
    console.log(`│ ${r} │ ${tr} │ ${wr}  │ ${pnlStr}  │ ${status}`);
  }
  
  console.log('└───────────────┴─────────┴───────────┴──────────────┘');
  
  // Test: Filtrer par régime
  console.log('\n' + '═'.repeat(80));
  console.log('🧪 TEST: FILTRER PAR RÉGIME BTC');
  console.log('═'.repeat(80));
  
  const filters = [
    { name: 'Tous', test: () => true },
    { name: 'Not BEAR', test: t => t.btcRegime !== 'BEAR' },
    { name: 'BULL only', test: t => t.btcRegime === 'BULL' || t.btcRegime === 'STRONG_BULL' },
    { name: 'STRONG_BULL only', test: t => t.btcRegime === 'STRONG_BULL' },
    { name: 'BULL or RANGE', test: t => ['BULL', 'STRONG_BULL', 'RANGE'].includes(t.btcRegime) },
    { name: 'BTC > MA50', test: t => t.btcAboveMa50 },
    { name: 'BTC momentum > 0', test: t => t.btcMomentum > 0 },
    { name: 'BTC momentum > -2', test: t => t.btcMomentum > -2 },
  ];
  
  console.log('\n┌──────────────────────┬─────────┬───────────┬──────────────┬────────────┐');
  console.log('│       Filtre         │ Trades  │  Win Rate │     P&L      │ Mois +/-   │');
  console.log('├──────────────────────┼─────────┼───────────┼──────────────┼────────────┤');
  
  for (const filter of filters) {
    const filtered = allTrades.filter(filter.test);
    if (filtered.length === 0) continue;
    
    const wins = filtered.filter(t => t.win).length;
    const pnl = filtered.reduce((s, t) => s + t.netPnl, 0);
    
    // Calculer mois positifs
    const monthlyPnL = {};
    for (const t of filtered) {
      if (!monthlyPnL[t.month]) monthlyPnL[t.month] = 0;
      monthlyPnL[t.month] += t.netPnl;
    }
    const months = Object.keys(monthlyPnL);
    const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
    
    const f = filter.name.padEnd(20);
    const tr = String(filtered.length).padStart(7);
    const wr = (wins / filtered.length * 100).toFixed(1).padStart(8) + '%';
    const pnlStr = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(0).padStart(8);
    const monthsStr = `${positiveMonths}/${months.length}`.padStart(8);
    const status = positiveMonths >= months.length * 0.7 ? '✅' : (positiveMonths >= months.length * 0.5 ? '⚠️' : '❌');
    
    console.log(`│ ${f} │ ${tr} │ ${wr}  │ ${pnlStr}  │ ${monthsStr} ${status} │`);
  }
  
  console.log('└──────────────────────┴─────────┴───────────┴──────────────┴────────────┘');
  
  // Détail du meilleur filtre
  const bestFilter = filters.find(f => f.name === 'BTC > MA50');
  const bestFiltered = allTrades.filter(bestFilter.test);
  
  if (bestFiltered.length > 0) {
    console.log('\n' + '═'.repeat(80));
    console.log(`🏆 DÉTAIL: ${bestFilter.name}`);
    console.log('═'.repeat(80));
    
    const monthlyPnL = {};
    for (const t of bestFiltered) {
      if (!monthlyPnL[t.month]) monthlyPnL[t.month] = 0;
      monthlyPnL[t.month] += t.netPnl;
    }
    
    const months = Object.keys(monthlyPnL).sort();
    console.log('\n📅 Performance mensuelle:');
    
    for (const month of months) {
      const pnl = monthlyPnL[month];
      const trades = bestFiltered.filter(t => t.month === month).length;
      console.log(`   ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} (${trades} trades) ${pnl > 0 ? '✅' : '❌'}`);
    }
    
    const totalPnL = bestFiltered.reduce((s, t) => s + t.netPnl, 0);
    const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
    
    console.log(`\n📊 Total: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)} | ${positiveMonths}/${months.length} mois positifs`);
  }
  
  // Test final: combiner tout
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 STRATÉGIE OPTIMALE COMBINÉE');
  console.log('═'.repeat(80));
  
  const optimalFiltered = allTrades.filter(t => 
    t.btcAboveMa50 && // BTC en tendance haussière
    t.btcMomentum > -3 // Pas de momentum fortement négatif
  );
  
  if (optimalFiltered.length > 0) {
    const monthlyPnL = {};
    for (const t of optimalFiltered) {
      if (!monthlyPnL[t.month]) monthlyPnL[t.month] = 0;
      monthlyPnL[t.month] += t.netPnl;
    }
    
    const wins = optimalFiltered.filter(t => t.win).length;
    const totalPnL = optimalFiltered.reduce((s, t) => s + t.netPnl, 0);
    const months = Object.keys(monthlyPnL).sort();
    const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
    
    console.log('\n📊 Signal: Vol 5x + Bullish + MA20');
    console.log('📅 Filtres: Dim/Lun/Mer/Jeu + BTC > MA50 + BTC momentum > -3');
    console.log(`\n   Trades: ${optimalFiltered.length}`);
    console.log(`   Win Rate: ${(wins / optimalFiltered.length * 100).toFixed(1)}%`);
    console.log(`   P&L Total: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}`);
    console.log(`   Mois positifs: ${positiveMonths}/${months.length} (${(positiveMonths/months.length*100).toFixed(0)}%)`);
    
    console.log('\n📅 Détail mensuel:');
    for (const month of months) {
      const pnl = monthlyPnL[month];
      console.log(`   ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${pnl > 0 ? '✅' : '❌'}`);
    }
    
    // Projection
    const monthlyAvg = totalPnL / months.length;
    const roiAnnual = monthlyAvg * 12 / CAPITAL * 100;
    
    console.log(`\n💰 Projection: ROI annuel = ${roiAnnual.toFixed(1)}%`);
    
    if (positiveMonths >= months.length * 0.7) {
      console.log('\n✅ STRATÉGIE VALIDÉE - 70%+ de mois positifs');
    } else {
      console.log('\n⚠️ STRATÉGIE À AMÉLIORER');
    }
  }
}

main().catch(console.error);
