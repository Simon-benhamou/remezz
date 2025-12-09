#!/usr/bin/env node
/**
 * Test different SL + Trailing combinations to find optimal
 */

import fs from 'fs';

const dataDir = './data';
const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'LINK'];

function loadCandles(symbol) {
  const file = `${dataDir}/${symbol}_USDT_1h.json`;
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return null;
}

function calcSMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcBB(closes, period = 20, std = 2) {
  if (closes.length < period) return { upper: closes[closes.length-1], middle: closes[closes.length-1], lower: closes[closes.length-1] };
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return { upper: middle + stdDev * std, middle, lower: middle - stdDev * std };
}

function calcVolRatio(volumes) {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 ? current / avg : 0;
}

function calcROC(closes, period = 10) {
  if (closes.length < period + 1) return 0;
  return (closes[closes.length - 1] - closes[closes.length - period - 1]) / closes[closes.length - period - 1];
}

function checkSignal(candles, btcCandles) {
  if (candles.length < 50) return null;
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  const isBullish = current.close > current.open;
  const btcCloses = btcCandles.map(c => c.close);
  const btcSma200 = calcSMA(btcCloses, 200);
  const btcPrice = btcCloses[btcCloses.length - 1];
  if (btcPrice <= btcSma200) return null;
  const bb = calcBB(closes, 20, 2);
  const volRatio = calcVolRatio(volumes);
  const roc = calcROC(closes, 10);
  if (isBullish && current.close < bb.middle && volRatio > 1.2 && roc > 0) {
    return { side: 'long' };
  }
  return null;
}

function checkSignalExit(candles) {
  if (candles.length < 20) return { shouldExit: false };
  const current = candles[candles.length - 1];
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const bb = calcBB(closes, 20, 2);
  const volRatio = calcVolRatio(volumes);
  const roc = calcROC(closes, 5);
  if (current.close > bb.upper && roc < 0) return { shouldExit: true, reason: 'momentum_fade' };
  if (volRatio < 0.5 && current.close < current.open) return { shouldExit: true, reason: 'volume_dry' };
  const candleChange = (current.close - current.open) / current.open;
  if (candleChange < -0.01) return { shouldExit: true, reason: 'strong_bearish' };
  return { shouldExit: false };
}

const allData = {};
for (const s of symbols) { const c = loadCandles(s); if (c) allData[s] = c; }
const btcCandles = allData['BTC'];

console.log('Testing SL + Trailing combinations...\n');

// Test different SL + trailing combinations
const configs = [
  { name: 'CURRENT: SL 1.5% + Trail 0.5/0.3', sl: 1.5, act: 0.5, cb: 0.3 },
  { name: 'OPT B:   SL 1.5% + Trail 1.5/0.3', sl: 1.5, act: 1.5, cb: 0.3 },
  { name: 'OPT B2:  SL 2.0% + Trail 1.5/0.3', sl: 2.0, act: 1.5, cb: 0.3 },
  { name: 'OPT B3:  SL 2.0% + Trail 1.5/0.5', sl: 2.0, act: 1.5, cb: 0.5 },
  { name: 'OPT B4:  SL 2.5% + Trail 1.5/0.5', sl: 2.5, act: 1.5, cb: 0.5 },
  { name: 'WIDE:    SL 2.0% + Trail 2.0/0.5', sl: 2.0, act: 2.0, cb: 0.5 },
];

console.log('┌────────────────────────────────────┬────────┬────────┬──────────┬─────────┬─────────┬─────────┐');
console.log('│ Configuration                      │ Trades │ WinRate│ ROI      │ SL      │ Trail   │ Signal  │');
console.log('├────────────────────────────────────┼────────┼────────┼──────────┼─────────┼─────────┼─────────┤');

for (const cfg of configs) {
  let trades = [], totalPnl = 0;
  
  for (const [symbol, candles] of Object.entries(allData)) {
    let pos = null, high = 0, trailActive = false, trailStop = 0;
    
    for (let i = 50; i < candles.length; i++) {
      const slice = candles.slice(0, i + 1);
      const btcSlice = btcCandles.slice(0, Math.min(i + 1, btcCandles.length));
      const cur = candles[i];
      
      if (pos === null) {
        const sig = checkSignal(slice, btcSlice);
        if (sig) {
          pos = { entry: cur.close, idx: i, sl: cur.close * (1 - cfg.sl / 100) };
          high = cur.close;
          trailActive = false;
        }
      } else {
        let exitP = null, exitR = null;
        
        // Check stop loss
        if (cur.low <= pos.sl) { 
          exitP = pos.sl; 
          exitR = 'stop_loss'; 
        }
        
        // Check trailing stop
        if (exitP === null && trailActive && cur.low <= trailStop) { 
          exitP = trailStop; 
          exitR = 'trailing'; 
        }
        
        // Update high and trailing
        if (exitP === null && cur.high > high) {
          high = cur.high;
          const pnl = (high - pos.entry) / pos.entry * 100;
          if (pnl >= cfg.act) trailActive = true;
          if (trailActive) trailStop = high * (1 - cfg.cb / 100);
        }
        
        // Check intra-candle trailing activation + trigger
        if (exitP === null && trailActive === false) {
          const pnl = (cur.high - pos.entry) / pos.entry * 100;
          if (pnl >= cfg.act) {
            const tmpStop = cur.high * (1 - cfg.cb / 100);
            if (cur.low <= tmpStop) { 
              exitP = tmpStop; 
              exitR = 'trailing'; 
            }
          }
        }
        
        // Check signal exit
        if (exitP === null) {
          const ex = checkSignalExit(slice);
          if (ex.shouldExit) { 
            exitP = cur.close; 
            exitR = ex.reason; 
          }
        }
        
        if (exitP !== null) {
          const pnl = (exitP - pos.entry) / pos.entry * 100;
          trades.push({ pnl, reason: exitR });
          totalPnl += pnl;
          pos = null; 
          high = 0; 
          trailActive = false; 
          trailStop = 0;
        }
      }
    }
  }
  
  const wins = trades.filter(t => t.pnl > 0).length;
  const sl = trades.filter(t => t.reason === 'stop_loss').length;
  const trail = trades.filter(t => t.reason === 'trailing').length;
  const sig = trades.length - sl - trail;
  
  const name = cfg.name.padEnd(34);
  const tradesStr = String(trades.length).padStart(6);
  const wrStr = (wins/trades.length*100).toFixed(0).padStart(6) + '%';
  const roiStr = (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(1).padStart(7) + '%';
  const slStr = `${sl} (${(sl/trades.length*100).toFixed(0)}%)`.padStart(7);
  const trailStr = `${trail} (${(trail/trades.length*100).toFixed(0)}%)`.padStart(7);
  const sigStr = `${sig} (${(sig/trades.length*100).toFixed(0)}%)`.padStart(7);
  
  console.log(`│ ${name} │${tradesStr} │${wrStr} │${roiStr} │${slStr} │${trailStr} │${sigStr} │`);
}

console.log('└────────────────────────────────────┴────────┴────────┴──────────┴─────────┴─────────┴─────────┘');

console.log('\nNOTE: With higher trailing activation (1.5%), more trades hit SL before trailing can protect them.');
console.log('But the trades that DO hit trailing have bigger wins (+1.5% minimum vs +0.5%).');
console.log('The question is: is the extra profit from bigger trailing wins worth the extra SL losses?');
