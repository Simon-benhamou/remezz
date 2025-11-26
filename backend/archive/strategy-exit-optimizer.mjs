/**
 * EXIT OPTIMIZER
 * 
 * Le constat:
 * - momentum_fade_profit: 88 trades, 100% WR, +18.89% ✅
 * - atr_trailing: 235 trades, 26% WR, -1.91% ❌
 * - stop_loss: 86 trades, 0% WR, -11.67% ❌
 * 
 * L'objectif: Améliorer les exits pour réduire les pertes
 * 
 * Idées à tester:
 * 1. Time-based exit (sortir après X heures sans profit)
 * 2. Break-even stop (move stop to entry après X% de profit)
 * 3. Partial exits (sortir 50% à X%, le reste trailing)
 * 4. Volume-based exit (sortir si volume chute)
 * 5. Multi-timeframe momentum (confirmer sur 4h aussi)
 */

import fs from 'fs';

// ═══════════════════════════════════════════════════════════════════════════
// LOAD LOCAL DATA
// ═══════════════════════════════════════════════════════════════════════════

function loadData(symbol) {
  const filename = `./data/${symbol.replace('/', '_')}_1h.json`;
  if (!fs.existsSync(filename)) {
    throw new Error(`Data file not found: ${filename}`);
  }
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

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
// COMMON ENTRY (Breakout Momentum - le même pour tous)
// ═══════════════════════════════════════════════════════════════════════════

function shouldEnterBreakout(i, data) {
  if (i < 30) return null;
  
  const close = data.candles[i].close;
  
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
  
  if (close > breakoutUp && roc5 > 0.015 && vol > volAvg * 1.3) {
    return 'long';
  }
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXIT STRATEGIES À COMPARER
// ═══════════════════════════════════════════════════════════════════════════

const EXIT_STRATEGIES = {
  // V0: Baseline (l'exit actuel)
  BASELINE: {
    name: 'Baseline (actuel)',
    
    shouldExit: (i, data, position) => {
      const roc5 = data.roc5[i];
      const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
      
      // Momentum fade profit
      if (pnl > 0.02 && roc5 < 0.005) {
        return { reason: 'momentum_fade_profit' };
      }
      
      // Stop loss fixe
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
    },
  },
  
  // V1: Time-based exit (sortir si pas de profit après X heures)
  TIME_BASED: {
    name: 'Time-Based Exit',
    
    shouldExit: (i, data, position) => {
      const roc5 = data.roc5[i];
      const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
      const holdingHours = i - position.entryIdx;
      
      // Momentum fade profit (garde le meilleur exit)
      if (pnl > 0.02 && roc5 < 0.005) {
        return { reason: 'momentum_fade_profit' };
      }
      
      // ⭐ TIME EXIT: Si après 12h on est flat/négatif, sortir
      if (holdingHours >= 12 && pnl < 0.005) {
        return { reason: 'time_exit_flat' };
      }
      
      // ⭐ TIME EXIT: Si après 24h on n'a pas +3%, sortir
      if (holdingHours >= 24 && pnl < 0.03) {
        return { reason: 'time_exit_no_progress' };
      }
      
      // Stop loss plus serré (-1.5% au lieu de -2%)
      if (pnl < -0.015) {
        return { reason: 'stop_loss_tight' };
      }
      
      return null;
    },
  },
  
  // V2: Break-Even Stop (déplacer le stop à l'entrée après profit)
  BREAK_EVEN: {
    name: 'Break-Even Stop',
    
    shouldExit: (i, data, position) => {
      const roc5 = data.roc5[i];
      const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
      
      // Momentum fade profit
      if (pnl > 0.02 && roc5 < 0.005) {
        return { reason: 'momentum_fade_profit' };
      }
      
      // ⭐ BREAK-EVEN: Si on a atteint +1.5%, le stop devient break-even
      const maxPnl = position.maxPnl || 0;
      const currentMaxPnl = Math.max(maxPnl, pnl);
      position.maxPnl = currentMaxPnl;
      
      if (currentMaxPnl >= 0.015 && pnl <= 0.002) {
        return { reason: 'break_even_stop' };
      }
      
      // ⭐ TRAILING PROFIT LOCK: Si +3%, ne pas perdre plus de 1%
      if (currentMaxPnl >= 0.03 && pnl < currentMaxPnl - 0.01) {
        return { reason: 'profit_lock' };
      }
      
      // Stop loss initial
      if (pnl < -0.02) {
        return { reason: 'stop_loss' };
      }
      
      return null;
    },
  },
  
  // V3: Volume-Based Exit
  VOLUME_EXIT: {
    name: 'Volume-Based Exit',
    
    shouldExit: (i, data, position) => {
      const roc5 = data.roc5[i];
      const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
      const vol = data.candles[i].volume;
      const volAvg = data.volSMA20[i];
      
      // Momentum fade profit
      if (pnl > 0.02 && roc5 < 0.005) {
        return { reason: 'momentum_fade_profit' };
      }
      
      // ⭐ VOLUME EXIT: Si volume chute ET momentum négatif = sortir
      if (pnl > 0 && vol < volAvg * 0.5 && roc5 < 0) {
        return { reason: 'volume_dry_up' };
      }
      
      // ⭐ CLIMAX EXIT: Volume spike + reversal = sortir avec profit
      if (pnl > 0.01 && vol > volAvg * 2.5 && roc5 < 0) {
        return { reason: 'volume_climax' };
      }
      
      // Stop loss
      if (pnl < -0.02) {
        return { reason: 'stop_loss' };
      }
      
      // ATR trailing backup
      const atr = data.atr[i];
      const high = Math.max(position.highWaterMark || position.entryPrice, data.candles[i].high);
      position.highWaterMark = high;
      if (data.candles[i].close < high - atr * 2.5) {
        return { reason: 'atr_trailing' };
      }
      
      return null;
    },
  },
  
  // V4: Multi-Signal Exit (combinaison de signaux)
  MULTI_SIGNAL: {
    name: 'Multi-Signal Exit',
    
    shouldExit: (i, data, position) => {
      const roc5 = data.roc5[i];
      const roc10 = data.roc10[i];
      const rsi = data.rsi[i];
      const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
      const vol = data.candles[i].volume;
      const volAvg = data.volSMA20[i];
      
      // Compter les signaux de sortie
      let exitSignals = 0;
      let signalReasons = [];
      
      // Signal 1: Momentum court terme négatif
      if (roc5 < 0) { exitSignals++; signalReasons.push('roc5'); }
      
      // Signal 2: Momentum long terme faiblit
      if (roc10 < roc5) { exitSignals++; signalReasons.push('roc_diverge'); }
      
      // Signal 3: RSI overbought
      if (rsi > 70) { exitSignals++; signalReasons.push('rsi_ob'); }
      
      // Signal 4: Volume faible
      if (vol < volAvg * 0.7) { exitSignals++; signalReasons.push('vol_low'); }
      
      // ⭐ MULTI-EXIT: Si en profit ET 3+ signaux = sortir
      if (pnl > 0.01 && exitSignals >= 3) {
        return { reason: `multi_signal_${exitSignals}` };
      }
      
      // ⭐ STRONG EXIT: Si 2+ signaux ET momentum très négatif
      if (pnl > 0 && exitSignals >= 2 && roc5 < -0.01) {
        return { reason: 'strong_reversal_signal' };
      }
      
      // Stop loss
      if (pnl < -0.018) {
        return { reason: 'stop_loss' };
      }
      
      return null;
    },
  },
  
  // V5: Adaptive Exit (s'adapte à la volatilité)
  ADAPTIVE: {
    name: 'Adaptive Exit',
    
    shouldExit: (i, data, position) => {
      const roc5 = data.roc5[i];
      const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
      const atr = data.atr[i];
      const atrPercent = atr / data.candles[i].close;
      
      // Volatilité: haute (>2%), moyenne (1-2%), basse (<1%)
      const volRegime = atrPercent > 0.02 ? 'high' : atrPercent > 0.01 ? 'medium' : 'low';
      
      // Momentum fade profit (adapté à la volatilité)
      const profitThreshold = volRegime === 'high' ? 0.03 : volRegime === 'medium' ? 0.02 : 0.015;
      const momentumThreshold = volRegime === 'high' ? 0.01 : volRegime === 'medium' ? 0.005 : 0.003;
      
      if (pnl > profitThreshold && roc5 < momentumThreshold) {
        return { reason: `momentum_fade_${volRegime}` };
      }
      
      // Stop loss adaptatif
      const stopLoss = volRegime === 'high' ? -0.025 : volRegime === 'medium' ? -0.018 : -0.012;
      if (pnl < stopLoss) {
        return { reason: `stop_loss_${volRegime}` };
      }
      
      // Break-even après avoir atteint le profit threshold
      const maxPnl = position.maxPnl || 0;
      position.maxPnl = Math.max(maxPnl, pnl);
      
      if (position.maxPnl >= profitThreshold && pnl <= 0.003) {
        return { reason: 'adaptive_breakeven' };
      }
      
      return null;
    },
  },
  
  // V6: Optimized (meilleur de chaque approche)
  OPTIMIZED: {
    name: '⭐ OPTIMIZED',
    
    shouldExit: (i, data, position) => {
      const roc5 = data.roc5[i];
      const roc10 = data.roc10[i];
      const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
      const holdingHours = i - position.entryIdx;
      const vol = data.candles[i].volume;
      const volAvg = data.volSMA20[i];
      const atr = data.atr[i];
      const atrPercent = atr / data.candles[i].close;
      
      // Track max PnL
      const maxPnl = position.maxPnl || 0;
      position.maxPnl = Math.max(maxPnl, pnl);
      
      // ══════════════════════════════════════════════════════════════
      // PROFIT EXITS (priorité 1: sécuriser les gains)
      // ══════════════════════════════════════════════════════════════
      
      // 1a. Momentum fade profit (le meilleur exit historique)
      if (pnl > 0.02 && roc5 < 0.005) {
        return { reason: 'momentum_fade_profit' };
      }
      
      // 1b. Double momentum confirmation (encore plus sûr)
      if (pnl > 0.015 && roc5 < 0 && roc10 < roc5) {
        return { reason: 'double_momentum_fade' };
      }
      
      // 1c. Volume climax exit
      if (pnl > 0.015 && vol > volAvg * 2 && roc5 < 0) {
        return { reason: 'volume_climax_exit' };
      }
      
      // ══════════════════════════════════════════════════════════════
      // PROTECTION EXITS (priorité 2: protéger le capital)
      // ══════════════════════════════════════════════════════════════
      
      // 2a. Break-even stop après avoir touché +1.5%
      if (position.maxPnl >= 0.015 && pnl <= 0.002) {
        return { reason: 'breakeven_protection' };
      }
      
      // 2b. Profit lock: ne pas perdre plus de 40% du max gain
      if (position.maxPnl >= 0.025 && pnl < position.maxPnl * 0.6) {
        return { reason: 'profit_lock_40pct' };
      }
      
      // ══════════════════════════════════════════════════════════════
      // TIME EXITS (priorité 3: éviter les trades zombies)
      // ══════════════════════════════════════════════════════════════
      
      // 3a. Time exit: 12h sans progression = sortir flat
      if (holdingHours >= 12 && pnl >= 0 && pnl < 0.01) {
        return { reason: 'time_exit_12h' };
      }
      
      // 3b. Long stale trade: 48h+ = sortir si pas de bon momentum
      if (holdingHours >= 48 && roc5 < 0.01) {
        return { reason: 'time_exit_48h' };
      }
      
      // ══════════════════════════════════════════════════════════════
      // STOP LOSS (priorité 4: dernière protection)
      // ══════════════════════════════════════════════════════════════
      
      // Stop loss adaptatif à la volatilité
      const stopLossPercent = atrPercent > 0.02 ? -0.025 : atrPercent > 0.01 ? -0.018 : -0.015;
      if (pnl < stopLossPercent) {
        return { reason: 'adaptive_stop_loss' };
      }
      
      return null;
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE
// ═══════════════════════════════════════════════════════════════════════════

function runBacktest(symbol, exitStrategy, candles) {
  const leverage = CONFIG.LEVERAGE[symbol.replace('/USDT', '')] || 3;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  
  const data = {
    candles,
    atr: calculateATR(candles, 14),
    roc5: calculateROC(closes, 5),
    roc10: calculateROC(closes, 10),
    volSMA20: calculateVolSMA(volumes, 20),
    ema20: calculateEMA(closes, 20),
    rsi: calculateRSI(candles, 14),
  };
  
  const trades = [];
  let position = null;
  let capital = 100;
  let peakCapital = 100;
  let maxDrawdown = 0;
  
  for (let i = 50; i < candles.length; i++) {
    if (!position) {
      const signal = shouldEnterBreakout(i, data);
      if (signal) {
        const entryPrice = candles[i].close * (1 + CONFIG.SLIPPAGE);
        capital -= capital * CONFIG.ENTRY_FEE;
        
        position = {
          side: signal,
          entryPrice,
          entryIdx: i,
          entryTime: new Date(candles[i].timestamp),
          capitalAtEntry: capital,
          highWaterMark: entryPrice,
          maxPnl: 0,
        };
      }
    } else {
      position.highWaterMark = Math.max(position.highWaterMark, candles[i].high);
      
      const exitSignal = exitStrategy.shouldExit(i, data, position);
      if (exitSignal) {
        const exitPrice = candles[i].close * (1 - CONFIG.SLIPPAGE);
        const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice;
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
    
    // Drawdown tracking
    const equity = position 
      ? position.capitalAtEntry * (1 + ((candles[i].close - position.entryPrice) / position.entryPrice) * leverage)
      : capital;
    if (equity > peakCapital) peakCapital = equity;
    const dd = (peakCapital - equity) / peakCapital * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  
  // Close open position
  if (position) {
    const exitPrice = candles[candles.length - 1].close;
    const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice;
    const pnlWithLeverage = pnlPercent * leverage;
    capital = position.capitalAtEntry * (1 + pnlWithLeverage);
    trades.push({
      symbol,
      pnlPercent: pnlPercent * 100,
      pnlWithLeverage: pnlWithLeverage * 100,
      exitReason: 'end_of_data',
      holdingHours: candles.length - position.entryIdx,
    });
  }
  
  return { trades, finalCapital: capital, maxDrawdown };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 EXIT STRATEGY OPTIMIZER');
  console.log('═'.repeat(80));
  console.log('\n📂 Loading local data...\n');
  
  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'];
  const allCandles = {};
  
  for (const symbol of symbols) {
    allCandles[symbol] = loadData(symbol);
    console.log(`   ${symbol}: ${allCandles[symbol].length} candles`);
  }
  
  const allResults = {};
  
  for (const [stratKey, strategy] of Object.entries(EXIT_STRATEGIES)) {
    console.log('\n' + '─'.repeat(80));
    console.log(`🔬 ${strategy.name}`);
    console.log('─'.repeat(80));
    
    const symbolResults = {};
    let allTrades = [];
    
    for (const symbol of symbols) {
      const { trades, finalCapital, maxDrawdown } = runBacktest(symbol, strategy, allCandles[symbol]);
      symbolResults[symbol] = { trades, finalCapital, maxDrawdown };
      allTrades = allTrades.concat(trades);
    }
    
    // Stats par asset
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
      if (!exitStats[t.exitReason]) exitStats[t.exitReason] = { count: 0, pnl: 0, wins: 0 };
      exitStats[t.exitReason].count++;
      exitStats[t.exitReason].pnl += t.pnlWithLeverage || 0;
      if ((t.pnlWithLeverage || 0) > 0) exitStats[t.exitReason].wins++;
    });
    
    console.log('\n📊 Exit Reasons:');
    for (const [reason, stats] of Object.entries(exitStats).sort((a, b) => b[1].pnl - a[1].pnl)) {
      const avgPnl = stats.pnl / stats.count;
      const wr = stats.wins / stats.count * 100;
      const marker = avgPnl > 0 ? '✅' : '❌';
      console.log(`   ${marker} ${reason}: ${stats.count} trades, WR: ${wr.toFixed(0)}%, Avg: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%`);
    }
    
    // Avg holding
    const avgHold = allTrades.reduce((s, t) => s + (t.holdingHours || 0), 0) / allTrades.length;
    console.log(`\n⏱️  Holding moyen: ${avgHold.toFixed(1)}h (${(avgHold/24).toFixed(1)} jours)`);
    
    allResults[stratKey] = {
      name: strategy.name,
      totalTrades: allTrades.length,
      winRate: totalWR,
      totalROI,
      avgHold,
      exitBreakdown: exitStats,
    };
  }
  
  // Final comparison
  console.log('\n' + '═'.repeat(80));
  console.log('🏆 EXIT STRATEGY RANKING');
  console.log('═'.repeat(80));
  
  console.log('\n┌─────────────────────────┬────────┬──────────┬───────────┬──────────┐');
  console.log('│ Exit Strategy           │ Trades │ Win Rate │ Total ROI │ Avg Hold │');
  console.log('├─────────────────────────┼────────┼──────────┼───────────┼──────────┤');
  
  const sorted = Object.values(allResults).sort((a, b) => b.totalROI - a.totalROI);
  for (const r of sorted) {
    const marker = r.totalROI > 0 ? '✅' : '❌';
    console.log(`│${marker}${r.name.padEnd(23)} │ ${String(r.totalTrades).padStart(6)} │ ${r.winRate.toFixed(1).padStart(7)}% │ ${r.totalROI >= 0 ? '+' : ''}${r.totalROI.toFixed(0).padStart(8)}% │ ${r.avgHold.toFixed(0).padStart(5)}h   │`);
  }
  console.log('└─────────────────────────┴────────┴──────────┴───────────┴──────────┘');
  
  // Improvement analysis
  const baseline = allResults.BASELINE;
  const best = sorted[0];
  const improvement = best.totalROI - baseline.totalROI;
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 📈 ANALYSE DES AMÉLIORATIONS                                                  ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ Baseline ROI:  ${baseline.totalROI >= 0 ? '+' : ''}${baseline.totalROI.toFixed(0)}%                                                        ║
║ Best ROI:      ${best.totalROI >= 0 ? '+' : ''}${best.totalROI.toFixed(0)}% (${best.name})                              ║
║ Amélioration:  ${improvement >= 0 ? '+' : ''}${improvement.toFixed(0)}%                                                        ║
║                                                                               ║
║ 🎯 Best exit strategy: ${best.name.padEnd(30)}                  ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);

  // Detailed breakdown of best strategy
  if (best.exitBreakdown) {
    console.log(`\n📊 Breakdown des exits de "${best.name}":`);
    for (const [reason, stats] of Object.entries(best.exitBreakdown).sort((a, b) => b[1].pnl - a[1].pnl)) {
      const avgPnl = stats.pnl / stats.count;
      const wr = stats.wins / stats.count * 100;
      const marker = avgPnl > 0 ? '✅' : '❌';
      const contribution = stats.pnl;
      console.log(`   ${marker} ${reason.padEnd(25)}: ${String(stats.count).padStart(3)} trades, WR: ${wr.toFixed(0).padStart(3)}%, Avg: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2).padStart(6)}%, Total: ${contribution >= 0 ? '+' : ''}${contribution.toFixed(0).padStart(5)}%`);
    }
  }
}

main().catch(console.error);
