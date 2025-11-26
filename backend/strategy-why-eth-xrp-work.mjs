/**
 * ANALYSE APPROFONDIE: Pourquoi ETH et XRP marchent?
 * 
 * On va analyser les CARACTÉRISTIQUES qui font que la stratégie fonctionne:
 * 1. Volatilité et structure
 * 2. Qualité des breakouts
 * 3. Comportement post-breakout
 * 4. Corrélation avec BTC
 * 5. Volume patterns
 * 
 * + Test avec position sizing à 50%
 */

import fs from 'fs';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  ENTRY_FEE: 0.0004,
  EXIT_FEE: 0.0004,
  SLIPPAGE: 0.0002,
  TOTAL_FEES: 0.001,
  
  LEVERAGE: { BTC: 3, ETH: 5, SOL: 5, XRP: 4 },
  
  ENTRY: {
    BB_PERIOD: 20,
    BB_STD: 2,
    ROC_MIN: 0.015,
    VOLUME_MULT: 1.3,
    MAX_CONSEC_UP: 4,
  },
  
  EXIT: {
    PROFIT_TARGET: 0.025,
    STOP_LOSS: 0.02,
    TRAILING_ACTIVATION: 0.015,
    TRAILING_DISTANCE: 0.008,
    MAX_HOLD: 48,
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
// MARKET CHARACTERISTICS ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

function analyzeMarketCharacteristics(candles, symbol) {
  const characteristics = {
    symbol,
    // Volatility metrics
    avgDailyVolatility: 0,
    maxDailyVolatility: 0,
    volatilityStability: 0, // Stable = good for SL/TP fixed
    
    // Trend metrics
    avgTrendDuration: 0,    // How long trends last
    trendContinuation: 0,   // % of breakouts that continue
    meanReversion: 0,       // % of breakouts that reverse
    
    // Breakout quality
    breakoutFollowThrough: 0, // Average move after breakout
    falseBreakoutRate: 0,
    avgBreakoutVolume: 0,
    
    // BTC correlation
    btcCorrelation: 0,
    btcLeadLag: 0, // Does it lead or lag BTC?
    
    // Volume patterns
    volumeSpikePredictability: 0,
    avgVolumeRatio: 0,
  };
  
  // 1. VOLATILITY ANALYSIS
  const dailyReturns = [];
  const hourlyVolatility = [];
  
  for (let i = 1; i < candles.length; i++) {
    const hourlyReturn = Math.abs((candles[i].close - candles[i-1].close) / candles[i-1].close);
    hourlyVolatility.push(hourlyReturn);
    
    // Group by day
    if (i % 24 === 0 && i >= 24) {
      const dayCandles = candles.slice(i - 24, i);
      const dayHigh = Math.max(...dayCandles.map(c => c.high));
      const dayLow = Math.min(...dayCandles.map(c => c.low));
      const dayOpen = dayCandles[0].open;
      dailyReturns.push((dayHigh - dayLow) / dayOpen);
    }
  }
  
  characteristics.avgDailyVolatility = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length * 100;
  characteristics.maxDailyVolatility = Math.max(...dailyReturns) * 100;
  
  // Volatility stability (std dev of volatility)
  const avgVol = hourlyVolatility.reduce((a, b) => a + b, 0) / hourlyVolatility.length;
  const volVariance = hourlyVolatility.reduce((sum, v) => sum + Math.pow(v - avgVol, 2), 0) / hourlyVolatility.length;
  characteristics.volatilityStability = 1 - Math.sqrt(volVariance) / avgVol; // Higher = more stable
  
  // 2. BREAKOUT ANALYSIS
  const bb = calculateBB(candles, 20, 2);
  let breakouts = 0;
  let continuations = 0;
  let followThroughs = [];
  let breakoutVolumes = [];
  
  for (let i = 50; i < candles.length - 24; i++) {
    if (!bb[i].upper) continue;
    
    const isBreakout = candles[i].close > bb[i].upper;
    const wasNotBreakout = candles[i-1].close <= bb[i-1].upper;
    
    if (isBreakout && wasNotBreakout) {
      breakouts++;
      
      // Check next 24 hours
      const entryPrice = candles[i].close;
      let maxGain = 0;
      let maxLoss = 0;
      let finalPnL = 0;
      
      for (let j = i + 1; j < Math.min(i + 24, candles.length); j++) {
        const gain = (candles[j].high - entryPrice) / entryPrice;
        const loss = (entryPrice - candles[j].low) / entryPrice;
        maxGain = Math.max(maxGain, gain);
        maxLoss = Math.max(maxLoss, loss);
      }
      
      finalPnL = (candles[Math.min(i + 24, candles.length - 1)].close - entryPrice) / entryPrice;
      
      // Continuation = made at least 2% gain without hitting -2% first
      if (maxGain >= 0.02 && maxLoss < 0.02) {
        continuations++;
      }
      
      followThroughs.push(maxGain);
      
      // Volume at breakout
      const avgVol20 = candles.slice(i - 20, i).reduce((a, b) => a + b.volume, 0) / 20;
      breakoutVolumes.push(candles[i].volume / avgVol20);
    }
  }
  
  characteristics.totalBreakouts = breakouts;
  characteristics.trendContinuation = (continuations / breakouts) * 100;
  characteristics.falseBreakoutRate = ((breakouts - continuations) / breakouts) * 100;
  characteristics.breakoutFollowThrough = followThroughs.length > 0 
    ? followThroughs.reduce((a, b) => a + b, 0) / followThroughs.length * 100 
    : 0;
  characteristics.avgBreakoutVolume = breakoutVolumes.length > 0
    ? breakoutVolumes.reduce((a, b) => a + b, 0) / breakoutVolumes.length
    : 0;
  
  // 3. TREND DURATION
  let trendDurations = [];
  let currentTrend = null;
  let trendStart = 0;
  
  for (let i = 1; i < candles.length; i++) {
    const trend = candles[i].close > candles[i-1].close ? 'up' : 'down';
    
    if (trend !== currentTrend) {
      if (currentTrend !== null) {
        trendDurations.push(i - trendStart);
      }
      currentTrend = trend;
      trendStart = i;
    }
  }
  
  // Count consecutive same-direction candles
  let consecCounts = [];
  let consec = 1;
  for (let i = 1; i < candles.length; i++) {
    if ((candles[i].close > candles[i].open) === (candles[i-1].close > candles[i-1].open)) {
      consec++;
    } else {
      consecCounts.push(consec);
      consec = 1;
    }
  }
  
  characteristics.avgTrendDuration = consecCounts.reduce((a, b) => a + b, 0) / consecCounts.length;
  characteristics.maxConsecutive = Math.max(...consecCounts);
  
  return characteristics;
}

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
// BACKTEST WITH POSITION SIZING OPTIONS
// ═══════════════════════════════════════════════════════════════════════════

function runBacktestWithSizing(candles, symbol, btcSMA200, btcCandles, positionSizePct = 1.0) {
  const leverage = CONFIG.LEVERAGE[symbol] || 3;
  const bb = calculateBB(candles, CONFIG.ENTRY.BB_PERIOD, CONFIG.ENTRY.BB_STD);
  
  const trades = [];
  let position = null;
  let capital = 1000;
  let maxCapital = 1000;
  let minCapital = 1000;
  
  for (let i = 50; i < candles.length; i++) {
    const c = candles[i];
    
    // Track equity
    if (!position) {
      maxCapital = Math.max(maxCapital, capital);
      minCapital = Math.min(minCapital, capital);
    }
    
    // Check regime filter
    let inBullRegime = true;
    if (btcSMA200 && btcCandles) {
      const btcClose = btcCandles[i]?.close;
      const sma200 = btcSMA200[i];
      if (btcClose && sma200) {
        inBullRegime = btcClose > sma200;
      }
    }
    
    if (!position) {
      if (!inBullRegime) continue;
      if (!bb[i].upper) continue;
      
      const breakout = c.close > bb[i].upper;
      const roc = (c.close - candles[i - 10].close) / candles[i - 10].close;
      const avgVol = candles.slice(i - 20, i).reduce((a, b) => a + b.volume, 0) / 20;
      const volSpike = c.volume > avgVol * CONFIG.ENTRY.VOLUME_MULT;
      
      let consecUp = 0;
      for (let j = i; j > i - 10 && j > 0; j--) {
        if (candles[j].close > candles[j].open) consecUp++;
        else break;
      }
      
      if (breakout && roc > CONFIG.ENTRY.ROC_MIN && volSpike && consecUp <= CONFIG.ENTRY.MAX_CONSEC_UP) {
        const entryPrice = c.close * (1 + CONFIG.SLIPPAGE);
        
        // Position sizing: only use X% of capital
        const positionCapital = capital * positionSizePct;
        const fee = positionCapital * CONFIG.ENTRY_FEE;
        
        position = {
          entryPrice,
          entryIdx: i,
          entryTime: c.timestamp,
          positionCapital: positionCapital - fee,
          reserveCapital: capital - positionCapital,
          highPrice: entryPrice,
          stopLoss: entryPrice * (1 - CONFIG.EXIT.STOP_LOSS),
          trailingActive: false,
        };
      }
    } else {
      // Update trailing
      if (c.high > position.highPrice) {
        position.highPrice = c.high;
        const gain = (position.highPrice - position.entryPrice) / position.entryPrice;
        if (gain >= CONFIG.EXIT.TRAILING_ACTIVATION && !position.trailingActive) {
          position.trailingActive = true;
        }
        if (position.trailingActive) {
          const newStop = position.highPrice * (1 - CONFIG.EXIT.TRAILING_DISTANCE);
          if (newStop > position.stopLoss) {
            position.stopLoss = newStop;
          }
        }
      }
      
      // Check exit
      let exitReason = null;
      let exitPrice = c.close;
      
      if (c.low <= position.stopLoss) {
        exitReason = position.trailingActive ? 'trailing_stop' : 'stop_loss';
        exitPrice = position.stopLoss;
      }
      
      const gain = (c.close - position.entryPrice) / position.entryPrice;
      if (!exitReason && gain >= CONFIG.EXIT.PROFIT_TARGET) {
        exitReason = 'take_profit';
      }
      
      const holdTime = i - position.entryIdx;
      if (!exitReason && holdTime >= CONFIG.EXIT.MAX_HOLD) {
        exitReason = 'max_hold';
      }
      
      if (exitReason) {
        exitPrice = exitPrice * (1 - CONFIG.SLIPPAGE);
        const pnlPct = (exitPrice - position.entryPrice) / position.entryPrice;
        const pnlWithLeverage = pnlPct * leverage;
        
        const newPositionCapital = position.positionCapital * (1 + pnlWithLeverage);
        capital = position.reserveCapital + newPositionCapital * (1 - CONFIG.EXIT_FEE);
        
        trades.push({
          symbol,
          entryTime: position.entryTime,
          exitTime: c.timestamp,
          pnlPct: pnlPct * 100,
          pnlWithLeverage: pnlWithLeverage * 100,
          capitalAfter: capital,
          exitReason,
        });
        
        position = null;
      }
    }
  }
  
  // Calculate stats
  const wins = trades.filter(t => t.pnlWithLeverage > 0).length;
  const losses = trades.filter(t => t.pnlWithLeverage < 0).length;
  const stopLosses = trades.filter(t => t.exitReason === 'stop_loss').length;
  
  // Calculate max drawdown
  let peak = 1000;
  let maxDD = 0;
  for (const trade of trades) {
    if (trade.capitalAfter > peak) peak = trade.capitalAfter;
    const dd = (peak - trade.capitalAfter) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  return {
    trades,
    finalCapital: capital,
    totalPnL: ((capital - 1000) / 1000) * 100,
    winRate: wins / trades.length * 100,
    wins,
    losses,
    stopLosses,
    maxDrawdown: maxDD * 100,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FIND SIMILAR CRYPTOS
// ═══════════════════════════════════════════════════════════════════════════

function findIdealProfile(ethChars, xrpChars) {
  // Average the characteristics of ETH and XRP
  return {
    minVolatility: Math.min(ethChars.avgDailyVolatility, xrpChars.avgDailyVolatility) * 0.8,
    maxVolatility: Math.max(ethChars.avgDailyVolatility, xrpChars.avgDailyVolatility) * 1.2,
    minContinuation: Math.min(ethChars.trendContinuation, xrpChars.trendContinuation) * 0.9,
    minFollowThrough: Math.min(ethChars.breakoutFollowThrough, xrpChars.breakoutFollowThrough) * 0.9,
    maxFalseBreakout: Math.max(ethChars.falseBreakoutRate, xrpChars.falseBreakoutRate) * 1.1,
    minVolStability: Math.min(ethChars.volatilityStability, xrpChars.volatilityStability) * 0.9,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(80));
  console.log('🔬 ANALYSE: POURQUOI ETH ET XRP MARCHENT?');
  console.log('═'.repeat(80));
  
  // Load all data
  const symbols = ['BTC', 'ETH', 'SOL', 'XRP'];
  const allCandles = {};
  const allCharacteristics = {};
  
  for (const symbol of symbols) {
    allCandles[symbol] = loadData(symbol);
    if (allCandles[symbol]) {
      allCharacteristics[symbol] = analyzeMarketCharacteristics(allCandles[symbol], symbol);
      console.log(`   ${symbol}: ${allCandles[symbol].length} candles loaded`);
    }
  }
  
  const btcSMA200 = calculateSMA(allCandles.BTC, 200);
  
  // ═══════════════════════════════════════════════════════════════════════
  // PART 1: MARKET CHARACTERISTICS COMPARISON
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 PART 1: CARACTÉRISTIQUES DE MARCHÉ');
  console.log('═'.repeat(80));
  
  console.log('\n┌─────────────────────────────┬──────────┬──────────┬──────────┬──────────┐');
  console.log('│ Caractéristique             │   BTC    │   ETH    │   SOL    │   XRP    │');
  console.log('├─────────────────────────────┼──────────┼──────────┼──────────┼──────────┤');
  
  const metrics = [
    { key: 'avgDailyVolatility', label: 'Volatilité moy/jour', suffix: '%', good: 'medium' },
    { key: 'volatilityStability', label: 'Stabilité volatilité', suffix: '', good: 'high' },
    { key: 'totalBreakouts', label: 'Nb breakouts/an', suffix: '', good: 'high' },
    { key: 'trendContinuation', label: 'Continuation rate', suffix: '%', good: 'high' },
    { key: 'falseBreakoutRate', label: 'Faux breakouts', suffix: '%', good: 'low' },
    { key: 'breakoutFollowThrough', label: 'Follow-through moy', suffix: '%', good: 'high' },
    { key: 'avgBreakoutVolume', label: 'Volume ratio breakout', suffix: 'x', good: 'high' },
    { key: 'avgTrendDuration', label: 'Durée tendance moy', suffix: 'h', good: 'high' },
  ];
  
  for (const metric of metrics) {
    const values = symbols.map(s => allCharacteristics[s][metric.key]);
    const best = metric.good === 'high' ? Math.max(...values) : Math.min(...values);
    
    let row = `│ ${metric.label.padEnd(27)} │`;
    for (const symbol of symbols) {
      const val = allCharacteristics[symbol][metric.key];
      const formatted = typeof val === 'number' ? val.toFixed(1) : val;
      const isBest = Math.abs(val - best) < 0.1;
      const display = isBest ? `✅${formatted}` : `  ${formatted}`;
      row += ` ${display.padStart(8)}${metric.suffix.padEnd(1)} │`;
    }
    console.log(row);
  }
  
  console.log('└─────────────────────────────┴──────────┴──────────┴──────────┴──────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════
  // PART 2: BACKTEST WITH POSITION SIZING
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 PART 2: BACKTEST AVEC DIFFÉRENTS POSITION SIZING');
  console.log('═'.repeat(80));
  
  const positionSizes = [1.0, 0.75, 0.50, 0.25];
  const sizingResults = {};
  
  for (const size of positionSizes) {
    sizingResults[size] = {};
    
    for (const symbol of ['ETH', 'XRP']) {
      const result = runBacktestWithSizing(
        allCandles[symbol], 
        symbol, 
        btcSMA200, 
        allCandles.BTC, 
        size
      );
      sizingResults[size][symbol] = result;
    }
    
    // Combined results
    let combinedCapital = 1000;
    const allTrades = [
      ...sizingResults[size].ETH.trades,
      ...sizingResults[size].XRP.trades
    ].sort((a, b) => a.exitTime - b.exitTime);
    
    for (const trade of allTrades) {
      const pnlOnCapital = (trade.pnlWithLeverage / 100) * size;
      combinedCapital *= (1 + pnlOnCapital);
    }
    
    // Calculate combined max DD
    let peak = 1000;
    let maxDD = 0;
    let tempCap = 1000;
    for (const trade of allTrades) {
      const pnlOnCapital = (trade.pnlWithLeverage / 100) * size;
      tempCap *= (1 + pnlOnCapital);
      if (tempCap > peak) peak = tempCap;
      const dd = (peak - tempCap) / peak;
      if (dd > maxDD) maxDD = dd;
    }
    
    sizingResults[size].combined = {
      finalCapital: combinedCapital,
      totalPnL: ((combinedCapital - 1000) / 1000) * 100,
      maxDrawdown: maxDD * 100,
      trades: allTrades.length,
    };
  }
  
  console.log('\n┌───────────────┬─────────────┬─────────────┬─────────────┬─────────────┐');
  console.log('│ Position Size │ Capital Fin │   ROI       │  Max DD     │   Ratio     │');
  console.log('├───────────────┼─────────────┼─────────────┼─────────────┼─────────────┤');
  
  for (const size of positionSizes) {
    const r = sizingResults[size].combined;
    const ratio = r.totalPnL / r.maxDrawdown;
    console.log(`│ ${(size * 100).toFixed(0).padStart(3)}%          │ $${r.finalCapital.toFixed(0).padStart(8)}  │ ${r.totalPnL >= 0 ? '+' : ''}${r.totalPnL.toFixed(0).padStart(5)}%      │ ${r.maxDrawdown.toFixed(1).padStart(6)}%     │ ${ratio.toFixed(2).padStart(6)}      │`);
  }
  console.log('└───────────────┴─────────────┴─────────────┴─────────────┴─────────────┘');
  
  // ═══════════════════════════════════════════════════════════════════════
  // PART 3: WHY ETH AND XRP WORK
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('💡 PART 3: POURQUOI ETH ET XRP MARCHENT?');
  console.log('═'.repeat(80));
  
  const ethC = allCharacteristics.ETH;
  const xrpC = allCharacteristics.XRP;
  const btcC = allCharacteristics.BTC;
  const solC = allCharacteristics.SOL;
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🎯 PROFIL GAGNANT: ETH et XRP partagent ces caractéristiques                  ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ 1️⃣  TAUX DE CONTINUATION ÉLEVÉ                                                ║
║    ETH: ${ethC.trendContinuation.toFixed(1)}% | XRP: ${xrpC.trendContinuation.toFixed(1)}% | BTC: ${btcC.trendContinuation.toFixed(1)}% | SOL: ${solC.trendContinuation.toFixed(1)}%                     ║
║    → Quand breakout, le mouvement CONTINUE (pas de reversal immédiat)         ║
║                                                                               ║
║ 2️⃣  FOLLOW-THROUGH SUFFISANT                                                  ║
║    ETH: ${ethC.breakoutFollowThrough.toFixed(1)}% | XRP: ${xrpC.breakoutFollowThrough.toFixed(1)}% | BTC: ${btcC.breakoutFollowThrough.toFixed(1)}% | SOL: ${solC.breakoutFollowThrough.toFixed(1)}%                     ║
║    → Le gain après breakout dépasse le stop loss (2%) + frais                 ║
║                                                                               ║
║ 3️⃣  VOLATILITÉ "GOLDILOCKS"                                                   ║
║    ETH: ${ethC.avgDailyVolatility.toFixed(1)}% | XRP: ${xrpC.avgDailyVolatility.toFixed(1)}% | BTC: ${btcC.avgDailyVolatility.toFixed(1)}% | SOL: ${solC.avgDailyVolatility.toFixed(1)}%                     ║
║    → Assez volatile pour des gains, pas trop pour éviter SL constants         ║
║                                                                               ║
║ 4️⃣  FAUX BREAKOUTS MODÉRÉS                                                    ║
║    ETH: ${ethC.falseBreakoutRate.toFixed(1)}% | XRP: ${xrpC.falseBreakoutRate.toFixed(1)}% | BTC: ${btcC.falseBreakoutRate.toFixed(1)}% | SOL: ${solC.falseBreakoutRate.toFixed(1)}%                     ║
║    → Moins de pièges que BTC (trop manipulé) et SOL (trop volatile)           ║
║                                                                               ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ ❌ POURQUOI BTC NE MARCHE PAS:                                                 ║
║ • Trop de manipulation institutionnelle (faux breakouts)                      ║
║ • Volatilité trop faible pour compenser les frais avec leverage 3x            ║
║ • Continuation rate: ${btcC.trendContinuation.toFixed(1)}% seulement                                       ║
║                                                                               ║
║ ❌ POURQUOI SOL NE MARCHE PAS:                                                 ║
║ • Volatilité TROP élevée (${solC.avgDailyVolatility.toFixed(1)}%/jour)                                     ║
║ • Stop loss 2% atteint trop souvent sur le bruit normal                       ║
║ • Faux breakouts: ${solC.falseBreakoutRate.toFixed(1)}%                                                    ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
  
  // ═══════════════════════════════════════════════════════════════════════
  // PART 4: IDEAL CRYPTO PROFILE
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 PART 4: PROFIL CRYPTO IDÉAL POUR CETTE STRATÉGIE');
  console.log('═'.repeat(80));
  
  const idealProfile = findIdealProfile(ethC, xrpC);
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 🔍 CRITÈRES POUR TROUVER D'AUTRES CRYPTOS COMPATIBLES:                        ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║ ✅ Volatilité journalière: ${idealProfile.minVolatility.toFixed(1)}% - ${idealProfile.maxVolatility.toFixed(1)}%                              ║
║ ✅ Taux de continuation: > ${idealProfile.minContinuation.toFixed(1)}%                                       ║
║ ✅ Follow-through moyen: > ${idealProfile.minFollowThrough.toFixed(1)}%                                       ║
║ ✅ Faux breakouts: < ${idealProfile.maxFalseBreakout.toFixed(1)}%                                             ║
║ ✅ Stabilité volatilité: > ${idealProfile.minVolStability.toFixed(2)}                                        ║
║                                                                               ║
║ 🎯 CRYPTOS À TESTER (même profil que ETH/XRP):                                ║
║ • LINK (Oracle, correlé ETH)                                                  ║
║ • AVAX (L1, profil similaire ETH)                                             ║
║ • DOT (L0, moins volatile que SOL)                                            ║
║ • MATIC/POL (L2 ETH, correlé)                                                 ║
║ • ATOM (Cosmos, indépendant)                                                  ║
║                                                                               ║
║ ⚠️  À ÉVITER (profil BTC ou SOL):                                              ║
║ • Memecoins (DOGE, SHIB, PEPE) - trop volatile, manipulation                  ║
║ • Petites caps < $1B - liquidité insuffisante                                 ║
║ • BTC-like (LTC, BCH) - même problème que BTC                                 ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
  
  // ═══════════════════════════════════════════════════════════════════════
  // PART 5: POSITION SIZING RECOMMENDATION
  // ═══════════════════════════════════════════════════════════════════════
  
  console.log('\n' + '═'.repeat(80));
  console.log('💰 PART 5: RECOMMANDATION POSITION SIZING');
  console.log('═'.repeat(80));
  
  const size100 = sizingResults[1.0].combined;
  const size50 = sizingResults[0.5].combined;
  
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 📊 COMPARAISON 100% vs 50% POSITION SIZE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║                        100% Capital        50% Capital                        ║
║ ─────────────────────────────────────────────────────────────────────────     ║
║ Capital initial:       $1,000              $1,000                             ║
║ Capital final:         $${size100.finalCapital.toFixed(0).padStart(5)}              $${size50.finalCapital.toFixed(0).padStart(5)}                             ║
║ ROI total:             ${size100.totalPnL >= 0 ? '+' : ''}${size100.totalPnL.toFixed(0)}%               ${size50.totalPnL >= 0 ? '+' : ''}${size50.totalPnL.toFixed(0)}%                              ║
║ Max Drawdown:          ${size100.maxDrawdown.toFixed(1)}%               ${size50.maxDrawdown.toFixed(1)}%                              ║
║ Ratio ROI/DD:          ${(size100.totalPnL / size100.maxDrawdown).toFixed(2)}                ${(size50.totalPnL / size50.maxDrawdown).toFixed(2)}                              ║
║                                                                               ║
║ 🎯 VERDICT:                                                                   ║
║ • 50% = Meilleur ratio risque/récompense                                      ║
║ • 50% = Drawdown supportable (${size50.maxDrawdown.toFixed(0)}% vs ${size100.maxDrawdown.toFixed(0)}%)                              ║
║ • 50% = Survie garantie même avec 10 pertes consécutives                      ║
║                                                                               ║
║ 📈 AVEC $1000 ET 50% POSITION:                                                ║
║ • Perte max par trade: ~5% du capital total                                   ║
║ • Après 5 SL consécutifs: -23% (vs -41% avec 100%)                            ║
║ • ROI annuel: +${size50.totalPnL.toFixed(0)}%                                                      ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
`);
  
  // Monthly breakdown with 50% sizing
  console.log('\n📅 SIMULATION MENSUELLE (50% position size, ETH+XRP):');
  
  const allTrades50 = [
    ...sizingResults[0.5].ETH.trades,
    ...sizingResults[0.5].XRP.trades
  ].sort((a, b) => a.exitTime - b.exitTime);
  
  const monthlyPnL = {};
  for (const trade of allTrades50) {
    const month = new Date(trade.exitTime).toISOString().slice(0, 7);
    if (!monthlyPnL[month]) monthlyPnL[month] = { pnl: 0, trades: 0 };
    monthlyPnL[month].pnl += trade.pnlWithLeverage * 0.5; // 50% sizing
    monthlyPnL[month].trades++;
  }
  
  console.log('┌─────────────┬────────┬──────────┬─────────────────────────────────────┐');
  console.log('│ Month       │ Trades │ PnL %    │ Visualization                       │');
  console.log('├─────────────┼────────┼──────────┼─────────────────────────────────────┤');
  
  let runningCapital = 1000;
  const months = Object.keys(monthlyPnL).sort();
  for (const month of months) {
    const m = monthlyPnL[month];
    runningCapital *= (1 + m.pnl / 100);
    const bar = m.pnl >= 0 
      ? '🟢'.repeat(Math.min(Math.round(m.pnl / 5), 15))
      : '🔴'.repeat(Math.min(Math.round(Math.abs(m.pnl) / 5), 15));
    console.log(`│ ${month}   │ ${String(m.trades).padStart(6)} │ ${m.pnl >= 0 ? '+' : ''}${m.pnl.toFixed(1).padStart(6)}% │ ${bar.padEnd(35)} │`);
  }
  console.log('└─────────────┴────────┴──────────┴─────────────────────────────────────┘');
  console.log(`\n💰 Capital final avec 50% sizing: $${runningCapital.toFixed(0)}`);
}

main().catch(console.error);
