#!/usr/bin/env node
/**
 * 🎯 OPTIMISATION PATTERN PRÉDICTIF
 * 
 * On a trouvé que "Near Resistance + Vol Extreme" prédit 82.8% des gros moves
 * Mais le backtest échoue car le R:R est mauvais.
 * 
 * Nouvelle approche: Mesurer le VRAI mouvement moyen après le signal
 * et ajuster TP/SL en conséquence
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
  const volume = volumes[volumes.length - 1];
  
  // Volume
  const avgVol20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volRatio = volume / avgVol20;
  
  // MAs
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
  
  // Bollinger
  const std20 = Math.sqrt(closes.slice(-20).map(c => Math.pow(c - ma20, 2)).reduce((a, b) => a + b, 0) / 20);
  const bbLower = ma20 - 2 * std20;
  const bbUpper = ma20 + 2 * std20;
  const bbPosition = (close - bbLower) / (bbUpper - bbLower);
  
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
  const momentum4h = (close - closes[closes.length - 17]) / closes[closes.length - 17] * 100;
  
  // Higher lows
  const recentLows = [];
  for (let j = 0; j < 3; j++) {
    recentLows.push(Math.min(...lows.slice(-10 - j * 4, -6 - j * 4)));
  }
  const higherLows = recentLows[0] > recentLows[1] && recentLows[1] > recentLows[2];
  
  // Candle
  const open = opens[opens.length - 1];
  const isBullish = close > open;
  
  return {
    volRatio,
    volSpike: volRatio > 2,
    volExtreme: volRatio > 4,
    priceAboveMa20: close > ma20,
    priceAboveMa50: close > ma50,
    allMaAligned: close > ma5 && ma5 > ma20 && ma20 > ma50,
    rsi,
    rsiNeutral: rsi >= 40 && rsi <= 60,
    rsiOversold: rsi < 30,
    breakoutUp20: close > highest20,
    breakoutUp50: close > highest50,
    nearResistance20: close >= highest20 * 0.995,
    bbPosition,
    bbLower: bbPosition < 0.3,
    atrPct,
    momentum1h,
    momentum4h,
    higherLows,
    isBullish,
  };
}

// Mesurer ce qui se passe APRÈS un signal
function measureOutcome(candles, entryIndex, maxBars = 32) {
  const entry = candles[entryIndex][4];
  
  let maxUp = 0, maxDown = 0;
  let maxUpBar = 0, maxDownBar = 0;
  let closeAt8 = entry, closeAt16 = entry, closeAt32 = entry;
  
  for (let j = 1; j <= Math.min(maxBars, candles.length - entryIndex - 1); j++) {
    const high = candles[entryIndex + j][2];
    const low = candles[entryIndex + j][3];
    const close = candles[entryIndex + j][4];
    
    const up = (high - entry) / entry * 100;
    const down = (entry - low) / entry * 100;
    
    if (up > maxUp) { maxUp = up; maxUpBar = j; }
    if (down > maxDown) { maxDown = down; maxDownBar = j; }
    
    if (j === 8) closeAt8 = close;
    if (j === 16) closeAt16 = close;
    if (j === 32) closeAt32 = close;
  }
  
  return {
    maxUp: Math.round(maxUp * 100) / 100,
    maxDown: Math.round(maxDown * 100) / 100,
    maxUpBar,
    maxDownBar,
    favorableRatio: maxUp / (maxDown || 0.01),
    return8: Math.round((closeAt8 - entry) / entry * 10000) / 100,
    return16: Math.round((closeAt16 - entry) / entry * 10000) / 100,
    return32: Math.round((closeAt32 - entry) / entry * 10000) / 100,
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 ANALYSE DES OUTCOMES PAR SIGNAL - Quel TP/SL optimal?');
  console.log('═'.repeat(80));
  
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`📥 ${symbol}...`);
    allCandles[symbol] = await fetchCandles(symbol, 120);
  }
  
  // Règles à tester (basées sur les meilleurs prédicteurs trouvés)
  const rules = [
    { name: 'Near Resistance + Vol Extreme', test: f => f.nearResistance20 && f.volExtreme },
    { name: 'Breakout50 + Vol2x', test: f => f.breakoutUp50 && f.volRatio > 2 },
    { name: 'Vol Extreme + Bullish', test: f => f.volExtreme && f.isBullish },
    { name: 'BB Lower + Vol Spike', test: f => f.bbLower && f.volSpike && f.isBullish },
    { name: 'All MA + Vol Spike', test: f => f.allMaAligned && f.volSpike },
    { name: 'Higher Lows + Vol + MA', test: f => f.higherLows && f.volSpike && f.priceAboveMa20 },
    { name: 'Momentum + Vol Extreme', test: f => f.momentum1h > 0.3 && f.volExtreme },
    { name: 'RSI Oversold + Vol Spike', test: f => f.rsiOversold && f.volSpike && f.isBullish },
    { name: 'Breakout20 + Vol Extreme', test: f => f.breakoutUp20 && f.volExtreme },
    { name: 'ATR High + Vol Extreme', test: f => f.atrPct > 1 && f.volExtreme },
  ];
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 ANALYSE DES OUTCOMES RÉELS PAR SIGNAL');
  console.log('═'.repeat(80));
  
  for (const rule of rules) {
    const outcomes = [];
    
    for (const symbol of SYMBOLS) {
      const candles = allCandles[symbol];
      
      for (let i = 100; i < candles.length - 40; i++) {
        const features = calculateFeatures(candles, i);
        if (!features || !rule.test(features)) continue;
        
        const outcome = measureOutcome(candles, i, 32);
        outcomes.push({ symbol, index: i, ...outcome });
        
        i += 4; // Skip pour éviter overlap
      }
    }
    
    if (outcomes.length < 10) continue;
    
    // Stats
    const avgMaxUp = outcomes.reduce((s, o) => s + o.maxUp, 0) / outcomes.length;
    const avgMaxDown = outcomes.reduce((s, o) => s + o.maxDown, 0) / outcomes.length;
    const avgReturn8 = outcomes.reduce((s, o) => s + o.return8, 0) / outcomes.length;
    const avgReturn16 = outcomes.reduce((s, o) => s + o.return16, 0) / outcomes.length;
    const avgFavorable = outcomes.reduce((s, o) => s + o.favorableRatio, 0) / outcomes.length;
    
    // Calculer le TP optimal basé sur le maxUp médian
    outcomes.sort((a, b) => a.maxUp - b.maxUp);
    const medianMaxUp = outcomes[Math.floor(outcomes.length / 2)].maxUp;
    const p25MaxUp = outcomes[Math.floor(outcomes.length * 0.25)].maxUp;
    
    console.log(`\n📈 ${rule.name}`);
    console.log(`   Signaux: ${outcomes.length}`);
    console.log(`   Max Up moyen: +${avgMaxUp.toFixed(2)}% | Max Down moyen: -${avgMaxDown.toFixed(2)}%`);
    console.log(`   Ratio favorable: ${avgFavorable.toFixed(2)}x`);
    console.log(`   Return @2h: ${avgReturn8 >= 0 ? '+' : ''}${avgReturn8.toFixed(2)}% | @4h: ${avgReturn16 >= 0 ? '+' : ''}${avgReturn16.toFixed(2)}%`);
    console.log(`   Médiane Max Up: +${medianMaxUp.toFixed(2)}% | P25: +${p25MaxUp.toFixed(2)}%`);
    
    // Suggérer TP/SL optimal
    const suggestedTP = Math.max(p25MaxUp * 0.8, 1.5); // 80% du P25 pour être atteignable
    const suggestedSL = suggestedTP / 2; // R:R 2:1
    console.log(`   💡 TP suggéré: +${suggestedTP.toFixed(2)}% | SL: -${suggestedSL.toFixed(2)}%`);
  }
  
  // Maintenant backtest avec TP/SL dynamique
  console.log('\n' + '═'.repeat(80));
  console.log('💰 BACKTEST AVEC TP/SL DYNAMIQUE (basé sur ATR)');
  console.log('═'.repeat(80));
  
  const CAPITAL = 10000;
  const RISK = 0.01;
  const FEES = 0.0006;
  
  // Test avec TP = 1.5*ATR et SL = 0.75*ATR (R:R 2:1)
  const dynamicRules = [
    { name: 'Vol Extreme + Bullish', test: f => f.volExtreme && f.isBullish },
    { name: 'Breakout20 + Vol Extreme', test: f => f.breakoutUp20 && f.volExtreme },
    { name: 'All MA + Vol Spike', test: f => f.allMaAligned && f.volSpike },
    { name: 'Near Resistance + Vol Extreme', test: f => f.nearResistance20 && f.volExtreme },
  ];
  
  for (const rule of dynamicRules) {
    const trades = [];
    const monthlyPnL = {};
    
    for (const symbol of SYMBOLS) {
      const candles = allCandles[symbol];
      
      for (let i = 100; i < candles.length - 40; i++) {
        const features = calculateFeatures(candles, i);
        if (!features || !rule.test(features)) continue;
        
        const entry = candles[i][4];
        
        // TP/SL basé sur ATR
        const tpPct = features.atrPct * 2; // 2x ATR
        const slPct = features.atrPct * 1; // 1x ATR
        
        const tp = entry * (1 + tpPct / 100);
        const sl = entry * (1 - slPct / 100);
        
        let result = null;
        for (let j = 1; j <= 32; j++) {
          const high = candles[i + j][2];
          const low = candles[i + j][3];
          
          if (low <= sl) { result = { win: false, pnl: -slPct }; break; }
          if (high >= tp) { result = { win: true, pnl: tpPct }; break; }
        }
        
        if (!result) {
          const exitPrice = candles[i + 32][4];
          result = { win: exitPrice > entry, pnl: (exitPrice - entry) / entry * 100 };
        }
        
        const date = new Date(candles[i][0]);
        const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        
        const posSize = CAPITAL * RISK / (slPct / 100);
        const fees = posSize * FEES;
        const netPnl = posSize * (result.pnl / 100) - fees;
        
        trades.push({ month, symbol, tpPct, slPct, ...result, netPnl });
        
        if (!monthlyPnL[month]) monthlyPnL[month] = 0;
        monthlyPnL[month] += netPnl;
        
        i += 4;
      }
    }
    
    if (trades.length === 0) continue;
    
    const wins = trades.filter(t => t.win).length;
    const totalPnL = trades.reduce((s, t) => s + t.netPnl, 0);
    const totalFees = trades.length * CAPITAL * RISK * FEES / 0.01;
    const months = Object.keys(monthlyPnL).sort();
    const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
    const avgTp = trades.reduce((s, t) => s + t.tpPct, 0) / trades.length;
    const avgSl = trades.reduce((s, t) => s + t.slPct, 0) / trades.length;
    
    console.log(`\n📊 ${rule.name}`);
    console.log(`   Trades: ${trades.length} | WR: ${(wins/trades.length*100).toFixed(1)}%`);
    console.log(`   TP moy: ${avgTp.toFixed(2)}% | SL moy: ${avgSl.toFixed(2)}%`);
    console.log(`   P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)} | Frais: $${totalFees.toFixed(0)}`);
    console.log(`   Mois positifs: ${positiveMonths}/${months.length}`);
    
    // Détail mensuel
    for (const month of months) {
      const pnl = monthlyPnL[month];
      console.log(`      ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${pnl > 0 ? '✅' : '❌'}`);
    }
    
    if (totalPnL > 0 && positiveMonths >= months.length * 0.6) {
      console.log('   🎯 PROMETTEUR!');
    }
  }
  
  // Test final: combinaison de signaux
  console.log('\n' + '═'.repeat(80));
  console.log('🔥 COMBINAISONS AVANCÉES');
  console.log('═'.repeat(80));
  
  const advancedRules = [
    { 
      name: 'Ultra Selective (Vol 5x + Breakout + MA)',
      test: f => f.volRatio > 5 && f.breakoutUp20 && f.priceAboveMa20 && f.isBullish
    },
    { 
      name: 'Reversal Setup (BB Low + Vol 3x + Oversold)',
      test: f => f.bbPosition < 0.2 && f.volRatio > 3 && f.rsi < 35 && f.isBullish
    },
    { 
      name: 'Trend Continuation (MA + HigherLows + Vol)',
      test: f => f.allMaAligned && f.higherLows && f.volRatio > 2 && f.momentum1h > 0
    },
    { 
      name: 'Momentum Burst (Mom 4h > 1% + Vol 4x)',
      test: f => f.momentum4h > 1 && f.volRatio > 4 && f.isBullish
    },
  ];
  
  for (const rule of advancedRules) {
    const trades = [];
    const monthlyPnL = {};
    
    for (const symbol of SYMBOLS) {
      const candles = allCandles[symbol];
      
      for (let i = 100; i < candles.length - 40; i++) {
        const features = calculateFeatures(candles, i);
        if (!features || !rule.test(features)) continue;
        
        const entry = candles[i][4];
        
        // R:R 3:1 avec TP basé sur ATR
        const tpPct = Math.max(features.atrPct * 3, 2);
        const slPct = Math.max(features.atrPct * 1, 0.5);
        
        const tp = entry * (1 + tpPct / 100);
        const sl = entry * (1 - slPct / 100);
        
        let result = null;
        for (let j = 1; j <= 48; j++) { // 12h max
          if (i + j >= candles.length) break;
          const high = candles[i + j][2];
          const low = candles[i + j][3];
          
          if (low <= sl) { result = { win: false, pnl: -slPct }; break; }
          if (high >= tp) { result = { win: true, pnl: tpPct }; break; }
        }
        
        if (!result) {
          const exitIdx = Math.min(i + 48, candles.length - 1);
          const exitPrice = candles[exitIdx][4];
          result = { win: exitPrice > entry, pnl: (exitPrice - entry) / entry * 100 };
        }
        
        const date = new Date(candles[i][0]);
        const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        
        const posSize = CAPITAL * RISK / (slPct / 100);
        const fees = posSize * FEES;
        const netPnl = posSize * (result.pnl / 100) - fees;
        
        trades.push({ month, ...result, netPnl, tpPct, slPct });
        
        if (!monthlyPnL[month]) monthlyPnL[month] = 0;
        monthlyPnL[month] += netPnl;
        
        i += 8; // Plus de skip pour très sélectif
      }
    }
    
    if (trades.length === 0) {
      console.log(`\n❌ ${rule.name}: 0 trades`);
      continue;
    }
    
    const wins = trades.filter(t => t.win).length;
    const totalPnL = trades.reduce((s, t) => s + t.netPnl, 0);
    const months = Object.keys(monthlyPnL).sort();
    const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
    
    const status = totalPnL > 0 && positiveMonths >= months.length * 0.6 ? '🎯' : '❌';
    
    console.log(`\n${status} ${rule.name}`);
    console.log(`   Trades: ${trades.length} (${(trades.length / (120/30)).toFixed(1)}/mois) | WR: ${(wins/trades.length*100).toFixed(1)}%`);
    console.log(`   P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)} | ROI: ${(totalPnL/CAPITAL*100).toFixed(1)}%`);
    console.log(`   Mois: ${positiveMonths}/${months.length} positifs`);
    
    for (const month of months) {
      const pnl = monthlyPnL[month];
      console.log(`      ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${pnl > 0 ? '✅' : '❌'}`);
    }
  }
}

main().catch(console.error);
