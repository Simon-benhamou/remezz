/**
 * Test different MAX_CONSEC_UP settings to see impact on performance
 * Compare: 3 (current), 4, 5, NO_LIMIT
 */
import fs from 'fs';
import path from 'path';

const SYMBOLS = ['SOL/USDT:USDT', 'ETH/USDT:USDT', 'BTC/USDT:USDT', 'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'DOT/USDT:USDT', 'DOGE/USDT:USDT', 'XRP/USDT:USDT', 'ATOM/USDT:USDT'];

const CONFIG = {
  RSI_PERIOD: 14,
  MACD_FAST: 12,
  MACD_SLOW: 26,
  MACD_SIGNAL: 9,
  ATR_PERIOD: 14,
  BB_PERIOD: 20,
  BB_STD: 2.0,
  SL_ATR_MULT: 3.0,
  SL_MIN_PCT: 1.0,
  SL_MAX_PCT: 4.5,
  TRAIL_ACTIVATION_PCT: 0.5,
  TRAIL_DISTANCE_PCT: 0.3,
  FEE_PCT: 0.04,
  LEVERAGE: { 'SOL/USDT:USDT': 4.5, 'ETH/USDT:USDT': 4.5, 'BTC/USDT:USDT': 4, 'AVAX/USDT:USDT': 4, 'LINK/USDT:USDT': 4, 'DOT/USDT:USDT': 4, 'DOGE/USDT:USDT': 4, 'XRP/USDT:USDT': 4, 'ATOM/USDT:USDT': 4 }
};

// Technical indicators
function calculateSMA(data, period) {
  const sma = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      sma.push(0);
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += data[i - j];
      sma.push(sum / period);
    }
  }
  return sma;
}

function calculateStdDev(data, period, sma, idx) {
  if (idx < period - 1) return 0;
  let sum = 0;
  for (let i = 0; i < period; i++) {
    const diff = data[idx - i] - sma[idx];
    sum += diff * diff;
  }
  return Math.sqrt(sum / period);
}

function calculateBB(closes, period = 20, mult = 2.0) {
  const middle = calculateSMA(closes, period);
  const upper = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    const std = calculateStdDev(closes, period, middle, i);
    upper.push(middle[i] + std * mult);
    lower.push(middle[i] - std * mult);
  }
  return { upper, middle, lower };
}

function calculateRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(0);
  if (closes.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change; else losses -= change;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

function calculateEMA(data, period) {
  const ema = new Array(data.length).fill(0);
  if (data.length < period) return ema;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  ema[period - 1] = sum / period;
  const mult = 2 / (period + 1);
  for (let i = period; i < data.length; i++) ema[i] = (data[i] - ema[i - 1]) * mult + ema[i - 1];
  return ema;
}

function calculateMACD(closes) {
  const emaFast = calculateEMA(closes, CONFIG.MACD_FAST);
  const emaSlow = calculateEMA(closes, CONFIG.MACD_SLOW);
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = calculateEMA(macdLine, CONFIG.MACD_SIGNAL);
  return { histogram: macdLine.map((m, i) => m - signalLine[i]) };
}

function calculateATR(candles, period = 14) {
  const atr = new Array(candles.length).fill(0);
  const tr = candles.map((c, i) => i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i-1].close), Math.abs(c.low - candles[i-1].close)));
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  atr[period - 1] = sum / period;
  for (let i = period; i < candles.length; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  return atr;
}

function calculateROC(closes, period = 10) {
  const roc = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      roc.push(0);
    } else {
      roc.push((closes[i] - closes[i - period]) / closes[i - period]);
    }
  }
  return roc;
}

function calculateVolRatio(candles, period = 20) {
  const ratios = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period) {
      ratios.push(0);
    } else {
      let sum = 0;
      for (let j = 1; j <= period; j++) sum += candles[i - j].volume;
      const avgVol = sum / period;
      ratios.push(avgVol > 0 ? candles[i].volume / avgVol : 0);
    }
  }
  return ratios;
}

function countConsecUp(candles, idx) {
  let count = 0;
  for (let i = idx; i >= 0; i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}

function runBacktest(candles, symbol, maxConsecUp) {
  const closes = candles.map(c => c.close);
  const rsi = calculateRSI(closes);
  const macd = calculateMACD(closes);
  const atr = calculateATR(candles);
  const bb = calculateBB(closes);
  const roc = calculateROC(closes, 10);
  const volRatio = calculateVolRatio(candles);
  
  const trades = [];
  let position = null;
  let skippedByConsecUp = 0;
  
  for (let i = 50; i < candles.length; i++) {
    const candle = candles[i];
    const price = candle.close;
    const ts = new Date(candle.timestamp);
    
    // Exit logic
    if (position) {
      if (candle.high > position.highWaterMark) {
        position.highWaterMark = candle.high;
        const pnlPct = ((candle.high - position.entryPrice) / position.entryPrice) * 100;
        if (pnlPct >= CONFIG.TRAIL_ACTIVATION_PCT && !position.trailingActive) {
          position.trailingActive = true;
          position.trailingStop = candle.high * (1 - CONFIG.TRAIL_DISTANCE_PCT / 100);
        }
        if (position.trailingActive) {
          position.trailingStop = Math.max(position.trailingStop, candle.high * (1 - CONFIG.TRAIL_DISTANCE_PCT / 100));
        }
      }
      
      let exitPrice = null, exitReason = null;
      if (candle.low <= position.stopLoss) { exitPrice = position.stopLoss; exitReason = 'SL'; }
      else if (position.trailingActive && candle.low <= position.trailingStop) { exitPrice = position.trailingStop; exitReason = 'TRAIL'; }
      
      if (exitPrice) {
        const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
        const notional = 1000;
        const fees = notional * CONFIG.FEE_PCT / 100 * 2;
        trades.push({ 
          entryTime: position.entryTime, 
          exitTime: ts, 
          pnlPct, 
          pnlUsd: (pnlPct / 100) * notional - fees, 
          exitReason,
          consecUp: position.consecUp
        });
        position = null;
      }
    }
    
    // Entry logic - LONG only
    if (!position) {
      const isBullish = candle.close > candle.open;
      const breakout = price > bb.upper[i];
      const rocOk = roc[i] >= 0.03; // 3% min
      const volOk = volRatio[i] >= 1.5;
      const consecUp = countConsecUp(candles, i);
      const consecOk = maxConsecUp === 999 ? true : consecUp <= maxConsecUp;
      
      // Track skipped trades
      if (isBullish && breakout && rocOk && volOk && !consecOk) {
        skippedByConsecUp++;
      }
      
      if (isBullish && breakout && rocOk && volOk && consecOk && atr[i] > 0) {
        const slPct = Math.max(CONFIG.SL_MIN_PCT, Math.min(CONFIG.SL_MAX_PCT, (atr[i] / price) * 100 * CONFIG.SL_ATR_MULT));
        position = {
          entryPrice: price,
          entryTime: ts,
          stopLoss: price * (1 - slPct / 100),
          highWaterMark: price,
          trailingActive: false,
          trailingStop: 0,
          consecUp
        };
      }
    }
  }
  
  return { trades, skippedByConsecUp };
}

// Load data and test
console.log('╔════════════════════════════════════════════════════════════════════╗');
console.log('║       MAX_CONSEC_UP Filter Impact Analysis - V5.11 Strategy       ║');
console.log('╚════════════════════════════════════════════════════════════════════╝\n');

const scenarios = [
  { name: 'Current (3)', maxConsecUp: 3 },
  { name: 'Relaxed (4)', maxConsecUp: 4 },
  { name: 'Very Relaxed (5)', maxConsecUp: 5 },
  { name: 'No Limit', maxConsecUp: 999 }
];

const results = [];

for (const scenario of scenarios) {
  const allTrades = [];
  let totalSkipped = 0;
  
  for (const symbol of SYMBOLS) {
    const filename = symbol.replace('/', '_').replace(':USDT', '') + '_1h.json';
    const filepath = path.join(process.cwd(), 'data', filename);
    if (!fs.existsSync(filepath)) continue;
    
    const candles = JSON.parse(fs.readFileSync(filepath, 'utf-8')).map(c => ({
      timestamp: c.timestamp || c.openTime,
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
    }));
    
    const { trades, skippedByConsecUp } = runBacktest(candles, symbol, scenario.maxConsecUp);
    allTrades.push(...trades);
    totalSkipped += skippedByConsecUp;
  }
  
  const wins = allTrades.filter(t => t.pnlUsd > 0).length;
  const losses = allTrades.filter(t => t.pnlUsd <= 0).length;
  const totalPnl = allTrades.reduce((s, t) => s + t.pnlUsd, 0);
  const slCount = allTrades.filter(t => t.exitReason === 'SL').length;
  const avgConsecUp = allTrades.length > 0 ? allTrades.reduce((s, t) => s + t.consecUp, 0) / allTrades.length : 0;
  
  results.push({
    scenario: scenario.name,
    maxConsecUp: scenario.maxConsecUp,
    trades: allTrades.length,
    wins,
    losses,
    winRate: allTrades.length > 0 ? (wins / allTrades.length) * 100 : 0,
    totalPnl,
    avgPnl: allTrades.length > 0 ? totalPnl / allTrades.length : 0,
    slRate: allTrades.length > 0 ? (slCount / allTrades.length) * 100 : 0,
    skipped: totalSkipped,
    avgConsecUp
  });
}

// Display results
console.log('═══ COMPARISON RESULTS ═══\n');
console.log('Scenario       │ Trades │  WR%  │  Total PnL  │ Avg PnL │  SL%  │ Skipped │ Avg ConsecUp');
console.log('───────────────┼────────┼───────┼─────────────┼─────────┼───────┼─────────┼─────────────');

for (const r of results) {
  const pnlStr = (r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(0) + '$';
  const avgPnlStr = (r.avgPnl >= 0 ? '+' : '') + r.avgPnl.toFixed(2) + '$';
  console.log(
    `${r.scenario.padEnd(14)} │ ${String(r.trades).padStart(5)}  │ ${r.winRate.toFixed(0).padStart(4)}% │ ${pnlStr.padStart(10)}  │ ${avgPnlStr.padStart(7)} │ ${r.slRate.toFixed(0).padStart(4)}% │ ${String(r.skipped).padStart(6)}  │ ${r.avgConsecUp.toFixed(1)}`
  );
}

// Analysis
console.log('\n═══ DETAILED ANALYSIS ═══\n');

const baseline = results[0]; // Current (3)
console.log(`📊 Baseline (MAX_CONSEC_UP = 3):`);
console.log(`   ${baseline.trades} trades, ${baseline.winRate.toFixed(0)}% WR, ${baseline.totalPnl >= 0 ? '+' : ''}${baseline.totalPnl.toFixed(0)}$ total`);
console.log(`   Skipped ${baseline.skipped} potential entries\n`);

for (let i = 1; i < results.length; i++) {
  const r = results[i];
  const diffTrades = r.trades - baseline.trades;
  const diffPnl = r.totalPnl - baseline.totalPnl;
  const diffWR = r.winRate - baseline.winRate;
  const additionalTradesWR = diffTrades > 0 ? ((r.wins - baseline.wins) / diffTrades) * 100 : 0;
  const additionalTradesPnl = diffTrades > 0 ? diffPnl / diffTrades : 0;
  
  console.log(`${r.scenario}:`);
  console.log(`   ${diffTrades >= 0 ? '+' : ''}${diffTrades} trades (${r.trades} total)`);
  console.log(`   ${diffPnl >= 0 ? '+' : ''}${diffPnl.toFixed(0)}$ PnL (${r.totalPnl >= 0 ? '+' : ''}${r.totalPnl.toFixed(0)}$ total)`);
  console.log(`   ${diffWR >= 0 ? '+' : ''}${diffWR.toFixed(1)}% WR (${r.winRate.toFixed(0)}% total)`);
  if (diffTrades > 0) {
    console.log(`   → Additional ${diffTrades} trades: ${additionalTradesWR.toFixed(0)}% WR, ${additionalTradesPnl >= 0 ? '+' : ''}${additionalTradesPnl.toFixed(2)}$ avg`);
  }
  console.log(`   Skipped: ${r.skipped} (${baseline.skipped - r.skipped} fewer than baseline)\n`);
}

// Recommendation
console.log('═══ RECOMMENDATION ═══\n');
const best = results.reduce((a, b) => a.totalPnl > b.totalPnl ? a : b);
console.log(`🏆 Best performer: ${best.scenario}`);
console.log(`   Total PnL: ${best.totalPnl >= 0 ? '+' : ''}${best.totalPnl.toFixed(0)}$`);
console.log(`   Win Rate: ${best.winRate.toFixed(0)}%`);
console.log(`   Trades: ${best.trades}`);

if (best.scenario !== baseline.scenario) {
  const improvement = best.totalPnl - baseline.totalPnl;
  const improvementPct = (improvement / Math.abs(baseline.totalPnl || 1)) * 100;
  console.log(`\n   ✅ Switching from ${baseline.scenario} to ${best.scenario} would improve PnL by ${improvement >= 0 ? '+' : ''}${improvement.toFixed(0)}$ (${improvementPct >= 0 ? '+' : ''}${improvementPct.toFixed(0)}%)`);
} else {
  console.log(`\n   ✅ Current setting (${baseline.scenario}) is already optimal`);
}

// Risk analysis
console.log('\n═══ RISK ANALYSIS ═══\n');
for (const r of results) {
  const riskScore = r.slRate * 0.4 + (100 - r.winRate) * 0.6; // Lower is better
  console.log(`${r.scenario.padEnd(14)}: Risk Score = ${riskScore.toFixed(1)} | SL Rate = ${r.slRate.toFixed(0)}% | Loss Rate = ${(100 - r.winRate).toFixed(0)}%`);
}
