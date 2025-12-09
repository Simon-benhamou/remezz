#!/usr/bin/env node
/**
 * 📊 TRAILING DISTANCE OPTIMIZATION
 * 
 * Teste différentes distances de trailing pour trouver l'optimum
 * entre protection des gains et éviter les faux exits
 */

import fs from 'fs';

// Charger les données
const dataDir = './data';
const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'AVAX', 'DOT', 'LINK'];

function loadCandles(symbol) {
  const file = `${dataDir}/${symbol}_USDT_1h.json`;
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Convert 1h to 15m approximation (use same data, 4x more bars)
  return data;
}

// Indicateurs
function calcSMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || candles[i].open;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    sum += tr;
  }
  return sum / period;
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

function countConsecUp(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}

function countConsecDown(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) count++;
    else break;
  }
  return count;
}

// Signal check (simplified)
function checkSignal(candles, isBull) {
  if (candles.length < 50) return null;
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  const isBullish = current.close > current.open;
  const isBearish = current.close < current.open;
  
  const bb = calcBB(closes, 20, 2);
  const ma20 = calcSMA(closes, 20);
  const volRatio = calcVolRatio(volumes);
  const roc10 = calcROC(closes, 10);
  const roc5 = calcROC(closes, 5);
  
  if (isBull) {
    // LONG conditions
    const breakout = current.close > bb.upper;
    const rocOk = roc10 >= 0.025;
    const volOk = volRatio >= 2.0;
    const consecOk = countConsecUp(candles) <= 3;
    
    if (isBullish && breakout && rocOk && volOk && consecOk) {
      return 'long';
    }
  } else {
    // SHORT conditions
    const dropOk = roc5 <= -0.015;
    const volOk = volRatio >= 2.0;
    const belowMa20 = current.close < ma20;
    const belowBB = current.close < bb.lower;
    const consecOk = countConsecDown(candles) <= 4;
    
    if (isBearish && dropOk && volOk && belowMa20 && belowBB && consecOk) {
      return 'short';
    }
  }
  
  return null;
}

// Dynamic SL (ATR-based)
function calcDynamicSL(candles, atrMult = 3.0, minPct = 1.0, maxPct = 4.5) {
  const atr = calcATR(candles, 14);
  if (!atr || candles.length === 0) return 2.5; // Fallback
  
  const price = candles[candles.length - 1].close;
  const atrPct = (atr / price) * 100;
  const rawSL = atrPct * atrMult;
  return Math.min(maxPct, Math.max(minPct, rawSL));
}

// Backtest with specific trailing params
function runBacktest(allData, btcCandles, params) {
  const { trailActivation, trailDistance, tpPct = 3.0 } = params;
  
  const btcCloses = btcCandles.map(c => c.close);
  const symbols = Object.keys(allData);
  
  let capital = 10000;
  let trades = [];
  let positions = {};
  let cooldowns = {};
  
  symbols.forEach(s => {
    positions[s] = null;
    cooldowns[s] = 0;
  });
  
  // Start after 200 candles
  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
    const btcPrice = btcCloses[btcIdx - 1];
    const isBull = btcPrice > btcSma200;
    
    for (const symbol of symbols) {
      const candles = allData[symbol];
      if (!candles || btcIdx >= candles.length) continue;
      
      const current = candles[btcIdx];
      const windowCandles = candles.slice(Math.max(0, btcIdx - 200), btcIdx + 1);
      
      // Decrement cooldown
      if (cooldowns[symbol] > 0) cooldowns[symbol]--;
      
      // Manage existing position
      if (positions[symbol]) {
        const pos = positions[symbol];
        const holdBars = btcIdx - pos.entryIdx;
        let exitReason = null;
        let exitPrice = current.close;
        
        if (pos.side === 'long') {
          const pnlPct = ((current.close - pos.entryPrice) / pos.entryPrice) * 100;
          pos.hwm = Math.max(pos.hwm || pos.entryPrice, current.high);
          const hwmPct = ((pos.hwm - pos.entryPrice) / pos.entryPrice) * 100;
          
          // Trailing check FIRST
          if (hwmPct >= trailActivation) {
            const trailStop = pos.hwm * (1 - trailDistance / 100);
            if (current.low <= trailStop) {
              exitReason = 'TRAIL';
              exitPrice = trailStop;
            }
          }
          
          // Then SL
          if (!exitReason && pnlPct <= -pos.slPct) {
            exitReason = 'SL';
            exitPrice = pos.entryPrice * (1 - pos.slPct / 100);
          }
          
          // Then TP
          if (!exitReason && pnlPct >= tpPct) {
            exitReason = 'TP';
            exitPrice = pos.entryPrice * (1 + tpPct / 100);
          }
          
          // Time exit
          if (!exitReason && holdBars >= 192) {
            exitReason = 'TIME';
          }
        } else {
          // SHORT
          const pnlPct = ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
          pos.lwm = Math.min(pos.lwm || pos.entryPrice, current.low);
          const lwmPct = ((pos.entryPrice - pos.lwm) / pos.entryPrice) * 100;
          
          // Trailing check FIRST
          if (lwmPct >= trailActivation) {
            const trailStop = pos.lwm * (1 + trailDistance / 100);
            if (current.high >= trailStop) {
              exitReason = 'TRAIL';
              exitPrice = trailStop;
            }
          }
          
          // Then SL
          if (!exitReason && pnlPct <= -pos.slPct) {
            exitReason = 'SL';
            exitPrice = pos.entryPrice * (1 + pos.slPct / 100);
          }
          
          // Then TP
          if (!exitReason && pnlPct >= tpPct) {
            exitReason = 'TP';
            exitPrice = pos.entryPrice * (1 - tpPct / 100);
          }
          
          // Time exit
          if (!exitReason && holdBars >= 192) {
            exitReason = 'TIME';
          }
        }
        
        // Execute exit
        if (exitReason) {
          const pricePct = pos.side === 'long'
            ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
          
          const leverage = 4.5;
          const grossPnlPct = pricePct * leverage;
          const fees = 0.04 * 2 * leverage; // 0.04% × 2 × leverage
          const netPnlPct = grossPnlPct - fees;
          const netPnlUsd = (netPnlPct / 100) * pos.marginUsd;
          
          capital += netPnlUsd + pos.marginUsd;
          
          trades.push({
            symbol,
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice,
            pnlPct: netPnlPct,
            pnlUsd: netPnlUsd,
            exitReason,
            holdBars,
            hwm: pos.hwm,
            lwm: pos.lwm,
          });
          
          positions[symbol] = null;
          cooldowns[symbol] = 8;
        }
      }
      
      // Check for new entry
      if (!positions[symbol] && cooldowns[symbol] <= 0 && capital > 100) {
        const signal = checkSignal(windowCandles, isBull);
        if (signal) {
          const slPct = calcDynamicSL(windowCandles);
          const marginUsd = capital * 0.4; // 40% position size
          
          positions[symbol] = {
            side: signal,
            entryPrice: current.close,
            entryIdx: btcIdx,
            slPct,
            marginUsd,
            hwm: signal === 'long' ? current.close : undefined,
            lwm: signal === 'short' ? current.close : undefined,
          };
          
          capital -= marginUsd;
        }
      }
    }
  }
  
  // Close remaining positions
  for (const symbol of symbols) {
    if (positions[symbol]) {
      capital += positions[symbol].marginUsd;
    }
  }
  
  // Calculate stats
  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const slExits = trades.filter(t => t.exitReason === 'SL');
  const trailExits = trades.filter(t => t.exitReason === 'TRAIL');
  const tpExits = trades.filter(t => t.exitReason === 'TP');
  const timeExits = trades.filter(t => t.exitReason === 'TIME');
  
  // Analyze trail exits that could have been better
  let prematureTrailExits = 0;
  let missedProfits = 0;
  
  for (const t of trailExits) {
    // If trail exit was in profit but less than 1%, might be premature
    if (t.pnlPct > 0 && t.pnlPct < 2) {
      prematureTrailExits++;
      // Estimate missed profit (rough)
      const potentialPnl = t.side === 'long' 
        ? ((t.hwm - t.entryPrice) / t.entryPrice) * 100 * 4.5
        : ((t.entryPrice - t.lwm) / t.entryPrice) * 100 * 4.5;
      missedProfits += Math.max(0, potentialPnl - t.pnlPct);
    }
  }
  
  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / trades.length * 100) || 0,
    totalPnlPct: ((capital - 10000) / 10000 * 100),
    finalCapital: capital,
    slExits: slExits.length,
    trailExits: trailExits.length,
    tpExits: tpExits.length,
    timeExits: timeExits.length,
    slRate: (slExits.length / trades.length * 100) || 0,
    trailRate: (trailExits.length / trades.length * 100) || 0,
    avgWinPct: wins.length > 0 ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0,
    avgLossPct: losses.length > 0 ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0,
    prematureTrailExits,
    missedProfits,
    trailExitWins: trailExits.filter(t => t.pnlPct > 0).length,
    trailExitLosses: trailExits.filter(t => t.pnlPct <= 0).length,
  };
}

// Main
async function main() {
  console.log('📊 TRAILING DISTANCE OPTIMIZATION\n');
  console.log('Loading data...');
  
  // Load all data
  const allData = {};
  let btcCandles = null;
  
  for (const sym of symbols) {
    const candles = loadCandles(sym);
    if (candles) {
      allData[sym] = candles;
      if (sym === 'BTC') btcCandles = candles;
      console.log(`  ${sym}: ${candles.length} candles`);
    }
  }
  
  if (!btcCandles) {
    console.error('BTC data required!');
    return;
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('TESTING TRAILING CONFIGURATIONS');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  
  // Test different trailing configurations
  const configs = [
    // Current V5.11
    { trailActivation: 0.5, trailDistance: 0.3, name: 'V5.11 (0.5%/0.3%) - Current' },
    
    // More aggressive activation, same distance
    { trailActivation: 0.3, trailDistance: 0.3, name: 'Ultra Aggressive (0.3%/0.3%)' },
    
    // Same activation, wider distance
    { trailActivation: 0.5, trailDistance: 0.4, name: 'Wider Trail (0.5%/0.4%)' },
    { trailActivation: 0.5, trailDistance: 0.5, name: 'Wide Trail (0.5%/0.5%)' },
    { trailActivation: 0.5, trailDistance: 0.6, name: 'Very Wide (0.5%/0.6%)' },
    
    // Later activation, wider distance
    { trailActivation: 0.75, trailDistance: 0.4, name: 'Later+Wider (0.75%/0.4%)' },
    { trailActivation: 1.0, trailDistance: 0.4, name: 'Conservative (1.0%/0.4%)' },
    { trailActivation: 1.0, trailDistance: 0.5, name: 'V5.8 Original (1.0%/0.5%)' },
    
    // Very conservative
    { trailActivation: 1.5, trailDistance: 0.5, name: 'Very Conservative (1.5%/0.5%)' },
    
    // Dynamic distance based on activation
    { trailActivation: 0.5, trailDistance: 0.35, name: 'Balanced (0.5%/0.35%)' },
    { trailActivation: 0.6, trailDistance: 0.4, name: 'Balanced+ (0.6%/0.4%)' },
    { trailActivation: 0.7, trailDistance: 0.45, name: 'Moderate (0.7%/0.45%)' },
  ];
  
  const results = [];
  
  for (const config of configs) {
    const result = runBacktest(allData, btcCandles, config);
    results.push({ ...config, ...result });
  }
  
  // Sort by total PnL
  results.sort((a, b) => b.totalPnlPct - a.totalPnlPct);
  
  console.log('RANKING BY TOTAL PNL:\n');
  console.log('┌────────────────────────────────────┬────────┬────────┬──────────┬────────┬────────┬────────┬──────────┐');
  console.log('│ Configuration                      │ Trades │ WinRate│ ROI %    │ SL %   │ Trail% │ AvgWin │ Premature│');
  console.log('├────────────────────────────────────┼────────┼────────┼──────────┼────────┼────────┼────────┼──────────┤');
  
  for (const r of results) {
    const name = r.name.padEnd(34);
    const trades = String(r.totalTrades).padStart(6);
    const wr = r.winRate.toFixed(1).padStart(6) + '%';
    const roi = (r.totalPnlPct >= 0 ? '+' : '') + r.totalPnlPct.toFixed(0).padStart(7) + '%';
    const slRate = r.slRate.toFixed(1).padStart(5) + '%';
    const trailRate = r.trailRate.toFixed(1).padStart(5) + '%';
    const avgWin = '+' + r.avgWinPct.toFixed(1).padStart(4) + '%';
    const premature = String(r.prematureTrailExits).padStart(8);
    
    console.log(`│ ${name} │${trades} │${wr} │${roi} │${slRate} │${trailRate} │${avgWin} │${premature} │`);
  }
  
  console.log('└────────────────────────────────────┴────────┴────────┴──────────┴────────┴────────┴────────┴──────────┘');
  
  // Best performer analysis
  const best = results[0];
  const current = results.find(r => r.name.includes('Current'));
  
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  
  console.log(`🏆 BEST: ${best.name}`);
  console.log(`   ROI: +${best.totalPnlPct.toFixed(0)}% | WR: ${best.winRate.toFixed(1)}% | SL: ${best.slRate.toFixed(1)}% | Trail: ${best.trailRate.toFixed(1)}%`);
  console.log(`   Trail exits: ${best.trailExits} (${best.trailExitWins} wins, ${best.trailExitLosses} losses)`);
  console.log(`   Premature trail exits: ${best.prematureTrailExits}`);
  
  if (current && current !== best) {
    console.log(`\n📍 CURRENT (V5.11): ${current.name}`);
    console.log(`   ROI: +${current.totalPnlPct.toFixed(0)}% | WR: ${current.winRate.toFixed(1)}% | SL: ${current.slRate.toFixed(1)}% | Trail: ${current.trailRate.toFixed(1)}%`);
    console.log(`   Trail exits: ${current.trailExits} (${current.trailExitWins} wins, ${current.trailExitLosses} losses)`);
    console.log(`   Premature trail exits: ${current.prematureTrailExits}`);
    
    const diff = best.totalPnlPct - current.totalPnlPct;
    console.log(`\n   → BEST vs CURRENT: ${diff >= 0 ? '+' : ''}${diff.toFixed(0)}% difference`);
  }
  
  // Noise analysis
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('NOISE ANALYSIS (Trailing Distance vs Premature Exits)');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  
  const byDistance = results.reduce((acc, r) => {
    const key = r.trailDistance;
    if (!acc[key]) acc[key] = [];
    acc[key].push(r);
    return acc;
  }, {});
  
  for (const [dist, configs] of Object.entries(byDistance).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))) {
    const avgPremature = configs.reduce((a, c) => a + c.prematureTrailExits, 0) / configs.length;
    const avgROI = configs.reduce((a, c) => a + c.totalPnlPct, 0) / configs.length;
    console.log(`  Distance ${dist}%: Avg premature=${avgPremature.toFixed(0)}, Avg ROI=+${avgROI.toFixed(0)}%`);
  }
  
  console.log('\n✅ RECOMMENDATION:');
  if (best.trailDistance > 0.3) {
    console.log(`   Increase trailing distance from 0.3% to ${best.trailDistance}%`);
    console.log(`   This reduces noise-triggered exits and improves ROI`);
  } else {
    console.log(`   Current 0.3% distance is optimal for this dataset`);
  }
}

main().catch(console.error);
