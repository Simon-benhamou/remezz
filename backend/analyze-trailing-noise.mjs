#!/usr/bin/env node
/**
 * 📊 TRAILING NOISE ANALYSIS
 * 
 * Analyse approfondie du bruit vs les trailing exits
 * Regarde spécifiquement les trades où le trailing a causé un exit
 * alors que le prix a continué dans la bonne direction après
 */

import fs from 'fs';

const dataDir = './data';
const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'AVAX', 'DOT', 'LINK'];

function loadCandles(symbol) {
  const file = `${dataDir}/${symbol}_USDT_1h.json`;
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Indicateurs (même que avant)
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

// Backtest avec analyse du "missed profit"
function runDetailedBacktest(allData, btcCandles, params) {
  const { trailActivation, trailDistance } = params;
  
  const btcCloses = btcCandles.map(c => c.close);
  const symbolList = Object.keys(allData);
  
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
      
      // Manage position
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
          // Look ahead to see what would have happened
          let maxFutureProfit = 0;
          let minFutureLoss = 0;
          const lookAhead = Math.min(48, candles.length - btcIdx - 1); // 48 bars = 48h for 1h data
          
          for (let i = 1; i <= lookAhead; i++) {
            const futureCandle = candles[btcIdx + i];
            if (!futureCandle) break;
            
            let futurePnl;
            if (pos.side === 'long') {
              futurePnl = ((futureCandle.high - pos.entryPrice) / pos.entryPrice) * 100;
              const futureLow = ((futureCandle.low - pos.entryPrice) / pos.entryPrice) * 100;
              minFutureLoss = Math.min(minFutureLoss, futureLow);
            } else {
              futurePnl = ((pos.entryPrice - futureCandle.low) / pos.entryPrice) * 100;
              const futureHigh = ((pos.entryPrice - futureCandle.high) / pos.entryPrice) * 100;
              minFutureLoss = Math.min(minFutureLoss, futureHigh);
            }
            maxFutureProfit = Math.max(maxFutureProfit, futurePnl);
          }
          
          const pricePct = pos.side === 'long'
            ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
          
          const leverage = 4.5;
          const netPnlPct = pricePct * leverage - 0.04 * 2 * leverage;
          
          trades.push({
            symbol,
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice,
            pnlPct: netPnlPct,
            exitReason,
            holdBars,
            hwm: pos.hwm,
            lwm: pos.lwm,
            maxFutureProfit: maxFutureProfit * leverage,
            minFutureLoss: minFutureLoss * leverage,
            missedProfit: Math.max(0, maxFutureProfit * leverage - netPnlPct),
            wouldHitSL: minFutureLoss <= -pos.slPct,
          });
          
          positions[symbol] = null;
          cooldowns[symbol] = 8;
        }
      }
      
      // New entry
      if (!positions[symbol] && cooldowns[symbol] <= 0) {
        const signal = checkSignal(windowCandles, isBull);
        if (signal) {
          const slPct = calcDynamicSL(windowCandles);
          
          positions[symbol] = {
            side: signal,
            entryPrice: current.close,
            entryIdx: btcIdx,
            slPct,
            hwm: signal === 'long' ? current.close : undefined,
            lwm: signal === 'short' ? current.close : undefined,
          };
        }
      }
    }
  }
  
  return trades;
}

async function main() {
  console.log('📊 TRAILING NOISE DEEP ANALYSIS\n');
  
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
  
  // Test current config
  console.log('Analyzing V5.11 (0.5%/0.3%) trailing exits...\n');
  
  const trades = runDetailedBacktest(allData, btcCandles, {
    trailActivation: 0.5,
    trailDistance: 0.3,
  });
  
  const trailExits = trades.filter(t => t.exitReason === 'TRAIL');
  
  console.log(`Total trades: ${trades.length}`);
  console.log(`Trailing exits: ${trailExits.length} (${(trailExits.length / trades.length * 100).toFixed(1)}%)\n`);
  
  // Analyze trailing exits
  let prematureCount = 0;
  let totalMissedProfit = 0;
  let goodExitCount = 0;
  let noiseExitCount = 0;
  
  const prematureExamples = [];
  const noiseExamples = [];
  
  for (const t of trailExits) {
    // Premature = we exited with profit < 3% but price went higher after
    if (t.pnlPct > 0 && t.pnlPct < 10 && t.missedProfit > 5) {
      prematureCount++;
      totalMissedProfit += t.missedProfit;
      if (prematureExamples.length < 5) {
        prematureExamples.push(t);
      }
    }
    
    // Noise exit = trail triggered but price would NOT have hit SL
    // Meaning the retracement was temporary
    if (!t.wouldHitSL && t.maxFutureProfit > t.pnlPct + 5) {
      noiseExitCount++;
      if (noiseExamples.length < 5) {
        noiseExamples.push(t);
      }
    }
    
    // Good exit = we exited and price would have hit SL
    if (t.wouldHitSL) {
      goodExitCount++;
    }
  }
  
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('TRAILING EXIT QUALITY ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  
  console.log(`✅ GOOD exits (saved from SL): ${goodExitCount} (${(goodExitCount/trailExits.length*100).toFixed(1)}%)`);
  console.log(`   → Price would have hit stop loss after we exited`);
  console.log();
  console.log(`⚠️  NOISE exits (premature): ${noiseExitCount} (${(noiseExitCount/trailExits.length*100).toFixed(1)}%)`);
  console.log(`   → Trail triggered by noise, price recovered and went higher`);
  console.log();
  console.log(`📉 MISSED PROFIT: ${prematureCount} trades, ~$${(totalMissedProfit / 100 * 10000 * 0.4).toFixed(0)} USD potential`);
  
  if (noiseExamples.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════════════════');
    console.log('NOISE EXIT EXAMPLES (trailing triggered by noise)');
    console.log('═══════════════════════════════════════════════════════════════════\n');
    
    for (const t of noiseExamples) {
      console.log(`${t.symbol} ${t.side.toUpperCase()}:`);
      console.log(`  Entry: $${t.entryPrice.toFixed(4)}`);
      console.log(`  Exit:  $${t.exitPrice.toFixed(4)} (Trail triggered)`);
      console.log(`  PnL:   +${t.pnlPct.toFixed(1)}%`);
      console.log(`  Max future profit: +${t.maxFutureProfit.toFixed(1)}% (missed ${t.missedProfit.toFixed(1)}%)`);
      console.log(`  Would hit SL after exit: ${t.wouldHitSL ? 'YES' : 'NO'}`);
      console.log();
    }
  }
  
  // Compare with wider trailing
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('COMPARISON: 0.3% vs 0.4% vs 0.5% trailing distance');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  
  for (const dist of [0.3, 0.4, 0.5]) {
    const testTrades = runDetailedBacktest(allData, btcCandles, {
      trailActivation: 0.5,
      trailDistance: dist,
    });
    
    const testTrail = testTrades.filter(t => t.exitReason === 'TRAIL');
    const testNoise = testTrail.filter(t => !t.wouldHitSL && t.maxFutureProfit > t.pnlPct + 5);
    const testGood = testTrail.filter(t => t.wouldHitSL);
    
    const wins = testTrades.filter(t => t.pnlPct > 0);
    const totalPnl = testTrades.reduce((a, t) => a + t.pnlPct, 0);
    
    console.log(`Distance ${dist}%:`);
    console.log(`  Trades: ${testTrades.length} | WR: ${(wins.length/testTrades.length*100).toFixed(1)}%`);
    console.log(`  Trail exits: ${testTrail.length} (${testGood.length} good, ${testNoise.length} noise)`);
    console.log(`  Noise ratio: ${(testNoise.length/testTrail.length*100).toFixed(1)}%`);
    console.log();
  }
  
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('RECOMMENDATION');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  
  const noiseRatio = noiseExitCount / trailExits.length * 100;
  
  if (noiseRatio > 30) {
    console.log(`⚠️  HIGH NOISE RATIO: ${noiseRatio.toFixed(1)}% of trailing exits are triggered by noise`);
    console.log(`   → Consider increasing trailing distance from 0.3% to 0.4% or 0.5%`);
    console.log(`   → This will reduce false exits caused by intra-candle volatility`);
  } else if (noiseRatio > 15) {
    console.log(`⚡ MODERATE NOISE: ${noiseRatio.toFixed(1)}% of trailing exits are noise`);
    console.log(`   → Current 0.3% is acceptable but 0.4% could be safer`);
  } else {
    console.log(`✅ LOW NOISE: Only ${noiseRatio.toFixed(1)}% of trailing exits are noise`);
    console.log(`   → Current 0.3% distance is working well`);
  }
}

main().catch(console.error);
