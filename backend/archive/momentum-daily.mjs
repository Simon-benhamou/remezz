#!/usr/bin/env node
/**
 * 🎯 STRATÉGIE MOMENTUM JOURNALIER
 * 
 * Hypothèse: Trader SEULEMENT quand BTC a déjà montré une direction claire aujourd'hui
 * = Momentum intraday positif avant d'entrer
 * 
 * Objectif: Éviter les jours sans direction
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
  
  // BTC momentum intraday: comparer close actuel vs open du jour
  const btcLookback = btcCandles.slice(i - 100, i + 1);
  const btcCloses = btcLookback.map(c => c[4]);
  const btcMA50 = btcCloses.slice(-50).reduce((a, b) => a + b, 0) / 50;
  
  // Momentum BTC sur les dernières 4h (16 bougies de 15min)
  const btc4hAgo = btcCloses[btcCloses.length - 17] || btcCloses[0];
  const btcNow = btcCloses[btcCloses.length - 1];
  const btcMomentum4h = (btcNow - btc4hAgo) / btc4hAgo * 100;
  
  // Momentum BTC sur les dernières 24h (96 bougies)
  const btc24hAgo = btcCloses[btcCloses.length - 97] || btcCloses[0];
  const btcMomentum24h = (btcNow - btc24hAgo) / btc24hAgo * 100;
  
  // Momentum du jour: depuis minuit UTC
  const date = new Date(candles[i][0]);
  const candlesSinceMidnight = Math.floor((date.getUTCHours() * 60 + date.getUTCMinutes()) / 15);
  const midnightIdx = i - candlesSinceMidnight;
  const btcMidnight = midnightIdx >= 0 ? btcCandles[midnightIdx]?.[1] || btcNow : btcNow;
  const btcDayMomentum = (btcNow - btcMidnight) / btcMidnight * 100;
  
  return {
    volRatio,
    priceAboveMa20: close > ma20,
    isBullish: close > open,
    btcAboveMa50: btcNow > btcMA50,
    btcMomentum4h,
    btcMomentum24h,
    btcDayMomentum,
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 STRATÉGIE MOMENTUM JOURNALIER');
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
  
  const dayFilter = d => [0, 1, 3, 4].includes(d);
  
  // Test différents filtres de momentum
  const momentumFilters = [
    { name: 'Base (Vol 5x)', filter: (f) => true },
    { name: '+ BTC 4h mom > 0.5%', filter: (f) => f.btcMomentum4h > 0.5 },
    { name: '+ BTC 4h mom > 1%', filter: (f) => f.btcMomentum4h > 1 },
    { name: '+ BTC 4h mom > 1.5%', filter: (f) => f.btcMomentum4h > 1.5 },
    { name: '+ BTC day mom > 1%', filter: (f) => f.btcDayMomentum > 1 },
    { name: '+ BTC day mom > 2%', filter: (f) => f.btcDayMomentum > 2 },
    { name: '+ BTC 24h mom > 3%', filter: (f) => f.btcMomentum24h > 3 },
    { name: '+ BTC 24h mom > 5%', filter: (f) => f.btcMomentum24h > 5 },
    { name: '+ BTC MA50 + 4h > 0.5%', filter: (f) => f.btcAboveMa50 && f.btcMomentum4h > 0.5 },
    { name: '+ BTC MA50 + day > 1%', filter: (f) => f.btcAboveMa50 && f.btcDayMomentum > 1 },
  ];
  
  console.log('\n📊 TEST DES FILTRES MOMENTUM (Vol 5x + Bull + MA20 + Jours)');
  console.log('─'.repeat(80));
  console.log('Filtre                          │ Trades │ WR    │ P&L     │ Mois+ │ Status');
  console.log('─'.repeat(80));
  
  for (const momentumFilter of momentumFilters) {
    const trades = [];
    const monthlyPnL = {};
    
    for (const symbol of SYMBOLS) {
      const candles = allCandles[symbol];
      
      for (let i = 100; i < candles.length - HOLD_PERIOD - 1; i++) {
        const features = calculateFeatures(candles, i, btcCandles);
        if (!features) continue;
        
        const date = new Date(candles[i][0]);
        if (!dayFilter(date.getDay())) continue;
        
        // Signal de base: Vol 5x + Bullish + Above MA20
        if (features.volRatio < 5) continue;
        if (!features.isBullish) continue;
        if (!features.priceAboveMa20) continue;
        
        // Filtre momentum additionnel
        if (!momentumFilter.filter(features)) continue;
        
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
        
        trades.push({ month, netPnl, win: netPnl > 0 });
        if (!monthlyPnL[month]) monthlyPnL[month] = 0;
        monthlyPnL[month] += netPnl;
        
        i += 4;
      }
    }
    
    if (trades.length < 10) {
      console.log(`${momentumFilter.name.padEnd(30)} │ ${String(trades.length).padStart(6)} │ N/A   │ N/A     │ N/A   │ ⚠️`);
      continue;
    }
    
    const wins = trades.filter(t => t.win).length;
    const totalPnL = trades.reduce((s, t) => s + t.netPnl, 0);
    const months = Object.keys(monthlyPnL).sort();
    const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
    
    const status = positiveMonths >= months.length * 0.7 ? '✅' : 
                   positiveMonths >= months.length * 0.6 ? '⚠️' : '❌';
    
    const wrStr = `${(wins / trades.length * 100).toFixed(1)}%`.padStart(5);
    const pnlStr = `${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}`.padStart(7);
    const monthStr = `${positiveMonths}/${months.length}`.padStart(5);
    
    console.log(`${momentumFilter.name.padEnd(30)} │ ${String(trades.length).padStart(6)} │ ${wrStr} │ ${pnlStr} │ ${monthStr} │ ${status}`);
    
    // Si prometteur (>60% mois positifs), afficher détail
    if (positiveMonths >= months.length * 0.6) {
      for (const month of months) {
        const pnl = monthlyPnL[month];
        console.log(`   ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${pnl > 0 ? '✅' : '❌'}`);
      }
    }
  }
  
  // Combinaison ultime
  console.log('\n' + '═'.repeat(80));
  console.log('🚀 COMBINAISONS AVANCÉES');
  console.log('═'.repeat(80));
  
  const advancedFilters = [
    { name: 'Vol 6x + BTC 4h > 1%', volMin: 6, filter: (f) => f.btcMomentum4h > 1 },
    { name: 'Vol 6x + BTC MA50 + 4h > 0.5%', volMin: 6, filter: (f) => f.btcAboveMa50 && f.btcMomentum4h > 0.5 },
    { name: 'Vol 7x + BTC day > 1%', volMin: 7, filter: (f) => f.btcDayMomentum > 1 },
    { name: 'Vol 5x + BTC MA50 + day > 0.5%', volMin: 5, filter: (f) => f.btcAboveMa50 && f.btcDayMomentum > 0.5 },
    { name: 'Vol 5x + BTC 4h > 0.5% + day > 0%', volMin: 5, filter: (f) => f.btcMomentum4h > 0.5 && f.btcDayMomentum > 0 },
    { name: 'Vol 4x + BTC MA50 + 4h > 1%', volMin: 4, filter: (f) => f.btcAboveMa50 && f.btcMomentum4h > 1 },
  ];
  
  console.log('Filtre                               │ Trades │ WR    │ P&L     │ Mois+ │ Status');
  console.log('─'.repeat(80));
  
  for (const advFilter of advancedFilters) {
    const trades = [];
    const monthlyPnL = {};
    
    for (const symbol of SYMBOLS) {
      const candles = allCandles[symbol];
      
      for (let i = 100; i < candles.length - HOLD_PERIOD - 1; i++) {
        const features = calculateFeatures(candles, i, btcCandles);
        if (!features) continue;
        
        const date = new Date(candles[i][0]);
        if (!dayFilter(date.getDay())) continue;
        
        if (features.volRatio < advFilter.volMin) continue;
        if (!features.isBullish) continue;
        if (!features.priceAboveMa20) continue;
        if (!advFilter.filter(features)) continue;
        
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
        
        trades.push({ month, netPnl, win: netPnl > 0 });
        if (!monthlyPnL[month]) monthlyPnL[month] = 0;
        monthlyPnL[month] += netPnl;
        
        i += 4;
      }
    }
    
    if (trades.length < 10) {
      console.log(`${advFilter.name.padEnd(35)} │ ${String(trades.length).padStart(6)} │ N/A   │ N/A     │ N/A   │ ⚠️`);
      continue;
    }
    
    const wins = trades.filter(t => t.win).length;
    const totalPnL = trades.reduce((s, t) => s + t.netPnl, 0);
    const months = Object.keys(monthlyPnL).sort();
    const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
    
    const status = positiveMonths >= months.length * 0.7 ? '✅✅' : 
                   positiveMonths >= months.length * 0.6 ? '✅' : '❌';
    
    const wrStr = `${(wins / trades.length * 100).toFixed(1)}%`.padStart(5);
    const pnlStr = `${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}`.padStart(7);
    const monthStr = `${positiveMonths}/${months.length}`.padStart(5);
    
    console.log(`${advFilter.name.padEnd(35)} │ ${String(trades.length).padStart(6)} │ ${wrStr} │ ${pnlStr} │ ${monthStr} │ ${status}`);
    
    // Détail mensuel si > 60%
    if (positiveMonths >= months.length * 0.6) {
      for (const month of months) {
        const pnl = monthlyPnL[month];
        console.log(`      ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${pnl > 0 ? '✅' : '❌'}`);
      }
    }
  }
}

main().catch(console.error);
