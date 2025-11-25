#!/usr/bin/env node
/**
 * 🎯 GAME CHANGER - Trouver des signaux de haute conviction
 * 
 * Objectif : Signaux RARES mais avec GROS gains
 * - Peu de trades (5-15/mois max)
 * - R:R de 3:1 à 5:1 minimum
 * - Frais négligeables vs gains
 * - Chaque mois positif
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ enableRateLimit: true });
const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];

// Configuration
const CAPITAL = 10000;
const RISK_PER_TRADE = 0.01; // 1% du capital risqué par trade
const FEES_ROUNDTRIP = 0.0006; // 0.06%
const LEVERAGE = 5; // Leverage moyen

async function fetchCandles(symbol, days = 365) {
  const limit = Math.min(days * 96, 35000); // 15min candles
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

// Calculer indicateurs avancés
function calculateIndicators(candles, i) {
  if (i < 50) return null;
  
  const closes = candles.slice(i - 50, i + 1).map(c => c[4]);
  const highs = candles.slice(i - 50, i + 1).map(c => c[2]);
  const lows = candles.slice(i - 50, i + 1).map(c => c[3]);
  const volumes = candles.slice(i - 50, i + 1).map(c => c[5]);
  const opens = candles.slice(i - 50, i + 1).map(c => c[1]);
  
  const close = closes[closes.length - 1];
  const high = highs[highs.length - 1];
  const low = lows[lows.length - 1];
  const open = opens[opens.length - 1];
  const volume = volumes[volumes.length - 1];
  
  // Volume analysis
  const avgVol20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volRatio = volume / avgVol20;
  
  // Price range (volatilité)
  const range = (high - low) / close * 100;
  const avgRange = candles.slice(i - 20, i).map(c => (c[2] - c[3]) / c[4] * 100).reduce((a, b) => a + b, 0) / 20;
  const rangeExpansion = range / avgRange;
  
  // Trend analysis multi-timeframe simulé
  const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  
  // RSI
  let gains = 0, losses = 0;
  for (let j = closes.length - 14; j < closes.length; j++) {
    const change = closes[j] - closes[j - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const rs = gains / (losses || 0.0001);
  const rsi = 100 - (100 / (1 + rs));
  
  // MACD
  const ema12 = closes.slice(-12).reduce((a, b, i) => a + b * (2 / 13), 0) / closes.slice(-12).reduce((a, _, i) => a + (2 / 13), 0);
  const ema26 = closes.slice(-26).reduce((a, b, i) => a + b * (2 / 27), 0) / closes.slice(-26).reduce((a, _, i) => a + (2 / 27), 0);
  const macd = ema12 - ema26;
  
  // Candle patterns
  const body = close - open;
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const bodySize = Math.abs(body);
  const totalRange = high - low || 0.0001;
  
  const isBullish = close > open;
  const isBearish = close < open;
  const isStrongBullish = isBullish && bodySize > avgRange * close / 100 * 1.5;
  const isStrongBearish = isBearish && bodySize > avgRange * close / 100 * 1.5;
  
  // Breakout detection
  const highest20 = Math.max(...highs.slice(-21, -1));
  const lowest20 = Math.min(...lows.slice(-21, -1));
  const highest50 = Math.max(...highs.slice(-51, -1));
  const lowest50 = Math.min(...lows.slice(-51, -1));
  
  const breakoutUp20 = close > highest20;
  const breakoutDown20 = close < lowest20;
  const breakoutUp50 = close > highest50;
  const breakoutDown50 = close < lowest50;
  
  // Consolidation detection (low volatility then expansion)
  const recentRanges = candles.slice(i - 10, i).map(c => (c[2] - c[3]) / c[4] * 100);
  const avgRecentRange = recentRanges.reduce((a, b) => a + b, 0) / 10;
  const wasConsolidating = avgRecentRange < avgRange * 0.7;
  
  // Momentum
  const momentum5 = (close - closes[closes.length - 6]) / closes[closes.length - 6] * 100;
  const momentum10 = (close - closes[closes.length - 11]) / closes[closes.length - 11] * 100;
  const momentum20 = (close - closes[closes.length - 21]) / closes[closes.length - 21] * 100;
  
  // Consecutive candles
  let consecutiveBullish = 0;
  let consecutiveBearish = 0;
  for (let j = candles.length - 1; j >= Math.max(0, candles.length - 10); j--) {
    const c = candles.slice(i - 50 + j, i - 50 + j + 1)[0];
    if (!c) break;
    if (c[4] > c[1]) {
      if (consecutiveBearish > 0) break;
      consecutiveBullish++;
    } else {
      if (consecutiveBullish > 0) break;
      consecutiveBearish++;
    }
  }
  
  // Volume surge detection
  const volSurge = volume > avgVol20 * 3;
  const extremeVolSurge = volume > avgVol20 * 5;
  
  return {
    close, high, low, open, volume,
    volRatio, range, rangeExpansion,
    ma5, ma10, ma20, ma50,
    rsi, macd,
    isBullish, isBearish, isStrongBullish, isStrongBearish,
    breakoutUp20, breakoutDown20, breakoutUp50, breakoutDown50,
    wasConsolidating,
    momentum5, momentum10, momentum20,
    consecutiveBullish, consecutiveBearish,
    volSurge, extremeVolSurge,
    bodySize, upperWick, lowerWick, totalRange,
  };
}

// Définir les signaux de haute conviction
const GAME_CHANGER_SIGNALS = {
  // Signal 1: Breakout 50 périodes + Volume explosif
  'breakout50_vol5x': (ind) => {
    return ind.breakoutUp50 && ind.volRatio > 5 && ind.isStrongBullish;
  },
  
  // Signal 2: Consolidation puis explosion
  'consolidation_explosion': (ind) => {
    return ind.wasConsolidating && ind.rangeExpansion > 2.5 && ind.volRatio > 3 && ind.isBullish;
  },
  
  // Signal 3: Triple confirmation (MA + Volume + Breakout)
  'triple_confirmation': (ind) => {
    const maAligned = ind.close > ind.ma5 && ind.ma5 > ind.ma10 && ind.ma10 > ind.ma20;
    return maAligned && ind.breakoutUp20 && ind.volRatio > 3 && ind.isStrongBullish;
  },
  
  // Signal 4: RSI oversold + Volume spike + Reversal candle
  'oversold_reversal': (ind) => {
    return ind.rsi < 30 && ind.volRatio > 2.5 && ind.isStrongBullish && ind.lowerWick > ind.bodySize;
  },
  
  // Signal 5: Momentum explosion (rare mais puissant)
  'momentum_explosion': (ind) => {
    return ind.momentum5 > 3 && ind.volRatio > 4 && ind.isStrongBullish && ind.consecutiveBullish >= 3;
  },
  
  // Signal 6: Breakout 50 après 7+ candles dans le même sens
  'trend_breakout': (ind) => {
    return ind.breakoutUp50 && ind.consecutiveBullish >= 5 && ind.volRatio > 2;
  },
  
  // Signal 7: Volume extreme + Strong candle (très rare)
  'extreme_volume': (ind) => {
    return ind.extremeVolSurge && ind.isStrongBullish && ind.rangeExpansion > 2;
  },
  
  // Signal 8: Multi-MA crossover + Volume
  'ma_crossover_vol': (ind) => {
    return ind.close > ind.ma5 && ind.ma5 > ind.ma10 && ind.ma10 > ind.ma20 && ind.ma20 > ind.ma50 && ind.volRatio > 2.5;
  },
  
  // Signal 9: Breakout with momentum
  'breakout_momentum': (ind) => {
    return ind.breakoutUp20 && ind.momentum10 > 2 && ind.volRatio > 2 && ind.consecutiveBullish >= 3;
  },
  
  // Signal 10: Perfect setup (toutes conditions alignées)
  'perfect_setup': (ind) => {
    const maAligned = ind.close > ind.ma5 && ind.ma5 > ind.ma10 && ind.ma10 > ind.ma20;
    return maAligned && ind.breakoutUp20 && ind.volRatio > 3 && 
           ind.isStrongBullish && ind.momentum5 > 1 && ind.rsi > 50 && ind.rsi < 70;
  },
};

// R:R ratios à tester
const RR_RATIOS = [
  { tp: 3, sl: 1, name: '3:1' },
  { tp: 4, sl: 1, name: '4:1' },
  { tp: 5, sl: 1, name: '5:1' },
  { tp: 3, sl: 0.5, name: '3:0.5' },
  { tp: 4, sl: 0.5, name: '4:0.5' },
];

// Simuler un trade
function simulateTrade(candles, entryIndex, tp_pct, sl_pct) {
  const entry = candles[entryIndex][4];
  const tp = entry * (1 + tp_pct / 100);
  const sl = entry * (1 - sl_pct / 100);
  
  for (let i = entryIndex + 1; i < Math.min(entryIndex + 200, candles.length); i++) {
    const high = candles[i][2];
    const low = candles[i][3];
    
    // Check SL first (worst case)
    if (low <= sl) {
      return { win: false, pnl: -sl_pct, bars: i - entryIndex };
    }
    // Check TP
    if (high >= tp) {
      return { win: true, pnl: tp_pct, bars: i - entryIndex };
    }
  }
  
  // Timeout - close at current price
  const exitPrice = candles[Math.min(entryIndex + 199, candles.length - 1)][4];
  const pnl = (exitPrice - entry) / entry * 100;
  return { win: pnl > 0, pnl, bars: 200, timeout: true };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 GAME CHANGER - Recherche de signaux à haute conviction');
  console.log('═'.repeat(80));
  console.log(`\n⚡ Objectif: Peu de trades mais GROS gains, frais négligeables`);
  console.log(`💰 Capital: $${CAPITAL} | Leverage: ${LEVERAGE}x | Risk/trade: ${RISK_PER_TRADE * 100}%`);
  
  // Fetch data
  const allCandles = {};
  for (const symbol of SYMBOLS) {
    console.log(`\n📥 Fetching ${symbol}...`);
    allCandles[symbol] = await fetchCandles(symbol, 365);
    console.log(`   ✅ ${allCandles[symbol].length} candles`);
  }
  
  // Période
  const firstDate = new Date(Math.max(...Object.values(allCandles).map(c => c[0][0])));
  const lastDate = new Date(Math.min(...Object.values(allCandles).map(c => c[c.length - 1][0])));
  const days = Math.floor((lastDate - firstDate) / (24 * 60 * 60 * 1000));
  console.log(`\n📅 Période: ${firstDate.toISOString().slice(0, 10)} → ${lastDate.toISOString().slice(0, 10)} (${days} jours)`);
  
  const results = [];
  
  // Tester chaque signal avec chaque R:R
  for (const [signalName, signalFn] of Object.entries(GAME_CHANGER_SIGNALS)) {
    for (const rr of RR_RATIOS) {
      const trades = [];
      const monthlyPnL = {};
      
      for (const symbol of SYMBOLS) {
        const candles = allCandles[symbol];
        
        for (let i = 50; i < candles.length - 200; i++) {
          const ind = calculateIndicators(candles, i);
          if (!ind) continue;
          
          if (signalFn(ind)) {
            const result = simulateTrade(candles, i, rr.tp, rr.sl);
            const date = new Date(candles[i][0]);
            const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            
            // Calculer P&L avec frais et leverage
            const positionValue = CAPITAL * RISK_PER_TRADE / (rr.sl / 100); // Position size basée sur risk
            const fees = positionValue * FEES_ROUNDTRIP;
            const grossPnl = positionValue * (result.pnl / 100);
            const netPnl = grossPnl - fees;
            
            trades.push({
              date,
              month,
              symbol,
              ...result,
              positionValue,
              fees,
              grossPnl,
              netPnl,
            });
            
            if (!monthlyPnL[month]) monthlyPnL[month] = 0;
            monthlyPnL[month] += netPnl;
            
            // Skip next 4 candles (1h) pour éviter les signaux consécutifs
            i += 4;
          }
        }
      }
      
      if (trades.length === 0) continue;
      
      const wins = trades.filter(t => t.win).length;
      const winRate = wins / trades.length * 100;
      const totalNetPnL = trades.reduce((sum, t) => sum + t.netPnl, 0);
      const totalFees = trades.reduce((sum, t) => sum + t.fees, 0);
      const avgPnlPerTrade = totalNetPnL / trades.length;
      const tradesPerMonth = trades.length / (days / 30);
      
      // Compter les mois positifs
      const months = Object.keys(monthlyPnL).sort();
      const positiveMonths = months.filter(m => monthlyPnL[m] > 0).length;
      
      results.push({
        signal: signalName,
        rr: rr.name,
        trades: trades.length,
        tradesPerMonth: tradesPerMonth.toFixed(1),
        winRate: winRate.toFixed(1),
        totalNetPnL,
        totalFees,
        avgPnlPerTrade,
        positiveMonths,
        totalMonths: months.length,
        monthlyPnL,
        roi: (totalNetPnL / CAPITAL * 100).toFixed(1),
      });
    }
  }
  
  // Trier par ratio mois positifs puis par P&L
  results.sort((a, b) => {
    const ratioA = a.positiveMonths / a.totalMonths;
    const ratioB = b.positiveMonths / b.totalMonths;
    if (ratioB !== ratioA) return ratioB - ratioA;
    return b.totalNetPnL - a.totalNetPnL;
  });
  
  // Afficher les meilleurs résultats
  console.log('\n' + '═'.repeat(80));
  console.log('🏆 TOP 15 CONFIGURATIONS');
  console.log('═'.repeat(80));
  
  console.log('\n┌────────────────────────────┬───────┬────────┬─────────┬──────────┬───────────┬─────────────┐');
  console.log('│          Signal            │  R:R  │ Trades │  WR%    │   P&L    │ Mois +/-  │   ROI/An    │');
  console.log('├────────────────────────────┼───────┼────────┼─────────┼──────────┼───────────┼─────────────┤');
  
  for (const r of results.slice(0, 15)) {
    const signal = r.signal.padEnd(26).slice(0, 26);
    const rrStr = r.rr.padStart(5);
    const trades = String(r.trades).padStart(6);
    const wr = r.winRate.padStart(6) + '%';
    const pnl = (r.totalNetPnL >= 0 ? '+' : '') + '$' + Math.round(r.totalNetPnL).toString().padStart(5);
    const months = `${r.positiveMonths}/${r.totalMonths}`.padStart(7);
    const roi = (r.totalNetPnL >= 0 ? '+' : '') + r.roi + '%';
    
    const status = r.positiveMonths >= r.totalMonths * 0.8 ? '✅' : (r.positiveMonths >= r.totalMonths * 0.6 ? '⚠️' : '❌');
    
    console.log(`│ ${signal} │ ${rrStr} │ ${trades} │ ${wr} │ ${pnl} │ ${months} ${status} │ ${roi.padStart(10)} │`);
  }
  
  console.log('└────────────────────────────┴───────┴────────┴─────────┴──────────┴───────────┴─────────────┘');
  
  // Détail du meilleur
  const best = results[0];
  if (best && best.positiveMonths >= best.totalMonths * 0.7) {
    console.log('\n' + '═'.repeat(80));
    console.log(`🎯 MEILLEUR: ${best.signal} avec R:R ${best.rr}`);
    console.log('═'.repeat(80));
    
    console.log(`\n📊 Statistiques:`);
    console.log(`   Trades totaux: ${best.trades} (${best.tradesPerMonth}/mois)`);
    console.log(`   Win Rate: ${best.winRate}%`);
    console.log(`   P&L Net Total: $${best.totalNetPnL.toFixed(2)}`);
    console.log(`   Frais Totaux: $${best.totalFees.toFixed(2)}`);
    console.log(`   P&L Moyen/Trade: $${best.avgPnlPerTrade.toFixed(2)}`);
    console.log(`   ROI Annuel: ${best.roi}%`);
    
    console.log(`\n📅 Performance Mensuelle:`);
    const months = Object.keys(best.monthlyPnL).sort();
    for (const month of months) {
      const pnl = best.monthlyPnL[month];
      const status = pnl > 0 ? '✅' : '❌';
      console.log(`   ${month}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0).padStart(5)} ${status}`);
    }
    
    // Projection avec leverage
    console.log('\n' + '═'.repeat(80));
    console.log('💰 PROJECTION REVENUS (avec leverage)');
    console.log('═'.repeat(80));
    
    const monthlyAvgPnl = best.totalNetPnL / best.totalMonths;
    
    console.log('\n┌──────────────────┬────────────────┬────────────────┬────────────────┐');
    console.log('│  Capital Initial │ Profit/Mois    │ Profit/An      │ ROI Annuel     │');
    console.log('├──────────────────┼────────────────┼────────────────┼────────────────┤');
    
    for (const cap of [1000, 5000, 10000, 25000, 50000, 100000]) {
      const multiplier = cap / CAPITAL;
      const profitMois = monthlyAvgPnl * multiplier;
      const profitAn = profitMois * 12;
      const roi = (profitAn / cap * 100).toFixed(1);
      
      console.log(`│ $${String(cap).padStart(15)} │ ${(profitMois >= 0 ? '+$' : '-$') + Math.abs(profitMois).toFixed(0).padStart(12)} │ ${(profitAn >= 0 ? '+$' : '-$') + Math.abs(profitAn).toFixed(0).padStart(12)} │ ${(roi >= 0 ? '+' : '') + roi + '%'.padStart(13)} │`);
    }
    
    console.log('└──────────────────┴────────────────┴────────────────┴────────────────┘');
  }
  
  // Chercher le signal avec le plus de mois positifs
  const bestMonthly = results.reduce((best, r) => {
    if (r.positiveMonths / r.totalMonths > best.positiveMonths / best.totalMonths) return r;
    if (r.positiveMonths / r.totalMonths === best.positiveMonths / best.totalMonths && r.totalNetPnL > best.totalNetPnL) return r;
    return best;
  }, results[0]);
  
  if (bestMonthly && bestMonthly !== best) {
    console.log('\n' + '═'.repeat(80));
    console.log(`📈 PLUS STABLE: ${bestMonthly.signal} avec R:R ${bestMonthly.rr}`);
    console.log('═'.repeat(80));
    console.log(`   Mois positifs: ${bestMonthly.positiveMonths}/${bestMonthly.totalMonths} (${(bestMonthly.positiveMonths/bestMonthly.totalMonths*100).toFixed(0)}%)`);
    console.log(`   ROI: ${bestMonthly.roi}%`);
  }
  
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 VERDICT');
  console.log('═'.repeat(80));
  
  const hasViable = results.some(r => r.positiveMonths >= r.totalMonths * 0.9 && r.totalNetPnL > 0);
  if (hasViable) {
    const viable = results.find(r => r.positiveMonths >= r.totalMonths * 0.9 && r.totalNetPnL > 0);
    console.log(`\n✅ SIGNAL VIABLE TROUVÉ: ${viable.signal}`);
    console.log(`   ${viable.positiveMonths}/${viable.totalMonths} mois positifs avec +${viable.roi}% ROI`);
  } else {
    const bestRatio = Math.max(...results.map(r => r.positiveMonths / r.totalMonths));
    console.log(`\n⚠️ Meilleur ratio mois positifs: ${(bestRatio * 100).toFixed(0)}%`);
    console.log(`   Aucune stratégie n'atteint 90%+ de mois positifs`);
  }
}

main().catch(console.error);
