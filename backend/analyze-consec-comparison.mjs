/**
 * Test ConsecUp variations with VOL=1.5x and no RSI filter
 * Compare: ConsecUp = 3, 4, 5, no limit
 */
import fs from 'fs';
import path from 'path';

const dataDir = path.join(process.cwd(), 'data');
const SYMBOLS = ['SOL', 'ETH', 'BTC', 'AVAX', 'LINK', 'DOT', 'DOGE', 'XRP', 'ATOM'];

const CONFIG = {
  LONG: {
    BB_PERIOD: 20,
    BB_STD: 2,
    ROC_MIN: 2.5,
    VOL_MULTIPLIER: 1.5,
  },
  EXIT: {
    STOP_LOSS_ATR_MULT: 3.0,
    STOP_LOSS_MIN: 1.0,
    STOP_LOSS_MAX: 4.5,
    TRAILING_ACTIVATION: 0.5,
    TRAILING_DISTANCE: 0.3,
  },
  COSTS: {
    TRADING_FEE_PCT: 0.04,
    SLIPPAGE_PCT: 0.05,
    FUNDING_RATE_PCT: 0.01,
    FUNDING_INTERVAL_BARS: 32,
  },
  DEFAULT_LEVERAGE: 4.5,
};

// Indicators
function calcSMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return { upper: 0 };
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - middle, 2), 0) / period;
  return { upper: middle + Math.sqrt(variance) * mult };
}

function calcROC(closes, period) {
  if (closes.length < period + 1) return 0;
  return ((closes[closes.length - 1] - closes[closes.length - period - 1]) / closes[closes.length - period - 1]) * 100;
}

function calcVolRatio(volumes) {
  if (volumes.length < 21) return 0;
  const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 ? volumes[volumes.length - 1] / avg : 0;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(candles[i].high - candles[i].low, 
      Math.abs(candles[i].high - (candles[i-1]?.close || candles[i].open)),
      Math.abs(candles[i].low - (candles[i-1]?.close || candles[i].open)));
    sum += tr;
  }
  return sum / period;
}

function countConsecUp(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}

function isBtcBullRegime(btcCandles) {
  if (btcCandles.length < 200) return true;
  const closes = btcCandles.map(c => c.close);
  return closes[closes.length - 1] > calcSMA(closes, 200);
}

function loadCandles15m(symbol) {
  const file = `${dataDir}/${symbol}_USDT_15m.json`;
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8')).map(c => ({
    timestamp: c.timestamp || c.openTime,
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
  }));
}

function resampleTo1h(candles15m) {
  const result = [];
  for (let i = 0; i < candles15m.length; i += 4) {
    if (i + 3 >= candles15m.length) break;
    const g = candles15m.slice(i, i + 4);
    result.push({
      timestamp: g[0].timestamp, open: g[0].open,
      high: Math.max(...g.map(c => c.high)), low: Math.min(...g.map(c => c.low)),
      close: g[3].close, volume: g.reduce((s, c) => s + c.volume, 0)
    });
  }
  return result;
}

function simulateTrade(candles, entryIdx, entryPrice, atr) {
  const leverage = CONFIG.DEFAULT_LEVERAGE;
  let slPct = atr ? (atr / entryPrice) * 100 * CONFIG.EXIT.STOP_LOSS_ATR_MULT : 2.5;
  slPct = Math.max(CONFIG.EXIT.STOP_LOSS_MIN, Math.min(CONFIG.EXIT.STOP_LOSS_MAX, slPct));
  const stopLoss = entryPrice * (1 - slPct / 100);
  
  let hwm = entryPrice, trailActive = false, trailStop = 0, bars = 0;
  
  for (let i = entryIdx + 1; i < candles.length && bars < 192; i++) {
    const c = candles[i]; bars++;
    if (c.high > hwm) {
      hwm = c.high;
      if (((hwm - entryPrice) / entryPrice) * 100 >= CONFIG.EXIT.TRAILING_ACTIVATION) trailActive = true;
      if (trailActive) trailStop = Math.max(trailStop, hwm * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100));
    }
    
    let exit = null, reason = null;
    if (c.low <= stopLoss) { exit = stopLoss; reason = 'SL'; }
    else if (trailActive && c.low <= trailStop) { exit = trailStop; reason = 'TRAIL'; }
    
    if (exit) {
      const gross = ((exit - entryPrice) / entryPrice) * 100 * leverage;
      const costs = (CONFIG.COSTS.TRADING_FEE_PCT * 2 + CONFIG.COSTS.SLIPPAGE_PCT * 2 + 
        Math.floor(bars / CONFIG.COSTS.FUNDING_INTERVAL_BARS) * CONFIG.COSTS.FUNDING_RATE_PCT) * leverage;
      return { pnlPct: gross - costs, exitReason: reason, holdBars: bars };
    }
  }
  
  const last = candles[Math.min(entryIdx + 192, candles.length - 1)];
  return { pnlPct: ((last.close - entryPrice) / entryPrice) * 100 * leverage - 0.5, exitReason: 'TIME', holdBars: 192 };
}

console.log('╔════════════════════════════════════════════════════════════════════════════╗');
console.log('║         ConsecUp Comparison - VOL=1.5x, No RSI Filter                    ║');
console.log('║         Period: Dec 2023 → Dec 2025 | 9 Cryptos | 2 Years               ║');
console.log('╚════════════════════════════════════════════════════════════════════════════╝\n');

const btcCandles1h = resampleTo1h(loadCandles15m('BTC'));
console.log(`BTC: ${btcCandles1h.length} 1h candles loaded\n`);

// Test each ConsecUp value
const consecValues = [3, 4, 5, 99];
const results = [];

for (const maxConsec of consecValues) {
  const trades = [];
  
  for (const symbol of SYMBOLS) {
    const candles15m = loadCandles15m(symbol);
    if (!candles15m) continue;
    const candles1h = resampleTo1h(candles15m);
    
    let lastIdx = 0;
    for (let i = 50; i < candles1h.length - 50; i++) {
      if (i < lastIdx + 8) continue;
      
      const window = candles1h.slice(0, i + 1);
      const btcWindow = btcCandles1h.slice(0, i + 1);
      const curr = window[window.length - 1];
      const closes = window.map(c => c.close);
      const volumes = window.map(c => c.volume);
      
      if (curr.close <= curr.open) continue;
      if (!isBtcBullRegime(btcWindow)) continue;
      if (curr.close <= calcBB(closes).upper) continue;
      if (calcROC(closes, 10) < CONFIG.LONG.ROC_MIN) continue;
      if (calcVolRatio(volumes) < CONFIG.LONG.VOL_MULTIPLIER) continue;
      if (countConsecUp(window) > maxConsec) continue;
      
      const trade = simulateTrade(candles1h, i, curr.close, calcATR(window));
      trades.push(trade);
      lastIdx = i + trade.holdBars;
    }
  }
  
  const wins = trades.filter(t => t.pnlPct > 0).length;
  const sls = trades.filter(t => t.exitReason === 'SL').length;
  const totalPnl = trades.reduce((s, t) => s + t.pnlPct, 0);
  
  results.push({
    maxConsec: maxConsec === 99 ? 'No Limit' : maxConsec,
    trades: trades.length,
    totalPnl,
    avgPnl: trades.length > 0 ? totalPnl / trades.length : 0,
    wr: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    slRate: trades.length > 0 ? (sls / trades.length) * 100 : 0,
  });
}

// Display results
console.log('═══ RÉSULTATS ═══\n');
console.log('ConsecUp │ Trades │ Total PnL │ Avg/Trade │  WR%  │  SL%');
console.log('─────────┼────────┼───────────┼───────────┼───────┼──────');

for (const r of results) {
  const name = String(r.maxConsec).padEnd(8);
  console.log(
    `${name} │ ${String(r.trades).padStart(5)}  │ ${(r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(0).padStart(8)}% │ ${(r.avgPnl >= 0 ? '+' : '') + r.avgPnl.toFixed(2).padStart(8)}% │ ${r.wr.toFixed(0).padStart(4)}% │ ${r.slRate.toFixed(0).padStart(4)}%`
  );
}

// Comparison
console.log('\n═══ COMPARAISON vs ConsecUp=3 ═══\n');
const baseline = results[0];

for (let i = 1; i < results.length; i++) {
  const r = results[i];
  const diffTrades = r.trades - baseline.trades;
  const diffPnl = r.totalPnl - baseline.totalPnl;
  const diffAvg = r.avgPnl - baseline.avgPnl;
  const diffSL = r.slRate - baseline.slRate;
  
  let verdict = '';
  if (diffPnl > 50 && diffSL <= 3) verdict = '✅ BETTER';
  else if (diffPnl > 0 && diffSL <= 5) verdict = '⚠️ SLIGHT BETTER';
  else if (diffPnl < -50) verdict = '❌ WORSE';
  else verdict = '➖ SIMILAR';
  
  console.log(`ConsecUp=${r.maxConsec}:`);
  console.log(`   Trades: ${diffTrades >= 0 ? '+' : ''}${diffTrades} | PnL: ${diffPnl >= 0 ? '+' : ''}${diffPnl.toFixed(0)}% | Avg: ${diffAvg >= 0 ? '+' : ''}${diffAvg.toFixed(2)}%/trade`);
  console.log(`   SL Rate: ${diffSL >= 0 ? '+' : ''}${diffSL.toFixed(1)}% | → ${verdict}\n`);
}

// Best option
const best = [...results].sort((a, b) => b.totalPnl - a.totalPnl)[0];
console.log(`🏆 MEILLEUR: ConsecUp=${best.maxConsec} avec +${best.totalPnl.toFixed(0)}% PnL`);
