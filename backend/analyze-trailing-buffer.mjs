#!/usr/bin/env node
/**
 * 📊 TRAILING ACTIVATION vs DISTANCE OPTIMIZATION
 * 
 * Le problème n'est pas juste la distance mais aussi l'activation
 * Si on active le trailing trop tôt (à +0.5%), on n'a pas assez de buffer
 */

import fs from 'fs';

const dataDir = './data';
const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'AVAX', 'DOT', 'LINK'];

function loadCandles(symbol) {
  const file = `${dataDir}/${symbol}_USDT_1h.json`;
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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
    const breakout = current.close > bb.upper;
    const rocOk = roc10 >= 0.025;
    const volOk = volRatio >= 2.0;
    const consecOk = countConsecUp(candles) <= 3;
    
    if (isBullish && breakout && rocOk && volOk && consecOk) {
      return 'long';
    }
  } else {
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

function calcDynamicSL(candles, atrMult = 3.0, minPct = 1.0, maxPct = 4.5) {
  const atr = calcATR(candles, 14);
  if (!atr || candles.length === 0) return 2.5;
  
  const price = candles[candles.length - 1].close;
  const atrPct = (atr / price) * 100;
  const rawSL = atrPct * atrMult;
  return Math.min(maxPct, Math.max(minPct, rawSL));
}

function runBacktest(allData, btcCandles, params) {
  const { trailActivation, trailDistance } = params;
  
  const btcCloses = btcCandles.map(c => c.close);
  const symbolList = Object.keys(allData);
  
  let capital = 10000;
  let trades = [];
  let positions = {};
  let cooldowns = {};
  
  symbolList.forEach(s => {
    positions[s] = null;
    cooldowns[s] = 0;
  });
  
  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
    const btcPrice = btcCloses[btcIdx - 1];
    const isBull = btcPrice > btcSma200;
    
    for (const symbol of symbolList) {
      const candles = allData[symbol];
      if (!candles || btcIdx >= candles.length) continue;
      
      const current = candles[btcIdx];
      const windowCandles = candles.slice(Math.max(0, btcIdx - 200), btcIdx + 1);
      
      if (cooldowns[symbol] > 0) cooldowns[symbol]--;
      
      if (positions[symbol]) {
        const pos = positions[symbol];
        const holdBars = btcIdx - pos.entryIdx;
        let exitReason = null;
        let exitPrice = current.close;
        
        if (pos.side === 'long') {
          const pnlPct = ((current.close - pos.entryPrice) / pos.entryPrice) * 100;
          pos.hwm = Math.max(pos.hwm || pos.entryPrice, current.high);
          const hwmPct = ((pos.hwm - pos.entryPrice) / pos.entryPrice) * 100;
          
          if (hwmPct >= trailActivation) {
            const trailStop = pos.hwm * (1 - trailDistance / 100);
            if (current.low <= trailStop) {
              exitReason = 'TRAIL';
              exitPrice = trailStop;
            }
          }
          
          if (!exitReason && pnlPct <= -pos.slPct) {
            exitReason = 'SL';
            exitPrice = pos.entryPrice * (1 - pos.slPct / 100);
          }
          
          if (!exitReason && pnlPct >= 3.0) {
            exitReason = 'TP';
            exitPrice = pos.entryPrice * 1.03;
          }
          
          if (!exitReason && holdBars >= 192) {
            exitReason = 'TIME';
          }
        } else {
          const pnlPct = ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
          pos.lwm = Math.min(pos.lwm || pos.entryPrice, current.low);
          const lwmPct = ((pos.entryPrice - pos.lwm) / pos.entryPrice) * 100;
          
          if (lwmPct >= trailActivation) {
            const trailStop = pos.lwm * (1 + trailDistance / 100);
            if (current.high >= trailStop) {
              exitReason = 'TRAIL';
              exitPrice = trailStop;
            }
          }
          
          if (!exitReason && pnlPct <= -pos.slPct) {
            exitReason = 'SL';
            exitPrice = pos.entryPrice * (1 + pos.slPct / 100);
          }
          
          if (!exitReason && pnlPct >= 3.0) {
            exitReason = 'TP';
            exitPrice = pos.entryPrice * 0.97;
          }
          
          if (!exitReason && holdBars >= 192) {
            exitReason = 'TIME';
          }
        }
        
        if (exitReason) {
          // Look ahead
          let maxFutureProfit = 0;
          const lookAhead = Math.min(48, candles.length - btcIdx - 1);
          
          for (let i = 1; i <= lookAhead; i++) {
            const futureCandle = candles[btcIdx + i];
            if (!futureCandle) break;
            
            let futurePnl;
            if (pos.side === 'long') {
              futurePnl = ((futureCandle.high - pos.entryPrice) / pos.entryPrice) * 100;
            } else {
              futurePnl = ((pos.entryPrice - futureCandle.low) / pos.entryPrice) * 100;
            }
            maxFutureProfit = Math.max(maxFutureProfit, futurePnl);
          }
          
          const pricePct = pos.side === 'long'
            ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
          
          const leverage = 4.5;
          const netPnlPct = pricePct * leverage - 0.04 * 2 * leverage;
          const netPnlUsd = (netPnlPct / 100) * pos.marginUsd;
          
          capital += netPnlUsd + pos.marginUsd;
          
          trades.push({
            pnlPct: netPnlPct,
            exitReason,
            maxFutureProfit: maxFutureProfit * leverage,
            wouldHitSL: false, // Simplified
          });
          
          positions[symbol] = null;
          cooldowns[symbol] = 8;
        }
      }
      
      if (!positions[symbol] && cooldowns[symbol] <= 0 && capital > 100) {
        const signal = checkSignal(windowCandles, isBull);
        if (signal) {
          const slPct = calcDynamicSL(windowCandles);
          const marginUsd = capital * 0.4;
          
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
  
  // Close remaining
  for (const symbol of symbolList) {
    if (positions[symbol]) {
      capital += positions[symbol].marginUsd;
    }
  }
  
  const wins = trades.filter(t => t.pnlPct > 0);
  const slExits = trades.filter(t => t.exitReason === 'SL');
  const trailExits = trades.filter(t => t.exitReason === 'TRAIL');
  
  // Noise = trail exit where price would have gone higher
  const noiseExits = trailExits.filter(t => t.maxFutureProfit > t.pnlPct + 5);
  
  return {
    totalTrades: trades.length,
    winRate: (wins.length / trades.length * 100) || 0,
    totalPnlPct: ((capital - 10000) / 10000 * 100),
    slExits: slExits.length,
    trailExits: trailExits.length,
    noiseExits: noiseExits.length,
    noiseRatio: trailExits.length > 0 ? (noiseExits.length / trailExits.length * 100) : 0,
    avgTrailPnl: trailExits.length > 0 ? trailExits.reduce((a, t) => a + t.pnlPct, 0) / trailExits.length : 0,
  };
}

async function main() {
  console.log('📊 TRAILING ACTIVATION vs DISTANCE OPTIMIZATION\n');
  
  // Load data
  const allData = {};
  let btcCandles = null;
  
  for (const sym of symbols) {
    const candles = loadCandles(sym);
    if (candles) {
      allData[sym] = candles;
      if (sym === 'BTC') btcCandles = candles;
    }
  }
  
  if (!btcCandles) {
    console.error('BTC data required!');
    return;
  }
  
  console.log('Testing different activation + distance combinations...\n');
  
  // Test matrix
  const activations = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  const distances = [0.3, 0.4, 0.5, 0.6, 0.75];
  
  const results = [];
  
  for (const act of activations) {
    for (const dist of distances) {
      // Distance should be less than activation (makes sense)
      if (dist >= act) continue;
      
      const result = runBacktest(allData, btcCandles, {
        trailActivation: act,
        trailDistance: dist,
      });
      
      results.push({
        activation: act,
        distance: dist,
        buffer: act - dist, // Space between activation and trail stop
        ...result,
      });
    }
  }
  
  // Sort by lowest noise ratio (best quality exits)
  const byQuality = [...results].sort((a, b) => a.noiseRatio - b.noiseRatio);
  
  // Sort by highest ROI
  const byROI = [...results].sort((a, b) => b.totalPnlPct - a.totalPnlPct);
  
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('TOP 10 BY LOWEST NOISE (Best Quality Exits)');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  
  console.log('┌──────────┬──────────┬────────┬────────┬──────────┬────────┬────────┐');
  console.log('│ Activate │ Distance │ Buffer │ Trades │ ROI %    │ Noise% │ AvgPnl │');
  console.log('├──────────┼──────────┼────────┼────────┼──────────┼────────┼────────┤');
  
  for (const r of byQuality.slice(0, 10)) {
    const act = r.activation.toFixed(2).padStart(7) + '%';
    const dist = r.distance.toFixed(2).padStart(7) + '%';
    const buf = r.buffer.toFixed(2).padStart(5) + '%';
    const trades = String(r.totalTrades).padStart(6);
    const roi = (r.totalPnlPct >= 0 ? '+' : '') + r.totalPnlPct.toFixed(0).padStart(7) + '%';
    const noise = r.noiseRatio.toFixed(1).padStart(5) + '%';
    const avgPnl = '+' + r.avgTrailPnl.toFixed(1).padStart(4) + '%';
    
    console.log(`│ ${act} │ ${dist} │${buf} │${trades} │${roi} │${noise} │${avgPnl} │`);
  }
  
  console.log('└──────────┴──────────┴────────┴────────┴──────────┴────────┴────────┘');
  
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('TOP 10 BY ROI (Best Profit)');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  
  console.log('┌──────────┬──────────┬────────┬────────┬──────────┬────────┬────────┐');
  console.log('│ Activate │ Distance │ Buffer │ Trades │ ROI %    │ Noise% │ AvgPnl │');
  console.log('├──────────┼──────────┼────────┼────────┼──────────┼────────┼────────┤');
  
  for (const r of byROI.slice(0, 10)) {
    const act = r.activation.toFixed(2).padStart(7) + '%';
    const dist = r.distance.toFixed(2).padStart(7) + '%';
    const buf = r.buffer.toFixed(2).padStart(5) + '%';
    const trades = String(r.totalTrades).padStart(6);
    const roi = (r.totalPnlPct >= 0 ? '+' : '') + r.totalPnlPct.toFixed(0).padStart(7) + '%';
    const noise = r.noiseRatio.toFixed(1).padStart(5) + '%';
    const avgPnl = '+' + r.avgTrailPnl.toFixed(1).padStart(4) + '%';
    
    console.log(`│ ${act} │ ${dist} │${buf} │${trades} │${roi} │${noise} │${avgPnl} │`);
  }
  
  console.log('└──────────┴──────────┴────────┴────────┴──────────┴────────┴────────┘');
  
  // Find the current config
  const current = results.find(r => r.activation === 0.5 && r.distance === 0.3);
  
  // Find best balance (low noise + good ROI)
  const balanced = results
    .filter(r => r.noiseRatio < 40) // Less than 40% noise
    .sort((a, b) => b.totalPnlPct - a.totalPnlPct)[0];
  
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  
  if (current) {
    console.log(`📍 CURRENT (V5.11): Activation 0.5% / Distance 0.3%`);
    console.log(`   ROI: +${current.totalPnlPct.toFixed(0)}% | Noise: ${current.noiseRatio.toFixed(1)}%`);
  }
  
  if (balanced) {
    console.log(`\n🎯 RECOMMENDED: Activation ${balanced.activation}% / Distance ${balanced.distance}%`);
    console.log(`   ROI: +${balanced.totalPnlPct.toFixed(0)}% | Noise: ${balanced.noiseRatio.toFixed(1)}%`);
    console.log(`   Buffer: ${balanced.buffer.toFixed(2)}% (space before trail triggers)`);
    
    if (current) {
      const noiseImprove = current.noiseRatio - balanced.noiseRatio;
      console.log(`\n   → ${noiseImprove.toFixed(1)}% less noise exits`);
    }
  }
  
  // Key insight
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('KEY INSIGHT');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  
  console.log('The "buffer" (activation - distance) is crucial:');
  console.log('  - Buffer 0.2% (0.5% - 0.3%): Trail triggers immediately after activation → HIGH NOISE');
  console.log('  - Buffer 0.5%+ : Price has room to fluctuate → LOW NOISE');
  console.log();
  console.log('With 0.5% activation and 0.3% distance:');
  console.log('  → Trail activates at +0.5%');
  console.log('  → Trail stop is at +0.2% (0.5% - 0.3%)');
  console.log('  → Only 0.2% buffer for normal volatility!');
  console.log();
  console.log('Recommendation: Increase buffer to at least 0.4% or more');
}

main().catch(console.error);
