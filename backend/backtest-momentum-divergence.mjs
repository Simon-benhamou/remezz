/**
 * DEEP DIVE: Momentum Divergence Strategy
 * 
 * L'insight du backtest précédent:
 * - Exit "momentum_divergence" = 100% Win Rate, +16.67% avg
 * 
 * L'idée: On entre seulement quand on SAIT qu'on va pouvoir 
 * sortir sur momentum divergence (= quand le setup est clean)
 * 
 * Pattern recherché:
 * 1. Tendance claire établie
 * 2. Momentum fort au départ
 * 3. Attendre le "momentum fade" pour sortir avec profit
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  ENTRY_FEE: 0.0004,
  EXIT_FEE: 0.0004,
  SLIPPAGE: 0.0002,
  
  LEVERAGE: { BTC: 3, ETH: 5, SOL: 5, XRP: 4 },
};

// ═══════════════════════════════════════════════════════════════════════════
// INDICATEURS
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
    if (i < period) {
      atrs.push(tr);
    } else {
      const prevATR = atrs[i-1];
      atrs.push((prevATR * (period - 1) + tr) / period);
    }
  }
  return atrs;
}

function calculateEMA(prices, period) {
  const emas = [];
  const multiplier = 2 / (period + 1);
  for (let i = 0; i < prices.length; i++) {
    if (i === 0) emas.push(prices[i]);
    else emas.push((prices[i] - emas[i-1]) * multiplier + emas[i-1]);
  }
  return emas;
}

function calculateRSI(candles, period = 14) {
  const rsis = [];
  let avgGain = 0, avgLoss = 0;
  
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      rsis.push(50);
      continue;
    }
    
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

// Rate of Change
function calculateROC(prices, period) {
  return prices.map((p, i) => {
    if (i < period) return 0;
    return (p - prices[i - period]) / prices[i - period];
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGIES BASÉES SUR MOMENTUM DIVERGENCE
// ═══════════════════════════════════════════════════════════════════════════

const STRATEGIES = {
  // V1: Entry sur momentum breakout, exit sur momentum fade
  MOMENTUM_BREAKOUT: {
    name: 'Momentum Breakout → Fade Exit',
    description: 'Entre sur explosion de momentum, sort quand il faiblit',
    
    shouldEnter: (i, data) => {
      if (i < 30) return null;
      
      const roc5 = data.roc5[i];
      const roc10 = data.roc10[i];
      const roc5_prev = data.roc5[i-1];
      const rsi = data.rsi[i];
      const close = data.candles[i].close;
      const ema20 = data.ema20[i];
      
      // Entry conditions:
      // 1. Momentum explosion: ROC5 passe au-dessus de 2%
      // 2. Prix au-dessus de EMA20
      // 3. RSI pas en surachat (< 75)
      // 4. ROC10 confirme la tendance (positif)
      if (roc5 > 0.02 && roc5_prev <= 0.02 && close > ema20 && rsi < 75 && roc10 > 0) {
        return 'long';
      }
      return null;
    },
    
    shouldExit: (i, data, position) => {
      const roc5 = data.roc5[i];
      const roc5_prev = data.roc5[i-1];
      const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
      
      // Exit 1: Momentum fade avec profit (notre edge!)
      if (pnl > 0.01 && roc5 < roc5_prev && roc5 < 0.01) {
        return { reason: 'momentum_fade_profit' };
      }
      
      // Exit 2: Momentum collapse (protection)
      if (roc5 < -0.02) {
        return { reason: 'momentum_collapse' };
      }
      
      // Exit 3: Trailing stop basé sur ATR
      const atr = data.atr[i];
      const high = Math.max(position.highWaterMark || position.entryPrice, data.candles[i].high);
      position.highWaterMark = high;
      if (data.candles[i].close < high - atr * 2) {
        return { reason: 'atr_trailing' };
      }
      
      // Exit 4: Time-based (max 5 jours)
      if (i - position.entryIdx > 120) {
        return { reason: 'time_exit' };
      }
      
      return null;
    },
  },
  
  // V2: RSI Momentum avec divergence
  RSI_MOMENTUM: {
    name: 'RSI Momentum Divergence',
    description: 'Entre quand RSI monte avec prix, sort sur divergence',
    
    shouldEnter: (i, data) => {
      if (i < 30) return null;
      
      const rsi = data.rsi[i];
      const rsi_prev5 = data.rsi[i-5];
      const close = data.candles[i].close;
      const close_prev5 = data.candles[i-5].close;
      const ema20 = data.ema20[i];
      const ema50 = data.ema50[i];
      
      // Entry: RSI et Prix montent ensemble (pas de divergence)
      const rsiUp = rsi > rsi_prev5;
      const priceUp = close > close_prev5;
      const trendUp = ema20 > ema50;
      
      // RSI dans zone d'achat (40-60) et en hausse
      if (rsi > 40 && rsi < 65 && rsiUp && priceUp && trendUp && close > ema20) {
        // Confirmation: pas de divergence bearish récente
        return 'long';
      }
      return null;
    },
    
    shouldExit: (i, data, position) => {
      const rsi = data.rsi[i];
      const rsi_prev5 = data.rsi[i-5] || rsi;
      const close = data.candles[i].close;
      const close_prev5 = data.candles[i-5]?.close || close;
      const pnl = (close - position.entryPrice) / position.entryPrice;
      
      // Exit sur BEARISH DIVERGENCE: Prix monte mais RSI baisse
      const priceUp = close > close_prev5;
      const rsiDown = rsi < rsi_prev5;
      
      if (pnl > 0.01 && priceUp && rsiDown) {
        return { reason: 'bearish_divergence' };
      }
      
      // RSI surachat extrême
      if (rsi > 80) {
        return { reason: 'rsi_overbought' };
      }
      
      // Stop loss
      if (pnl < -0.03) {
        return { reason: 'stop_loss' };
      }
      
      // Trailing
      const atr = data.atr[i];
      const high = Math.max(position.highWaterMark || position.entryPrice, data.candles[i].high);
      position.highWaterMark = high;
      if (close < high - atr * 2.5) {
        return { reason: 'atr_trailing' };
      }
      
      return null;
    },
  },
  
  // V3: Volume + Momentum
  VOLUME_MOMENTUM: {
    name: 'Volume Breakout + Momentum',
    description: 'Entre sur volume spike avec momentum, sort sur volume fade',
    
    shouldEnter: (i, data) => {
      if (i < 30) return null;
      
      const vol = data.candles[i].volume;
      const volAvg = data.volSMA20[i];
      const roc5 = data.roc5[i];
      const close = data.candles[i].close;
      const ema20 = data.ema20[i];
      
      // Volume spike (2x average) + Momentum positif
      if (vol > volAvg * 2 && roc5 > 0.01 && close > ema20) {
        // Bougie verte (close > open)
        if (data.candles[i].close > data.candles[i].open) {
          return 'long';
        }
      }
      return null;
    },
    
    shouldExit: (i, data, position) => {
      const vol = data.candles[i].volume;
      const volAvg = data.volSMA20[i];
      const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
      const roc5 = data.roc5[i];
      
      // Exit sur volume fade avec profit
      if (pnl > 0.015 && vol < volAvg * 0.7) {
        return { reason: 'volume_fade_profit' };
      }
      
      // Momentum collapse
      if (roc5 < -0.015) {
        return { reason: 'momentum_collapse' };
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
  
  // V4: Multi-timeframe momentum alignment
  MULTI_MOMENTUM: {
    name: 'Multi-Timeframe Momentum',
    description: 'Entre quand tous les momentums alignés, sort sur désalignement',
    
    shouldEnter: (i, data) => {
      if (i < 50) return null;
      
      const roc5 = data.roc5[i];
      const roc10 = data.roc10[i];
      const roc20 = data.roc20[i];
      const rsi = data.rsi[i];
      
      // Tous les momentums doivent être positifs ET en accélération
      const roc5_prev = data.roc5[i-1];
      const roc10_prev = data.roc10[i-1];
      
      if (roc5 > 0.005 && roc10 > 0.01 && roc20 > 0.02 && 
          roc5 > roc5_prev && roc10 > roc10_prev &&
          rsi > 45 && rsi < 70) {
        return 'long';
      }
      return null;
    },
    
    shouldExit: (i, data, position) => {
      const roc5 = data.roc5[i];
      const roc10 = data.roc10[i];
      const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
      
      // Exit quand les momentums se désalignent
      if (pnl > 0.01 && (roc5 < 0 || roc10 < 0)) {
        return { reason: 'momentum_misalignment' };
      }
      
      // Momentum short-term reverse
      if (roc5 < -0.02) {
        return { reason: 'momentum_reverse' };
      }
      
      // ATR stop
      const atr = data.atr[i];
      const high = Math.max(position.highWaterMark || position.entryPrice, data.candles[i].high);
      position.highWaterMark = high;
      if (data.candles[i].close < high - atr * 2.5) {
        return { reason: 'atr_trailing' };
      }
      
      return null;
    },
  },
  
  // V5: Breakout + Momentum Confirmation
  BREAKOUT_CONFIRMED: {
    name: 'Breakout + Momentum Confirm',
    description: 'Entre sur breakout de range, sort quand momentum confirme plus',
    
    shouldEnter: (i, data) => {
      if (i < 30) return null;
      
      const close = data.candles[i].close;
      
      // Calculer le range des 20 dernières bougies
      let highest = 0, lowest = Infinity;
      for (let j = i - 20; j < i; j++) {
        if (data.candles[j].high > highest) highest = data.candles[j].high;
        if (data.candles[j].low < lowest) lowest = data.candles[j].low;
      }
      
      const range = highest - lowest;
      const breakoutThreshold = highest + range * 0.02; // 2% au-dessus du range
      
      // Breakout confirmé par momentum
      const roc5 = data.roc5[i];
      const vol = data.candles[i].volume;
      const volAvg = data.volSMA20[i];
      
      if (close > breakoutThreshold && roc5 > 0.015 && vol > volAvg * 1.3) {
        return 'long';
      }
      return null;
    },
    
    shouldExit: (i, data, position) => {
      const roc5 = data.roc5[i];
      const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
      
      // Momentum ne confirme plus le breakout
      if (pnl > 0.02 && roc5 < 0.005) {
        return { reason: 'momentum_not_confirming' };
      }
      
      // Retour dans le range = faux breakout
      if (pnl < -0.02) {
        return { reason: 'false_breakout' };
      }
      
      // Trailing stop
      const atr = data.atr[i];
      const high = Math.max(position.highWaterMark || position.entryPrice, data.candles[i].high);
      position.highWaterMark = high;
      if (data.candles[i].close < high - atr * 2) {
        return { reason: 'atr_trailing' };
      }
      
      return null;
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE
// ═══════════════════════════════════════════════════════════════════════════

async function runBacktest(symbol, strategy, candles) {
  const leverage = CONFIG.LEVERAGE[symbol.replace('/USDT', '')] || 3;
  
  // Prepare indicators
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  
  const atr = calculateATR(candles, 14);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const rsi = calculateRSI(candles, 14);
  const roc5 = calculateROC(closes, 5);
  const roc10 = calculateROC(closes, 10);
  const roc20 = calculateROC(closes, 20);
  
  // Volume SMA
  const volSMA20 = volumes.map((v, i) => {
    if (i < 20) return v;
    const slice = volumes.slice(i - 20, i);
    return slice.reduce((a, b) => a + b, 0) / 20;
  });
  
  const data = { candles, atr, ema20, ema50, rsi, roc5, roc10, roc20, volSMA20 };
  
  const trades = [];
  let position = null;
  let capital = 100;
  
  for (let i = 50; i < candles.length; i++) {
    if (!position) {
      const signal = strategy.shouldEnter(i, data);
      if (signal === 'long') {
        const entryPrice = candles[i].close * (1 + CONFIG.SLIPPAGE);
        capital -= capital * CONFIG.ENTRY_FEE;
        
        position = {
          side: 'long',
          entryPrice,
          entryIdx: i,
          entryTime: candles[i].timestamp,
          capitalAtEntry: capital,
          highWaterMark: entryPrice,
        };
      }
    } else {
      position.highWaterMark = Math.max(position.highWaterMark || position.entryPrice, candles[i].high);
      
      const exitSignal = strategy.shouldExit(i, data, position);
      if (exitSignal) {
        const exitPrice = candles[i].close * (1 - CONFIG.SLIPPAGE);
        const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice;
        const pnlWithLeverage = pnlPercent * leverage;
        
        capital = position.capitalAtEntry * (1 + pnlWithLeverage);
        capital -= capital * CONFIG.EXIT_FEE;
        
        trades.push({
          symbol,
          entryPrice: position.entryPrice,
          exitPrice,
          entryTime: position.entryTime,
          exitTime: candles[i].timestamp,
          holdingPeriod: i - position.entryIdx,
          pnlPercent: pnlPercent * 100,
          pnlWithLeverage: pnlWithLeverage * 100,
          exitReason: exitSignal.reason,
        });
        
        position = null;
      }
    }
  }
  
  // Close open position
  if (position) {
    const exitPrice = candles[candles.length - 1].close;
    const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice;
    const pnlWithLeverage = pnlPercent * leverage;
    capital = position.capitalAtEntry * (1 + pnlWithLeverage);
    trades.push({
      symbol,
      entryPrice: position.entryPrice,
      exitPrice,
      pnlPercent: pnlPercent * 100,
      pnlWithLeverage: pnlWithLeverage * 100,
      exitReason: 'end_of_data',
      holdingPeriod: candles.length - position.entryIdx,
    });
  }
  
  return { trades, finalCapital: capital };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(80));
  console.log('🎯 MOMENTUM DIVERGENCE DEEP DIVE');
  console.log('═'.repeat(80));
  console.log('\n📊 Fetching 1 year of hourly data...\n');
  
  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'];
  
  async function fetchCandles(symbol, since, limit = 500) {
    const candles = [];
    let currentSince = since;
    while (candles.length < 8760) {
      const batch = await exchange.fetchOHLCV(symbol, '1h', currentSince, limit);
      if (batch.length === 0) break;
      candles.push(...batch);
      currentSince = batch[batch.length - 1][0] + 1;
      await new Promise(r => setTimeout(r, 100));
    }
    return candles;
  }
  
  const allCandles = {};
  const since = Date.now() - 365 * 24 * 60 * 60 * 1000;
  
  for (const symbol of symbols) {
    const rawCandles = await fetchCandles(symbol, since);
    allCandles[symbol] = rawCandles.map(c => ({
      timestamp: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    }));
    console.log(`   ${symbol}: ${allCandles[symbol].length} candles`);
  }
  
  const allResults = {};
  
  for (const [stratKey, strategy] of Object.entries(STRATEGIES)) {
    console.log('\n' + '─'.repeat(80));
    console.log(`\n🔬 ${strategy.name}`);
    console.log(`   ${strategy.description}`);
    console.log('─'.repeat(80));
    
    let totalTrades = 0, totalWins = 0, allTrades = [];
    const symbolResults = {};
    
    for (const symbol of symbols) {
      const { trades, finalCapital } = await runBacktest(symbol, strategy, allCandles[symbol]);
      
      const wins = trades.filter(t => t.pnlWithLeverage > 0).length;
      const roi = finalCapital - 100;
      
      symbolResults[symbol] = { 
        trades: trades.length, 
        wins, 
        winRate: trades.length > 0 ? wins/trades.length*100 : 0, 
        roi 
      };
      totalTrades += trades.length;
      totalWins += wins;
      allTrades = allTrades.concat(trades);
    }
    
    console.log('\n┌──────────┬────────┬──────────┬──────────┐');
    console.log('│ Symbol   │ Trades │ Win Rate │   ROI    │');
    console.log('├──────────┼────────┼──────────┼──────────┤');
    
    let totalROI = 0;
    for (const symbol of symbols) {
      const r = symbolResults[symbol];
      totalROI += r.roi;
      console.log(`│ ${symbol.padEnd(8)} │ ${String(r.trades).padStart(6)} │ ${r.winRate.toFixed(1).padStart(7)}% │ ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1).padStart(7)}% │`);
    }
    
    console.log('├──────────┼────────┼──────────┼──────────┤');
    const wr = totalTrades > 0 ? totalWins / totalTrades * 100 : 0;
    console.log(`│ TOTAL    │ ${String(totalTrades).padStart(6)} │ ${wr.toFixed(1).padStart(7)}% │ ${totalROI >= 0 ? '+' : ''}${totalROI.toFixed(1).padStart(7)}% │`);
    console.log('└──────────┴────────┴──────────┴──────────┘');
    
    // Exit reasons
    const exitReasons = {};
    allTrades.forEach(t => {
      if (!exitReasons[t.exitReason]) exitReasons[t.exitReason] = { count: 0, pnl: 0, wins: 0 };
      exitReasons[t.exitReason].count++;
      exitReasons[t.exitReason].pnl += t.pnlWithLeverage;
      if (t.pnlWithLeverage > 0) exitReasons[t.exitReason].wins++;
    });
    
    console.log('\n📊 Exit Reasons Performance:');
    for (const [reason, stats] of Object.entries(exitReasons).sort((a,b) => b[1].count - a[1].count)) {
      const avgPnL = stats.pnl / stats.count;
      const wr = stats.wins / stats.count * 100;
      const marker = avgPnL > 0 ? '✅' : '❌';
      console.log(`   ${marker} ${reason}: ${stats.count} trades, WR: ${wr.toFixed(0)}%, Avg: ${avgPnL >= 0 ? '+' : ''}${avgPnL.toFixed(2)}%`);
    }
    
    // Avg holding
    const avgHold = allTrades.length > 0 ? allTrades.reduce((s, t) => s + (t.holdingPeriod || 0), 0) / allTrades.length : 0;
    console.log(`\n⏱️  Avg holding: ${avgHold.toFixed(1)}h (${(avgHold/24).toFixed(1)} days)`);
    
    allResults[stratKey] = { 
      name: strategy.name, 
      totalTrades, 
      winRate: wr, 
      totalROI,
      avgHold,
      bestExit: Object.entries(exitReasons)
        .filter(([k, v]) => v.count >= 3)
        .sort((a,b) => (b[1].pnl/b[1].count) - (a[1].pnl/a[1].count))[0]
    };
  }
  
  // Final comparison
  console.log('\n' + '═'.repeat(80));
  console.log('🏆 FINAL RANKING');
  console.log('═'.repeat(80));
  
  const sorted = Object.values(allResults).sort((a, b) => b.totalROI - a.totalROI);
  
  console.log('\n┌─────────────────────────────┬────────┬──────────┬───────────┐');
  console.log('│ Strategy                    │ Trades │ Win Rate │ Total ROI │');
  console.log('├─────────────────────────────┼────────┼──────────┼───────────┤');
  for (const r of sorted) {
    console.log(`│ ${r.name.padEnd(27)} │ ${String(r.totalTrades).padStart(6)} │ ${r.winRate.toFixed(1).padStart(7)}% │ ${r.totalROI >= 0 ? '+' : ''}${r.totalROI.toFixed(1).padStart(8)}% │`);
  }
  console.log('└─────────────────────────────┴────────┴──────────┴───────────┘');
  
  // Best exit reasons across all strategies
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 MEILLEURS EXIT TYPES (pattern qui marche?)');
  console.log('═'.repeat(80) + '\n');
  
  for (const r of sorted.slice(0, 3)) {
    if (r.bestExit) {
      const [exitName, stats] = r.bestExit;
      const avgPnL = stats.pnl / stats.count;
      if (avgPnL > 0) {
        console.log(`   ✅ ${r.name}: "${exitName}" = ${stats.count} trades, +${avgPnL.toFixed(2)}% avg`);
      }
    }
  }
  
  console.log(`

╔═══════════════════════════════════════════════════════════════════════════════╗
║ 💡 CONCLUSION: Est-ce que c'est possible?                                     ║
╠═══════════════════════════════════════════════════════════════════════════════╣
`);

  const profitable = sorted.filter(s => s.totalROI > 0);
  if (profitable.length === 0) {
    console.log(`║ ❌ RÉSULTAT: ${sorted.length}/${sorted.length} stratégies PERDENT de l'argent                     ║`);
    console.log(`║                                                                               ║`);
    console.log(`║ Le trend following avec momentum divergence NE SUFFIT PAS.                    ║`);
    console.log(`║ Le marché est trop efficient - les patterns sont déjà exploités.              ║`);
  } else {
    console.log(`║ ✅ RÉSULTAT: ${profitable.length}/${sorted.length} stratégies PROFITABLES!                               ║`);
    console.log(`║                                                                               ║`);
    for (const p of profitable) {
      console.log(`║ → ${p.name.padEnd(25)} : +${p.totalROI.toFixed(1)}% ROI (${p.totalTrades} trades)          ║`);
    }
  }
  
  console.log(`╚═══════════════════════════════════════════════════════════════════════════════╝
`);
  
  process.exit(0);
}

main().catch(console.error);
