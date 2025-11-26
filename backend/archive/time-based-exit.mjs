#!/usr/bin/env node
/**
 * 🎯 APPROCHE RADICALE - Exit basé sur le TEMPS pas le prix
 * 
 * Hypothèse: Après un signal fort, le prix monte RAPIDEMENT
 * On entre et on sort après N bougies, peu importe le prix
 * (sauf SL de protection)
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
  const high = highs[highs.length - 1];
  const low = lows[lows.length - 1];
  const volume = volumes[volumes.length - 1];
  
  const avgVol20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volRatio = volume / avgVol20;
  
  const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  
  // RSI
  let gains = 0, losses = 0;
  for (let j = closes.length - 14; j < closes.length; j++) {
    const change = closes[j] - closes[j - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const rsi = 100 - (100 / (1 + gains / (losses || 0.0001)));
  
  // Breakout
  const highest20 = Math.max(...highs.slice(-21, -1));
  const highest50 = Math.max(...highs.slice(-51, -1));
  const lowest20 = Math.min(...lows.slice(-21, -1));
  
  // Body et wick
  const body = close - open;
  const bodyPct = Math.abs(body) / close * 100;
  const range = high - low;
  const avgRange = candles.slice(i - 20, i).map(c => c[2] - c[3]).reduce((a, b) => a + b, 0) / 20;
  const rangeExpansion = range / avgRange;
  
  // ATR
  let atrSum = 0;
  for (let j = lookback.length - 14; j < lookback.length; j++) {
    const tr = Math.max(highs[j] - lows[j], Math.abs(highs[j] - closes[j - 1]), Math.abs(lows[j] - closes[j - 1]));
    atrSum += tr;
  }
  const atr = atrSum / 14;
  const atrPct = atr / close * 100;
  
  // Momentum
  const momentum1h = (close - closes[closes.length - 5]) / closes[closes.length - 5] * 100;
  const momentum4h = closes.length >= 17 ? (close - closes[closes.length - 17]) / closes[closes.length - 17] * 100 : 0;
  
  // Consécutives
  let consecutiveUp = 0;
  for (let j = closes.length - 1; j > 0; j--) {
    if (closes[j] > closes[j - 1]) consecutiveUp++;
    else break;
  }
  
  // Higher lows récents
  const low1 = Math.min(...lows.slice(-5));
  const low2 = Math.min(...lows.slice(-10, -5));
  const low3 = Math.min(...lows.slice(-15, -10));
  const higherLows = low1 > low2 && low2 > low3;
  
  // Volume pattern
  const volIncreasing = volumes.slice(-3).every((v, i, arr) => i === 0 || v > arr[i - 1] * 0.9);
  
  return {
    volRatio,
    priceAboveMa5: close > ma5,
    priceAboveMa20: close > ma20,
    priceAboveMa50: close > ma50,
    allMaAligned: close > ma5 && ma5 > ma20 && ma20 > ma50,
    rsi,
    breakoutUp20: close > highest20,
    breakoutUp50: close > highest50,
    breakoutDown20: close < lowest20,
    nearHighest20: close > highest20 * 0.99,
    isBullish: close > open,
    isStrongBullish: close > open && bodyPct > 0.3,
    rangeExpansion,
    atrPct,
    momentum1h,
    momentum4h,
    consecutiveUp,
    higherLows,
    volIncreasing,
    bodyPct,
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 TEST - EXIT BASÉ SUR LE TEMPS (pas sur le prix)');
  console.log('═'.repeat(80));
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 ${symbol}...`);
    allCandles[symbol] = await fetchCandles(symbol, 120);
  }
  
  const CAPITAL = 10000;
  const RISK = 0.01;
  const FEES = 0.0006;
  
  // Signaux à tester
  const signals = [
    { name: 'Vol 3x + Bullish + Above MA20', test: f => f.volRatio > 3 && f.isBullish && f.priceAboveMa20 },
    { name: 'Vol 4x + Strong Bullish', test: f => f.volRatio > 4 && f.isStrongBullish },
    { name: 'Breakout20 + Vol 2x', test: f => f.breakoutUp20 && f.volRatio > 2 },
    { name: 'All MA + Vol 2x', test: f => f.allMaAligned && f.volRatio > 2 },
    { name: 'Higher Lows + Vol 2x + Bullish', test: f => f.higherLows && f.volRatio > 2 && f.isBullish },
    { name: 'Vol Increasing 3x + Momentum+', test: f => f.volIncreasing && f.volRatio > 2 && f.momentum1h > 0.2 },
    { name: 'Range Expansion + Vol 3x', test: f => f.rangeExpansion > 2 && f.volRatio > 3 && f.isBullish },
    { name: 'Consecutive Up 3+ + Vol', test: f => f.consecutiveUp >= 3 && f.volRatio > 2 },
  ];
  
  // Durées de holding à tester (en bougies 15min)
  const holdPeriods = [4, 8, 12, 16]; // 1h, 2h, 3h, 4h
  
  // SL de protection (en %)
  const stopLosses = [1, 1.5, 2];
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSULTATS - Time-Based Exit');
  console.log('═'.repeat(80));
  
  const allResults = [];
  
  for (const signal of signals) {
    for (const holdPeriod of holdPeriods) {
      for (const sl of stopLosses) {
        const trades = [];
        const monthlyPnL = {};
        
        for (const symbol of SYMBOLS) {
          const candles = allCandles[symbol];
          
          for (let i = 100; i < candles.length - holdPeriod - 1; i++) {
            const features = calculateFeatures(candles, i);
            if (!features || !signal.test(features)) continue;
            
            const entry = candles[i][4];
            const stopPrice = entry * (1 - sl / 100);
            
            let exitPrice = entry;
            let hitStop = false;
            
            // Vérifier si SL touché pendant la période
            for (let j = 1; j <= holdPeriod; j++) {
              const low = candles[i + j][3];
              if (low <= stopPrice) {
                exitPrice = stopPrice;
                hitStop = true;
                break;
              }
            }
            
            // Si pas de SL, sortir au prix de clôture après holdPeriod
            if (!hitStop) {
              exitPrice = candles[i + holdPeriod][4];
            }
            
            const pnlPct = (exitPrice - entry) / entry * 100;
            const date = new Date(candles[i][0]);
            const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            
            // Position sizing basé sur SL
            const posSize = CAPITAL * RISK / (sl / 100);
            const fees = posSize * FEES;
            const netPnl = posSize * (pnlPct / 100) - fees;
            
            trades.push({ month, pnlPct, netPnl, hitStop });
            
            if (!monthlyPnL[month]) monthlyPnL[month] = 0;
            monthlyPnL[month] += netPnl;
            
            i += 2; // Skip next 30min
          }
        }
        
        if (trades.length < 20) continue;
        
        const wins = trades.filter(t => t.netPnl > 0).length;
        const totalPnL = trades.reduce((s, t) => s + t.netPnl, 0);
        const months = Object.keys(monthlyPnL).sort();
        const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
        const avgPnl = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
        const stoppedOut = trades.filter(t => t.hitStop).length;
        
        allResults.push({
          signal: signal.name,
          holdPeriod,
          sl,
          trades: trades.length,
          winRate: wins / trades.length * 100,
          avgPnl,
          totalPnL,
          positiveMonths,
          totalMonths: months.length,
          stoppedOut,
          monthlyPnL,
        });
      }
    }
  }
  
  // Trier par mois positifs puis par P&L
  allResults.sort((a, b) => {
    const ratioA = a.positiveMonths / a.totalMonths;
    const ratioB = b.positiveMonths / b.totalMonths;
    if (ratioB !== ratioA) return ratioB - ratioA;
    return b.totalPnL - a.totalPnL;
  });
  
  // Afficher top 15
  console.log('\n┌──────────────────────────────────┬──────┬────┬────────┬─────────┬──────────┬────────┐');
  console.log('│            Signal                │ Hold │ SL │ Trades │   WR    │   P&L    │ Mois   │');
  console.log('├──────────────────────────────────┼──────┼────┼────────┼─────────┼──────────┼────────┤');
  
  for (const r of allResults.slice(0, 20)) {
    const name = r.signal.slice(0, 32).padEnd(32);
    const hold = (r.holdPeriod * 15 / 60 + 'h').padStart(4);
    const sl = (r.sl + '%').padStart(3);
    const trades = String(r.trades).padStart(6);
    const wr = (r.winRate.toFixed(1) + '%').padStart(7);
    const pnl = (r.totalPnL >= 0 ? '+$' : '-$') + Math.abs(r.totalPnL).toFixed(0).padStart(5);
    const months = `${r.positiveMonths}/${r.totalMonths}`;
    const status = r.positiveMonths >= r.totalMonths * 0.8 ? '✅' : (r.positiveMonths >= r.totalMonths * 0.6 ? '⚠️' : '❌');
    
    console.log(`│ ${name} │ ${hold} │ ${sl} │ ${trades} │ ${wr} │ ${pnl} │ ${months} ${status}│`);
  }
  console.log('└──────────────────────────────────┴──────┴────┴────────┴─────────┴──────────┴────────┘');
  
  // Détail des meilleurs
  const best = allResults.filter(r => r.positiveMonths >= r.totalMonths * 0.6 && r.totalPnL > 0);
  
  if (best.length > 0) {
    console.log('\n' + '═'.repeat(80));
    console.log('🏆 CONFIGURATIONS PROMETTEUSES');
    console.log('═'.repeat(80));
    
    for (const r of best.slice(0, 5)) {
      console.log(`\n✅ ${r.signal}`);
      console.log(`   Hold: ${r.holdPeriod * 15 / 60}h | SL: ${r.sl}%`);
      console.log(`   Trades: ${r.trades} | WR: ${r.winRate.toFixed(1)}% | Avg PnL: ${r.avgPnl.toFixed(3)}%`);
      console.log(`   P&L Total: ${r.totalPnL >= 0 ? '+' : ''}$${r.totalPnL.toFixed(0)} | ROI: ${(r.totalPnL/CAPITAL*100).toFixed(1)}%`);
      console.log(`   Stoppé: ${r.stoppedOut}/${r.trades} (${(r.stoppedOut/r.trades*100).toFixed(0)}%)`);
      console.log(`   Mensuel:`);
      
      const months = Object.keys(r.monthlyPnL).sort();
      for (const month of months) {
        const pnl = r.monthlyPnL[month];
        console.log(`      ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${pnl > 0 ? '✅' : '❌'}`);
      }
    }
  }
  
  // Test SHORT aussi
  console.log('\n' + '═'.repeat(80));
  console.log('📉 TEST SIGNAUX SHORT (même logique, direction inverse)');
  console.log('═'.repeat(80));
  
  const shortSignals = [
    { name: 'Vol 3x + Bearish + Below MA20', test: f => f.volRatio > 3 && !f.isBullish && !f.priceAboveMa20 },
    { name: 'Breakout Down20 + Vol 2x', test: f => f.breakoutDown20 && f.volRatio > 2 },
  ];
  
  for (const signal of shortSignals) {
    for (const holdPeriod of [8, 12]) {
      for (const sl of [1.5, 2]) {
        const trades = [];
        const monthlyPnL = {};
        
        for (const symbol of SYMBOLS) {
          const candles = allCandles[symbol];
          
          for (let i = 100; i < candles.length - holdPeriod - 1; i++) {
            const features = calculateFeatures(candles, i);
            if (!features || !signal.test(features)) continue;
            
            const entry = candles[i][4];
            const stopPrice = entry * (1 + sl / 100); // SHORT: stop au-dessus
            
            let exitPrice = entry;
            let hitStop = false;
            
            for (let j = 1; j <= holdPeriod; j++) {
              const high = candles[i + j][2];
              if (high >= stopPrice) {
                exitPrice = stopPrice;
                hitStop = true;
                break;
              }
            }
            
            if (!hitStop) {
              exitPrice = candles[i + holdPeriod][4];
            }
            
            // SHORT: profit si prix baisse
            const pnlPct = (entry - exitPrice) / entry * 100;
            const date = new Date(candles[i][0]);
            const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            
            const posSize = CAPITAL * RISK / (sl / 100);
            const fees = posSize * FEES;
            const netPnl = posSize * (pnlPct / 100) - fees;
            
            trades.push({ month, pnlPct, netPnl, hitStop });
            
            if (!monthlyPnL[month]) monthlyPnL[month] = 0;
            monthlyPnL[month] += netPnl;
            
            i += 2;
          }
        }
        
        if (trades.length < 10) continue;
        
        const wins = trades.filter(t => t.netPnl > 0).length;
        const totalPnL = trades.reduce((s, t) => s + t.netPnl, 0);
        const months = Object.keys(monthlyPnL).sort();
        const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
        
        const status = totalPnL > 0 ? '✅' : '❌';
        console.log(`\n${status} ${signal.name} (Hold ${holdPeriod * 15 / 60}h, SL ${sl}%)`);
        console.log(`   Trades: ${trades.length} | WR: ${(wins/trades.length*100).toFixed(1)}%`);
        console.log(`   P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)} | Mois: ${positiveMonths}/${months.length}`);
      }
    }
  }
  
  // COMBO LONG + SHORT
  console.log('\n' + '═'.repeat(80));
  console.log('🔄 COMBO LONG + SHORT (diversification)');
  console.log('═'.repeat(80));
  
  // Prendre la meilleure config long et short
  const longConfig = { holdPeriod: 8, sl: 1.5 };
  const shortConfig = { holdPeriod: 8, sl: 1.5 };
  
  const longSignal = f => f.volRatio > 3 && f.isBullish && f.priceAboveMa20;
  const shortSignal = f => f.volRatio > 3 && !f.isBullish && !f.priceAboveMa20;
  
  const comboTrades = [];
  const comboMonthly = {};
  
  for (const symbol of SYMBOLS) {
    const candles = allCandles[symbol];
    
    for (let i = 100; i < candles.length - 20; i++) {
      const features = calculateFeatures(candles, i);
      if (!features) continue;
      
      let direction = null;
      let holdPeriod, sl;
      
      if (longSignal(features)) {
        direction = 'LONG';
        holdPeriod = longConfig.holdPeriod;
        sl = longConfig.sl;
      } else if (shortSignal(features)) {
        direction = 'SHORT';
        holdPeriod = shortConfig.holdPeriod;
        sl = shortConfig.sl;
      }
      
      if (!direction) continue;
      
      const entry = candles[i][4];
      const stopPrice = direction === 'LONG' ? entry * (1 - sl / 100) : entry * (1 + sl / 100);
      
      let exitPrice = entry;
      let hitStop = false;
      
      for (let j = 1; j <= holdPeriod; j++) {
        const testPrice = direction === 'LONG' ? candles[i + j][3] : candles[i + j][2];
        const stopHit = direction === 'LONG' ? testPrice <= stopPrice : testPrice >= stopPrice;
        
        if (stopHit) {
          exitPrice = stopPrice;
          hitStop = true;
          break;
        }
      }
      
      if (!hitStop) {
        exitPrice = candles[i + holdPeriod][4];
      }
      
      const pnlPct = direction === 'LONG' 
        ? (exitPrice - entry) / entry * 100 
        : (entry - exitPrice) / entry * 100;
      
      const date = new Date(candles[i][0]);
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      const posSize = CAPITAL * RISK / (sl / 100);
      const fees = posSize * FEES;
      const netPnl = posSize * (pnlPct / 100) - fees;
      
      comboTrades.push({ month, direction, pnlPct, netPnl });
      
      if (!comboMonthly[month]) comboMonthly[month] = 0;
      comboMonthly[month] += netPnl;
      
      i += 2;
    }
  }
  
  const comboWins = comboTrades.filter(t => t.netPnl > 0).length;
  const comboTotalPnL = comboTrades.reduce((s, t) => s + t.netPnl, 0);
  const comboMonths = Object.keys(comboMonthly).sort();
  const comboPositiveMonths = comboMonths.filter(m => comboMonthly[m] > 0).length;
  const longTrades = comboTrades.filter(t => t.direction === 'LONG');
  const shortTrades = comboTrades.filter(t => t.direction === 'SHORT');
  
  console.log(`\n📊 COMBO (Long + Short avec Vol 3x)`);
  console.log(`   Trades: ${comboTrades.length} (${longTrades.length} long, ${shortTrades.length} short)`);
  console.log(`   WR: ${(comboWins/comboTrades.length*100).toFixed(1)}%`);
  console.log(`   P&L: ${comboTotalPnL >= 0 ? '+' : ''}$${comboTotalPnL.toFixed(0)}`);
  console.log(`   Mois positifs: ${comboPositiveMonths}/${comboMonths.length}`);
  
  for (const month of comboMonths) {
    const pnl = comboMonthly[month];
    console.log(`      ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${pnl > 0 ? '✅' : '❌'}`);
  }
}

main().catch(console.error);
