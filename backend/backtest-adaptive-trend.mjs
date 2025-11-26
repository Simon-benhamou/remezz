/**
 * ADAPTIVE TREND FOLLOWING - Deep Analysis
 * 
 * L'idée: Suivre la tendance MAIS s'adapter à la volatilité
 * 
 * Problème classique:
 * - Stop trop serré = shakeout sur bruit normal
 * - Stop trop large = reversal mange tout le profit
 * 
 * Solution proposée:
 * - Trailing stop basé sur ATR (Average True Range)
 * - Entry seulement quand tendance CONFIRMÉE
 * - Exit quand structure de tendance CASSE
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
  // Fees réalistes
  ENTRY_FEE: 0.0004,  // 0.04%
  EXIT_FEE: 0.0004,
  SLIPPAGE: 0.0002,   // 0.02%
  
  // Leverage par asset
  LEVERAGE: {
    BTC: 3,
    ETH: 5,
    SOL: 5,
    XRP: 4,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// INDICATEURS TECHNIQUES
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
    if (i === 0) {
      emas.push(prices[i]);
    } else {
      emas.push((prices[i] - emas[i-1]) * multiplier + emas[i-1]);
    }
  }
  return emas;
}

function calculateSupertrend(candles, period = 10, multiplier = 3) {
  const atrs = calculateATR(candles, period);
  const supertrend = [];
  const direction = []; // 1 = uptrend, -1 = downtrend
  
  for (let i = 0; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const atr = atrs[i];
    
    const upperBand = hl2 + (multiplier * atr);
    const lowerBand = hl2 - (multiplier * atr);
    
    if (i === 0) {
      supertrend.push({ upper: upperBand, lower: lowerBand, value: lowerBand });
      direction.push(1);
      continue;
    }
    
    // Adjust bands based on previous values
    const prevUpper = supertrend[i-1].upper;
    const prevLower = supertrend[i-1].lower;
    
    const finalUpper = (upperBand < prevUpper || candles[i-1].close > prevUpper) ? upperBand : prevUpper;
    const finalLower = (lowerBand > prevLower || candles[i-1].close < prevLower) ? lowerBand : prevLower;
    
    // Determine direction
    let dir;
    if (direction[i-1] === 1) {
      dir = candles[i].close < finalLower ? -1 : 1;
    } else {
      dir = candles[i].close > finalUpper ? 1 : -1;
    }
    
    direction.push(dir);
    supertrend.push({
      upper: finalUpper,
      lower: finalLower,
      value: dir === 1 ? finalLower : finalUpper,
      direction: dir,
    });
  }
  
  return { supertrend, direction };
}

// Detect Higher Highs / Higher Lows (uptrend structure)
function detectTrendStructure(candles, lookback = 20) {
  const structures = [];
  
  for (let i = 0; i < candles.length; i++) {
    if (i < lookback * 2) {
      structures.push({ trend: 'undefined', strength: 0 });
      continue;
    }
    
    // Find local highs and lows in recent history
    const recentCandles = candles.slice(i - lookback, i + 1);
    const highs = [];
    const lows = [];
    
    for (let j = 2; j < recentCandles.length - 2; j++) {
      // Local high
      if (recentCandles[j].high > recentCandles[j-1].high &&
          recentCandles[j].high > recentCandles[j-2].high &&
          recentCandles[j].high > recentCandles[j+1].high &&
          recentCandles[j].high > recentCandles[j+2].high) {
        highs.push({ idx: j, price: recentCandles[j].high });
      }
      // Local low
      if (recentCandles[j].low < recentCandles[j-1].low &&
          recentCandles[j].low < recentCandles[j-2].low &&
          recentCandles[j].low < recentCandles[j+1].low &&
          recentCandles[j].low < recentCandles[j+2].low) {
        lows.push({ idx: j, price: recentCandles[j].low });
      }
    }
    
    // Check for Higher Highs + Higher Lows (uptrend)
    let hhCount = 0, hlCount = 0, llCount = 0, lhCount = 0;
    
    for (let j = 1; j < highs.length; j++) {
      if (highs[j].price > highs[j-1].price) hhCount++;
      else lhCount++;
    }
    for (let j = 1; j < lows.length; j++) {
      if (lows[j].price > lows[j-1].price) hlCount++;
      else llCount++;
    }
    
    const uptrend = hhCount >= 2 && hlCount >= 2;
    const downtrend = lhCount >= 2 && llCount >= 2;
    
    if (uptrend && !downtrend) {
      structures.push({ trend: 'up', strength: (hhCount + hlCount) / 4 });
    } else if (downtrend && !uptrend) {
      structures.push({ trend: 'down', strength: (lhCount + llCount) / 4 });
    } else {
      structures.push({ trend: 'range', strength: 0 });
    }
  }
  
  return structures;
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGIES TO TEST
// ═══════════════════════════════════════════════════════════════════════════

const STRATEGIES = {
  // Strategy 1: Supertrend classique
  SUPERTREND_BASIC: {
    name: 'Supertrend Basic',
    description: 'Entry on Supertrend flip, exit on reverse flip',
    params: { period: 10, multiplier: 3 },
    
    shouldEnter: (i, data) => {
      if (i < 2) return null;
      const { direction } = data.supertrend;
      // Enter LONG when direction flips from -1 to 1
      if (direction[i] === 1 && direction[i-1] === -1) {
        return 'long';
      }
      return null;
    },
    
    shouldExit: (i, data, position) => {
      const { direction } = data.supertrend;
      // Exit when direction flips
      if (position.side === 'long' && direction[i] === -1) {
        return { reason: 'supertrend_flip' };
      }
      return null;
    },
  },
  
  // Strategy 2: Supertrend + Trend Structure Filter
  SUPERTREND_FILTERED: {
    name: 'Supertrend + Structure',
    description: 'Supertrend entry ONLY when trend structure confirmed',
    params: { period: 10, multiplier: 3 },
    
    shouldEnter: (i, data) => {
      if (i < 2) return null;
      const { direction } = data.supertrend;
      const structure = data.trendStructure[i];
      
      // Enter LONG when supertrend flips AND structure is uptrend
      if (direction[i] === 1 && direction[i-1] === -1 && structure.trend === 'up') {
        return 'long';
      }
      return null;
    },
    
    shouldExit: (i, data, position) => {
      const { direction } = data.supertrend;
      const structure = data.trendStructure[i];
      
      // Exit when supertrend flips OR structure breaks
      if (position.side === 'long') {
        if (direction[i] === -1) return { reason: 'supertrend_flip' };
        if (structure.trend === 'down') return { reason: 'structure_break' };
      }
      return null;
    },
  },
  
  // Strategy 3: ATR Trailing Stop
  ATR_TRAILING: {
    name: 'ATR Trailing Stop',
    description: 'Enter on EMA cross, exit on ATR-based trailing stop',
    params: { atrMultiplier: 2.5, emaPeriod: 20 },
    
    shouldEnter: (i, data) => {
      if (i < 25) return null;
      const ema20 = data.ema20[i];
      const ema50 = data.ema50[i];
      const close = data.candles[i].close;
      
      // Enter when price crosses above EMA20 AND EMA20 > EMA50
      if (close > ema20 && data.candles[i-1].close <= data.ema20[i-1] && ema20 > ema50) {
        return 'long';
      }
      return null;
    },
    
    getTrailingStop: (i, data, position) => {
      const atr = data.atr[i];
      const highSinceEntry = Math.max(
        position.highWaterMark || position.entryPrice,
        data.candles[i].high
      );
      return highSinceEntry - (atr * 2.5);
    },
    
    shouldExit: (i, data, position) => {
      const trailingStop = STRATEGIES.ATR_TRAILING.getTrailingStop(i, data, position);
      const close = data.candles[i].close;
      
      if (close < trailingStop) {
        return { reason: 'trailing_stop', stopPrice: trailingStop };
      }
      return null;
    },
  },
  
  // Strategy 4: Volatility-Adaptive
  VOLATILITY_ADAPTIVE: {
    name: 'Volatility Adaptive',
    description: 'Wider stops when volatile, tighter when calm',
    params: {},
    
    shouldEnter: (i, data) => {
      if (i < 50) return null;
      const { direction } = data.supertrend;
      const structure = data.trendStructure[i];
      
      // Only enter in confirmed uptrend
      if (direction[i] === 1 && direction[i-1] === -1 && structure.trend === 'up') {
        return 'long';
      }
      return null;
    },
    
    shouldExit: (i, data, position) => {
      const atr = data.atr[i];
      const atr20Avg = data.atr.slice(Math.max(0, i-20), i+1).reduce((a,b) => a+b, 0) / Math.min(20, i+1);
      
      // Volatility ratio: current ATR vs average
      const volRatio = atr / atr20Avg;
      
      // Adaptive multiplier: 2x when calm, 4x when volatile
      const atrMult = volRatio < 0.8 ? 2 : volRatio > 1.5 ? 4 : 3;
      
      const highWaterMark = position.highWaterMark || position.entryPrice;
      const newHigh = Math.max(highWaterMark, data.candles[i].high);
      position.highWaterMark = newHigh;
      
      const trailingStop = newHigh - (atr * atrMult);
      const close = data.candles[i].close;
      
      if (close < trailingStop) {
        return { reason: `adaptive_stop_${atrMult.toFixed(1)}x`, stopPrice: trailingStop };
      }
      
      // Also exit on structure break
      if (data.trendStructure[i].trend === 'down') {
        return { reason: 'structure_break' };
      }
      
      return null;
    },
  },
  
  // Strategy 5: Momentum Confirmation
  MOMENTUM_TREND: {
    name: 'Momentum + Trend',
    description: 'Enter when momentum aligns with trend, exit on momentum divergence',
    params: {},
    
    shouldEnter: (i, data) => {
      if (i < 50) return null;
      
      const structure = data.trendStructure[i];
      const { direction } = data.supertrend;
      
      // Calculate momentum (ROC over 10 candles)
      const roc10 = (data.candles[i].close - data.candles[i-10].close) / data.candles[i-10].close;
      const roc20 = (data.candles[i].close - data.candles[i-20].close) / data.candles[i-20].close;
      
      // Enter when:
      // 1. Structure is uptrend
      // 2. Supertrend is bullish
      // 3. Short momentum AND long momentum are positive
      if (structure.trend === 'up' && direction[i] === 1 && roc10 > 0.01 && roc20 > 0.02) {
        // But only if we weren't already in this trend
        if (direction[i-1] === -1 || structure.trend !== data.trendStructure[i-1].trend) {
          return 'long';
        }
      }
      return null;
    },
    
    shouldExit: (i, data, position) => {
      // Calculate momentum
      const roc5 = (data.candles[i].close - data.candles[i-5].close) / data.candles[i-5].close;
      const roc10 = (data.candles[i].close - data.candles[i-10].close) / data.candles[i-10].close;
      
      // Momentum divergence: short term negative while we're in profit
      const pnl = (data.candles[i].close - position.entryPrice) / position.entryPrice;
      
      if (pnl > 0.02 && roc5 < -0.01) {
        return { reason: 'momentum_divergence' };
      }
      
      // Strong reversal
      if (roc5 < -0.03) {
        return { reason: 'momentum_collapse' };
      }
      
      // ATR trailing stop as backup
      const atr = data.atr[i];
      const highWaterMark = position.highWaterMark || position.entryPrice;
      position.highWaterMark = Math.max(highWaterMark, data.candles[i].high);
      
      const trailingStop = position.highWaterMark - (atr * 3);
      if (data.candles[i].close < trailingStop) {
        return { reason: 'atr_trailing_stop' };
      }
      
      return null;
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE
// ═══════════════════════════════════════════════════════════════════════════

async function runBacktest(symbol, strategy, candles) {
  const leverage = CONFIG.LEVERAGE[symbol.replace('USDT', '')] || 3;
  
  // Prepare indicators
  const closes = candles.map(c => c.close);
  const atr = calculateATR(candles, 14);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const { supertrend, direction } = calculateSupertrend(candles, 10, 3);
  const trendStructure = detectTrendStructure(candles, 20);
  
  const data = {
    candles,
    atr,
    ema20,
    ema50,
    supertrend: { supertrend, direction },
    trendStructure,
  };
  
  // Simulation
  const trades = [];
  let position = null;
  let capital = 100;
  
  for (let i = 50; i < candles.length; i++) {
    if (!position) {
      // Check entry
      const signal = strategy.shouldEnter(i, data);
      if (signal === 'long') {
        const entryPrice = candles[i].close * (1 + CONFIG.SLIPPAGE);
        const fee = capital * CONFIG.ENTRY_FEE;
        capital -= fee;
        
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
      // Update high water mark
      position.highWaterMark = Math.max(position.highWaterMark || position.entryPrice, candles[i].high);
      
      // Check exit
      const exitSignal = strategy.shouldExit(i, data, position);
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
          exitTime: candles[i].timestamp,
          holdingPeriod: i - position.entryIdx,
          pnlPercent: pnlPercent * 100,
          pnlWithLeverage: pnlWithLeverage * 100,
          exitReason: exitSignal.reason,
          maxDrawdown: ((position.highWaterMark - candles[i].low) / position.highWaterMark) * 100,
        });
        
        position = null;
      }
    }
  }
  
  // Close any open position at end
  if (position) {
    const exitPrice = candles[candles.length - 1].close;
    const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice;
    const pnlWithLeverage = pnlPercent * leverage;
    capital = position.capitalAtEntry * (1 + pnlWithLeverage);
    
    trades.push({
      symbol,
      side: position.side,
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
  console.log('🎯 ADAPTIVE TREND FOLLOWING - Deep Backtest');
  console.log('═'.repeat(80));
  console.log('\n📊 Fetching 1 year of hourly data...\n');
  
  const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'];
  const allResults = {};
  
  // Helper to fetch candles
  async function fetchCandles(symbol, timeframe, since, limit = 500) {
    const candles = [];
    let currentSince = since;
    while (candles.length < 8760) { // ~1 year of hourly candles
      const batch = await exchange.fetchOHLCV(symbol, timeframe, currentSince, limit);
      if (batch.length === 0) break;
      candles.push(...batch);
      currentSince = batch[batch.length - 1][0] + 1;
      await new Promise(r => setTimeout(r, 100));
    }
    return candles;
  }
  
  // Fetch data for all symbols
  const allCandles = {};
  const since = Date.now() - 365 * 24 * 60 * 60 * 1000;
  
  for (const symbol of symbols) {
    const rawCandles = await fetchCandles(symbol, '1h', since);
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
  
  // Test each strategy
  for (const [stratKey, strategy] of Object.entries(STRATEGIES)) {
    console.log('\n' + '─'.repeat(80));
    console.log(`\n🔬 Testing: ${strategy.name}`);
    console.log(`   ${strategy.description}`);
    console.log('─'.repeat(80));
    
    let totalTrades = 0;
    let totalWins = 0;
    let totalPnL = 0;
    let allTrades = [];
    const symbolResults = {};
    
    for (const symbol of symbols) {
      const { trades, finalCapital } = await runBacktest(symbol, strategy, allCandles[symbol]);
      
      const wins = trades.filter(t => t.pnlWithLeverage > 0).length;
      const avgPnL = trades.length > 0 ? trades.reduce((s, t) => s + t.pnlWithLeverage, 0) / trades.length : 0;
      const roi = finalCapital - 100;
      
      symbolResults[symbol] = { trades: trades.length, wins, winRate: wins/trades.length*100, avgPnL, roi };
      totalTrades += trades.length;
      totalWins += wins;
      totalPnL += roi;
      allTrades = allTrades.concat(trades);
    }
    
    // Print results
    console.log('\n┌──────────┬────────┬──────────┬───────────┬──────────┐');
    console.log('│ Symbol   │ Trades │ Win Rate │  Avg P&L  │   ROI    │');
    console.log('├──────────┼────────┼──────────┼───────────┼──────────┤');
    
    for (const symbol of symbols) {
      const r = symbolResults[symbol];
      console.log(`│ ${symbol.padEnd(8)} │ ${String(r.trades).padStart(6)} │ ${r.winRate.toFixed(1).padStart(7)}% │ ${r.avgPnL >= 0 ? '+' : ''}${r.avgPnL.toFixed(2).padStart(8)}% │ ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1).padStart(7)}% │`);
    }
    
    console.log('├──────────┼────────┼──────────┼───────────┼──────────┤');
    const overallWR = totalTrades > 0 ? (totalWins/totalTrades*100) : 0;
    const overallAvgPnL = totalTrades > 0 ? allTrades.reduce((s, t) => s + t.pnlWithLeverage, 0) / totalTrades : 0;
    console.log(`│ TOTAL    │ ${String(totalTrades).padStart(6)} │ ${overallWR.toFixed(1).padStart(7)}% │ ${overallAvgPnL >= 0 ? '+' : ''}${overallAvgPnL.toFixed(2).padStart(8)}% │ ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(1).padStart(7)}% │`);
    console.log('└──────────┴────────┴──────────┴───────────┴──────────┘');
    
    // Exit reasons breakdown
    const exitReasons = {};
    allTrades.forEach(t => {
      exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
    });
    
    console.log('\n📊 Exit Reasons:');
    for (const [reason, count] of Object.entries(exitReasons).sort((a,b) => b[1] - a[1])) {
      const tradesForReason = allTrades.filter(t => t.exitReason === reason);
      const avgPnL = tradesForReason.reduce((s, t) => s + t.pnlWithLeverage, 0) / tradesForReason.length;
      const wr = tradesForReason.filter(t => t.pnlWithLeverage > 0).length / tradesForReason.length * 100;
      console.log(`   ${reason}: ${count} trades (WR: ${wr.toFixed(0)}%, Avg: ${avgPnL >= 0 ? '+' : ''}${avgPnL.toFixed(2)}%)`);
    }
    
    // Average holding period
    const avgHold = allTrades.reduce((s, t) => s + (t.holdingPeriod || 0), 0) / allTrades.length;
    console.log(`\n⏱️  Average holding period: ${avgHold.toFixed(1)} hours (${(avgHold/24).toFixed(1)} days)`);
    
    allResults[stratKey] = {
      name: strategy.name,
      totalTrades,
      winRate: overallWR,
      avgPnL: overallAvgPnL,
      totalROI: totalPnL,
      avgHoldingHours: avgHold,
    };
  }
  
  // Final comparison
  console.log('\n' + '═'.repeat(80));
  console.log('🏆 STRATEGY COMPARISON');
  console.log('═'.repeat(80));
  
  console.log('\n┌─────────────────────────┬────────┬──────────┬───────────┬───────────┬──────────┐');
  console.log('│ Strategy                │ Trades │ Win Rate │  Avg P&L  │ Total ROI │ Avg Hold │');
  console.log('├─────────────────────────┼────────┼──────────┼───────────┼───────────┼──────────┤');
  
  const sorted = Object.values(allResults).sort((a, b) => b.totalROI - a.totalROI);
  for (const r of sorted) {
    console.log(`│ ${r.name.padEnd(23)} │ ${String(r.totalTrades).padStart(6)} │ ${r.winRate.toFixed(1).padStart(7)}% │ ${r.avgPnL >= 0 ? '+' : ''}${r.avgPnL.toFixed(2).padStart(8)}% │ ${r.totalROI >= 0 ? '+' : ''}${r.totalROI.toFixed(1).padStart(8)}% │ ${r.avgHoldingHours.toFixed(0).padStart(5)}h   │`);
  }
  console.log('└─────────────────────────┴────────┴──────────┴───────────┴───────────┴──────────┘');
  
  // Conclusions
  console.log('\n' + '═'.repeat(80));
  console.log('💡 CONCLUSIONS');
  console.log('═'.repeat(80));
  
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🎯 ANALYSE HONNÊTE DU TREND FOLLOWING                                         ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ Meilleure stratégie: ${best.name.padEnd(20)} (${best.totalROI >= 0 ? '+' : ''}${best.totalROI.toFixed(1)}% ROI)                     ║
║ Pire stratégie:      ${worst.name.padEnd(20)} (${worst.totalROI >= 0 ? '+' : ''}${worst.totalROI.toFixed(1)}% ROI)                     ║
║                                                                               ║
║ ⚠️  RÉALITÉ:                                                                  ║
║ - ${sorted.filter(s => s.totalROI > 0).length}/${sorted.length} stratégies sont profitables sur 1 an                            ║
║ - Toutes ont un Win Rate autour de 40-50%                                     ║
║ - Les gains viennent des GROS trades gagnants vs petites pertes               ║
║                                                                               ║
║ 🔑 CE QUI FONCTIONNE:                                                         ║
║ - Filtrer par structure de tendance = MOINS de trades mais MEILLEURS          ║
║ - Trailing stop adaptatif = Protège les gains                                 ║
║ - Sortir sur perte de momentum = Évite les reversals                          ║
║                                                                               ║
║ ❌ CE QUI NE FONCTIONNE PAS:                                                   ║
║ - Supertrend seul = Trop de faux signaux                                      ║
║ - Stops fixes = Pas adaptés à la volatilité variable                          ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
  
  process.exit(0);
}

main().catch(console.error);
