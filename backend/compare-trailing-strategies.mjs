#!/usr/bin/env node
/**
 * 📊 COMPARE TRAILING STRATEGIES
 * 
 * Compare 3 approaches:
 * 1. Current: activation 0.5%, callback 0.3%
 * 2. Option B: activation 1.5%, callback 0.3% (higher buffer)
 * 3. No trailing: only stop loss + signal exit
 * 
 * IMPORTANT: Simulates tick-by-tick behavior like Binance (uses high/low within candle)
 */

import fs from 'fs';

const dataDir = './data';
const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'LINK'];

// Load 15m candle data if available, otherwise use 1h
function loadCandles(symbol) {
  // Try 15m first
  const file15m = `${dataDir}/candles/${symbol}_USDT_15m.json`;
  if (fs.existsSync(file15m)) {
    return JSON.parse(fs.readFileSync(file15m, 'utf8'));
  }
  // Fallback to 1h
  const file1h = `${dataDir}/${symbol}_USDT_1h.json`;
  if (fs.existsSync(file1h)) {
    return JSON.parse(fs.readFileSync(file1h, 'utf8'));
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// INDICATORS
// ═══════════════════════════════════════════════════════════════════

function calcSMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcBB(closes, period = 20, std = 2) {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 0;
    return { upper: last, middle: last, lower: last };
  }
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return { upper: middle + stdDev * std, middle, lower: middle - stdDev * std };
}

function calcROC(closes, period = 10) {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - period - 1];
  return past > 0 ? (current - past) / past : 0;
}

function calcVolRatio(volumes) {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 ? current / avg : 0;
}

// ═══════════════════════════════════════════════════════════════════
// SIGNAL DETECTION (simplified from momentumSimple.ts)
// ═══════════════════════════════════════════════════════════════════

function checkSignal(candles, btcCandles) {
  if (candles.length < 50) return null;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  const isBullish = current.close > current.open;
  
  // BTC regime
  const btcCloses = btcCandles.map(c => c.close);
  const btcSma200 = calcSMA(btcCloses, 200);
  const btcPrice = btcCloses[btcCloses.length - 1];
  const isBull = btcPrice > btcSma200;
  
  if (!isBull) return null; // Only long in bull regime
  
  const bb = calcBB(closes, 20, 2);
  const volRatio = calcVolRatio(volumes);
  const roc = calcROC(closes, 10);
  
  // Long signal: bullish candle, near lower BB, good volume, positive momentum
  if (isBullish && current.close < bb.middle && volRatio > 1.2 && roc > 0) {
    return { side: 'long', reason: 'momentum_bounce' };
  }
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// EXIT CONDITIONS (momentum fade, volume dry)
// ═══════════════════════════════════════════════════════════════════

function checkSignalExit(candles, position) {
  if (candles.length < 20) return false;
  
  const current = candles[candles.length - 1];
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  
  const bb = calcBB(closes, 20, 2);
  const volRatio = calcVolRatio(volumes);
  const roc = calcROC(closes, 5);
  
  // Exit conditions for long:
  // 1. Momentum fade (price at upper BB + negative ROC)
  if (current.close > bb.upper && roc < 0) {
    return { shouldExit: true, reason: 'momentum_fade' };
  }
  
  // 2. Volume dry up (very low volume + bearish candle)
  if (volRatio < 0.5 && current.close < current.open) {
    return { shouldExit: true, reason: 'volume_dry' };
  }
  
  // 3. Strong bearish candle (>1% red)
  const candleChange = (current.close - current.open) / current.open;
  if (candleChange < -0.01) {
    return { shouldExit: true, reason: 'strong_bearish' };
  }
  
  return { shouldExit: false };
}

// ═══════════════════════════════════════════════════════════════════
// BACKTEST ENGINE
// ═══════════════════════════════════════════════════════════════════

function runBacktest(allData, btcCandles, config) {
  const { trailActivation, trailDistance, stopLossPct, useTrailing, dynamicTrail, phase2Threshold, phase2Distance } = config;
  
  const trades = [];
  let totalPnl = 0;
  
  for (const [symbol, candles] of Object.entries(allData)) {
    if (!candles || candles.length < 100) continue;
    
    let position = null;
    let highSinceEntry = 0;
    let trailingActive = false;
    let trailingStopPrice = 0;
    let currentCallbackPct = trailDistance; // Dynamic callback
    
    for (let i = 50; i < candles.length; i++) {
      const slice = candles.slice(0, i + 1);
      const btcSlice = btcCandles.slice(0, Math.min(i + 1, btcCandles.length));
      const current = candles[i];
      
      if (!position) {
        // Check for entry
        const signal = checkSignal(slice, btcSlice);
        if (signal && signal.side === 'long') {
          position = {
            entryPrice: current.close,
            entryIdx: i,
            symbol,
            stopLoss: current.close * (1 - stopLossPct / 100),
          };
          highSinceEntry = current.close;
          trailingActive = false;
          trailingStopPrice = 0;
          currentCallbackPct = trailDistance; // Reset to initial callback
        }
      } else {
        // ══════════════════════════════════════════════════════════════
        // TICK-BY-TICK SIMULATION within candle
        // Binance checks every tick, so we check both high and low
        // ══════════════════════════════════════════════════════════════
        
        let exitPrice = null;
        let exitReason = null;
        
        // Order of checks matters! 
        // In a candle, we assume: Open -> High or Low first (unknown) -> Close
        // Conservative approach: check stop loss first (worst case)
        
        // 1. Check STOP LOSS hit (uses candle low for long)
        if (current.low <= position.stopLoss) {
          exitPrice = position.stopLoss;
          exitReason = 'stop_loss';
        }
        
        // 2. Check TRAILING STOP (if active)
        if (!exitPrice && useTrailing && trailingActive) {
          // Trailing triggers if price drops callback% from high
          if (current.low <= trailingStopPrice) {
            exitPrice = trailingStopPrice;
            exitReason = 'trailing_stop';
          }
        }
        
        // 3. Update high watermark and trailing activation + DYNAMIC CALLBACK
        if (!exitPrice && current.high > highSinceEntry) {
          highSinceEntry = current.high;
          
          // Check if trailing should activate
          if (useTrailing && !trailingActive) {
            const pnlPctFromHigh = (highSinceEntry - position.entryPrice) / position.entryPrice * 100;
            if (pnlPctFromHigh >= trailActivation) {
              trailingActive = true;
            }
          }
          
          // DYNAMIC TRAILING: Switch to wider callback when profit exceeds threshold
          if (dynamicTrail && trailingActive && phase2Threshold && phase2Distance) {
            const currentPnlPct = (highSinceEntry - position.entryPrice) / position.entryPrice * 100;
            if (currentPnlPct >= phase2Threshold) {
              currentCallbackPct = phase2Distance; // Switch to wider callback
            }
          }
          
          // Update trailing stop price with current callback
          if (trailingActive) {
            trailingStopPrice = highSinceEntry * (1 - currentCallbackPct / 100);
          }
        }
        
        // 4. Check if trailing activated during this candle and then triggered
        // (price went high enough to activate, then dropped callback%)
        if (!exitPrice && useTrailing && !trailingActive) {
          const pnlPctFromHigh = (current.high - position.entryPrice) / position.entryPrice * 100;
          if (pnlPctFromHigh >= trailActivation) {
            // Trailing would activate at high, check if low triggers it
            const tempTrailStop = current.high * (1 - currentCallbackPct / 100);
            if (current.low <= tempTrailStop) {
              exitPrice = tempTrailStop;
              exitReason = 'trailing_stop';
            }
          }
        }
        
        // 5. Check SIGNAL EXIT (momentum fade, volume dry) - at candle close
        if (!exitPrice) {
          const signalExit = checkSignalExit(slice, position);
          if (signalExit.shouldExit) {
            exitPrice = current.close;
            exitReason = signalExit.reason;
          }
        }
        
        // Process exit
        if (exitPrice) {
          const pnlPct = (exitPrice - position.entryPrice) / position.entryPrice * 100;
          const holdBars = i - position.entryIdx;
          
          trades.push({
            symbol,
            entryPrice: position.entryPrice,
            exitPrice,
            pnlPct,
            reason: exitReason,
            holdBars,
            trailingWasActive: trailingActive,
          });
          
          totalPnl += pnlPct;
          position = null;
          highSinceEntry = 0;
          trailingActive = false;
          trailingStopPrice = 0;
        }
      }
    }
  }
  
  // Calculate stats
  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const slExits = trades.filter(t => t.reason === 'stop_loss');
  const trailExits = trades.filter(t => t.reason === 'trailing_stop');
  const signalExits = trades.filter(t => ['momentum_fade', 'volume_dry', 'strong_bearish'].includes(t.reason));
  
  // Premature trailing = trailing exit with pnl < activation threshold
  const prematureTrailExits = trailExits.filter(t => t.pnlPct < trailActivation - 0.1);
  
  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    totalPnlPct: totalPnl,
    avgPnlPct: trades.length > 0 ? totalPnl / trades.length : 0,
    avgWinPct: wins.length > 0 ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0,
    avgLossPct: losses.length > 0 ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0,
    slExits: slExits.length,
    slRate: trades.length > 0 ? (slExits.length / trades.length) * 100 : 0,
    trailExits: trailExits.length,
    trailRate: trades.length > 0 ? (trailExits.length / trades.length) * 100 : 0,
    signalExits: signalExits.length,
    signalRate: trades.length > 0 ? (signalExits.length / trades.length) * 100 : 0,
    prematureTrailExits: prematureTrailExits.length,
    trades,
  };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

console.log('📊 TRAILING STRATEGY COMPARISON');
console.log('════════════════════════════════════════════════════════════════\n');

// Load data
const allData = {};
for (const symbol of symbols) {
  const candles = loadCandles(symbol);
  if (candles) {
    allData[symbol] = candles;
    console.log(`✅ Loaded ${symbol}: ${candles.length} candles`);
  }
}

const btcCandles = allData['BTC'] || [];
console.log(`\nBTC candles for regime: ${btcCandles.length}`);

// Define scenarios
const scenarios = [
  {
    name: '1️⃣  CURRENT (0.5% / 0.3%)',
    trailActivation: 0.5,
    trailDistance: 0.3,
    stopLossPct: 1.5,
    useTrailing: true,
    dynamicTrail: false,
  },
  {
    name: '2️⃣  OPTION B (1.5% / 0.3%)',
    trailActivation: 1.5,
    trailDistance: 0.3,
    stopLossPct: 1.5,
    useTrailing: true,
    dynamicTrail: false,
  },
  {
    name: '3️⃣  SMART (0.8%→0.5cb, >1.5%→0.6cb)',
    trailActivation: 0.8,
    trailDistance: 0.5,        // Initial callback
    stopLossPct: 1.5,
    useTrailing: true,
    dynamicTrail: true,
    phase2Threshold: 1.5,      // When to switch
    phase2Distance: 0.6,       // Wider callback in phase 2
  },
  {
    name: '4️⃣  SMART-B (0.8%→0.4cb, >1.5%→0.5cb)',
    trailActivation: 0.8,
    trailDistance: 0.4,
    stopLossPct: 1.5,
    useTrailing: true,
    dynamicTrail: true,
    phase2Threshold: 1.5,
    phase2Distance: 0.5,
  },
  {
    name: '5️⃣  SMART-C (1.0%→0.4cb, >2%→0.6cb)',
    trailActivation: 1.0,
    trailDistance: 0.4,
    stopLossPct: 1.5,
    useTrailing: true,
    dynamicTrail: true,
    phase2Threshold: 2.0,
    phase2Distance: 0.6,
  },
  {
    name: '6️⃣  NO TRAILING (signal exit only)',
    trailActivation: 999,
    trailDistance: 0.3,
    stopLossPct: 1.5,
    useTrailing: false,
    dynamicTrail: false,
  },
];

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('RUNNING BACKTESTS...');
console.log('═══════════════════════════════════════════════════════════════════\n');

const results = [];

for (const scenario of scenarios) {
  const result = runBacktest(allData, btcCandles, scenario);
  results.push({ ...scenario, ...result });
}

// Display results
console.log('┌─────────────────────────────────────┬────────┬────────┬──────────┬────────┬────────┬────────┬──────────┐');
console.log('│ Strategy                            │ Trades │ WinRate│ Total ROI│ SL %   │ Trail% │ Signal%│ Premature│');
console.log('├─────────────────────────────────────┼────────┼────────┼──────────┼────────┼────────┼────────┼──────────┤');

for (const r of results) {
  const name = r.name.substring(0, 35).padEnd(35);
  const trades = String(r.totalTrades).padStart(6);
  const wr = r.winRate.toFixed(1).padStart(6) + '%';
  const roi = (r.totalPnlPct >= 0 ? '+' : '') + r.totalPnlPct.toFixed(1).padStart(7) + '%';
  const slRate = r.slRate.toFixed(1).padStart(5) + '%';
  const trailRate = r.trailRate.toFixed(1).padStart(5) + '%';
  const signalRate = r.signalRate.toFixed(1).padStart(5) + '%';
  const premature = String(r.prematureTrailExits).padStart(8);
  
  console.log(`│ ${name} │${trades} │${wr} │${roi} │${slRate} │${trailRate} │${signalRate} │${premature} │`);
}

console.log('└─────────────────────────────────────┴────────┴────────┴──────────┴────────┴────────┴────────┴──────────┘');

// Analysis
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('DETAILED ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════════\n');

for (const r of results) {
  console.log(`${r.name}`);
  console.log(`  Trades: ${r.totalTrades} | Wins: ${r.wins} | Losses: ${r.losses}`);
  console.log(`  Avg Win: +${r.avgWinPct.toFixed(2)}% | Avg Loss: ${r.avgLossPct.toFixed(2)}%`);
  console.log(`  Exit breakdown: SL=${r.slExits} | Trail=${r.trailExits} | Signal=${r.signalExits}`);
  if (r.prematureTrailExits > 0) {
    console.log(`  ⚠️  Premature trailing exits: ${r.prematureTrailExits} (exited before reaching activation profit)`);
  }
  console.log('');
}

// Recommendation
const best = results.reduce((a, b) => a.totalPnlPct > b.totalPnlPct ? a : b);
const current = results[0];

console.log('═══════════════════════════════════════════════════════════════════');
console.log('RECOMMENDATION');
console.log('═══════════════════════════════════════════════════════════════════\n');

console.log(`🏆 BEST PERFORMER: ${best.name}`);
console.log(`   ROI: ${best.totalPnlPct >= 0 ? '+' : ''}${best.totalPnlPct.toFixed(1)}%`);
console.log(`   Win Rate: ${best.winRate.toFixed(1)}%`);

if (best !== current) {
  const improvement = best.totalPnlPct - current.totalPnlPct;
  console.log(`\n   → Improvement over current: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(1)}%`);
}

// Check if no trailing is competitive
const noTrailing = results.find(r => !r.useTrailing);
if (noTrailing) {
  console.log(`\n📊 NO TRAILING comparison:`);
  console.log(`   ROI: ${noTrailing.totalPnlPct >= 0 ? '+' : ''}${noTrailing.totalPnlPct.toFixed(1)}%`);
  console.log(`   Win Rate: ${noTrailing.winRate.toFixed(1)}%`);
  console.log(`   Exits purely on SL (${noTrailing.slRate.toFixed(1)}%) or signal (${noTrailing.signalRate.toFixed(1)}%)`);
  
  if (noTrailing.totalPnlPct > current.totalPnlPct) {
    console.log(`   ⚠️  NO TRAILING beats current config by ${(noTrailing.totalPnlPct - current.totalPnlPct).toFixed(1)}%!`);
  }
}
