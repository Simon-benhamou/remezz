#!/usr/bin/env node
/**
 * 🎯 ULTRA SÉLECTIF - Filtre de régime de marché
 * 
 * Idée: Ne trader que quand le MARCHÉ (BTC) est favorable
 * Combiner signal + contexte macro
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
  if (i < 100) return null;
  
  const lookback = candles.slice(i - 100, i + 1);
  const closes = lookback.map(c => c[4]);
  const highs = lookback.map(c => c[2]);
  const lows = lookback.map(c => c[3]);
  const volumes = lookback.map(c => c[5]);
  const opens = lookback.map(c => c[1]);
  
  const close = closes[closes.length - 1];
  const open = opens[opens.length - 1];
  const volume = volumes[volumes.length - 1];
  
  const avgVol20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volRatio = volume / avgVol20;
  
  const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  
  // Momentum Daily (96 x 15min = 24h)
  const momentum24h = closes.length >= 97 ? (close - closes[closes.length - 97]) / closes[closes.length - 97] * 100 : 0;
  const momentum4h = closes.length >= 17 ? (close - closes[closes.length - 17]) / closes[closes.length - 17] * 100 : 0;
  
  // RSI
  let gains = 0, losses = 0;
  for (let j = closes.length - 14; j < closes.length; j++) {
    const change = closes[j] - closes[j - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const rsi = 100 - (100 / (1 + gains / (losses || 0.0001)));
  
  // Volatilité (écart-type des returns)
  const returns = [];
  for (let j = closes.length - 20; j < closes.length; j++) {
    returns.push((closes[j] - closes[j - 1]) / closes[j - 1] * 100);
  }
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const volatility = Math.sqrt(returns.map(r => Math.pow(r - avgReturn, 2)).reduce((a, b) => a + b, 0) / returns.length);
  
  return {
    volRatio,
    priceAboveMa20: close > ma20,
    priceAboveMa50: close > ma50,
    allMaAligned: close > ma5 && ma5 > ma20 && ma20 > ma50,
    isBullish: close > open,
    momentum24h,
    momentum4h,
    rsi,
    volatility,
    ma20Trend: ma20 > closes.slice(-25, -20).reduce((a, b) => a + b, 0) / 5, // MA20 montante
  };
}

// Calculer le régime de marché basé sur BTC
function calculateMarketRegime(btcCandles, i) {
  if (i < 100) return 'UNKNOWN';
  
  const features = calculateFeatures(btcCandles, i);
  if (!features) return 'UNKNOWN';
  
  // Bull market: Prix > MA20 > MA50, momentum positif
  if (features.priceAboveMa50 && features.priceAboveMa20 && features.momentum24h > 0) {
    return 'BULL';
  }
  
  // Bear market: Prix < MA50, momentum négatif
  if (!features.priceAboveMa50 && features.momentum24h < -1) {
    return 'BEAR';
  }
  
  // Range/consolidation
  return 'RANGE';
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 ULTRA SÉLECTIF - Filtre par régime de marché BTC');
  console.log('═'.repeat(80));
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 ${symbol}...`);
    allCandles[symbol] = await fetchCandles(symbol, 120);
  }
  
  const btcCandles = allCandles['BTC/USDT:USDT'];
  
  // Analyser la distribution des régimes
  const regimes = { BULL: 0, BEAR: 0, RANGE: 0 };
  for (let i = 100; i < btcCandles.length; i++) {
    regimes[calculateMarketRegime(btcCandles, i)]++;
  }
  console.log(`\n📊 Régimes BTC: Bull ${regimes.BULL}, Bear ${regimes.BEAR}, Range ${regimes.RANGE}`);
  
  const CAPITAL = 10000;
  const RISK = 0.01;
  const FEES = 0.0006;
  
  // Signal de base: Vol 3x + Bullish + Above MA20
  const baseSignal = f => f.volRatio > 3 && f.isBullish && f.priceAboveMa20;
  
  // Configurations à tester
  const configs = [
    { name: 'Base (pas de filtre)', regimeFilter: () => true },
    { name: 'Only in BULL', regimeFilter: r => r === 'BULL' },
    { name: 'BULL or RANGE', regimeFilter: r => r === 'BULL' || r === 'RANGE' },
    { name: 'Not in BEAR', regimeFilter: r => r !== 'BEAR' },
    { name: 'BULL + Low Vol BTC', regimeFilter: (r, btcF) => r === 'BULL' && btcF && btcF.volatility < 1 },
    { name: 'BULL + BTC momentum+', regimeFilter: (r, btcF) => r === 'BULL' && btcF && btcF.momentum4h > 0 },
  ];
  
  // Signaux à combiner
  const signals = [
    { name: 'Vol 3x + Bull + MA20', test: f => f.volRatio > 3 && f.isBullish && f.priceAboveMa20 },
    { name: 'Vol 4x + Bull', test: f => f.volRatio > 4 && f.isBullish },
    { name: 'All MA + Vol 2x', test: f => f.allMaAligned && f.volRatio > 2 },
    { name: 'RSI 40-60 + Vol 3x + Bull', test: f => f.rsi >= 40 && f.rsi <= 60 && f.volRatio > 3 && f.isBullish },
    { name: 'Mom4h > 0.3 + Vol 3x', test: f => f.momentum4h > 0.3 && f.volRatio > 3 && f.isBullish },
  ];
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS PAR SIGNAL + FILTRE MARCHÉ');
  console.log('═'.repeat(80));
  
  const allResults = [];
  
  for (const signal of signals) {
    for (const config of configs) {
      const trades = [];
      const monthlyPnL = {};
      
      for (const symbol of SYMBOLS) {
        const candles = allCandles[symbol];
        
        for (let i = 100; i < candles.length - 20; i++) {
          // Vérifier le régime BTC
          const regime = calculateMarketRegime(btcCandles, i);
          const btcFeatures = calculateFeatures(btcCandles, i);
          
          if (!config.regimeFilter(regime, btcFeatures)) continue;
          
          // Vérifier le signal sur le symbole
          const features = calculateFeatures(candles, i);
          if (!features || !signal.test(features)) continue;
          
          const entry = candles[i][4];
          const sl = 1.5;
          const stopPrice = entry * (1 - sl / 100);
          const holdPeriod = 16; // 4h
          
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
          const date = new Date(candles[i][0]);
          const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          
          const posSize = CAPITAL * RISK / (sl / 100);
          const fees = posSize * FEES;
          const netPnl = posSize * (pnlPct / 100) - fees;
          
          trades.push({ month, netPnl });
          
          if (!monthlyPnL[month]) monthlyPnL[month] = 0;
          monthlyPnL[month] += netPnl;
          
          i += 4;
        }
      }
      
      if (trades.length < 10) continue;
      
      const totalPnL = trades.reduce((s, t) => s + t.netPnl, 0);
      const months = Object.keys(monthlyPnL).sort();
      const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
      
      allResults.push({
        signal: signal.name,
        filter: config.name,
        trades: trades.length,
        totalPnL,
        positiveMonths,
        totalMonths: months.length,
        monthlyPnL,
      });
    }
  }
  
  // Trier par mois positifs
  allResults.sort((a, b) => {
    const ratioA = a.positiveMonths / a.totalMonths;
    const ratioB = b.positiveMonths / b.totalMonths;
    if (ratioB !== ratioA) return ratioB - ratioA;
    return b.totalPnL - a.totalPnL;
  });
  
  // Top 15
  console.log('\n┌─────────────────────────────┬─────────────────────┬────────┬──────────┬────────┐');
  console.log('│          Signal             │       Filtre        │ Trades │   P&L    │ Mois   │');
  console.log('├─────────────────────────────┼─────────────────────┼────────┼──────────┼────────┤');
  
  for (const r of allResults.slice(0, 20)) {
    const signal = r.signal.slice(0, 27).padEnd(27);
    const filter = r.filter.slice(0, 19).padEnd(19);
    const trades = String(r.trades).padStart(6);
    const pnl = (r.totalPnL >= 0 ? '+$' : '-$') + Math.abs(r.totalPnL).toFixed(0).padStart(5);
    const months = `${r.positiveMonths}/${r.totalMonths}`;
    const status = r.positiveMonths >= r.totalMonths * 0.8 ? '✅' : (r.positiveMonths >= r.totalMonths * 0.6 ? '⚠️' : '❌');
    
    console.log(`│ ${signal} │ ${filter} │ ${trades} │ ${pnl} │ ${months} ${status}│`);
  }
  console.log('└─────────────────────────────┴─────────────────────┴────────┴──────────┴────────┘');
  
  // Focus sur les configs avec 4/5+ mois positifs
  const promising = allResults.filter(r => r.positiveMonths >= 4);
  
  if (promising.length > 0) {
    console.log('\n' + '═'.repeat(80));
    console.log('🏆 CONFIGURATIONS 4/5+ MOIS POSITIFS');
    console.log('═'.repeat(80));
    
    for (const r of promising.slice(0, 5)) {
      console.log(`\n✅ ${r.signal} + ${r.filter}`);
      console.log(`   Trades: ${r.trades} | P&L: ${r.totalPnL >= 0 ? '+' : ''}$${r.totalPnL.toFixed(0)}`);
      console.log(`   Mensuel:`);
      
      const months = Object.keys(r.monthlyPnL).sort();
      for (const month of months) {
        const pnl = r.monthlyPnL[month];
        console.log(`      ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${pnl > 0 ? '✅' : '❌'}`);
      }
    }
  }
  
  // Test additionnel: Filtrer par JOUR de la semaine
  console.log('\n' + '═'.repeat(80));
  console.log('📅 ANALYSE PAR JOUR DE LA SEMAINE');
  console.log('═'.repeat(80));
  
  const dayNames = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  const dayPnL = [0, 0, 0, 0, 0, 0, 0];
  const dayTrades = [0, 0, 0, 0, 0, 0, 0];
  
  // Refaire le test de base et tracker par jour
  for (const symbol of SYMBOLS) {
    const candles = allCandles[symbol];
    
    for (let i = 100; i < candles.length - 20; i++) {
      const features = calculateFeatures(candles, i);
      if (!features || !baseSignal(features)) continue;
      
      const entry = candles[i][4];
      const date = new Date(candles[i][0]);
      const dayOfWeek = date.getDay();
      
      let exitPrice = entry;
      for (let j = 1; j <= 16; j++) {
        if (i + j >= candles.length) break;
        if (candles[i + j][3] <= entry * 0.985) {
          exitPrice = entry * 0.985;
          break;
        }
      }
      if (exitPrice === entry && i + 16 < candles.length) {
        exitPrice = candles[i + 16][4];
      }
      
      const pnlPct = (exitPrice - entry) / entry * 100;
      const posSize = CAPITAL * RISK / 0.015;
      const fees = posSize * FEES;
      const netPnl = posSize * (pnlPct / 100) - fees;
      
      dayPnL[dayOfWeek] += netPnl;
      dayTrades[dayOfWeek]++;
      
      i += 4;
    }
  }
  
  console.log('\n┌──────┬────────┬───────────┬──────────────┐');
  console.log('│ Jour │ Trades │   P&L     │  Avg/Trade   │');
  console.log('├──────┼────────┼───────────┼──────────────┤');
  
  for (let d = 0; d < 7; d++) {
    const name = dayNames[d].padEnd(4);
    const trades = String(dayTrades[d]).padStart(6);
    const pnl = (dayPnL[d] >= 0 ? '+$' : '-$') + Math.abs(dayPnL[d]).toFixed(0).padStart(5);
    const avg = dayTrades[d] > 0 ? (dayPnL[d] / dayTrades[d]).toFixed(2) : '0';
    const status = dayPnL[d] > 0 ? '✅' : '❌';
    
    console.log(`│ ${name} │ ${trades} │ ${pnl}   │ $${avg.padStart(9)}  │ ${status}`);
  }
  console.log('└──────┴────────┴───────────┴──────────────┘');
  
  // Identifier les meilleurs jours
  const bestDays = dayPnL.map((pnl, i) => ({ day: i, pnl, trades: dayTrades[i] }))
                         .filter(d => d.pnl > 0)
                         .map(d => d.day);
  
  if (bestDays.length > 0) {
    console.log(`\n💡 Meilleurs jours: ${bestDays.map(d => dayNames[d]).join(', ')}`);
    
    // Backtest en ne tradant que ces jours
    console.log('\n📊 Test: Ne trader que les jours rentables');
    
    const filteredTrades = [];
    const filteredMonthly = {};
    
    for (const symbol of SYMBOLS) {
      const candles = allCandles[symbol];
      
      for (let i = 100; i < candles.length - 20; i++) {
        const features = calculateFeatures(candles, i);
        if (!features || !baseSignal(features)) continue;
        
        const date = new Date(candles[i][0]);
        const dayOfWeek = date.getDay();
        
        // Filtre jour
        if (!bestDays.includes(dayOfWeek)) continue;
        
        const entry = candles[i][4];
        const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        
        let exitPrice = entry;
        for (let j = 1; j <= 16; j++) {
          if (i + j >= candles.length) break;
          if (candles[i + j][3] <= entry * 0.985) {
            exitPrice = entry * 0.985;
            break;
          }
        }
        if (exitPrice === entry && i + 16 < candles.length) {
          exitPrice = candles[i + 16][4];
        }
        
        const pnlPct = (exitPrice - entry) / entry * 100;
        const posSize = CAPITAL * RISK / 0.015;
        const fees = posSize * FEES;
        const netPnl = posSize * (pnlPct / 100) - fees;
        
        filteredTrades.push({ month, netPnl });
        
        if (!filteredMonthly[month]) filteredMonthly[month] = 0;
        filteredMonthly[month] += netPnl;
        
        i += 4;
      }
    }
    
    const totalPnL = filteredTrades.reduce((s, t) => s + t.netPnl, 0);
    const months = Object.keys(filteredMonthly).sort();
    const positiveMonths = months.filter(m => filteredMonthly[m] > 0).length;
    
    console.log(`   Trades: ${filteredTrades.length}`);
    console.log(`   P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}`);
    console.log(`   Mois positifs: ${positiveMonths}/${months.length}`);
    
    for (const month of months) {
      const pnl = filteredMonthly[month];
      console.log(`      ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${pnl > 0 ? '✅' : '❌'}`);
    }
  }
  
  // Test: Filtrer par HEURE
  console.log('\n' + '═'.repeat(80));
  console.log('🕐 ANALYSE PAR HEURE UTC');
  console.log('═'.repeat(80));
  
  const hourPnL = new Array(24).fill(0);
  const hourTrades = new Array(24).fill(0);
  
  for (const symbol of SYMBOLS) {
    const candles = allCandles[symbol];
    
    for (let i = 100; i < candles.length - 20; i++) {
      const features = calculateFeatures(candles, i);
      if (!features || !baseSignal(features)) continue;
      
      const entry = candles[i][4];
      const date = new Date(candles[i][0]);
      const hour = date.getUTCHours();
      
      let exitPrice = entry;
      for (let j = 1; j <= 16; j++) {
        if (i + j >= candles.length) break;
        if (candles[i + j][3] <= entry * 0.985) {
          exitPrice = entry * 0.985;
          break;
        }
      }
      if (exitPrice === entry && i + 16 < candles.length) {
        exitPrice = candles[i + 16][4];
      }
      
      const pnlPct = (exitPrice - entry) / entry * 100;
      const posSize = CAPITAL * RISK / 0.015;
      const fees = posSize * FEES;
      const netPnl = posSize * (pnlPct / 100) - fees;
      
      hourPnL[hour] += netPnl;
      hourTrades[hour]++;
      
      i += 4;
    }
  }
  
  // Trouver les meilleures heures
  const hourStats = hourPnL.map((pnl, h) => ({ hour: h, pnl, trades: hourTrades[h] }))
                           .filter(h => h.trades > 10)
                           .sort((a, b) => b.pnl - a.pnl);
  
  console.log('\n Top 5 heures:');
  for (const h of hourStats.slice(0, 5)) {
    console.log(`   ${String(h.hour).padStart(2)}h UTC: ${h.pnl >= 0 ? '+' : ''}$${h.pnl.toFixed(0)} (${h.trades} trades)`);
  }
  
  console.log('\n Pires 5 heures:');
  for (const h of hourStats.slice(-5).reverse()) {
    console.log(`   ${String(h.hour).padStart(2)}h UTC: ${h.pnl >= 0 ? '+' : ''}$${h.pnl.toFixed(0)} (${h.trades} trades)`);
  }
}

main().catch(console.error);
