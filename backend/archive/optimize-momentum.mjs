#!/usr/bin/env node
/**
 * 🎯 OPTIMISATION DU FILTRE MOMENTUM 4H
 * 
 * Base prometteuse: Vol 4x + BTC MA50 + 4h mom > 1% = 8/12 mois positifs
 * Objectif: Optimiser pour augmenter le P&L tout en gardant la constance
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

function calculateFeatures(candles, i, btcCandles) {
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
  
  const btcLookback = btcCandles.slice(i - 100, i + 1);
  const btcCloses = btcLookback.map(c => c[4]);
  const btcMA50 = btcCloses.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const btcNow = btcCloses[btcCloses.length - 1];
  
  // Momentum BTC sur les dernières 4h (16 bougies)
  const btc4hAgo = btcCloses[btcCloses.length - 17] || btcCloses[0];
  const btcMomentum4h = (btcNow - btc4hAgo) / btc4hAgo * 100;
  
  // Momentum sur 2h, 6h, 8h
  const btc2hAgo = btcCloses[btcCloses.length - 9] || btcCloses[0];
  const btcMomentum2h = (btcNow - btc2hAgo) / btc2hAgo * 100;
  
  const btc6hAgo = btcCloses[btcCloses.length - 25] || btcCloses[0];
  const btcMomentum6h = (btcNow - btc6hAgo) / btc6hAgo * 100;
  
  return {
    volRatio,
    priceAboveMa20: close > ma20,
    isBullish: close > open,
    btcAboveMa50: btcNow > btcMA50,
    btcMomentum2h,
    btcMomentum4h,
    btcMomentum6h,
    btcNow,
    btcMA50,
  };
}

async function backtest(allCandles, btcCandles, config) {
  const { volMin, btcMomMin, momPeriod, slPct, holdPeriod } = config;
  
  const CAPITAL = 10000;
  const RISK = 0.01;
  const FEES = 0.0006;
  
  const dayFilter = d => [0, 1, 3, 4].includes(d);
  
  const trades = [];
  const monthlyPnL = {};
  
  for (const symbol of SYMBOLS) {
    const candles = allCandles[symbol];
    
    for (let i = 100; i < candles.length - holdPeriod - 1; i++) {
      const features = calculateFeatures(candles, i, btcCandles);
      if (!features) continue;
      
      const date = new Date(candles[i][0]);
      if (!dayFilter(date.getDay())) continue;
      
      // Signal: Vol + Bullish + MA20
      if (features.volRatio < volMin) continue;
      if (!features.isBullish) continue;
      if (!features.priceAboveMa20) continue;
      
      // Filtre: BTC > MA50 + momentum
      if (!features.btcAboveMa50) continue;
      
      let btcMom;
      if (momPeriod === '2h') btcMom = features.btcMomentum2h;
      else if (momPeriod === '4h') btcMom = features.btcMomentum4h;
      else btcMom = features.btcMomentum6h;
      
      if (btcMom < btcMomMin) continue;
      
      const entry = candles[i][4];
      const stopPrice = entry * (1 - slPct / 100);
      
      let exitPrice = entry;
      for (let j = 1; j <= holdPeriod; j++) {
        if (i + j >= candles.length) break;
        if (candles[i + j][3] <= stopPrice) {
          exitPrice = stopPrice;
          break;
        }
      }
      if (exitPrice === entry && i + holdPeriod < candles.length) {
        exitPrice = candles[i + holdPeriod][4];
      }
      
      const pnlPct = (exitPrice - entry) / entry * 100;
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const posSize = CAPITAL * RISK / (slPct / 100);
      const fees = posSize * FEES;
      const netPnl = posSize * (pnlPct / 100) - fees;
      
      trades.push({ month, netPnl, win: netPnl > 0 });
      if (!monthlyPnL[month]) monthlyPnL[month] = 0;
      monthlyPnL[month] += netPnl;
      
      i += 4;
    }
  }
  
  const months = Object.keys(monthlyPnL).sort();
  const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
  const totalPnL = trades.reduce((s, t) => s + t.netPnl, 0);
  const winRate = trades.length > 0 ? trades.filter(t => t.win).length / trades.length * 100 : 0;
  
  return {
    trades: trades.length,
    winRate,
    totalPnL,
    months,
    positiveMonths,
    monthlyPnL,
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 OPTIMISATION FILTRE MOMENTUM 4H');
  console.log('═'.repeat(80));
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 ${symbol}...`);
    allCandles[symbol] = await fetchCandles(symbol, 365);
  }
  
  const btcCandles = allCandles['BTC/USDT:USDT'];
  
  // Paramètres à tester
  const volMinValues = [3, 4, 5];
  const btcMomMinValues = [0.5, 0.75, 1, 1.25, 1.5];
  const momPeriods = ['2h', '4h', '6h'];
  const slValues = [1, 1.5, 2];
  const holdValues = [12, 16, 20, 24]; // 3h, 4h, 5h, 6h
  
  const results = [];
  
  console.log('\n📊 GRILLE DE RECHERCHE...');
  
  for (const volMin of volMinValues) {
    for (const btcMomMin of btcMomMinValues) {
      for (const momPeriod of momPeriods) {
        for (const slPct of slValues) {
          for (const holdPeriod of holdValues) {
            const config = { volMin, btcMomMin, momPeriod, slPct, holdPeriod };
            const result = await backtest(allCandles, btcCandles, config);
            
            if (result.trades >= 30) {
              results.push({
                ...config,
                ...result,
                monthRatio: result.positiveMonths / result.months.length,
                score: result.totalPnL * (result.positiveMonths / result.months.length),
              });
            }
          }
        }
      }
    }
  }
  
  // Trier par ratio de mois positifs, puis par P&L
  results.sort((a, b) => {
    if (Math.abs(a.monthRatio - b.monthRatio) > 0.05) return b.monthRatio - a.monthRatio;
    return b.totalPnL - a.totalPnL;
  });
  
  console.log('\n' + '═'.repeat(100));
  console.log('🏆 TOP 15 CONFIGURATIONS (classées par constance puis P&L)');
  console.log('═'.repeat(100));
  console.log('Vol │ Mom  │ Period │ SL   │ Hold │ Trades │ WR    │ P&L      │ Mois+  │ Score');
  console.log('─'.repeat(100));
  
  for (const r of results.slice(0, 15)) {
    const volStr = String(r.volMin).padStart(3);
    const momStr = `>${r.btcMomMin}%`.padStart(5);
    const periodStr = r.momPeriod.padStart(4);
    const slStr = `${r.slPct}%`.padStart(4);
    const holdStr = `${r.holdPeriod * 15}m`.padStart(4);
    const tradesStr = String(r.trades).padStart(6);
    const wrStr = `${r.winRate.toFixed(1)}%`.padStart(5);
    const pnlStr = `${r.totalPnL >= 0 ? '+' : ''}$${r.totalPnL.toFixed(0)}`.padStart(8);
    const monthStr = `${r.positiveMonths}/${r.months.length} (${(r.monthRatio*100).toFixed(0)}%)`.padStart(10);
    const scoreStr = r.score.toFixed(0).padStart(6);
    
    console.log(`${volStr} │ ${momStr} │ ${periodStr}   │ ${slStr} │ ${holdStr} │ ${tradesStr} │ ${wrStr} │ ${pnlStr} │ ${monthStr} │ ${scoreStr}`);
  }
  
  // Afficher les détails du top 3
  console.log('\n' + '═'.repeat(80));
  console.log('📋 DÉTAIL MENSUEL DES TOP 3');
  console.log('═'.repeat(80));
  
  for (let i = 0; i < Math.min(3, results.length); i++) {
    const r = results[i];
    console.log(`\n#${i+1}: Vol ${r.volMin}x + BTC MA50 + ${r.momPeriod} mom > ${r.btcMomMin}% | SL ${r.slPct}% | Hold ${r.holdPeriod * 15}m`);
    console.log(`   ${r.trades} trades | WR ${r.winRate.toFixed(1)}% | P&L ${r.totalPnL >= 0 ? '+' : ''}$${r.totalPnL.toFixed(0)} | ${r.positiveMonths}/${r.months.length} mois`);
    
    for (const month of r.months) {
      const pnl = r.monthlyPnL[month];
      console.log(`   ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${pnl > 0 ? '✅' : '❌'}`);
    }
    
    const roiAnnual = (r.totalPnL / 10000) * (12 / r.months.length) * 100;
    console.log(`   💰 ROI annuel projeté: ${roiAnnual.toFixed(1)}%`);
  }
  
  // Rechercher la meilleure config avec >65% mois positifs ET > $2000 P&L
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 MEILLEURE CONFIG ÉQUILIBRÉE (>65% mois + >$2k P&L)');
  console.log('═'.repeat(80));
  
  const balanced = results.filter(r => r.monthRatio >= 0.65 && r.totalPnL > 2000);
  if (balanced.length > 0) {
    balanced.sort((a, b) => b.totalPnL - a.totalPnL);
    const best = balanced[0];
    
    console.log(`\n✅ TROUVÉE: Vol ${best.volMin}x + BTC MA50 + ${best.momPeriod} mom > ${best.btcMomMin}%`);
    console.log(`   SL: ${best.slPct}% | Hold: ${best.holdPeriod * 15}min`);
    console.log(`   ${best.trades} trades | WR: ${best.winRate.toFixed(1)}% | P&L: +$${best.totalPnL.toFixed(0)}`);
    console.log(`   Mois positifs: ${best.positiveMonths}/${best.months.length} (${(best.monthRatio*100).toFixed(0)}%)`);
    
    for (const month of best.months) {
      const pnl = best.monthlyPnL[month];
      console.log(`   ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${pnl > 0 ? '✅' : '❌'}`);
    }
  } else {
    console.log('\n❌ Aucune configuration ne remplit les critères');
    console.log('   Meilleure constance trouvée:', Math.max(...results.map(r => r.monthRatio)));
  }
}

main().catch(console.error);
