/**
 * Test ALL filters individually to see their actual impact
 * Tests: MAX_CONSEC_UP, RSI+BTC filter, ROC min, VOL min
 */
import fs from 'fs';
import path from 'path';

const SYMBOLS = ['SOL/USDT:USDT', 'ETH/USDT:USDT', 'BTC/USDT:USDT', 'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'DOT/USDT:USDT', 'DOGE/USDT:USDT', 'XRP/USDT:USDT', 'ATOM/USDT:USDT'];

const CONFIG = {
  ATR_PERIOD: 14,
  BB_PERIOD: 20,
  BB_STD: 2.0,
  SL_ATR_MULT: 3.0,
  SL_MIN_PCT: 1.0,
  SL_MAX_PCT: 4.5,
  TRAIL_ACTIVATION_PCT: 0.5,
  TRAIL_DISTANCE_PCT: 0.3,
  FEE_PCT: 0.04,
};

function calculateSMA(data, period) {
  const sma = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) sma.push(0);
    else {
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
  const rsi = new Array(closes.length).fill(null);
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
    if (i < period) roc.push(0);
    else roc.push((closes[i] - closes[i - period]) / closes[i - period]);
  }
  return roc;
}

function calculateVolRatio(candles, period = 20) {
  const ratios = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period) ratios.push(0);
    else {
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

function runBacktest(candles, btcCandles, filters) {
  const closes = candles.map(c => c.close);
  const btcCloses = btcCandles.map(c => c.close);
  const rsi = calculateRSI(closes);
  const atr = calculateATR(candles);
  const bb = calculateBB(closes);
  const roc = calculateROC(closes, 10);
  const btcRoc4h = calculateROC(btcCloses, 4);
  const volRatio = calculateVolRatio(candles);
  
  const trades = [];
  const rejections = {
    consecUp: 0,
    rsiFilter: 0,
    rocLow: 0,
    volLow: 0
  };
  let position = null;
  
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
          pnlUsd: (pnlPct / 100) * notional - fees, 
          exitReason
        });
        position = null;
      }
    }
    
    // Entry logic - LONG only
    if (!position) {
      const isBullish = candle.close > candle.open;
      const breakout = price > bb.upper[i];
      const rocValue = roc[i];
      const volValue = volRatio[i];
      const consecUp = countConsecUp(candles, i);
      const rsiValue = rsi[i];
      const btcRocValue = btcRoc4h[i] || 0;
      
      // Base conditions (always required)
      if (!isBullish || !breakout || atr[i] <= 0) continue;
      
      // Test each filter
      let skip = false;
      
      if (filters.maxConsecUp !== null && consecUp > filters.maxConsecUp) {
        rejections.consecUp++;
        skip = true;
      }
      
      if (filters.rsiFilter && rsiValue !== null && rsiValue > 75 && btcRocValue < 0) {
        rejections.rsiFilter++;
        skip = true;
      }
      
      if (filters.rocMin !== null && rocValue < filters.rocMin) {
        rejections.rocLow++;
        skip = true;
      }
      
      if (filters.volMin !== null && volValue < filters.volMin) {
        rejections.volLow++;
        skip = true;
      }
      
      if (skip) continue;
      
      // Enter
      const slPct = Math.max(CONFIG.SL_MIN_PCT, Math.min(CONFIG.SL_MAX_PCT, (atr[i] / price) * 100 * CONFIG.SL_ATR_MULT));
      position = {
        entryPrice: price,
        stopLoss: price * (1 - slPct / 100),
        highWaterMark: price,
        trailingActive: false,
        trailingStop: 0
      };
    }
  }
  
  return { trades, rejections };
}

// Test scenarios
console.log('╔════════════════════════════════════════════════════════════════════╗');
console.log('║           EXHAUSTIVE FILTER ANALYSIS - V5.11 Strategy             ║');
console.log('╚════════════════════════════════════════════════════════════════════╝\n');

const scenarios = [
  { name: 'NO FILTERS (baseline)', filters: { maxConsecUp: null, rsiFilter: false, rocMin: null, volMin: null } },
  { name: 'Only ConsecUp=3', filters: { maxConsecUp: 3, rsiFilter: false, rocMin: null, volMin: null } },
  { name: 'Only RSI+BTC filter', filters: { maxConsecUp: null, rsiFilter: true, rocMin: null, volMin: null } },
  { name: 'Only ROC>=3%', filters: { maxConsecUp: null, rsiFilter: false, rocMin: 0.03, volMin: null } },
  { name: 'Only VOL>=1.5x', filters: { maxConsecUp: null, rsiFilter: false, rocMin: null, volMin: 1.5 } },
  { name: 'ALL FILTERS (current)', filters: { maxConsecUp: 3, rsiFilter: true, rocMin: 0.03, volMin: 1.5 } },
];

const results = [];

// Load BTC for RSI filter
const btcFilename = 'BTC_USDT_1h.json';
const btcCandles = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', btcFilename), 'utf-8')).map(c => ({
  timestamp: c.timestamp || c.openTime,
  open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
}));

for (const scenario of scenarios) {
  const allTrades = [];
  const totalRejections = { consecUp: 0, rsiFilter: 0, rocLow: 0, volLow: 0 };
  
  for (const symbol of SYMBOLS) {
    const filename = symbol.replace('/', '_').replace(':USDT', '') + '_1h.json';
    const filepath = path.join(process.cwd(), 'data', filename);
    if (!fs.existsSync(filepath)) continue;
    
    const candles = JSON.parse(fs.readFileSync(filepath, 'utf-8')).map(c => ({
      timestamp: c.timestamp || c.openTime,
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
    }));
    
    const { trades, rejections } = runBacktest(candles, btcCandles, scenario.filters);
    allTrades.push(...trades);
    totalRejections.consecUp += rejections.consecUp;
    totalRejections.rsiFilter += rejections.rsiFilter;
    totalRejections.rocLow += rejections.rocLow;
    totalRejections.volLow += rejections.volLow;
  }
  
  const wins = allTrades.filter(t => t.pnlUsd > 0).length;
  const totalPnl = allTrades.reduce((s, t) => s + t.pnlUsd, 0);
  const slCount = allTrades.filter(t => t.exitReason === 'SL').length;
  
  results.push({
    scenario: scenario.name,
    trades: allTrades.length,
    wins,
    winRate: allTrades.length > 0 ? (wins / allTrades.length) * 100 : 0,
    totalPnl,
    avgPnl: allTrades.length > 0 ? totalPnl / allTrades.length : 0,
    slRate: allTrades.length > 0 ? (slCount / allTrades.length) * 100 : 0,
    rejections: totalRejections
  });
}

// Display
console.log('═══ RESULTS ═══\n');
console.log('Scenario                  │ Trades │  WR%  │  Total PnL  │ Avg PnL │  SL%');
console.log('──────────────────────────┼────────┼───────┼─────────────┼─────────┼──────');

for (const r of results) {
  const pnlStr = (r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(0) + '$';
  const avgStr = (r.avgPnl >= 0 ? '+' : '') + r.avgPnl.toFixed(2) + '$';
  console.log(
    `${r.scenario.padEnd(25)} │ ${String(r.trades).padStart(5)}  │ ${r.winRate.toFixed(0).padStart(4)}% │ ${pnlStr.padStart(10)}  │ ${avgStr.padStart(7)} │ ${r.slRate.toFixed(0).padStart(4)}%`
  );
}

// Analysis
console.log('\n═══ FILTER IMPACT ANALYSIS ═══\n');

const baseline = results[0];
console.log(`📊 Baseline (NO FILTERS): ${baseline.trades} trades, ${baseline.winRate.toFixed(0)}% WR, ${baseline.totalPnl >= 0 ? '+' : ''}${baseline.totalPnl.toFixed(0)}$ PnL\n`);

for (let i = 1; i < results.length - 1; i++) {
  const r = results[i];
  const impact = r.totalPnl - baseline.totalPnl;
  const tradeDiff = r.trades - baseline.trades;
  const rejected = Object.values(r.rejections).reduce((a, b) => a + b, 0);
  
  console.log(`${r.scenario}:`);
  console.log(`   ${impact >= 0 ? '+' : ''}${impact.toFixed(0)}$ (${(impact / baseline.totalPnl * 100).toFixed(1)}%)`);
  console.log(`   ${tradeDiff} trades (rejected ${rejected})`);
  console.log(`   ${r.winRate.toFixed(0)}% WR (${(r.winRate - baseline.winRate >= 0 ? '+' : '')}${(r.winRate - baseline.winRate).toFixed(1)}%)`);
  console.log(`   Verdict: ${impact < -200 ? '❌ HARMFUL' : impact < 0 ? '⚠️ SLIGHTLY NEGATIVE' : impact < 200 ? '✅ NEUTRAL' : '✅ BENEFICIAL'}\n`);
}

const current = results[results.length - 1];
const totalImpact = current.totalPnl - baseline.totalPnl;
console.log(`\n🔍 CURRENT (ALL FILTERS):`);
console.log(`   ${totalImpact >= 0 ? '+' : ''}${totalImpact.toFixed(0)}$ vs baseline (${(totalImpact / baseline.totalPnl * 100).toFixed(1)}%)`);
console.log(`   Rejected: ConsecUp=${current.rejections.consecUp}, RSI=${current.rejections.rsiFilter}, ROC=${current.rejections.rocLow}, VOL=${current.rejections.volLow}`);

// Recommendation
console.log('\n═══ RECOMMENDATIONS ═══\n');

const best = results.reduce((a, b) => a.totalPnl > b.totalPnl ? a : b);
console.log(`🏆 Best: ${best.scenario}`);
console.log(`   PnL: ${best.totalPnl >= 0 ? '+' : ''}${best.totalPnl.toFixed(0)}$ | WR: ${best.winRate.toFixed(0)}% | Trades: ${best.trades}`);

if (totalImpact < -500) {
  console.log(`\n⚠️ CRITICAL: Current filters reduce PnL by ${Math.abs(totalImpact).toFixed(0)}$ (-${Math.abs(totalImpact / baseline.totalPnl * 100).toFixed(0)}%)`);
  console.log(`   Recommendation: Remove harmful filters`);
} else if (totalImpact < 0) {
  console.log(`\n⚠️ Current filters slightly reduce PnL by ${Math.abs(totalImpact).toFixed(0)}$`);
} else {
  console.log(`\n✅ Current filters improve PnL by ${totalImpact.toFixed(0)}$`);
}
