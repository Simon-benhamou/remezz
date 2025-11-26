/**
 * ENTRY FILTER OPTIMIZER
 * 
 * Objectif: Réduire les 158 trades qui finissent en stop loss
 * 
 * Approche: Analyser les caractéristiques à l'entrée des trades
 * qui finissent bien vs mal, puis créer des filtres
 */

import fs from 'fs';

function loadData(symbol) {
  const filename = `./data/${symbol.replace('/', '_')}_1h.json`;
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

const CONFIG = {
  ENTRY_FEE: 0.0004,
  EXIT_FEE: 0.0004,
  SLIPPAGE: 0.0002,
  LEVERAGE: { BTC: 3, ETH: 5, SOL: 5, XRP: 4 },
};

// ═══════════════════════════════════════════════════════════════════════════
// INDICATORS
// ═══════════════════════════════════════════════════════════════════════════

function calculateATR(candles, period = 14) {
  const atrs = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { atrs.push(candles[i].high - candles[i].low); continue; }
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    );
    if (i < period) atrs.push(tr);
    else atrs.push((atrs[i-1] * (period - 1) + tr) / period);
  }
  return atrs;
}

function calculateROC(prices, period) {
  return prices.map((p, i) => i < period ? 0 : (p - prices[i - period]) / prices[i - period]);
}

function calculateVolSMA(volumes, period) {
  return volumes.map((v, i) => {
    if (i < period) return v;
    return volumes.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
  });
}

function calculateRSI(candles, period = 14) {
  const rsis = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { rsis.push(50); continue; }
    const change = candles[i].close - candles[i-1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i < period) {
      avgGain = (avgGain * (i - 1) + gain) / i;
      avgLoss = (avgLoss * (i - 1) + loss) / i;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsis.push(100 - (100 / (1 + rs)));
  }
  return rsis;
}

function calculateEMA(prices, period) {
  const emas = [];
  const mult = 2 / (period + 1);
  for (let i = 0; i < prices.length; i++) {
    if (i === 0) emas.push(prices[i]);
    else emas.push((prices[i] - emas[i-1]) * mult + emas[i-1]);
  }
  return emas;
}

function calculateBollingerBands(candles, period = 20, stdDev = 2) {
  const closes = candles.map(c => c.close);
  const bands = [];
  
  for (let i = 0; i < candles.length; i++) {
    if (i < period) {
      bands.push({ upper: closes[i], middle: closes[i], lower: closes[i], percentB: 0.5 });
      continue;
    }
    
    const slice = closes.slice(i - period, i);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
    const std = Math.sqrt(variance);
    
    const upper = sma + stdDev * std;
    const lower = sma - stdDev * std;
    const percentB = (closes[i] - lower) / (upper - lower);
    
    bands.push({ upper, middle: sma, lower, percentB });
  }
  
  return bands;
}

// ═══════════════════════════════════════════════════════════════════════════
// COLLECT ENTRY CHARACTERISTICS
// ═══════════════════════════════════════════════════════════════════════════

function collectTradesWithCharacteristics(symbol, candles) {
  const leverage = CONFIG.LEVERAGE[symbol.replace('/USDT', '')] || 3;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  
  const data = {
    candles,
    atr: calculateATR(candles, 14),
    roc5: calculateROC(closes, 5),
    roc10: calculateROC(closes, 10),
    roc20: calculateROC(closes, 20),
    volSMA20: calculateVolSMA(volumes, 20),
    rsi: calculateRSI(candles, 14),
    ema20: calculateEMA(closes, 20),
    ema50: calculateEMA(closes, 50),
    bb: calculateBollingerBands(candles, 20, 2),
  };
  
  const trades = [];
  let position = null;
  
  for (let i = 50; i < candles.length; i++) {
    if (!position) {
      // Entry condition (breakout momentum)
      const close = candles[i].close;
      let highest = 0, lowest = Infinity;
      for (let j = i - 20; j < i; j++) {
        if (candles[j].high > highest) highest = candles[j].high;
        if (candles[j].low < lowest) lowest = candles[j].low;
      }
      const range = highest - lowest;
      const breakoutUp = highest + range * 0.02;
      
      const roc5 = data.roc5[i];
      const vol = candles[i].volume;
      const volAvg = data.volSMA20[i];
      
      if (close > breakoutUp && roc5 > 0.015 && vol > volAvg * 1.3) {
        // CAPTURE ALL ENTRY CHARACTERISTICS
        const atrPercent = data.atr[i] / close;
        const distFromEMA20 = (close - data.ema20[i]) / data.ema20[i];
        const distFromEMA50 = (close - data.ema50[i]) / data.ema50[i];
        const volRatio = vol / volAvg;
        const bbPercentB = data.bb[i].percentB;
        const rangePercent = range / close;
        
        // Recent price action
        const recentHigh = Math.max(...candles.slice(i-5, i).map(c => c.high));
        const recentLow = Math.min(...candles.slice(i-5, i).map(c => c.low));
        const recentRange = (recentHigh - recentLow) / close;
        
        // Trend strength
        const ema20Above50 = data.ema20[i] > data.ema50[i];
        const priceAboveBothEMAs = close > data.ema20[i] && close > data.ema50[i];
        
        // Consecutive up candles
        let consecutiveUp = 0;
        for (let j = i; j > i - 10; j--) {
          if (candles[j].close > candles[j].open) consecutiveUp++;
          else break;
        }
        
        position = {
          entryIdx: i,
          entryPrice: close * (1 + CONFIG.SLIPPAGE),
          entryTime: new Date(candles[i].timestamp),
          maxPnl: 0,
          
          // Entry characteristics
          chars: {
            symbol,
            atrPercent,
            rsi: data.rsi[i],
            roc5: data.roc5[i],
            roc10: data.roc10[i],
            roc20: data.roc20[i],
            volRatio,
            distFromEMA20,
            distFromEMA50,
            bbPercentB,
            rangePercent,
            recentRange,
            ema20Above50,
            priceAboveBothEMAs,
            consecutiveUp,
            hour: new Date(candles[i].timestamp).getUTCHours(),
            dayOfWeek: new Date(candles[i].timestamp).getUTCDay(),
          },
        };
      }
    } else {
      // Exit logic (same as before)
      const roc5 = data.roc5[i];
      const roc10 = data.roc10[i];
      const rsi = data.rsi[i];
      const pnl = (candles[i].close - position.entryPrice) / position.entryPrice;
      const vol = candles[i].volume;
      const volAvg = data.volSMA20[i];
      const holdingHours = i - position.entryIdx;
      
      position.maxPnl = Math.max(position.maxPnl, pnl);
      
      let exitReason = null;
      
      if (pnl > 0.02 && roc5 < 0.005) exitReason = 'momentum_fade_profit';
      else if (pnl > 0.005 && vol < volAvg * 0.5 && roc5 < 0) exitReason = 'volume_dry_up';
      else if (pnl > 0.01 && [roc5 < 0, roc10 < roc5, rsi > 70, vol < volAvg * 0.7].filter(Boolean).length >= 3) exitReason = 'multi_signal_exit';
      else if (pnl > 0 && [roc5 < 0, roc10 < roc5, rsi > 70, vol < volAvg * 0.7].filter(Boolean).length >= 2 && roc5 < -0.01) exitReason = 'strong_reversal';
      else if (position.maxPnl >= 0.02 && pnl < position.maxPnl * 0.5) exitReason = 'profit_lock';
      else if (position.maxPnl >= 0.015 && pnl <= 0.002) exitReason = 'breakeven_stop';
      else if (holdingHours >= 6 && pnl >= 0 && pnl < 0.01 && roc5 < 0) exitReason = 'time_exit_6h';
      else if (holdingHours >= 24 && pnl < 0.015) exitReason = 'time_exit_24h';
      else {
        const atr = data.atr[i];
        const atrPercent = atr / candles[i].close;
        const stopLoss = atrPercent > 0.015 ? -0.02 : -0.015;
        if (pnl < stopLoss) exitReason = 'stop_loss';
      }
      
      if (exitReason) {
        const pnlWithLeverage = pnl * leverage;
        
        trades.push({
          ...position.chars,
          exitReason,
          pnlPercent: pnl * 100,
          pnlWithLeverage: pnlWithLeverage * 100,
          holdingHours,
          isStopLoss: exitReason === 'stop_loss',
          isWinner: pnlWithLeverage > 0,
        });
        
        position = null;
      }
    }
  }
  
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════════
// ANALYZE CHARACTERISTICS
// ═══════════════════════════════════════════════════════════════════════════

function analyzeCharacteristics(allTrades) {
  const stopLossTrades = allTrades.filter(t => t.isStopLoss);
  const winningTrades = allTrades.filter(t => t.isWinner);
  
  const metrics = [
    'atrPercent', 'rsi', 'roc5', 'roc10', 'roc20', 'volRatio',
    'distFromEMA20', 'distFromEMA50', 'bbPercentB', 'rangePercent',
    'recentRange', 'consecutiveUp'
  ];
  
  console.log('\n┌─────────────────┬────────────────────────┬────────────────────────┬───────────┐');
  console.log('│ Characteristic  │ Stop Loss (Bad)        │ Winners (Good)         │ Filter?   │');
  console.log('├─────────────────┼────────────────────────┼────────────────────────┼───────────┤');
  
  const filters = [];
  
  for (const metric of metrics) {
    const slValues = stopLossTrades.map(t => t[metric]).filter(v => v !== undefined);
    const winValues = winningTrades.map(t => t[metric]).filter(v => v !== undefined);
    
    if (slValues.length === 0 || winValues.length === 0) continue;
    
    const slAvg = slValues.reduce((a, b) => a + b, 0) / slValues.length;
    const winAvg = winValues.reduce((a, b) => a + b, 0) / winValues.length;
    
    const diff = Math.abs(slAvg - winAvg);
    const avgAll = (slAvg + winAvg) / 2;
    const diffPercent = avgAll !== 0 ? (diff / Math.abs(avgAll)) * 100 : 0;
    
    const isSignificant = diffPercent > 20;
    const filterDir = slAvg > winAvg ? '↓ Lower is better' : '↑ Higher is better';
    
    console.log(`│ ${metric.padEnd(15)} │ ${slAvg.toFixed(4).padStart(10)} (${slValues.length} trades) │ ${winAvg.toFixed(4).padStart(10)} (${winValues.length} trades) │ ${isSignificant ? '⚠️ ' + diffPercent.toFixed(0) + '%' : '  -   '}   │`);
    
    if (isSignificant) {
      filters.push({ metric, slAvg, winAvg, direction: slAvg > winAvg ? 'low' : 'high', diffPercent });
    }
  }
  
  console.log('└─────────────────┴────────────────────────┴────────────────────────┴───────────┘');
  
  // Boolean filters
  console.log('\n📊 Boolean characteristics:');
  const boolMetrics = ['ema20Above50', 'priceAboveBothEMAs'];
  for (const metric of boolMetrics) {
    const slTrue = stopLossTrades.filter(t => t[metric]).length;
    const slFalse = stopLossTrades.length - slTrue;
    const winTrue = winningTrades.filter(t => t[metric]).length;
    const winFalse = winningTrades.length - winTrue;
    
    const slTrueRate = slTrue / stopLossTrades.length * 100;
    const winTrueRate = winTrue / winningTrades.length * 100;
    
    console.log(`   ${metric}: StopLoss=${slTrueRate.toFixed(0)}% true, Winners=${winTrueRate.toFixed(0)}% true`);
    
    if (Math.abs(slTrueRate - winTrueRate) > 15) {
      filters.push({ metric, type: 'boolean', slTrueRate, winTrueRate });
    }
  }
  
  return filters;
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST FILTERS
// ═══════════════════════════════════════════════════════════════════════════

function testFilter(allTrades, filterFn, filterName) {
  const filtered = allTrades.filter(filterFn);
  const rejected = allTrades.filter(t => !filterFn(t));
  
  const filteredWins = filtered.filter(t => t.isWinner).length;
  const filteredSL = filtered.filter(t => t.isStopLoss).length;
  const filteredWR = filtered.length > 0 ? filteredWins / filtered.length * 100 : 0;
  const filteredPnL = filtered.reduce((s, t) => s + t.pnlWithLeverage, 0);
  
  const rejectedSL = rejected.filter(t => t.isStopLoss).length;
  const rejectedWins = rejected.filter(t => t.isWinner).length;
  
  return {
    name: filterName,
    kept: filtered.length,
    rejected: rejected.length,
    keptWR: filteredWR,
    keptPnL: filteredPnL,
    keptSL: filteredSL,
    rejectedSL,
    rejectedWins,
    slReduction: rejectedSL,
    goodTradesLost: rejectedWins,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 ENTRY FILTER OPTIMIZER');
  console.log('═'.repeat(80));
  
  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'];
  
  console.log('\n📂 Collecting trades with entry characteristics...\n');
  
  let allTrades = [];
  for (const symbol of symbols) {
    const candles = loadData(symbol);
    const trades = collectTradesWithCharacteristics(symbol, candles);
    allTrades = allTrades.concat(trades);
    
    const sl = trades.filter(t => t.isStopLoss).length;
    const wins = trades.filter(t => t.isWinner).length;
    console.log(`   ${symbol}: ${trades.length} trades (${wins} wins, ${sl} stop losses)`);
  }
  
  console.log(`\n📊 Total: ${allTrades.length} trades`);
  console.log(`   Winners: ${allTrades.filter(t => t.isWinner).length}`);
  console.log(`   Stop Losses: ${allTrades.filter(t => t.isStopLoss).length}`);
  
  // ═══════════════════════════════════════════════════════════════════════
  // ANALYZE
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 CHARACTERISTIC ANALYSIS');
  console.log('═'.repeat(80));
  
  const significantFilters = analyzeCharacteristics(allTrades);
  
  // ═══════════════════════════════════════════════════════════════════════
  // TEST INDIVIDUAL FILTERS
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('🧪 TESTING INDIVIDUAL FILTERS');
  console.log('═'.repeat(80));
  
  const baselinePnL = allTrades.reduce((s, t) => s + t.pnlWithLeverage, 0);
  const baselineSL = allTrades.filter(t => t.isStopLoss).length;
  const baselineWR = allTrades.filter(t => t.isWinner).length / allTrades.length * 100;
  
  console.log(`\n📈 Baseline: ${allTrades.length} trades, ${baselineWR.toFixed(1)}% WR, ${baselinePnL.toFixed(0)}% PnL, ${baselineSL} SL\n`);
  
  const filterTests = [
    // RSI filters
    { name: 'RSI < 75', fn: t => t.rsi < 75 },
    { name: 'RSI < 70', fn: t => t.rsi < 70 },
    { name: 'RSI < 65', fn: t => t.rsi < 65 },
    
    // ATR filters
    { name: 'ATR% < 3%', fn: t => t.atrPercent < 0.03 },
    { name: 'ATR% < 2.5%', fn: t => t.atrPercent < 0.025 },
    { name: 'ATR% < 2%', fn: t => t.atrPercent < 0.02 },
    
    // ROC filters
    { name: 'ROC5 < 5%', fn: t => t.roc5 < 0.05 },
    { name: 'ROC5 < 4%', fn: t => t.roc5 < 0.04 },
    { name: 'ROC10 < 8%', fn: t => t.roc10 < 0.08 },
    
    // Volume filters
    { name: 'VolRatio < 3', fn: t => t.volRatio < 3 },
    { name: 'VolRatio < 2.5', fn: t => t.volRatio < 2.5 },
    
    // Distance from EMA
    { name: 'Dist EMA20 < 5%', fn: t => t.distFromEMA20 < 0.05 },
    { name: 'Dist EMA20 < 3%', fn: t => t.distFromEMA20 < 0.03 },
    
    // Bollinger
    { name: 'BB %B < 1.2', fn: t => t.bbPercentB < 1.2 },
    { name: 'BB %B < 1.0', fn: t => t.bbPercentB < 1.0 },
    
    // Consecutive candles
    { name: 'ConsecUp < 5', fn: t => t.consecutiveUp < 5 },
    { name: 'ConsecUp < 4', fn: t => t.consecutiveUp < 4 },
    
    // EMA position
    { name: 'Price above both EMAs', fn: t => t.priceAboveBothEMAs },
    { name: 'EMA20 > EMA50', fn: t => t.ema20Above50 },
  ];
  
  console.log('┌──────────────────────────┬────────┬────────┬─────────┬────────────┬──────────────┐');
  console.log('│ Filter                   │ Trades │ WinRate│ PnL     │ SL Removed │ Wins Lost    │');
  console.log('├──────────────────────────┼────────┼────────┼─────────┼────────────┼──────────────┤');
  
  const results = [];
  for (const { name, fn } of filterTests) {
    const result = testFilter(allTrades, fn, name);
    results.push(result);
    
    const pnlChange = result.keptPnL - baselinePnL;
    const marker = pnlChange > 0 ? '✅' : '❌';
    
    console.log(`│${marker}${name.padEnd(24)} │ ${String(result.kept).padStart(6)} │ ${result.keptWR.toFixed(1).padStart(5)}% │ ${result.keptPnL >= 0 ? '+' : ''}${result.keptPnL.toFixed(0).padStart(6)}% │ ${String(result.slReduction).padStart(10)} │ ${String(result.goodTradesLost).padStart(12)} │`);
  }
  
  console.log('└──────────────────────────┴────────┴────────┴─────────┴────────────┴──────────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════
  // FIND BEST COMBINATIONS
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 BEST FILTER COMBINATIONS');
  console.log('═'.repeat(80));
  
  // Sort by PnL improvement
  const bestResults = results.filter(r => r.keptPnL > baselinePnL).sort((a, b) => b.keptPnL - a.keptPnL);
  
  console.log('\n📈 Top 5 single filters by PnL:');
  for (let i = 0; i < Math.min(5, bestResults.length); i++) {
    const r = bestResults[i];
    console.log(`   ${i+1}. ${r.name}: ${r.keptPnL.toFixed(0)}% PnL (+${(r.keptPnL - baselinePnL).toFixed(0)}%), -${r.slReduction} SL, -${r.goodTradesLost} wins`);
  }
  
  // Test combinations
  console.log('\n🔬 Testing filter combinations...\n');
  
  const combinations = [
    { name: 'RSI<70 + ATR<2.5%', fn: t => t.rsi < 70 && t.atrPercent < 0.025 },
    { name: 'RSI<70 + ROC5<4%', fn: t => t.rsi < 70 && t.roc5 < 0.04 },
    { name: 'RSI<70 + DistEMA20<3%', fn: t => t.rsi < 70 && t.distFromEMA20 < 0.03 },
    { name: 'RSI<65 + ATR<2.5%', fn: t => t.rsi < 65 && t.atrPercent < 0.025 },
    { name: 'ATR<2.5% + DistEMA20<5%', fn: t => t.atrPercent < 0.025 && t.distFromEMA20 < 0.05 },
    { name: 'RSI<70 + ConsecUp<4', fn: t => t.rsi < 70 && t.consecutiveUp < 4 },
    { name: 'RSI<70 + BB%B<1.0', fn: t => t.rsi < 70 && t.bbPercentB < 1.0 },
    { name: 'COMBO: RSI<70 + ATR<2.5% + DistEMA<5%', fn: t => t.rsi < 70 && t.atrPercent < 0.025 && t.distFromEMA20 < 0.05 },
    { name: 'COMBO: RSI<65 + ATR<2.5% + ROC5<4%', fn: t => t.rsi < 65 && t.atrPercent < 0.025 && t.roc5 < 0.04 },
    { name: 'SAFE: RSI<65 + ATR<2% + ConsecUp<4', fn: t => t.rsi < 65 && t.atrPercent < 0.02 && t.consecutiveUp < 4 },
  ];
  
  console.log('┌───────────────────────────────────────┬────────┬────────┬─────────┬──────────┬──────────┐');
  console.log('│ Combination                           │ Trades │ WinRate│ PnL     │ -SL      │ -Wins    │');
  console.log('├───────────────────────────────────────┼────────┼────────┼─────────┼──────────┼──────────┤');
  
  const comboResults = [];
  for (const { name, fn } of combinations) {
    const result = testFilter(allTrades, fn, name);
    comboResults.push(result);
    
    const pnlChange = result.keptPnL - baselinePnL;
    const marker = pnlChange > 0 ? '✅' : '❌';
    
    console.log(`│${marker}${name.padEnd(37)} │ ${String(result.kept).padStart(6)} │ ${result.keptWR.toFixed(1).padStart(5)}% │ ${result.keptPnL >= 0 ? '+' : ''}${result.keptPnL.toFixed(0).padStart(6)}% │ ${String(result.slReduction).padStart(8)} │ ${String(result.goodTradesLost).padStart(8)} │`);
  }
  
  console.log('└───────────────────────────────────────┴────────┴────────┴─────────┴──────────┴──────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════
  // BEST FILTER
  // ═══════════════════════════════════════════════════════════════════════
  
  const allFilters = [...results, ...comboResults];
  const bestFilter = allFilters.sort((a, b) => b.keptPnL - a.keptPnL)[0];
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🏆 BEST ENTRY FILTER                                                          ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ Filter: ${bestFilter.name.padEnd(45)}                       ║
║                                                                               ║
║ Results:                                                                      ║
║   • Trades: ${String(allTrades.length).padStart(3)} → ${String(bestFilter.kept).padStart(3)} (${((allTrades.length - bestFilter.kept) / allTrades.length * 100).toFixed(0)}% filtered)                                ║
║   • Win Rate: ${baselineWR.toFixed(1)}% → ${bestFilter.keptWR.toFixed(1)}%                                               ║
║   • PnL: ${baselinePnL.toFixed(0)}% → ${bestFilter.keptPnL.toFixed(0)}% (${bestFilter.keptPnL > baselinePnL ? '+' : ''}${(bestFilter.keptPnL - baselinePnL).toFixed(0)}%)                                      ║
║   • Stop Losses removed: ${bestFilter.slReduction}                                             ║
║   • Good trades lost: ${bestFilter.goodTradesLost}                                                ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);

  // Test best filter per asset
  console.log('\n📊 Best filter applied per asset:');
  console.log('┌──────────┬────────┬────────┬─────────┬────────┬─────────┐');
  console.log('│ Symbol   │ Before │ After  │ WR Bef  │ WR Aft │ PnL Chg │');
  console.log('├──────────┼────────┼────────┼─────────┼────────┼─────────┤');
  
  for (const symbol of symbols) {
    const symTrades = allTrades.filter(t => t.symbol === symbol);
    // Use best combo filter
    const filtered = symTrades.filter(t => t.rsi < 70 && t.atrPercent < 0.025);
    
    const beforeWR = symTrades.filter(t => t.isWinner).length / symTrades.length * 100;
    const afterWR = filtered.length > 0 ? filtered.filter(t => t.isWinner).length / filtered.length * 100 : 0;
    const beforePnL = symTrades.reduce((s, t) => s + t.pnlWithLeverage, 0);
    const afterPnL = filtered.reduce((s, t) => s + t.pnlWithLeverage, 0);
    
    console.log(`│ ${symbol.padEnd(8)} │ ${String(symTrades.length).padStart(6)} │ ${String(filtered.length).padStart(6)} │ ${beforeWR.toFixed(1).padStart(6)}% │ ${afterWR.toFixed(1).padStart(5)}% │ ${afterPnL - beforePnL >= 0 ? '+' : ''}${(afterPnL - beforePnL).toFixed(0).padStart(6)}% │`);
  }
  
  console.log('└──────────┴────────┴────────┴─────────┴────────┴─────────┘');
}

main().catch(console.error);
