#!/usr/bin/env node
/**
 * 📊 DYNAMIC TRAILING STRATEGY TEST
 * 
 * Smart trailing that WIDENS as profit increases:
 * - Phase 1 (0% → threshold): tight callback to protect early gains
 * - Phase 2 (>threshold): wider callback to let winners run
 * 
 * This is counter-intuitive but may work better because:
 * - Early in trade: protect small gains tightly
 * - Later in trade: give room for the trend to continue
 */

import fs from 'fs';

const dataDir = './data';
const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'LINK'];

function loadCandles(symbol) {
  const file15m = `${dataDir}/candles/${symbol}_USDT_15m.json`;
  if (fs.existsSync(file15m)) {
    return JSON.parse(fs.readFileSync(file15m, 'utf8'));
  }
  const file1h = `${dataDir}/${symbol}_USDT_1h.json`;
  if (fs.existsSync(file1h)) {
    return JSON.parse(fs.readFileSync(file1h, 'utf8'));
  }
  return null;
}

// Indicators
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

// Signal detection
function checkSignal(candles, btcCandles) {
  if (candles.length < 50) return null;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  const isBullish = current.close > current.open;
  
  const btcCloses = btcCandles.map(c => c.close);
  const btcSma200 = calcSMA(btcCloses, 200);
  const btcPrice = btcCloses[btcCloses.length - 1];
  const isBull = btcPrice > btcSma200;
  
  if (!isBull) return null;
  
  const bb = calcBB(closes, 20, 2);
  const volRatio = calcVolRatio(volumes);
  const roc = calcROC(closes, 10);
  
  if (isBullish && current.close < bb.middle && volRatio > 1.2 && roc > 0) {
    return { side: 'long', reason: 'momentum_bounce' };
  }
  
  return null;
}

// Signal exit conditions
function checkSignalExit(candles) {
  if (candles.length < 20) return { shouldExit: false };
  
  const current = candles[candles.length - 1];
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  
  const bb = calcBB(closes, 20, 2);
  const volRatio = calcVolRatio(volumes);
  const roc = calcROC(closes, 5);
  
  if (current.close > bb.upper && roc < 0) {
    return { shouldExit: true, reason: 'momentum_fade' };
  }
  
  if (volRatio < 0.5 && current.close < current.open) {
    return { shouldExit: true, reason: 'volume_dry' };
  }
  
  const candleChange = (current.close - current.open) / current.open;
  if (candleChange < -0.01) {
    return { shouldExit: true, reason: 'strong_bearish' };
  }
  
  return { shouldExit: false };
}

// ═══════════════════════════════════════════════════════════════════
// BACKTEST WITH DYNAMIC TRAILING
// ═══════════════════════════════════════════════════════════════════

function runBacktest(allData, btcCandles, config) {
  const { 
    trailActivation,      // When to activate trailing
    trailCallback1,       // Initial callback %
    trailCallback2,       // Callback after threshold
    widenThreshold,       // Profit % to switch to wider callback
    stopLossPct,
    name 
  } = config;
  
  const trades = [];
  let totalPnl = 0;
  
  for (const [symbol, candles] of Object.entries(allData)) {
    if (!candles || candles.length < 100) continue;
    
    let position = null;
    let highSinceEntry = 0;
    let trailingActive = false;
    let currentCallback = trailCallback1;
    let phase = 1;
    
    for (let i = 50; i < candles.length; i++) {
      const slice = candles.slice(0, i + 1);
      const btcSlice = btcCandles.slice(0, Math.min(i + 1, btcCandles.length));
      const current = candles[i];
      
      if (!position) {
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
          currentCallback = trailCallback1;
          phase = 1;
        }
      } else {
        let exitPrice = null;
        let exitReason = null;
        
        // Calculate current PnL from high
        const pnlPctFromEntry = (current.high - position.entryPrice) / position.entryPrice * 100;
        
        // Dynamic callback: widen when profit exceeds threshold
        if (phase === 1 && pnlPctFromEntry >= widenThreshold) {
          currentCallback = trailCallback2;
          phase = 2;
        }
        
        // 1. Check STOP LOSS
        if (current.low <= position.stopLoss) {
          exitPrice = position.stopLoss;
          exitReason = 'stop_loss';
        }
        
        // 2. Check TRAILING STOP
        if (!exitPrice && trailingActive) {
          const trailingStopPrice = highSinceEntry * (1 - currentCallback / 100);
          if (current.low <= trailingStopPrice) {
            exitPrice = trailingStopPrice;
            exitReason = phase === 2 ? 'trailing_phase2' : 'trailing_phase1';
          }
        }
        
        // 3. Update high and check trailing activation
        if (!exitPrice && current.high > highSinceEntry) {
          highSinceEntry = current.high;
          
          if (!trailingActive) {
            const pnlPct = (highSinceEntry - position.entryPrice) / position.entryPrice * 100;
            if (pnlPct >= trailActivation) {
              trailingActive = true;
            }
          }
        }
        
        // 4. Check if trailing activates AND triggers in same candle
        if (!exitPrice && !trailingActive) {
          const pnlPct = (current.high - position.entryPrice) / position.entryPrice * 100;
          if (pnlPct >= trailActivation) {
            const tempCallback = pnlPct >= widenThreshold ? trailCallback2 : trailCallback1;
            const trailStop = current.high * (1 - tempCallback / 100);
            if (current.low <= trailStop) {
              exitPrice = trailStop;
              exitReason = pnlPct >= widenThreshold ? 'trailing_phase2' : 'trailing_phase1';
            }
          }
        }
        
        // 5. Signal exit
        if (!exitPrice) {
          const signalExit = checkSignalExit(slice);
          if (signalExit.shouldExit) {
            exitPrice = current.close;
            exitReason = signalExit.reason;
          }
        }
        
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
            phase,
          });
          
          totalPnl += pnlPct;
          position = null;
          highSinceEntry = 0;
          trailingActive = false;
          phase = 1;
        }
      }
    }
  }
  
  // Stats
  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const slExits = trades.filter(t => t.reason === 'stop_loss');
  const trail1Exits = trades.filter(t => t.reason === 'trailing_phase1');
  const trail2Exits = trades.filter(t => t.reason === 'trailing_phase2');
  const signalExits = trades.filter(t => ['momentum_fade', 'volume_dry', 'strong_bearish'].includes(t.reason));
  
  // Premature = trailing exit with pnl < activation - callback
  const minExpectedPnl = trailActivation - trailCallback1;
  const prematureExits = [...trail1Exits, ...trail2Exits].filter(t => t.pnlPct < minExpectedPnl);
  
  return {
    name,
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
    trail1Exits: trail1Exits.length,
    trail2Exits: trail2Exits.length,
    signalExits: signalExits.length,
    signalRate: trades.length > 0 ? (signalExits.length / trades.length) * 100 : 0,
    prematureExits: prematureExits.length,
    trades,
  };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

console.log('📊 DYNAMIC TRAILING STRATEGY TEST');
console.log('════════════════════════════════════════════════════════════════\n');

const allData = {};
for (const symbol of symbols) {
  const candles = loadCandles(symbol);
  if (candles) {
    allData[symbol] = candles;
    console.log(`✅ Loaded ${symbol}: ${candles.length} candles`);
  }
}

const btcCandles = allData['BTC'] || [];
console.log(`\nBTC candles: ${btcCandles.length}`);

// Scenarios to test
const scenarios = [
  // Baseline: current config
  {
    name: '1️⃣  CURRENT (0.5% act / 0.3% cb)',
    trailActivation: 0.5,
    trailCallback1: 0.3,
    trailCallback2: 0.3,  // No change
    widenThreshold: 999,  // Never widens
    stopLossPct: 1.5,
  },
  // Option B from before
  {
    name: '2️⃣  OPTION B (1.5% act / 0.3% cb)',
    trailActivation: 1.5,
    trailCallback1: 0.3,
    trailCallback2: 0.3,
    widenThreshold: 999,
    stopLossPct: 1.5,
  },
  // USER IDEA: 0.8% activation, 0.5% cb → widens to 0.6% at 1.5%
  {
    name: '3️⃣  SMART (0.8%/0.5% → 0.6% @1.5%)',
    trailActivation: 0.8,
    trailCallback1: 0.5,
    trailCallback2: 0.6,
    widenThreshold: 1.5,
    stopLossPct: 1.5,
  },
  // Variation: earlier activation
  {
    name: '4️⃣  SMART v2 (0.5%/0.4% → 0.6% @1.5%)',
    trailActivation: 0.5,
    trailCallback1: 0.4,
    trailCallback2: 0.6,
    widenThreshold: 1.5,
    stopLossPct: 1.5,
  },
  // Variation: more aggressive widening
  {
    name: '5️⃣  SMART v3 (0.8%/0.5% → 0.8% @2%)',
    trailActivation: 0.8,
    trailCallback1: 0.5,
    trailCallback2: 0.8,
    widenThreshold: 2.0,
    stopLossPct: 1.5,
  },
  // Variation: tighter phase 1
  {
    name: '6️⃣  SMART v4 (0.6%/0.4% → 0.6% @1.2%)',
    trailActivation: 0.6,
    trailCallback1: 0.4,
    trailCallback2: 0.6,
    widenThreshold: 1.2,
    stopLossPct: 1.5,
  },
  // Even more conservative phase 2
  {
    name: '7️⃣  SMART v5 (0.8%/0.4% → 0.7% @1.5%)',
    trailActivation: 0.8,
    trailCallback1: 0.4,
    trailCallback2: 0.7,
    widenThreshold: 1.5,
    stopLossPct: 1.5,
  },
];

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('RUNNING BACKTESTS...');
console.log('═══════════════════════════════════════════════════════════════════\n');

const results = [];
for (const scenario of scenarios) {
  const result = runBacktest(allData, btcCandles, scenario);
  results.push(result);
}

// Sort by ROI
results.sort((a, b) => b.totalPnlPct - a.totalPnlPct);

console.log('┌──────────────────────────────────────┬────────┬────────┬──────────┬────────┬────────┬────────┬────────┐');
console.log('│ Strategy                             │ Trades │ WinRate│ Total ROI│ SL %   │Trail P1│Trail P2│ Signal │');
console.log('├──────────────────────────────────────┼────────┼────────┼──────────┼────────┼────────┼────────┼────────┤');

for (const r of results) {
  const name = r.name.substring(0, 36).padEnd(36);
  const trades = String(r.totalTrades).padStart(6);
  const wr = r.winRate.toFixed(1).padStart(6) + '%';
  const roi = (r.totalPnlPct >= 0 ? '+' : '') + r.totalPnlPct.toFixed(1).padStart(7) + '%';
  const slRate = r.slRate.toFixed(1).padStart(5) + '%';
  const t1 = String(r.trail1Exits).padStart(6);
  const t2 = String(r.trail2Exits).padStart(6);
  const sig = String(r.signalExits).padStart(6);
  
  console.log(`│ ${name} │${trades} │${wr} │${roi} │${slRate} │${t1} │${t2} │${sig} │`);
}

console.log('└──────────────────────────────────────┴────────┴────────┴──────────┴────────┴────────┴────────┴────────┘');

// Detailed analysis
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('DETAILED ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════════\n');

for (const r of results.slice(0, 4)) {
  console.log(`${r.name}`);
  console.log(`  ROI: ${r.totalPnlPct >= 0 ? '+' : ''}${r.totalPnlPct.toFixed(1)}% | Win Rate: ${r.winRate.toFixed(1)}%`);
  console.log(`  Avg Win: +${r.avgWinPct.toFixed(2)}% | Avg Loss: ${r.avgLossPct.toFixed(2)}%`);
  console.log(`  Exits: SL=${r.slExits} | Trail P1=${r.trail1Exits} | Trail P2=${r.trail2Exits} | Signal=${r.signalExits}`);
  if (r.prematureExits > 0) {
    console.log(`  ⚠️  Premature exits: ${r.prematureExits}`);
  }
  console.log('');
}

// Winner
const best = results[0];
const current = results.find(r => r.name.includes('CURRENT'));

console.log('═══════════════════════════════════════════════════════════════════');
console.log('RECOMMENDATION');
console.log('═══════════════════════════════════════════════════════════════════\n');

console.log(`🏆 BEST: ${best.name}`);
console.log(`   ROI: ${best.totalPnlPct >= 0 ? '+' : ''}${best.totalPnlPct.toFixed(1)}%`);
console.log(`   Win Rate: ${best.winRate.toFixed(1)}%`);
console.log(`   Avg Win: +${best.avgWinPct.toFixed(2)}%`);

if (current && best.name !== current.name) {
  const improvement = best.totalPnlPct - current.totalPnlPct;
  console.log(`\n   → Improvement vs current: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(1)}%`);
}

// Check if SMART variants beat static configs
const smartVariants = results.filter(r => r.name.includes('SMART'));
const staticConfigs = results.filter(r => !r.name.includes('SMART'));
const bestSmart = smartVariants.length > 0 ? smartVariants.reduce((a, b) => a.totalPnlPct > b.totalPnlPct ? a : b) : null;
const bestStatic = staticConfigs.length > 0 ? staticConfigs.reduce((a, b) => a.totalPnlPct > b.totalPnlPct ? a : b) : null;

if (bestSmart && bestStatic) {
  console.log('\n📊 SMART vs STATIC comparison:');
  console.log(`   Best SMART: ${bestSmart.name.substring(4)} → ROI: ${bestSmart.totalPnlPct.toFixed(1)}%`);
  console.log(`   Best STATIC: ${bestStatic.name.substring(4)} → ROI: ${bestStatic.totalPnlPct.toFixed(1)}%`);
  
  if (bestSmart.totalPnlPct > bestStatic.totalPnlPct) {
    console.log(`   ✅ SMART trailing is better by +${(bestSmart.totalPnlPct - bestStatic.totalPnlPct).toFixed(1)}%`);
  } else {
    console.log(`   ❌ STATIC is better by +${(bestStatic.totalPnlPct - bestSmart.totalPnlPct).toFixed(1)}%`);
  }
}
