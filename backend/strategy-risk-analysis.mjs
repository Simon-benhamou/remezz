/**
 * RISK ANALYSIS - Drawdown & Liquidation Risk
 * 
 * Questions à répondre:
 * 1. Quel est le drawdown maximum sur 12 mois?
 * 2. Risque de liquidation avec leverage?
 * 3. Combien de pertes consécutives max?
 * 4. Quel capital minimum pour survivre les mauvais mois?
 */

import fs from 'fs';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION V5
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  ENTRY_FEE: 0.0004,
  EXIT_FEE: 0.0004,
  SLIPPAGE: 0.0002,
  TOTAL_FEES: 0.001,
  
  LEVERAGE: { BTC: 3, ETH: 5, SOL: 5, XRP: 4 },
  
  // Entry: Breakout + momentum + volume + ConsecUp filter
  ENTRY: {
    BB_PERIOD: 20,
    BB_STD: 2,
    ROC_MIN: 0.015,
    VOLUME_MULT: 1.3,
    MAX_CONSEC_UP: 4,
  },
  
  // Exit: V3 optimized
  EXIT: {
    PROFIT_TARGET: 0.025,
    STOP_LOSS: 0.02,
    TRAILING_ACTIVATION: 0.015,
    TRAILING_DISTANCE: 0.008,
    MAX_HOLD: 48,
    VOLUME_EXIT_THRESHOLD: 0.5,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// LOAD DATA
// ═══════════════════════════════════════════════════════════════════════════

function loadData(symbol) {
  const path = `./data/${symbol}_USDT_1h.json`;
  if (!fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

// ═══════════════════════════════════════════════════════════════════════════
// INDICATORS
// ═══════════════════════════════════════════════════════════════════════════

function calculateBB(candles, period = 20, stdDev = 2) {
  const result = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      result.push({ upper: null, middle: null, lower: null });
      continue;
    }
    const slice = candles.slice(i - period + 1, i + 1);
    const closes = slice.map(c => c.close);
    const sma = closes.reduce((a, b) => a + b, 0) / period;
    const variance = closes.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
    const std = Math.sqrt(variance);
    result.push({
      upper: sma + stdDev * std,
      middle: sma,
      lower: sma - stdDev * std,
    });
  }
  return result;
}

function calculateSMA(candles, period) {
  const result = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }
    const slice = candles.slice(i - period + 1, i + 1);
    result.push(slice.reduce((a, b) => a + b.close, 0) / period);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST WITH DETAILED TRACKING
// ═══════════════════════════════════════════════════════════════════════════

function runDetailedBacktest(candles, symbol, btcSMA200 = null, btcCandles = null) {
  const leverage = CONFIG.LEVERAGE[symbol] || 3;
  const bb = calculateBB(candles, CONFIG.ENTRY.BB_PERIOD, CONFIG.ENTRY.BB_STD);
  
  const trades = [];
  const equityCurve = []; // Track capital at each hour
  let position = null;
  let capital = 1000; // Start with $1000
  
  // Track consecutive losses
  let consecLosses = 0;
  let maxConsecLosses = 0;
  
  for (let i = 50; i < candles.length; i++) {
    const c = candles[i];
    const date = new Date(c.timestamp);
    
    // Record equity every hour
    equityCurve.push({
      timestamp: c.timestamp,
      capital: position ? calculateUnrealizedCapital(position, c.close, capital, leverage) : capital,
      inPosition: !!position,
    });
    
    // Check regime filter (BTC > SMA200)
    let inBullRegime = true;
    if (btcSMA200 && btcCandles) {
      const btcClose = btcCandles[i]?.close;
      const sma200 = btcSMA200[i];
      if (btcClose && sma200) {
        inBullRegime = btcClose > sma200;
      }
    }
    
    if (!position) {
      // Skip if bear market
      if (!inBullRegime) continue;
      
      // Entry conditions
      if (!bb[i].upper) continue;
      
      const breakout = c.close > bb[i].upper;
      const roc = (c.close - candles[i - 10].close) / candles[i - 10].close;
      const avgVol = candles.slice(i - 20, i).reduce((a, b) => a + b.volume, 0) / 20;
      const volSpike = c.volume > avgVol * CONFIG.ENTRY.VOLUME_MULT;
      
      // Count consecutive up candles
      let consecUp = 0;
      for (let j = i; j > i - 10 && j > 0; j--) {
        if (candles[j].close > candles[j].open) consecUp++;
        else break;
      }
      
      if (breakout && roc > CONFIG.ENTRY.ROC_MIN && volSpike && consecUp <= CONFIG.ENTRY.MAX_CONSEC_UP) {
        const entryPrice = c.close * (1 + CONFIG.SLIPPAGE);
        const fee = capital * CONFIG.ENTRY_FEE;
        capital -= fee;
        
        position = {
          entryPrice,
          entryIdx: i,
          entryTime: c.timestamp,
          capitalAtEntry: capital,
          highPrice: entryPrice,
          stopLoss: entryPrice * (1 - CONFIG.EXIT.STOP_LOSS),
          trailingActive: false,
        };
      }
    } else {
      // Update high price for trailing
      if (c.high > position.highPrice) {
        position.highPrice = c.high;
        
        // Activate trailing stop
        const gain = (position.highPrice - position.entryPrice) / position.entryPrice;
        if (gain >= CONFIG.EXIT.TRAILING_ACTIVATION && !position.trailingActive) {
          position.trailingActive = true;
        }
        
        // Update trailing stop
        if (position.trailingActive) {
          const newStop = position.highPrice * (1 - CONFIG.EXIT.TRAILING_DISTANCE);
          if (newStop > position.stopLoss) {
            position.stopLoss = newStop;
          }
        }
      }
      
      // Check exit conditions
      let exitReason = null;
      let exitPrice = c.close;
      
      // Stop loss hit
      if (c.low <= position.stopLoss) {
        exitReason = position.trailingActive ? 'trailing_stop' : 'stop_loss';
        exitPrice = position.stopLoss;
      }
      
      // Take profit
      const gain = (c.close - position.entryPrice) / position.entryPrice;
      if (!exitReason && gain >= CONFIG.EXIT.PROFIT_TARGET) {
        exitReason = 'take_profit';
      }
      
      // Max hold time
      const holdTime = i - position.entryIdx;
      if (!exitReason && holdTime >= CONFIG.EXIT.MAX_HOLD) {
        exitReason = 'max_hold';
      }
      
      // Volume exit
      const avgVol = candles.slice(i - 20, i).reduce((a, b) => a + b.volume, 0) / 20;
      if (!exitReason && c.volume < avgVol * CONFIG.EXIT.VOLUME_EXIT_THRESHOLD && gain > 0.005) {
        exitReason = 'low_volume';
      }
      
      if (exitReason) {
        exitPrice = exitPrice * (1 - CONFIG.SLIPPAGE);
        const pnlPct = (exitPrice - position.entryPrice) / position.entryPrice;
        const pnlWithLeverage = pnlPct * leverage;
        
        const newCapital = position.capitalAtEntry * (1 + pnlWithLeverage);
        capital = newCapital * (1 - CONFIG.EXIT_FEE);
        
        // Track consecutive losses
        if (pnlWithLeverage < 0) {
          consecLosses++;
          if (consecLosses > maxConsecLosses) maxConsecLosses = consecLosses;
        } else {
          consecLosses = 0;
        }
        
        trades.push({
          symbol,
          entryTime: position.entryTime,
          exitTime: c.timestamp,
          entryPrice: position.entryPrice,
          exitPrice,
          pnlPct: pnlPct * 100,
          pnlWithLeverage: pnlWithLeverage * 100,
          capitalAfter: capital,
          exitReason,
          holdTime,
          maxDrawdownInTrade: ((position.highPrice - c.low) / position.highPrice) * 100,
        });
        
        position = null;
      }
    }
  }
  
  // Close open position
  if (position) {
    const exitPrice = candles[candles.length - 1].close;
    const pnlPct = (exitPrice - position.entryPrice) / position.entryPrice;
    const pnlWithLeverage = pnlPct * leverage;
    capital = position.capitalAtEntry * (1 + pnlWithLeverage);
    
    trades.push({
      symbol,
      entryTime: position.entryTime,
      exitTime: candles[candles.length - 1].timestamp,
      entryPrice: position.entryPrice,
      exitPrice,
      pnlPct: pnlPct * 100,
      pnlWithLeverage: pnlWithLeverage * 100,
      capitalAfter: capital,
      exitReason: 'end_of_data',
    });
  }
  
  return { trades, equityCurve, finalCapital: capital, maxConsecLosses };
}

function calculateUnrealizedCapital(position, currentPrice, capital, leverage) {
  const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
  const pnlWithLeverage = pnlPct * leverage;
  return position.capitalAtEntry * (1 + pnlWithLeverage);
}

// ═══════════════════════════════════════════════════════════════════════════
// RISK METRICS
// ═══════════════════════════════════════════════════════════════════════════

function calculateRiskMetrics(equityCurve, trades) {
  // Max Drawdown
  let peak = equityCurve[0].capital;
  let maxDrawdown = 0;
  let maxDrawdownPeriod = { start: null, end: null, duration: 0 };
  let currentDrawdownStart = null;
  
  for (let i = 0; i < equityCurve.length; i++) {
    const cap = equityCurve[i].capital;
    if (cap > peak) {
      peak = cap;
      currentDrawdownStart = null;
    } else {
      const dd = (peak - cap) / peak;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
        maxDrawdownPeriod.end = equityCurve[i].timestamp;
        if (!currentDrawdownStart) currentDrawdownStart = equityCurve[i].timestamp;
        maxDrawdownPeriod.start = currentDrawdownStart;
      }
    }
  }
  
  // Calculate drawdown duration
  if (maxDrawdownPeriod.start && maxDrawdownPeriod.end) {
    maxDrawdownPeriod.duration = Math.round((maxDrawdownPeriod.end - maxDrawdownPeriod.start) / (1000 * 60 * 60 * 24));
  }
  
  // Monthly breakdown
  const monthlyPnL = {};
  for (const trade of trades) {
    const month = new Date(trade.exitTime).toISOString().slice(0, 7);
    if (!monthlyPnL[month]) monthlyPnL[month] = { pnl: 0, trades: 0, wins: 0, losses: 0 };
    monthlyPnL[month].pnl += trade.pnlWithLeverage;
    monthlyPnL[month].trades++;
    if (trade.pnlWithLeverage > 0) monthlyPnL[month].wins++;
    else monthlyPnL[month].losses++;
  }
  
  // Worst single trade
  const worstTrade = trades.reduce((worst, t) => 
    t.pnlWithLeverage < worst.pnlWithLeverage ? t : worst, trades[0]);
  
  // Best single trade
  const bestTrade = trades.reduce((best, t) => 
    t.pnlWithLeverage > best.pnlWithLeverage ? t : best, trades[0]);
  
  // Stop loss stats
  const stopLosses = trades.filter(t => t.exitReason === 'stop_loss');
  const avgStopLossSize = stopLosses.length > 0 
    ? stopLosses.reduce((sum, t) => sum + t.pnlWithLeverage, 0) / stopLosses.length 
    : 0;
  
  return {
    maxDrawdown: maxDrawdown * 100,
    maxDrawdownPeriod,
    monthlyPnL,
    worstTrade,
    bestTrade,
    stopLossCount: stopLosses.length,
    avgStopLossSize,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LIQUIDATION ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

function analyzeLiquidationRisk(trades, symbol) {
  const leverage = CONFIG.LEVERAGE[symbol];
  
  // With leverage, liquidation occurs when loss = 100% of margin
  // E.g., 5x leverage: -20% move = -100% loss = liquidation
  const liquidationThreshold = 1 / leverage; // 20% for 5x, 25% for 4x
  
  // Check worst drawdown during each trade
  let nearLiquidations = 0;
  let worstIntraTrade = 0;
  
  for (const trade of trades) {
    if (trade.maxDrawdownInTrade) {
      const intraDDWithLeverage = (trade.maxDrawdownInTrade / 100) * leverage;
      if (intraDDWithLeverage > worstIntraTrade) {
        worstIntraTrade = intraDDWithLeverage;
      }
      // Near liquidation = within 50% of liquidation threshold
      if (trade.maxDrawdownInTrade / 100 > liquidationThreshold * 0.5) {
        nearLiquidations++;
      }
    }
  }
  
  return {
    leverage,
    liquidationThreshold: liquidationThreshold * 100,
    stopLossPct: CONFIG.EXIT.STOP_LOSS * 100,
    maxLossPerTrade: CONFIG.EXIT.STOP_LOSS * leverage * 100,
    worstIntraTradeLoss: worstIntraTrade * 100,
    nearLiquidations,
    isProtected: CONFIG.EXIT.STOP_LOSS < liquidationThreshold,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(80));
  console.log('🛡️  RISK ANALYSIS - Drawdown & Liquidation');
  console.log('═'.repeat(80));
  
  // Load data
  const symbols = ['ETH', 'XRP'];
  const allCandles = {};
  const btcCandles = loadData('BTC');
  const btcSMA200 = calculateSMA(btcCandles, 200);
  
  for (const symbol of symbols) {
    allCandles[symbol] = loadData(symbol);
    console.log(`   ${symbol}: ${allCandles[symbol].length} candles loaded`);
  }
  
  // Run backtest for each symbol
  let allTrades = [];
  let combinedEquity = null;
  const symbolResults = {};
  
  for (const symbol of symbols) {
    const { trades, equityCurve, finalCapital, maxConsecLosses } = runDetailedBacktest(
      allCandles[symbol], symbol, btcSMA200, btcCandles
    );
    
    symbolResults[symbol] = { trades, equityCurve, finalCapital, maxConsecLosses };
    allTrades = allTrades.concat(trades);
    
    // Combine equity curves (simplified: just merge)
    if (!combinedEquity) {
      combinedEquity = equityCurve.map(e => ({ ...e }));
    }
  }
  
  // Sort all trades by time
  allTrades.sort((a, b) => a.exitTime - b.exitTime);
  
  // Calculate combined capital curve
  let capital = 1000;
  const combinedCapital = [{ timestamp: allTrades[0]?.entryTime || Date.now(), capital: 1000 }];
  
  for (const trade of allTrades) {
    capital *= (1 + trade.pnlWithLeverage / 100);
    combinedCapital.push({ timestamp: trade.exitTime, capital });
  }
  
  // Risk metrics
  const riskMetrics = calculateRiskMetrics(combinedCapital, allTrades);
  
  console.log('\n' + '═'.repeat(80));
  console.log('📉 MAXIMUM DRAWDOWN ANALYSIS');
  console.log('═'.repeat(80));
  
  console.log(`
┌────────────────────────────────────────────────────────────────────────────────┐
│ 💰 STARTING CAPITAL: $1,000                                                    │
│ 💰 FINAL CAPITAL:    $${capital.toFixed(0).padStart(6)}                                                    │
│                                                                                │
│ 📉 MAX DRAWDOWN:     ${riskMetrics.maxDrawdown.toFixed(1)}%                                                  │
│ 📅 DRAWDOWN PERIOD:  ${riskMetrics.maxDrawdownPeriod.duration} days                                            │
│                                                                                │
│ 🔴 WORST TRADE:      ${riskMetrics.worstTrade.pnlWithLeverage.toFixed(1)}% (${riskMetrics.worstTrade.symbol}, ${riskMetrics.worstTrade.exitReason})       │
│ 🟢 BEST TRADE:       +${riskMetrics.bestTrade.pnlWithLeverage.toFixed(1)}% (${riskMetrics.bestTrade.symbol}, ${riskMetrics.bestTrade.exitReason})       │
│                                                                                │
│ 🛑 STOP LOSSES:      ${riskMetrics.stopLossCount} trades (avg: ${riskMetrics.avgStopLossSize.toFixed(1)}% per SL)              │
└────────────────────────────────────────────────────────────────────────────────┘
`);
  
  // Monthly breakdown
  console.log('\n📅 MONTHLY BREAKDOWN:');
  console.log('┌─────────────┬────────┬───────┬────────┬─────────────────────────────────────┐');
  console.log('│ Month       │ Trades │ W/L   │ PnL %  │ Visualization                       │');
  console.log('├─────────────┼────────┼───────┼────────┼─────────────────────────────────────┤');
  
  const months = Object.keys(riskMetrics.monthlyPnL).sort();
  for (const month of months) {
    const m = riskMetrics.monthlyPnL[month];
    const bar = m.pnl >= 0 
      ? '🟢'.repeat(Math.min(Math.round(m.pnl / 10), 20))
      : '🔴'.repeat(Math.min(Math.round(Math.abs(m.pnl) / 10), 20));
    console.log(`│ ${month}   │ ${String(m.trades).padStart(6)} │ ${m.wins}/${m.losses}   │ ${m.pnl >= 0 ? '+' : ''}${m.pnl.toFixed(1).padStart(6)}% │ ${bar.padEnd(37)} │`);
  }
  console.log('└─────────────┴────────┴───────┴────────┴─────────────────────────────────────┘');
  
  // Liquidation analysis
  console.log('\n' + '═'.repeat(80));
  console.log('⚠️  LIQUIDATION RISK ANALYSIS');
  console.log('═'.repeat(80));
  
  for (const symbol of symbols) {
    const liqAnalysis = analyzeLiquidationRisk(symbolResults[symbol].trades, symbol);
    
    console.log(`
┌─────────────────────────────────────────────────────────────────────────────────┐
│ ${symbol} - Leverage ${liqAnalysis.leverage}x                                                           │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Prix de liquidation:     ${liqAnalysis.liquidationThreshold.toFixed(0)}% contre nous                                │
│ Stop Loss configuré:     ${liqAnalysis.stopLossPct.toFixed(1)}% (soit ${liqAnalysis.maxLossPerTrade.toFixed(0)}% max perte par trade)            │
│ Protection:              ${liqAnalysis.isProtected ? '✅ PROTÉGÉ (SL < liquidation)' : '❌ RISQUE (SL > liquidation)'}                  │
│                                                                                 │
│ Pire perte intra-trade:  ${liqAnalysis.worstIntraTradeLoss.toFixed(1)}% (${liqAnalysis.worstIntraTradeLoss > 80 ? '⚠️ PROCHE LIQUIDATION' : '✅ OK'})                           │
│ Trades proches liqui:    ${liqAnalysis.nearLiquidations} sur ${symbolResults[symbol].trades.length}                                       │
│ Max pertes consécutives: ${symbolResults[symbol].maxConsecLosses}                                                │
└─────────────────────────────────────────────────────────────────────────────────┘`);
  }
  
  // Consecutive losses analysis
  console.log('\n' + '═'.repeat(80));
  console.log('📊 CONSECUTIVE LOSSES ANALYSIS');
  console.log('═'.repeat(80));
  
  // Find all losing streaks
  let currentStreak = 0;
  let maxStreak = 0;
  const streaks = [];
  let streakStart = null;
  
  for (const trade of allTrades) {
    if (trade.pnlWithLeverage < 0) {
      if (currentStreak === 0) streakStart = trade.entryTime;
      currentStreak++;
      if (currentStreak > maxStreak) maxStreak = currentStreak;
    } else {
      if (currentStreak > 0) {
        streaks.push({ length: currentStreak, start: streakStart, end: trade.exitTime });
      }
      currentStreak = 0;
    }
  }
  
  // Impact of worst streak
  const worstStreakLosses = allTrades
    .filter(t => t.pnlWithLeverage < 0)
    .sort((a, b) => a.pnlWithLeverage - b.pnlWithLeverage)
    .slice(0, maxStreak);
  
  const worstStreakTotal = worstStreakLosses.reduce((sum, t) => {
    return sum * (1 + t.pnlWithLeverage / 100);
  }, 1);
  
  console.log(`
┌────────────────────────────────────────────────────────────────────────────────┐
│ Max pertes consécutives:  ${maxStreak} trades                                            │
│ Si ${maxStreak} pires trades d'affilée: ${((1 - worstStreakTotal) * 100).toFixed(1)}% de perte sur capital                   │
│                                                                                │
│ Avec $1000 initial:                                                            │
│ - Après 1 SL (-10%):     $900                                                  │
│ - Après 2 SL (-10%):     $810                                                  │
│ - Après 3 SL (-10%):     $729                                                  │
│ - Après 4 SL (-10%):     $656                                                  │
│ - Après 5 SL (-10%):     $590                                                  │
│                                                                                │
│ ➡️  ${maxStreak} pertes consécutives = ${((1 - Math.pow(0.9, maxStreak)) * 100).toFixed(1)}% drawdown                                  │
└────────────────────────────────────────────────────────────────────────────────┘
`);
  
  // Position sizing recommendation
  console.log('\n' + '═'.repeat(80));
  console.log('💡 RECOMMANDATIONS DE POSITION SIZING');
  console.log('═'.repeat(80));
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🎯 POUR ÉVITER LA LIQUIDATION ET SURVIVRE LES MAUVAIS MOIS:                   ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ OPTION 1: RISK 100% DU CAPITAL PAR TRADE (actuel)                             ║
║ ───────────────────────────────────────────────────────────────────────────── ║
║ • Chaque trade utilise 100% du capital disponible                             ║
║ • Stop Loss = -2% → Perte = -10% (avec 5x)                                    ║
║ • Après 5 pertes consécutives: -41% du capital                                ║
║ • ⚠️  RISQUE ÉLEVÉ mais gains maximum                                         ║
║                                                                               ║
║ OPTION 2: RISK 50% DU CAPITAL PAR TRADE                                       ║
║ ───────────────────────────────────────────────────────────────────────────── ║
║ • Chaque trade utilise 50% du capital                                         ║
║ • Stop Loss = -2% → Perte = -5% du total                                      ║
║ • Après 5 pertes: -23% du capital                                             ║
║ • ✅ Plus sûr, gains réduits de ~50%                                          ║
║                                                                               ║
║ OPTION 3: FIXED RISK 2% DU CAPITAL                                            ║
║ ───────────────────────────────────────────────────────────────────────────── ║
║ • Risquer max 2% par trade                                                    ║
║ • Avec SL -10%, position = 20% du capital                                     ║
║ • Après 5 pertes: -10% du capital                                             ║
║ • ✅✅ TRÈS SÛR mais gains très réduits                                        ║
║                                                                               ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ 📊 SUR CETTE STRATÉGIE V5 (ETH+XRP, regime filter):                           ║
║                                                                               ║
║ • Max Drawdown historique: ${riskMetrics.maxDrawdown.toFixed(1)}%                                          ║
║ • Max pertes consécutives: ${maxStreak}                                                     ║
║ • Mois négatifs: ${months.filter(m => riskMetrics.monthlyPnL[m].pnl < 0).length}/12                                                          ║
║                                                                               ║
║ 🎯 RECOMMANDATION:                                                            ║
║ Si capital < $5000: Utiliser 50% max par trade                                ║
║ Si capital $5000-$20000: Utiliser 75% par trade                               ║
║ Si capital > $20000: Peut utiliser 100%                                       ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
  
  // Final summary
  console.log('\n' + '═'.repeat(80));
  console.log('📋 RÉSUMÉ FINAL - RISQUES VS REWARDS');
  console.log('═'.repeat(80));
  
  const positiveMonths = months.filter(m => riskMetrics.monthlyPnL[m].pnl > 0).length;
  const negativeMonths = months.filter(m => riskMetrics.monthlyPnL[m].pnl < 0).length;
  const avgPositiveMonth = months.filter(m => riskMetrics.monthlyPnL[m].pnl > 0)
    .reduce((sum, m) => sum + riskMetrics.monthlyPnL[m].pnl, 0) / positiveMonths || 0;
  const avgNegativeMonth = months.filter(m => riskMetrics.monthlyPnL[m].pnl < 0)
    .reduce((sum, m) => sum + riskMetrics.monthlyPnL[m].pnl, 0) / negativeMonths || 0;
  
  console.log(`
┌────────────────────────────────────────────────────────────────────────────────┐
│ ✅ AVANTAGES:                                                                  │
│ • Stop Loss protège de la liquidation (SL 2% < liqui 20%)                      │
│ • Win rate: ${(allTrades.filter(t => t.pnlWithLeverage > 0).length / allTrades.length * 100).toFixed(1)}%                                                           │
│ • Mois positif moyen: +${avgPositiveMonth.toFixed(1)}%                                              │
│ • ROI total: +${((capital - 1000) / 10).toFixed(0)}%                                                         │
│                                                                                │
│ ⚠️  RISQUES:                                                                   │
│ • ${negativeMonths}/12 mois négatifs                                                       │
│ • Mois négatif moyen: ${avgNegativeMonth.toFixed(1)}%                                              │
│ • Max drawdown: ${riskMetrics.maxDrawdown.toFixed(1)}%                                                      │
│ • Max pertes consécutives: ${maxStreak}                                                    │
│                                                                                │
│ 🎯 VERDICT:                                                                    │
│ ${riskMetrics.maxDrawdown < 30 ? '✅ Drawdown acceptable (<30%)' : '⚠️ Drawdown élevé (>30%)'}                                                │
│ ${maxStreak <= 4 ? '✅ Séries de pertes gérables (≤4)' : '⚠️ Séries de pertes risquées (>4)'}                                        │
│ ${positiveMonths >= 6 ? '✅ Majorité de mois positifs' : '⚠️ Trop de mois négatifs'}                                              │
└────────────────────────────────────────────────────────────────────────────────┘
`);
}

main().catch(console.error);
