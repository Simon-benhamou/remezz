/**
 * DEEP Filter Analysis - Using EXACT V5.11 Strategy Logic
 * Tests impact of each filter on 12 months of data across 9 cryptos
 * Matches backtestService.ts logic precisely
 */
import fs from 'fs';
import path from 'path';

const SYMBOLS = ['SOL/USDT:USDT', 'ETH/USDT:USDT', 'BTC/USDT:USDT', 'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'DOT/USDT:USDT', 'DOGE/USDT:USDT', 'XRP/USDT:USDT', 'ATOM/USDT:USDT'];

// EXACT CONFIG from backtestService.ts
const CONFIG = {
  LONG: {
    BB_PERIOD: 20,
    BB_STD: 2,
    ROC_MIN: 2.5, // V5.3: 2.5%
    VOL_MULTIPLIER: 2.0, // V5.8: 2x
    MAX_CONSEC_UP: 3, // V5.3: max 3 bougies vertes
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

// ============================================================================
// INDICATORS (exact from backtestService)
// ============================================================================

function calcSMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0 };
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - middle, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: middle + std * mult, middle, lower: middle - std * mult };
}

function calcROC(closes, period) {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - period - 1];
  return past > 0 ? ((current - past) / past) * 100 : 0;
}

function calcVolRatio(volumes) {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 ? current / avg : 0;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || candles[i].open;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr;
  }
  return atrSum / period;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function countConsecUp(candles) {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}

// BTC Regime
function isBtcBullRegime(btcCandles) {
  if (btcCandles.length < 200) return true;
  const closes = btcCandles.map(c => c.close);
  const sma200 = calcSMA(closes, 200);
  return closes[closes.length - 1] > sma200;
}

function calcBtcRoc4h(btcCandles) {
  if (btcCandles.length < 5) return 0;
  const closes = btcCandles.map(c => c.close);
  return calcROC(closes, 4);
}

// ============================================================================
// SIGNAL DETECTION with configurable filters
// ============================================================================

function checkSignal(candles, btcCandles, filterConfig) {
  if (candles.length < 50) return { valid: false, reason: 'not_enough_data' };
  
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const current = candles[candles.length - 1];
  
  const isBullish = current.close > current.open;
  const isBull = isBtcBullRegime(btcCandles);
  
  if (!isBull) return { valid: false, reason: 'bear_regime' };
  if (!isBullish) return { valid: false, reason: 'bearish_candle' };
  
  const bb = calcBB(closes, CONFIG.LONG.BB_PERIOD, CONFIG.LONG.BB_STD);
  const breakoutOk = current.close > bb.upper;
  
  if (!breakoutOk) return { valid: false, reason: 'no_breakout' };
  
  // Now apply configurable filters
  const roc10 = calcROC(closes, 10);
  const volRatio = calcVolRatio(volumes);
  const consecUp = countConsecUp(candles);
  const rsi = calcRSI(closes, 14);
  const btcRoc4h = calcBtcRoc4h(btcCandles);
  
  // Filter 1: ROC
  if (filterConfig.rocEnabled && roc10 < filterConfig.rocMin) {
    return { valid: false, reason: `roc_low(${roc10.toFixed(2)}%<${filterConfig.rocMin}%)`, filtered: 'roc' };
  }
  
  // Filter 2: Volume
  if (filterConfig.volEnabled && volRatio < filterConfig.volMin) {
    return { valid: false, reason: `vol_low(${volRatio.toFixed(1)}x<${filterConfig.volMin}x)`, filtered: 'vol' };
  }
  
  // Filter 3: ConsecUp
  if (filterConfig.consecEnabled && consecUp > filterConfig.consecMax) {
    return { valid: false, reason: `consec_up(${consecUp}>${filterConfig.consecMax})`, filtered: 'consec' };
  }
  
  // Filter 4: RSI + BTC ROC (V5.10)
  if (filterConfig.rsiEnabled && rsi !== null && rsi > 75 && btcRoc4h < 0) {
    return { valid: false, reason: `rsi_btc_filter(rsi=${rsi.toFixed(1)}>75,btc=${btcRoc4h.toFixed(2)}%<0)`, filtered: 'rsi' };
  }
  
  return { 
    valid: true, 
    side: 'long', 
    reason: 'bull_breakout',
    metrics: { roc10, volRatio, consecUp, rsi, btcRoc4h }
  };
}

// ============================================================================
// POSITION SIMULATION (exact from strategy)
// ============================================================================

function simulateTrade(candles, entryIdx, entryPrice, atr) {
  const leverage = CONFIG.DEFAULT_LEVERAGE;
  
  // Calculate SL
  let slPct = atr ? (atr / entryPrice) * 100 * CONFIG.EXIT.STOP_LOSS_ATR_MULT : 2.5;
  slPct = Math.max(CONFIG.EXIT.STOP_LOSS_MIN, Math.min(CONFIG.EXIT.STOP_LOSS_MAX, slPct));
  const stopLoss = entryPrice * (1 - slPct / 100);
  
  let highWaterMark = entryPrice;
  let trailingActive = false;
  let trailingStop = 0;
  let holdBars = 0;
  
  for (let i = entryIdx + 1; i < candles.length && holdBars < 192; i++) {
    const candle = candles[i];
    holdBars++;
    
    // Update high water mark and trailing
    if (candle.high > highWaterMark) {
      highWaterMark = candle.high;
      const unrealizedPct = ((highWaterMark - entryPrice) / entryPrice) * 100;
      
      if (unrealizedPct >= CONFIG.EXIT.TRAILING_ACTIVATION && !trailingActive) {
        trailingActive = true;
        trailingStop = highWaterMark * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100);
      }
      
      if (trailingActive) {
        trailingStop = Math.max(trailingStop, highWaterMark * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100));
      }
    }
    
    // Check exits
    let exitPrice = null;
    let exitReason = null;
    
    if (candle.low <= stopLoss) {
      exitPrice = stopLoss;
      exitReason = 'SL';
    } else if (trailingActive && candle.low <= trailingStop) {
      exitPrice = trailingStop;
      exitReason = 'TRAIL';
    }
    
    if (exitPrice) {
      const pricePct = ((exitPrice - entryPrice) / entryPrice) * 100;
      const grossPnlPct = pricePct * leverage;
      
      // Costs
      const tradingFees = CONFIG.COSTS.TRADING_FEE_PCT * 2;
      const slippage = CONFIG.COSTS.SLIPPAGE_PCT * 2;
      const fundingPeriods = Math.floor(holdBars / CONFIG.COSTS.FUNDING_INTERVAL_BARS);
      const funding = fundingPeriods * CONFIG.COSTS.FUNDING_RATE_PCT;
      const totalCostsPct = (tradingFees + slippage + funding) * leverage;
      
      const netPnlPct = grossPnlPct - totalCostsPct;
      const marginUsd = 100; // $100 per trade for normalization
      const netPnlUsd = (netPnlPct / 100) * marginUsd;
      
      return {
        exitReason,
        holdBars,
        pnlPct: netPnlPct,
        pnlUsd: netPnlUsd,
        maxPnlPct: ((highWaterMark - entryPrice) / entryPrice) * 100 * leverage
      };
    }
  }
  
  // Max hold time exit
  const lastCandle = candles[Math.min(entryIdx + 192, candles.length - 1)];
  const pricePct = ((lastCandle.close - entryPrice) / entryPrice) * 100;
  const grossPnlPct = pricePct * leverage;
  const totalCostsPct = (CONFIG.COSTS.TRADING_FEE_PCT * 2 + CONFIG.COSTS.SLIPPAGE_PCT * 2) * leverage;
  
  return {
    exitReason: 'TIME',
    holdBars: 192,
    pnlPct: grossPnlPct - totalCostsPct,
    pnlUsd: ((grossPnlPct - totalCostsPct) / 100) * 100,
    maxPnlPct: ((highWaterMark - entryPrice) / entryPrice) * 100 * leverage
  };
}

// ============================================================================
// RUN BACKTEST
// ============================================================================

function runBacktest(candles, btcCandles, filterConfig) {
  const trades = [];
  const rejections = { roc: 0, vol: 0, consec: 0, rsi: 0, other: 0 };
  let inPosition = false;
  let cooldown = 0;
  
  for (let i = 50; i < candles.length - 1; i++) {
    if (cooldown > 0) { cooldown--; continue; }
    if (inPosition) continue;
    
    const windowCandles = candles.slice(0, i + 1);
    const btcWindow = btcCandles.slice(0, i + 1);
    
    const signal = checkSignal(windowCandles, btcWindow, filterConfig);
    
    if (signal.filtered) {
      rejections[signal.filtered]++;
    } else if (!signal.valid && signal.reason !== 'no_breakout' && signal.reason !== 'bearish_candle' && signal.reason !== 'bear_regime') {
      rejections.other++;
    }
    
    if (signal.valid) {
      const entryPrice = candles[i].close;
      const atr = calcATR(windowCandles, 14);
      
      const result = simulateTrade(candles, i, entryPrice, atr);
      trades.push({
        entryIdx: i,
        entryTime: new Date(candles[i].timestamp),
        ...result,
        metrics: signal.metrics
      });
      
      inPosition = true;
      cooldown = result.holdBars;
      
      // Reset after exit
      setTimeout(() => { inPosition = false; }, 0);
      inPosition = false;
      i += result.holdBars;
    }
  }
  
  return { trades, rejections };
}

// ============================================================================
// MAIN
// ============================================================================

console.log('╔════════════════════════════════════════════════════════════════════════════╗');
console.log('║         DEEP FILTER ANALYSIS - V5.11 Strategy (Exact Logic)              ║');
console.log('║         Period: Nov 2024 - Nov 2025 | 9 Cryptos | 1h Candles             ║');
console.log('╚════════════════════════════════════════════════════════════════════════════╝\n');

// Load BTC for regime
const btcPath = path.join(process.cwd(), 'data', 'BTC_USDT_1h.json');
const btcCandles = JSON.parse(fs.readFileSync(btcPath, 'utf-8')).map(c => ({
  timestamp: c.timestamp || c.openTime,
  open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
}));

// Define filter scenarios
const scenarios = [
  { 
    name: 'V5.11 CURRENT', 
    filters: { rocEnabled: true, rocMin: 2.5, volEnabled: true, volMin: 2.0, consecEnabled: true, consecMax: 3, rsiEnabled: true }
  },
  { 
    name: 'No ConsecUp filter', 
    filters: { rocEnabled: true, rocMin: 2.5, volEnabled: true, volMin: 2.0, consecEnabled: false, consecMax: 99, rsiEnabled: true }
  },
  { 
    name: 'No RSI filter', 
    filters: { rocEnabled: true, rocMin: 2.5, volEnabled: true, volMin: 2.0, consecEnabled: true, consecMax: 3, rsiEnabled: false }
  },
  { 
    name: 'No ROC filter', 
    filters: { rocEnabled: false, rocMin: 0, volEnabled: true, volMin: 2.0, consecEnabled: true, consecMax: 3, rsiEnabled: true }
  },
  { 
    name: 'No VOL filter', 
    filters: { rocEnabled: true, rocMin: 2.5, volEnabled: false, volMin: 0, consecEnabled: true, consecMax: 3, rsiEnabled: true }
  },
  { 
    name: 'ROC=1.5% (relaxed)', 
    filters: { rocEnabled: true, rocMin: 1.5, volEnabled: true, volMin: 2.0, consecEnabled: true, consecMax: 3, rsiEnabled: true }
  },
  { 
    name: 'VOL=1.5x (relaxed)', 
    filters: { rocEnabled: true, rocMin: 2.5, volEnabled: true, volMin: 1.5, consecEnabled: true, consecMax: 3, rsiEnabled: true }
  },
  { 
    name: 'ConsecUp=5 (relaxed)', 
    filters: { rocEnabled: true, rocMin: 2.5, volEnabled: true, volMin: 2.0, consecEnabled: true, consecMax: 5, rsiEnabled: true }
  },
  { 
    name: 'ALL RELAXED', 
    filters: { rocEnabled: true, rocMin: 1.5, volEnabled: true, volMin: 1.5, consecEnabled: true, consecMax: 5, rsiEnabled: false }
  },
];

const results = [];

for (const scenario of scenarios) {
  let allTrades = [];
  let totalRejections = { roc: 0, vol: 0, consec: 0, rsi: 0, other: 0 };
  
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
    Object.keys(rejections).forEach(k => totalRejections[k] += rejections[k]);
  }
  
  const wins = allTrades.filter(t => t.pnlUsd > 0).length;
  const losses = allTrades.filter(t => t.pnlUsd <= 0).length;
  const totalPnl = allTrades.reduce((s, t) => s + t.pnlUsd, 0);
  const slCount = allTrades.filter(t => t.exitReason === 'SL').length;
  const trailCount = allTrades.filter(t => t.exitReason === 'TRAIL').length;
  
  // Per-trade quality metrics
  const avgMaxPnl = allTrades.length > 0 ? allTrades.reduce((s, t) => s + t.maxPnlPct, 0) / allTrades.length : 0;
  const avgHoldBars = allTrades.length > 0 ? allTrades.reduce((s, t) => s + t.holdBars, 0) / allTrades.length : 0;
  
  results.push({
    scenario: scenario.name,
    trades: allTrades.length,
    wins,
    losses,
    winRate: allTrades.length > 0 ? (wins / allTrades.length) * 100 : 0,
    totalPnl,
    avgPnl: allTrades.length > 0 ? totalPnl / allTrades.length : 0,
    slRate: allTrades.length > 0 ? (slCount / allTrades.length) * 100 : 0,
    trailRate: allTrades.length > 0 ? (trailCount / allTrades.length) * 100 : 0,
    avgMaxPnl,
    avgHoldBars,
    rejections: totalRejections
  });
}

// Display
console.log('═══ RESULTS COMPARISON ═══\n');
console.log('Scenario              │ Trades │  WR%  │   PnL    │ Avg/Trade │  SL%  │ Trail%');
console.log('──────────────────────┼────────┼───────┼──────────┼───────────┼───────┼────────');

const baseline = results[0];
for (const r of results) {
  const pnlStr = (r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(0) + '$';
  const avgStr = (r.avgPnl >= 0 ? '+' : '') + r.avgPnl.toFixed(2) + '$';
  const marker = r.scenario === 'V5.11 CURRENT' ? ' ◀' : '';
  console.log(
    `${r.scenario.padEnd(21)} │ ${String(r.trades).padStart(5)}  │ ${r.winRate.toFixed(0).padStart(4)}% │ ${pnlStr.padStart(7)}  │ ${avgStr.padStart(9)} │ ${r.slRate.toFixed(0).padStart(4)}% │ ${r.trailRate.toFixed(0).padStart(5)}%${marker}`
  );
}

// Detailed analysis
console.log('\n═══ FILTER IMPACT vs V5.11 CURRENT ═══\n');

for (let i = 1; i < results.length; i++) {
  const r = results[i];
  const diffTrades = r.trades - baseline.trades;
  const diffPnl = r.totalPnl - baseline.totalPnl;
  const diffWR = r.winRate - baseline.winRate;
  const diffSL = r.slRate - baseline.slRate;
  
  let verdict = '';
  if (diffPnl > 50 && diffWR >= -2) verdict = '✅ BETTER';
  else if (diffPnl < -50) verdict = '❌ WORSE';
  else if (diffWR > 2) verdict = '✅ SAFER';
  else if (diffSL > 5) verdict = '⚠️ RISKIER';
  else verdict = '➖ SIMILAR';
  
  console.log(`${r.scenario}:`);
  console.log(`   PnL: ${diffPnl >= 0 ? '+' : ''}${diffPnl.toFixed(0)}$ (${baseline.totalPnl > 0 ? (diffPnl / baseline.totalPnl * 100).toFixed(1) : 0}%)`);
  console.log(`   Trades: ${diffTrades >= 0 ? '+' : ''}${diffTrades} | WR: ${diffWR >= 0 ? '+' : ''}${diffWR.toFixed(1)}% | SL: ${diffSL >= 0 ? '+' : ''}${diffSL.toFixed(1)}%`);
  console.log(`   → ${verdict}\n`);
}

// Quality metrics
console.log('\n═══ TRADE QUALITY METRICS ═══\n');
console.log('Scenario              │ Avg Max PnL │ Avg Hold │ Trail Exit%');
console.log('──────────────────────┼─────────────┼──────────┼────────────');
for (const r of results) {
  console.log(
    `${r.scenario.padEnd(21)} │ ${r.avgMaxPnl.toFixed(1).padStart(10)}% │ ${r.avgHoldBars.toFixed(0).padStart(7)}h │ ${r.trailRate.toFixed(0).padStart(10)}%`
  );
}

// Best performer
console.log('\n═══ RECOMMENDATION ═══\n');
const sorted = [...results].sort((a, b) => b.totalPnl - a.totalPnl);
console.log(`🏆 Best PnL: ${sorted[0].scenario}`);
console.log(`   ${sorted[0].totalPnl >= 0 ? '+' : ''}${sorted[0].totalPnl.toFixed(0)}$ | ${sorted[0].winRate.toFixed(0)}% WR | ${sorted[0].trades} trades`);

const sortedByQuality = [...results].sort((a, b) => b.avgPnl - a.avgPnl);
console.log(`\n📊 Best Avg/Trade: ${sortedByQuality[0].scenario}`);
console.log(`   ${sortedByQuality[0].avgPnl >= 0 ? '+' : ''}${sortedByQuality[0].avgPnl.toFixed(2)}$/trade | ${sortedByQuality[0].winRate.toFixed(0)}% WR`);

const safest = [...results].sort((a, b) => a.slRate - b.slRate);
console.log(`\n🛡️ Safest (lowest SL): ${safest[0].scenario}`);
console.log(`   ${safest[0].slRate.toFixed(0)}% SL rate | ${safest[0].winRate.toFixed(0)}% WR`);
