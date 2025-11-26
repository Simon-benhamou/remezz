/**
 * STRATEGY OPTIMIZER V2
 * 
 * - Utilise les données locales (plus rapide)
 * - Supporte LONG et SHORT
 * - Analyse approfondie de la stratégie
 */

import fs from 'fs';

// ═══════════════════════════════════════════════════════════════════════════
// LOAD LOCAL DATA
// ═══════════════════════════════════════════════════════════════════════════

function loadData(symbol) {
  const filename = `./data/${symbol.replace('/', '_')}_1h.json`;
  if (!fs.existsSync(filename)) {
    throw new Error(`Data file not found: ${filename}. Run fetch-and-save-data.mjs first.`);
  }
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  ENTRY_FEE: 0.0004,  // 0.04%
  EXIT_FEE: 0.0004,
  SLIPPAGE: 0.0002,   // 0.02%
  
  LEVERAGE: { BTC: 3, ETH: 5, SOL: 5, XRP: 4 },
};

// ═══════════════════════════════════════════════════════════════════════════
// INDICATORS
// ═══════════════════════════════════════════════════════════════════════════

function calculateATR(candles, period = 14) {
  const atrs = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      atrs.push(candles[i].high - candles[i].low);
      continue;
    }
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

function calculateEMA(prices, period) {
  const emas = [];
  const mult = 2 / (period + 1);
  for (let i = 0; i < prices.length; i++) {
    if (i === 0) emas.push(prices[i]);
    else emas.push((prices[i] - emas[i-1]) * mult + emas[i-1]);
  }
  return emas;
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

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGIES (LONG + SHORT)
// ═══════════════════════════════════════════════════════════════════════════

const STRATEGIES = {
  // V1: Breakout Momentum (LONG ONLY - baseline)
  BREAKOUT_LONG_ONLY: {
    name: 'Breakout Momentum (LONG only)',
    
    shouldEnter: (i, data) => {
      if (i < 30) return null;
      
      const close = data.candles[i].close;
      
      // Range des 20 dernières bougies
      let highest = 0, lowest = Infinity;
      for (let j = i - 20; j < i; j++) {
        if (data.candles[j].high > highest) highest = data.candles[j].high;
        if (data.candles[j].low < lowest) lowest = data.candles[j].low;
      }
      
      const range = highest - lowest;
      const breakoutUp = highest + range * 0.02;
      
      const roc5 = data.roc5[i];
      const vol = data.candles[i].volume;
      const volAvg = data.volSMA20[i];
      
      // LONG: Breakout UP + momentum positif + volume
      if (close > breakoutUp && roc5 > 0.015 && vol > volAvg * 1.3) {
        return 'long';
      }
      
      return null;
    },
    
    shouldExit: (i, data, position) => {
      const roc5 = data.roc5[i];
      const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
      if (position.side === 'short') {
        // Inverse PnL for short
        const shortPnl = (position.entryPrice - data.candles[i].close) / position.entryPrice;
        return exitLogic(i, data, position, shortPnl, -roc5);
      }
      return exitLogic(i, data, position, pnl, roc5);
    },
  },
  
  // V2: Breakout Momentum (LONG + SHORT)
  BREAKOUT_BOTH: {
    name: 'Breakout Momentum (LONG + SHORT)',
    
    shouldEnter: (i, data) => {
      if (i < 30) return null;
      
      const close = data.candles[i].close;
      
      // Range des 20 dernières bougies
      let highest = 0, lowest = Infinity;
      for (let j = i - 20; j < i; j++) {
        if (data.candles[j].high > highest) highest = data.candles[j].high;
        if (data.candles[j].low < lowest) lowest = data.candles[j].low;
      }
      
      const range = highest - lowest;
      const breakoutUp = highest + range * 0.02;
      const breakoutDown = lowest - range * 0.02;
      
      const roc5 = data.roc5[i];
      const vol = data.candles[i].volume;
      const volAvg = data.volSMA20[i];
      
      // LONG: Breakout UP + momentum positif + volume
      if (close > breakoutUp && roc5 > 0.015 && vol > volAvg * 1.3) {
        return 'long';
      }
      
      // SHORT: Breakout DOWN + momentum négatif + volume
      if (close < breakoutDown && roc5 < -0.015 && vol > volAvg * 1.3) {
        return 'short';
      }
      
      return null;
    },
    
    shouldExit: (i, data, position) => {
      const roc5 = data.roc5[i];
      
      if (position.side === 'long') {
        const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
        return exitLogicLong(i, data, position, pnl, roc5);
      } else {
        // SHORT
        const pnl = (position.entryPrice - data.candles[i].close) / position.entryPrice;
        return exitLogicShort(i, data, position, pnl, roc5);
      }
    },
  },
  
  // V3: RSI Reversal (LONG + SHORT)
  RSI_REVERSAL: {
    name: 'RSI Reversal (LONG + SHORT)',
    
    shouldEnter: (i, data) => {
      if (i < 30) return null;
      
      const rsi = data.rsi[i];
      const rsi_prev = data.rsi[i-1];
      const roc5 = data.roc5[i];
      
      // LONG: RSI oversold et remonte
      if (rsi < 35 && rsi > rsi_prev && roc5 > 0) {
        return 'long';
      }
      
      // SHORT: RSI overbought et redescend
      if (rsi > 65 && rsi < rsi_prev && roc5 < 0) {
        return 'short';
      }
      
      return null;
    },
    
    shouldExit: (i, data, position) => {
      const rsi = data.rsi[i];
      const roc5 = data.roc5[i];
      
      if (position.side === 'long') {
        const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
        
        // Exit LONG quand RSI overbought
        if (rsi > 70 && pnl > 0.01) {
          return { reason: 'rsi_overbought_profit' };
        }
        return exitLogicLong(i, data, position, pnl, roc5);
      } else {
        // SHORT
        const pnl = (position.entryPrice - data.candles[i].close) / position.entryPrice;
        
        // Exit SHORT quand RSI oversold
        if (rsi < 30 && pnl > 0.01) {
          return { reason: 'rsi_oversold_profit' };
        }
        return exitLogicShort(i, data, position, pnl, roc5);
      }
    },
  },
  
  // V4: Trend Following with Mean Reversion Exit
  TREND_MEAN_REVERT: {
    name: 'Trend + Mean Reversion Exit',
    
    shouldEnter: (i, data) => {
      if (i < 50) return null;
      
      const close = data.candles[i].close;
      const ema20 = data.ema20[i];
      const ema50 = data.ema50[i];
      const roc10 = data.roc10[i];
      const vol = data.candles[i].volume;
      const volAvg = data.volSMA20[i];
      
      // LONG: Prix au-dessus des EMAs, EMA20 > EMA50, momentum positif
      if (close > ema20 && ema20 > ema50 && roc10 > 0.02 && vol > volAvg) {
        return 'long';
      }
      
      // SHORT: Prix en-dessous des EMAs, EMA20 < EMA50, momentum négatif
      if (close < ema20 && ema20 < ema50 && roc10 < -0.02 && vol > volAvg) {
        return 'short';
      }
      
      return null;
    },
    
    shouldExit: (i, data, position) => {
      const close = data.candles[i].close;
      const ema20 = data.ema20[i];
      const roc5 = data.roc5[i];
      
      if (position.side === 'long') {
        const pnl = (close - position.entryPrice) / position.entryPrice;
        
        // Mean reversion: sortir quand le prix revient vers EMA
        if (pnl > 0.02 && close < ema20) {
          return { reason: 'mean_reversion_ema' };
        }
        return exitLogicLong(i, data, position, pnl, roc5);
      } else {
        const pnl = (position.entryPrice - close) / position.entryPrice;
        
        if (pnl > 0.02 && close > ema20) {
          return { reason: 'mean_reversion_ema' };
        }
        return exitLogicShort(i, data, position, pnl, roc5);
      }
    },
  },
};

// Exit logic communes
function exitLogicLong(i, data, position, pnl, roc5) {
  // Momentum fade profit
  if (pnl > 0.02 && roc5 < 0.005) {
    return { reason: 'momentum_fade_profit' };
  }
  
  // False breakout / stop loss
  if (pnl < -0.02) {
    return { reason: 'stop_loss' };
  }
  
  // ATR trailing
  const atr = data.atr[i];
  const high = Math.max(position.highWaterMark || position.entryPrice, data.candles[i].high);
  position.highWaterMark = high;
  if (data.candles[i].close < high - atr * 2) {
    return { reason: 'atr_trailing' };
  }
  
  return null;
}

function exitLogicShort(i, data, position, pnl, roc5) {
  // Momentum fade profit (inverse)
  if (pnl > 0.02 && roc5 > -0.005) {
    return { reason: 'momentum_fade_profit' };
  }
  
  // False breakout / stop loss
  if (pnl < -0.02) {
    return { reason: 'stop_loss' };
  }
  
  // ATR trailing (inverse)
  const atr = data.atr[i];
  const low = Math.min(position.lowWaterMark || position.entryPrice, data.candles[i].low);
  position.lowWaterMark = low;
  if (data.candles[i].close > low + atr * 2) {
    return { reason: 'atr_trailing' };
  }
  
  return null;
}

// Legacy
function exitLogic(i, data, position, pnl, roc5) {
  return exitLogicLong(i, data, position, pnl, roc5);
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE
// ═══════════════════════════════════════════════════════════════════════════

function runBacktest(symbol, strategy, candles) {
  const leverage = CONFIG.LEVERAGE[symbol.replace('/USDT', '')] || 3;
  
  // Prepare indicators
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  
  const data = {
    candles,
    atr: calculateATR(candles, 14),
    roc5: calculateROC(closes, 5),
    roc10: calculateROC(closes, 10),
    volSMA20: calculateVolSMA(volumes, 20),
    ema20: calculateEMA(closes, 20),
    ema50: calculateEMA(closes, 50),
    rsi: calculateRSI(candles, 14),
  };
  
  const trades = [];
  let position = null;
  let capital = 100;
  let peakCapital = 100;
  let maxDrawdown = 0;
  
  for (let i = 50; i < candles.length; i++) {
    if (!position) {
      const signal = strategy.shouldEnter(i, data);
      if (signal) {
        const slipDir = signal === 'long' ? 1 : -1;
        const entryPrice = candles[i].close * (1 + CONFIG.SLIPPAGE * slipDir);
        capital -= capital * CONFIG.ENTRY_FEE;
        
        position = {
          side: signal,
          entryPrice,
          entryIdx: i,
          entryTime: new Date(candles[i].timestamp),
          capitalAtEntry: capital,
          highWaterMark: entryPrice,
          lowWaterMark: entryPrice,
        };
      }
    } else {
      // Update watermarks
      position.highWaterMark = Math.max(position.highWaterMark, candles[i].high);
      position.lowWaterMark = Math.min(position.lowWaterMark, candles[i].low);
      
      const exitSignal = strategy.shouldExit(i, data, position);
      if (exitSignal) {
        const slipDir = position.side === 'long' ? -1 : 1;
        const exitPrice = candles[i].close * (1 + CONFIG.SLIPPAGE * slipDir);
        
        let pnlPercent;
        if (position.side === 'long') {
          pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice;
        } else {
          pnlPercent = (position.entryPrice - exitPrice) / position.entryPrice;
        }
        
        const pnlWithLeverage = pnlPercent * leverage;
        capital = position.capitalAtEntry * (1 + pnlWithLeverage);
        capital -= capital * CONFIG.EXIT_FEE;
        
        trades.push({
          symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice,
          entryTime: position.entryTime,
          exitTime: new Date(candles[i].timestamp),
          holdingHours: i - position.entryIdx,
          pnlPercent: pnlPercent * 100,
          pnlWithLeverage: pnlWithLeverage * 100,
          exitReason: exitSignal.reason,
          month: position.entryTime.toISOString().slice(0, 7),
        });
        
        position = null;
      }
    }
    
    // Track drawdown
    const currentEquity = position 
      ? position.capitalAtEntry * (1 + calculatePositionPnL(position, candles[i]) * leverage)
      : capital;
    
    if (currentEquity > peakCapital) peakCapital = currentEquity;
    const dd = (peakCapital - currentEquity) / peakCapital * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  
  // Close open position
  if (position) {
    const exitPrice = candles[candles.length - 1].close;
    let pnlPercent;
    if (position.side === 'long') {
      pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice;
    } else {
      pnlPercent = (position.entryPrice - exitPrice) / position.entryPrice;
    }
    const pnlWithLeverage = pnlPercent * leverage;
    capital = position.capitalAtEntry * (1 + pnlWithLeverage);
    trades.push({
      symbol,
      side: position.side,
      pnlPercent: pnlPercent * 100,
      pnlWithLeverage: pnlWithLeverage * 100,
      exitReason: 'end_of_data',
      month: position.entryTime?.toISOString().slice(0, 7),
    });
  }
  
  return { trades, finalCapital: capital, maxDrawdown };
}

function calculatePositionPnL(position, candle) {
  if (position.side === 'long') {
    return (candle.close - position.entryPrice) / position.entryPrice;
  } else {
    return (position.entryPrice - candle.close) / position.entryPrice;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 STRATEGY OPTIMIZER V2 - LONG + SHORT ANALYSIS');
  console.log('═'.repeat(80));
  console.log('\n📂 Loading local data...\n');
  
  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'];
  const allCandles = {};
  
  for (const symbol of symbols) {
    allCandles[symbol] = loadData(symbol);
    console.log(`   ${symbol}: ${allCandles[symbol].length} candles loaded`);
  }
  
  const allResults = {};
  
  for (const [stratKey, strategy] of Object.entries(STRATEGIES)) {
    console.log('\n' + '═'.repeat(80));
    console.log(`🔬 ${strategy.name}`);
    console.log('═'.repeat(80));
    
    const symbolResults = {};
    let allTrades = [];
    
    for (const symbol of symbols) {
      const { trades, finalCapital, maxDrawdown } = runBacktest(symbol, strategy, allCandles[symbol]);
      symbolResults[symbol] = { trades, finalCapital, maxDrawdown };
      allTrades = allTrades.concat(trades);
    }
    
    // Stats globales
    const longTrades = allTrades.filter(t => t.side === 'long');
    const shortTrades = allTrades.filter(t => t.side === 'short');
    
    console.log(`\n📊 Distribution LONG/SHORT:`);
    console.log(`   LONG:  ${longTrades.length} trades`);
    console.log(`   SHORT: ${shortTrades.length} trades`);
    
    // Performance par direction
    console.log('\n┌──────────┬────────┬──────────┬───────────┬──────────┐');
    console.log('│ Direction│ Trades │ Win Rate │  Avg P&L  │ Total PnL│');
    console.log('├──────────┼────────┼──────────┼───────────┼──────────┤');
    
    if (longTrades.length > 0) {
      const longWins = longTrades.filter(t => t.pnlWithLeverage > 0).length;
      const longWR = longWins / longTrades.length * 100;
      const longAvg = longTrades.reduce((s, t) => s + t.pnlWithLeverage, 0) / longTrades.length;
      const longTotal = longTrades.reduce((s, t) => s + t.pnlWithLeverage, 0);
      console.log(`│ LONG     │ ${String(longTrades.length).padStart(6)} │ ${longWR.toFixed(1).padStart(7)}% │ ${longAvg >= 0 ? '+' : ''}${longAvg.toFixed(2).padStart(8)}% │ ${longTotal >= 0 ? '+' : ''}${longTotal.toFixed(0).padStart(7)}% │`);
    }
    
    if (shortTrades.length > 0) {
      const shortWins = shortTrades.filter(t => t.pnlWithLeverage > 0).length;
      const shortWR = shortWins / shortTrades.length * 100;
      const shortAvg = shortTrades.reduce((s, t) => s + t.pnlWithLeverage, 0) / shortTrades.length;
      const shortTotal = shortTrades.reduce((s, t) => s + t.pnlWithLeverage, 0);
      console.log(`│ SHORT    │ ${String(shortTrades.length).padStart(6)} │ ${shortWR.toFixed(1).padStart(7)}% │ ${shortAvg >= 0 ? '+' : ''}${shortAvg.toFixed(2).padStart(8)}% │ ${shortTotal >= 0 ? '+' : ''}${shortTotal.toFixed(0).padStart(7)}% │`);
    }
    
    console.log('└──────────┴────────┴──────────┴───────────┴──────────┘');
    
    // Performance par asset
    console.log('\n┌──────────┬────────┬──────────┬───────────┬──────────┐');
    console.log('│ Symbol   │ Trades │ Win Rate │   ROI     │  Max DD  │');
    console.log('├──────────┼────────┼──────────┼───────────┼──────────┤');
    
    let totalROI = 0;
    for (const symbol of symbols) {
      const r = symbolResults[symbol];
      const roi = r.finalCapital - 100;
      totalROI += roi;
      const trades = r.trades;
      const wins = trades.filter(t => t.pnlWithLeverage > 0).length;
      const wr = trades.length > 0 ? wins / trades.length * 100 : 0;
      console.log(`│ ${symbol.padEnd(8)} │ ${String(trades.length).padStart(6)} │ ${wr.toFixed(1).padStart(7)}% │ ${roi >= 0 ? '+' : ''}${roi.toFixed(0).padStart(8)}% │ ${r.maxDrawdown.toFixed(0).padStart(7)}% │`);
    }
    
    console.log('├──────────┼────────┼──────────┼───────────┼──────────┤');
    const totalWins = allTrades.filter(t => t.pnlWithLeverage > 0).length;
    const totalWR = allTrades.length > 0 ? totalWins / allTrades.length * 100 : 0;
    console.log(`│ TOTAL    │ ${String(allTrades.length).padStart(6)} │ ${totalWR.toFixed(1).padStart(7)}% │ ${totalROI >= 0 ? '+' : ''}${totalROI.toFixed(0).padStart(8)}% │         │`);
    console.log('└──────────┴────────┴──────────┴───────────┴──────────┘');
    
    // Exit reasons
    const exitStats = {};
    allTrades.forEach(t => {
      const key = `${t.side}_${t.exitReason}`;
      if (!exitStats[key]) exitStats[key] = { count: 0, pnl: 0, wins: 0 };
      exitStats[key].count++;
      exitStats[key].pnl += t.pnlWithLeverage || 0;
      if ((t.pnlWithLeverage || 0) > 0) exitStats[key].wins++;
    });
    
    console.log('\n📊 Exit Reasons par direction:');
    for (const [key, stats] of Object.entries(exitStats).sort((a, b) => b[1].pnl - a[1].pnl)) {
      const avgPnl = stats.pnl / stats.count;
      const wr = stats.wins / stats.count * 100;
      const marker = avgPnl > 0 ? '✅' : '❌';
      console.log(`   ${marker} ${key}: ${stats.count} trades, WR: ${wr.toFixed(0)}%, Avg: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%`);
    }
    
    allResults[stratKey] = {
      name: strategy.name,
      totalTrades: allTrades.length,
      longTrades: longTrades.length,
      shortTrades: shortTrades.length,
      winRate: totalWR,
      totalROI,
    };
  }
  
  // Summary
  console.log('\n' + '═'.repeat(80));
  console.log('🏆 FINAL RANKING');
  console.log('═'.repeat(80));
  
  console.log('\n┌───────────────────────────────────┬────────┬────────┬──────────┬───────────┐');
  console.log('│ Strategy                          │ L/S    │ Trades │ Win Rate │ Total ROI │');
  console.log('├───────────────────────────────────┼────────┼────────┼──────────┼───────────┤');
  
  const sorted = Object.values(allResults).sort((a, b) => b.totalROI - a.totalROI);
  for (const r of sorted) {
    const ls = `${r.longTrades}/${r.shortTrades}`;
    console.log(`│ ${r.name.padEnd(33)} │ ${ls.padStart(6)} │ ${String(r.totalTrades).padStart(6)} │ ${r.winRate.toFixed(1).padStart(7)}% │ ${r.totalROI >= 0 ? '+' : ''}${r.totalROI.toFixed(0).padStart(8)}% │`);
  }
  console.log('└───────────────────────────────────┴────────┴────────┴──────────┴───────────┘');
  
  // Conclusion
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 💡 CONCLUSIONS                                                                ║
╠═══════════════════════════════════════════════════════════════════════════════╣
`);

  const bestLongShort = sorted.find(s => s.shortTrades > 0);
  const bestLongOnly = sorted.find(s => s.shortTrades === 0);
  
  if (bestLongShort && bestLongOnly) {
    console.log(`║ Meilleure LONG+SHORT: ${bestLongShort.name.padEnd(25)} ${bestLongShort.totalROI >= 0 ? '+' : ''}${bestLongShort.totalROI.toFixed(0)}% ROI  ║`);
    console.log(`║ Meilleure LONG only:  ${bestLongOnly.name.padEnd(25)} ${bestLongOnly.totalROI >= 0 ? '+' : ''}${bestLongOnly.totalROI.toFixed(0)}% ROI  ║`);
  }
  
  const withShort = sorted.filter(s => s.shortTrades > 0);
  const shortHelps = withShort.length > 0 && withShort[0].totalROI > (bestLongOnly?.totalROI || 0);
  
  console.log(`║                                                                               ║`);
  if (shortHelps) {
    console.log(`║ ✅ Les SHORT AMÉLIORENT la performance!                                       ║`);
  } else {
    console.log(`║ ❌ Les SHORT N'AMÉLIORENT PAS la performance (ou la dégradent)               ║`);
  }
  console.log(`╚═══════════════════════════════════════════════════════════════════════════════╝
`);
}

main().catch(console.error);
