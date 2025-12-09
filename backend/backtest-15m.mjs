#!/usr/bin/env node
/**
 * 📊 BACKTEST WITH 15-MINUTE CANDLES - MATCHING PRODUCTION
 * 
 * Production behavior:
 * - Checks signals when 15m candle CLOSES (every 15 min)
 * - Trailing stop updated on each 15m candle close
 * - Uses native Binance trailing which triggers intra-candle
 * 
 * This backtest simulates the same behavior
 */

import fs from 'fs';

const dataDir = './data';
const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'AVAX', 'DOT', 'LINK', 'ATOM'];

function loadCandles15m(symbol) {
  const file = `${dataDir}/${symbol}_USDT_15m.json`;
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ═══════════════════════════════════════════════════════════════════
// INDICATORS (same as production momentumSimple.ts)
// ═══════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════
// SIGNAL DETECTION (same as production)
// ═══════════════════════════════════════════════════════════════════

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
    // LONG only in BULL market
    const breakout = current.close > bb.upper;
    const rocOk = roc10 >= 0.025;
    const volOk = volRatio >= 2.0;
    const consecOk = countConsecUp(candles) <= 6;
    const candleOk = isBullish;
    
    if (breakout && rocOk && volOk && consecOk && candleOk) {
      return 'long';
    }
  } else {
    // SHORT only in BEAR market
    const breakdown = current.close < bb.lower;
    const rocOk = roc10 <= -0.025;
    const volOk = volRatio >= 2.0;
    const consecOk = countConsecDown(candles) <= 6;
    const candleOk = isBearish;
    
    if (breakdown && rocOk && volOk && consecOk && candleOk) {
      return 'short';
    }
  }
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// DYNAMIC STOP LOSS (V5.11 config)
// ═══════════════════════════════════════════════════════════════════

function calcDynamicSL(candles) {
  const atr = calcATR(candles, 14);
  if (!atr) return 2.5;
  
  const price = candles[candles.length - 1].close;
  const atrPct = (atr / price) * 100;
  const slPct = atrPct * 3.0; // ATR × 3.0 (V5.11)
  
  return Math.max(1.0, Math.min(4.5, slPct)); // Clamp 1.0% - 4.5%
}

// ═══════════════════════════════════════════════════════════════════
// BACKTEST ENGINE
// ═══════════════════════════════════════════════════════════════════

function runBacktest(config) {
  const { trailActivation, trailDistance } = config;
  
  // Load all 15m data
  const allData = {};
  for (const symbol of symbols) {
    const candles = loadCandles15m(symbol);
    if (candles) allData[symbol] = candles;
  }
  
  if (!allData.BTC) {
    console.error('BTC data not found!');
    return null;
  }
  
  const btcCandles = allData.BTC;
  const symbolList = Object.keys(allData).filter(s => s !== 'BTC');
  
  let capital = 10000;
  const trades = [];
  const positions = {};
  const cooldowns = {};
  
  for (const s of symbolList) {
    positions[s] = null;
    cooldowns[s] = 0;
  }
  
  // Align all candles by timestamp
  const btcTimeMap = new Map();
  btcCandles.forEach((c, i) => btcTimeMap.set(c.openTime, i));
  
  // Calculate SMA200 on 15m candles (200 × 4 = 800 15m candles = 200 hours)
  // Actually for BTC regime, we should use 1h equivalent: SMA200 on 1h = SMA(200*4) on 15m
  // Simplified: use SMA800 on 15m data
  const SMA_PERIOD = 800; // 200 hours worth of 15m candles
  
  // Main loop - process each 15m candle
  for (let btcIdx = SMA_PERIOD; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];
    const btcCloses = btcCandles.slice(0, btcIdx + 1).map(c => c.close);
    const btcSMA200 = calcSMA(btcCloses, SMA_PERIOD);
    const isBull = btcCandle.close > btcSMA200;
    
    // Process each symbol
    for (const symbol of symbolList) {
      const symbolCandles = allData[symbol];
      
      // Find matching candle index by timestamp
      const matchIdx = symbolCandles.findIndex(c => c.openTime === btcCandle.openTime);
      if (matchIdx < 50) continue;
      
      const windowCandles = symbolCandles.slice(0, matchIdx + 1);
      const current = windowCandles[windowCandles.length - 1];
      
      cooldowns[symbol] = Math.max(0, cooldowns[symbol] - 1);
      
      // Check position exit
      if (positions[symbol]) {
        const pos = positions[symbol];
        const holdBars = matchIdx - pos.entryIdx;
        
        let pnlPct;
        if (pos.side === 'long') {
          pnlPct = ((current.close - pos.entryPrice) / pos.entryPrice) * 100;
        } else {
          pnlPct = ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
        }
        
        let exitReason = null;
        let exitPrice = current.close;
        
        // Check trailing stop (production uses TRAILING_STOP_MARKET)
        if (pos.side === 'long') {
          // Update HWM based on HIGH of candle (intra-candle max)
          if (current.high > pos.hwm) {
            pos.hwm = current.high;
          }
          
          const hwmPnl = ((pos.hwm - pos.entryPrice) / pos.entryPrice) * 100;
          
          // Trail activates when HWM reaches activation threshold
          if (hwmPnl >= trailActivation) {
            pos.trailActive = true;
          }
          
          if (pos.trailActive) {
            // Trail stop = HWM - distance
            const trailStop = pos.hwm * (1 - trailDistance / 100);
            
            // Check if LOW of candle hit the trail stop (simulates intra-candle trigger)
            if (current.low <= trailStop) {
              exitReason = 'TRAIL';
              exitPrice = trailStop;
            }
          }
        } else {
          // SHORT
          if (current.low < pos.lwm) {
            pos.lwm = current.low;
          }
          
          const lwmPnl = ((pos.entryPrice - pos.lwm) / pos.entryPrice) * 100;
          
          if (lwmPnl >= trailActivation) {
            pos.trailActive = true;
          }
          
          if (pos.trailActive) {
            const trailStop = pos.lwm * (1 + trailDistance / 100);
            
            if (current.high >= trailStop) {
              exitReason = 'TRAIL';
              exitPrice = trailStop;
            }
          }
        }
        
        // Check SL (uses candle LOW/HIGH to simulate intra-candle SL hit)
        if (!exitReason) {
          if (pos.side === 'long') {
            const slPrice = pos.entryPrice * (1 - pos.slPct / 100);
            if (current.low <= slPrice) {
              exitReason = 'SL';
              exitPrice = slPrice;
            }
          } else {
            const slPrice = pos.entryPrice * (1 + pos.slPct / 100);
            if (current.high >= slPrice) {
              exitReason = 'SL';
              exitPrice = slPrice;
            }
          }
        }
        
        // Time exit (192 × 15min = 48 hours)
        if (!exitReason && holdBars >= 192) {
          exitReason = 'TIME';
        }
        
        if (exitReason) {
          // Calculate PnL with exit price
          let pricePct;
          if (pos.side === 'long') {
            pricePct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
          } else {
            pricePct = ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
          }
          
          const leverage = 4.5;
          const netPnlPct = pricePct * leverage - 0.04 * 2 * leverage; // Fees
          const netPnlUsd = (netPnlPct / 100) * pos.marginUsd;
          
          capital += netPnlUsd + pos.marginUsd;
          
          // Look ahead to see if we exited too early
          let maxFutureProfit = 0;
          const lookAhead = Math.min(48, symbolCandles.length - matchIdx - 1);
          
          for (let i = 1; i <= lookAhead; i++) {
            const futureCandle = symbolCandles[matchIdx + i];
            if (!futureCandle) break;
            
            let futurePnl;
            if (pos.side === 'long') {
              futurePnl = ((futureCandle.high - pos.entryPrice) / pos.entryPrice) * 100;
            } else {
              futurePnl = ((pos.entryPrice - futureCandle.low) / pos.entryPrice) * 100;
            }
            maxFutureProfit = Math.max(maxFutureProfit, futurePnl);
          }
          
          trades.push({
            symbol,
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice,
            pnlPct: netPnlPct,
            exitReason,
            maxFutureProfit: maxFutureProfit * leverage,
            holdBars,
            date: new Date(btcCandle.openTime).toISOString().split('T')[0],
          });
          
          positions[symbol] = null;
          cooldowns[symbol] = 32; // 32 × 15min = 8 hours cooldown
        }
      }
      
      // Check for new entry
      if (!positions[symbol] && cooldowns[symbol] <= 0 && capital > 100) {
        const signal = checkSignal(windowCandles, isBull);
        if (signal) {
          const slPct = calcDynamicSL(windowCandles);
          const marginUsd = capital * 0.4;
          
          positions[symbol] = {
            side: signal,
            entryPrice: current.close,
            entryIdx: matchIdx,
            slPct,
            marginUsd,
            hwm: current.close,
            lwm: current.close,
            trailActive: false,
          };
          
          capital -= marginUsd;
        }
      }
    }
  }
  
  // Close remaining positions
  for (const symbol of symbolList) {
    if (positions[symbol]) {
      capital += positions[symbol].marginUsd;
    }
  }
  
  return { capital, trades };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN - Test different trailing configs
// ═══════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('📊 BACKTEST WITH 15-MINUTE CANDLES (PRODUCTION CONDITIONS)');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  
  const configs = [
    { name: 'V5.11 Current', trailActivation: 0.5, trailDistance: 0.3 },
    { name: 'More Buffer 1', trailActivation: 0.75, trailDistance: 0.3 },
    { name: 'More Buffer 2', trailActivation: 1.0, trailDistance: 0.4 },
    { name: 'Conservative', trailActivation: 1.0, trailDistance: 0.5 },
    { name: 'Very Conservative', trailActivation: 1.5, trailDistance: 0.5 },
    { name: 'Old Config', trailActivation: 1.0, trailDistance: 0.4 },
    { name: 'Wider Distance', trailActivation: 0.5, trailDistance: 0.5 },
    { name: 'ATR-like Wide', trailActivation: 1.0, trailDistance: 0.75 },
  ];
  
  const results = [];
  
  for (const cfg of configs) {
    process.stdout.write(`Testing ${cfg.name}...`);
    const result = runBacktest(cfg);
    
    if (!result) continue;
    
    const { capital, trades } = result;
    const wins = trades.filter(t => t.pnlPct > 0);
    const slExits = trades.filter(t => t.exitReason === 'SL');
    const trailExits = trades.filter(t => t.exitReason === 'TRAIL');
    
    // Noise = exited early and would have made 5%+ more
    const noiseExits = trailExits.filter(t => t.maxFutureProfit > t.pnlPct + 5);
    
    const roi = ((capital - 10000) / 10000) * 100;
    const avgPnl = trades.reduce((sum, t) => sum + t.pnlPct, 0) / trades.length;
    
    results.push({
      ...cfg,
      trades: trades.length,
      winRate: (wins.length / trades.length * 100).toFixed(1),
      roi: roi.toFixed(0),
      avgPnl: avgPnl.toFixed(2),
      slPct: (slExits.length / trades.length * 100).toFixed(1),
      trailPct: (trailExits.length / trades.length * 100).toFixed(1),
      noisePct: (noiseExits.length / trailExits.length * 100).toFixed(1),
      noiseCount: noiseExits.length,
    });
    
    console.log(` ✓`);
  }
  
  // Sort by ROI
  results.sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi));
  
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('RESULTS - SORTED BY ROI');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  
  console.log('┌────────────────────┬────────┬────────┬──────────┬────────┬────────┬────────┬────────┐');
  console.log('│ Config             │ Activ% │ Dist%  │ Trades   │ WR%    │ ROI%   │ Trail% │ Noise% │');
  console.log('├────────────────────┼────────┼────────┼──────────┼────────┼────────┼────────┼────────┤');
  
  for (const r of results) {
    console.log(`│ ${r.name.padEnd(18)} │ ${r.trailActivation.toFixed(2).padStart(5)}% │ ${r.trailDistance.toFixed(2).padStart(5)}% │ ${String(r.trades).padStart(8)} │ ${r.winRate.padStart(5)}% │ ${('+' + r.roi + '%').padStart(7)} │ ${r.trailPct.padStart(5)}% │ ${r.noisePct.padStart(5)}% │`);
  }
  
  console.log('└────────────────────┴────────┴────────┴──────────┴────────┴────────┴────────┴────────┘');
  
  // Show noise analysis for best config
  const best = results[0];
  console.log(`\n📍 BEST CONFIG: ${best.name}`);
  console.log(`   Activation: ${best.trailActivation}% | Distance: ${best.trailDistance}%`);
  console.log(`   ROI: +${best.roi}% | Win Rate: ${best.winRate}%`);
  console.log(`   Trail Exits: ${best.trailPct}% | Noise Exits: ${best.noisePct}% (${best.noiseCount} trades)`);
  
  // Compare V5.11 vs best
  const v511 = results.find(r => r.name === 'V5.11 Current');
  if (v511 && v511.name !== best.name) {
    console.log(`\n📊 V5.11 Current: ROI +${v511.roi}% | Noise: ${v511.noisePct}%`);
    const roiDiff = parseFloat(best.roi) - parseFloat(v511.roi);
    const noiseDiff = parseFloat(v511.noisePct) - parseFloat(best.noisePct);
    console.log(`   Difference: ROI ${roiDiff > 0 ? '+' : ''}${roiDiff.toFixed(0)}% | Noise ${noiseDiff > 0 ? '-' : '+'}${Math.abs(noiseDiff).toFixed(1)}%`);
  }
}

main().catch(console.error);
