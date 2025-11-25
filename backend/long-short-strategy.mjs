#!/usr/bin/env node
/**
 * 🔄 STRATÉGIE LONG/SHORT DYNAMIQUE
 * 
 * LONG quand: BTC > MA50 + Vol 5x + Bullish
 * SHORT quand: BTC < MA50 + Vol 5x + Bearish
 * 
 * Objectif: Trader dans les deux directions selon le contexte
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
  
  return {
    volRatio,
    priceAboveMa20: close > ma20,
    priceAboveMa50: close > ma50,
    priceBelowMa20: close < ma20,
    priceBelowMa50: close < ma50,
    isBullish: close > open,
    isBearish: close < open,
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🔄 STRATÉGIE LONG/SHORT DYNAMIQUE');
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
  
  // Stratégies à comparer
  const strategies = [
    {
      name: 'Long Only (Vol 5x + Bull + MA20)',
      getSignal: (f, btcF) => {
        if (f.volRatio > 5 && f.isBullish && f.priceAboveMa20) return 'LONG';
        return null;
      }
    },
    {
      name: 'Short Only (Vol 5x + Bear + below MA20)',
      getSignal: (f, btcF) => {
        if (f.volRatio > 5 && f.isBearish && f.priceBelowMa20) return 'SHORT';
        return null;
      }
    },
    {
      name: 'Long/Short selon BTC MA50',
      getSignal: (f, btcF) => {
        if (!btcF) return null;
        // Long si BTC > MA50
        if (btcF.priceAboveMa50 && f.volRatio > 5 && f.isBullish && f.priceAboveMa20) return 'LONG';
        // Short si BTC < MA50
        if (btcF.priceBelowMa50 && f.volRatio > 5 && f.isBearish && f.priceBelowMa20) return 'SHORT';
        return null;
      }
    },
    {
      name: 'Combo: Long BTC>MA50, Short BTC<MA50',
      getSignal: (f, btcF) => {
        if (!btcF) return null;
        if (btcF.priceAboveMa50) {
          if (f.volRatio > 4 && f.isBullish && f.priceAboveMa20) return 'LONG';
        } else {
          if (f.volRatio > 4 && f.isBearish && f.priceBelowMa20) return 'SHORT';
        }
        return null;
      }
    },
    {
      name: 'Vol 4x Long/Short dynamique',
      getSignal: (f, btcF) => {
        if (!btcF) return null;
        if (btcF.priceAboveMa50 && f.volRatio > 4 && f.isBullish) return 'LONG';
        if (btcF.priceBelowMa50 && f.volRatio > 4 && f.isBearish) return 'SHORT';
        return null;
      }
    },
  ];
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 COMPARAISON DES STRATÉGIES (12 mois)');
  console.log('═'.repeat(80));
  
  for (const strategy of strategies) {
    const trades = [];
    const monthlyPnL = {};
    
    for (const symbol of SYMBOLS) {
      const candles = allCandles[symbol];
      
      for (let i = 100; i < candles.length - HOLD_PERIOD - 1; i++) {
        const features = calculateFeatures(candles, i);
        const btcFeatures = calculateFeatures(btcCandles, i);
        if (!features) continue;
        
        const date = new Date(candles[i][0]);
        if (!dayFilter(date.getDay())) continue;
        
        const signal = strategy.getSignal(features, btcFeatures);
        if (!signal) continue;
        
        const entry = candles[i][4];
        const stopPrice = signal === 'LONG' 
          ? entry * (1 - SL / 100)
          : entry * (1 + SL / 100);
        
        let exitPrice = entry;
        let hitStop = false;
        
        for (let j = 1; j <= HOLD_PERIOD; j++) {
          if (i + j >= candles.length) break;
          const checkPrice = signal === 'LONG' 
            ? candles[i + j][3]  // Low for long
            : candles[i + j][2]; // High for short
          
          const stopHit = signal === 'LONG' 
            ? checkPrice <= stopPrice
            : checkPrice >= stopPrice;
          
          if (stopHit) {
            exitPrice = stopPrice;
            hitStop = true;
            break;
          }
        }
        
        if (!hitStop && i + HOLD_PERIOD < candles.length) {
          exitPrice = candles[i + HOLD_PERIOD][4];
        }
        
        // P&L selon direction
        const pnlPct = signal === 'LONG'
          ? (exitPrice - entry) / entry * 100
          : (entry - exitPrice) / entry * 100;
        
        const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const posSize = CAPITAL * RISK / (SL / 100);
        const fees = posSize * FEES;
        const netPnl = posSize * (pnlPct / 100) - fees;
        
        trades.push({ month, netPnl, win: netPnl > 0, signal });
        
        if (!monthlyPnL[month]) monthlyPnL[month] = 0;
        monthlyPnL[month] += netPnl;
        
        i += 4;
      }
    }
    
    if (trades.length === 0) {
      console.log(`\n❌ ${strategy.name}: 0 trades`);
      continue;
    }
    
    const wins = trades.filter(t => t.win).length;
    const totalPnL = trades.reduce((s, t) => s + t.netPnl, 0);
    const months = Object.keys(monthlyPnL).sort();
    const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
    const longs = trades.filter(t => t.signal === 'LONG').length;
    const shorts = trades.filter(t => t.signal === 'SHORT').length;
    
    const status = positiveMonths >= months.length * 0.7 ? '✅' : 
                   positiveMonths >= months.length * 0.5 ? '⚠️' : '❌';
    
    console.log(`\n${status} ${strategy.name}`);
    console.log(`   Trades: ${trades.length} (${longs} long, ${shorts} short)`);
    console.log(`   Win Rate: ${(wins / trades.length * 100).toFixed(1)}%`);
    console.log(`   P&L Total: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}`);
    console.log(`   Mois positifs: ${positiveMonths}/${months.length} (${(positiveMonths/months.length*100).toFixed(0)}%)`);
    
    // Détail mensuel pour les meilleures stratégies
    if (positiveMonths >= months.length * 0.5 || strategy.name.includes('Long/Short')) {
      console.log('   Mensuel:');
      for (const month of months) {
        const pnl = monthlyPnL[month];
        const monthTrades = trades.filter(t => t.month === month);
        const monthLongs = monthTrades.filter(t => t.signal === 'LONG').length;
        const monthShorts = monthTrades.filter(t => t.signal === 'SHORT').length;
        console.log(`      ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} (${monthLongs}L/${monthShorts}S) ${pnl > 0 ? '✅' : '❌'}`);
      }
    }
    
    // Projection si rentable
    if (totalPnL > 0) {
      const monthlyAvg = totalPnL / months.length;
      const roiAnnual = monthlyAvg * 12 / CAPITAL * 100;
      console.log(`   💰 ROI annuel projeté: ${roiAnnual.toFixed(1)}%`);
    }
  }
  
  // Test additionnel: Vol plus élevé
  console.log('\n' + '═'.repeat(80));
  console.log('🔬 TEST: VOL 6x+ (ultra sélectif)');
  console.log('═'.repeat(80));
  
  for (const volThreshold of [6, 7, 8]) {
    const trades = [];
    const monthlyPnL = {};
    
    for (const symbol of SYMBOLS) {
      const candles = allCandles[symbol];
      
      for (let i = 100; i < candles.length - HOLD_PERIOD - 1; i++) {
        const features = calculateFeatures(candles, i);
        const btcFeatures = calculateFeatures(btcCandles, i);
        if (!features || !btcFeatures) continue;
        
        const date = new Date(candles[i][0]);
        if (!dayFilter(date.getDay())) continue;
        
        let signal = null;
        if (btcFeatures.priceAboveMa50 && features.volRatio > volThreshold && features.isBullish && features.priceAboveMa20) {
          signal = 'LONG';
        } else if (btcFeatures.priceBelowMa50 && features.volRatio > volThreshold && features.isBearish && features.priceBelowMa20) {
          signal = 'SHORT';
        }
        
        if (!signal) continue;
        
        const entry = candles[i][4];
        const stopPrice = signal === 'LONG' ? entry * (1 - SL / 100) : entry * (1 + SL / 100);
        
        let exitPrice = entry;
        for (let j = 1; j <= HOLD_PERIOD; j++) {
          if (i + j >= candles.length) break;
          const checkPrice = signal === 'LONG' ? candles[i + j][3] : candles[i + j][2];
          const stopHit = signal === 'LONG' ? checkPrice <= stopPrice : checkPrice >= stopPrice;
          if (stopHit) { exitPrice = stopPrice; break; }
        }
        if (exitPrice === entry && i + HOLD_PERIOD < candles.length) {
          exitPrice = candles[i + HOLD_PERIOD][4];
        }
        
        const pnlPct = signal === 'LONG' ? (exitPrice - entry) / entry * 100 : (entry - exitPrice) / entry * 100;
        const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const posSize = CAPITAL * RISK / (SL / 100);
        const fees = posSize * FEES;
        const netPnl = posSize * (pnlPct / 100) - fees;
        
        trades.push({ month, netPnl, win: netPnl > 0, signal });
        if (!monthlyPnL[month]) monthlyPnL[month] = 0;
        monthlyPnL[month] += netPnl;
        
        i += 4;
      }
    }
    
    if (trades.length < 20) {
      console.log(`\n⚠️ Vol ${volThreshold}x: ${trades.length} trades (pas assez)`);
      continue;
    }
    
    const wins = trades.filter(t => t.win).length;
    const totalPnL = trades.reduce((s, t) => s + t.netPnl, 0);
    const months = Object.keys(monthlyPnL).sort();
    const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
    
    const status = positiveMonths >= months.length * 0.7 ? '✅' : '⚠️';
    
    console.log(`\n${status} Vol ${volThreshold}x L/S dynamique`);
    console.log(`   Trades: ${trades.length} | WR: ${(wins/trades.length*100).toFixed(1)}%`);
    console.log(`   P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)} | Mois: ${positiveMonths}/${months.length}`);
    
    for (const month of months) {
      const pnl = monthlyPnL[month];
      console.log(`      ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${pnl > 0 ? '✅' : '❌'}`);
    }
  }
}

main().catch(console.error);
