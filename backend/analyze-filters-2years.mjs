/**
 * DEEP Filter Analysis - 2 YEARS on 15m candles
 * Tests filter impact by period (monthly) to see if filters help in certain market conditions
 * Period: Dec 2023 → Dec 2025 (2 years)
 */
import fs from 'fs';
import path from 'path';

const dataDir = path.join(process.cwd(), 'data');
const SYMBOLS = ['SOL', 'ETH', 'BTC', 'AVAX', 'LINK', 'DOT', 'DOGE', 'XRP', 'ATOM'];

// CONFIG V5.11 (from backtestService.ts)
// TEST: VOL relaxed to 1.5x, RSI+BTC filter DISABLED, ConsecUp = VARIABLE
const CONSEC_UP_VALUES = [3, 4, 5, 99]; // 99 = no limit
const CONFIG = {
  LONG: {
    BB_PERIOD: 20,
    BB_STD: 2,
    ROC_MIN: 2.5,
    VOL_MULTIPLIER: 1.5,  // RELAXED from 2.0
    MAX_CONSEC_UP: 3, // Will be overridden in loop
  },
  RSI_BTC_FILTER_ENABLED: false, // DISABLED
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
    FUNDING_INTERVAL_BARS: 32, // 8h = 32 × 15m
  },
  DEFAULT_LEVERAGE: 4.5,
};

// ============================================================================
// DATA LOADING & RESAMPLING
// ============================================================================

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
    const group = candles15m.slice(i, i + 4);
    result.push({
      timestamp: group[0].timestamp,
      open: group[0].open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: group[3].close,
      volume: group.reduce((s, c) => s + c.volume, 0),
    });
  }
  return result;
}

// ============================================================================
// INDICATORS
// ============================================================================

function calcSMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
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
  return ((closes[closes.length - 1] - closes[closes.length - period - 1]) / closes[closes.length - period - 1]) * 100;
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
  if (losses === 0) return 100;
  return 100 - (100 / (1 + gains / losses));
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
  const sma200 = calcSMA(closes, 200);
  return closes[closes.length - 1] > sma200;
}

function calcBtcRoc4h(btcCandles) {
  if (btcCandles.length < 5) return 0;
  return calcROC(btcCandles.map(c => c.close), 4);
}

// ============================================================================
// TRADE SIMULATION
// ============================================================================

function simulateTrade(candles, entryIdx, entryPrice, atr) {
  const leverage = CONFIG.DEFAULT_LEVERAGE;
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
    
    if (candle.high > highWaterMark) {
      highWaterMark = candle.high;
      const unrealizedPct = ((highWaterMark - entryPrice) / entryPrice) * 100;
      if (unrealizedPct >= CONFIG.EXIT.TRAILING_ACTIVATION && !trailingActive) {
        trailingActive = true;
      }
      if (trailingActive) {
        trailingStop = Math.max(trailingStop, highWaterMark * (1 - CONFIG.EXIT.TRAILING_DISTANCE / 100));
      }
    }
    
    let exitPrice = null, exitReason = null;
    if (candle.low <= stopLoss) { exitPrice = stopLoss; exitReason = 'SL'; }
    else if (trailingActive && candle.low <= trailingStop) { exitPrice = trailingStop; exitReason = 'TRAIL'; }
    
    if (exitPrice) {
      const pricePct = ((exitPrice - entryPrice) / entryPrice) * 100;
      const grossPnlPct = pricePct * leverage;
      const tradingFees = CONFIG.COSTS.TRADING_FEE_PCT * 2;
      const slippage = CONFIG.COSTS.SLIPPAGE_PCT * 2;
      const fundingPeriods = Math.floor(holdBars / CONFIG.COSTS.FUNDING_INTERVAL_BARS);
      const funding = fundingPeriods * CONFIG.COSTS.FUNDING_RATE_PCT;
      const totalCostsPct = (tradingFees + slippage + funding) * leverage;
      return { pnlPct: grossPnlPct - totalCostsPct, exitReason, holdBars };
    }
  }
  
  const lastCandle = candles[Math.min(entryIdx + 192, candles.length - 1)];
  const pricePct = ((lastCandle.close - entryPrice) / entryPrice) * 100;
  return { pnlPct: pricePct * CONFIG.DEFAULT_LEVERAGE - 0.5, exitReason: 'TIME', holdBars: 192 };
}

// ============================================================================
// MAIN BACKTEST
// ============================================================================

console.log('╔════════════════════════════════════════════════════════════════════════════╗');
console.log('║         DEEP Filter Analysis - 2 YEARS on 15m Candles                    ║');
console.log('║         Period: Dec 2023 → Dec 2025 | 9 Cryptos                          ║');
console.log('╚════════════════════════════════════════════════════════════════════════════╝\n');

// Load BTC for regime detection
const btcCandles15m = loadCandles15m('BTC');
const btcCandles1h = resampleTo1h(btcCandles15m);
console.log(`BTC: ${btcCandles15m.length} 15m candles → ${btcCandles1h.length} 1h candles`);

// Collect all trades with their filter status
const allTrades = [];

for (const symbol of SYMBOLS) {
  const candles15m = loadCandles15m(symbol);
  if (!candles15m) continue;
  
  const candles1h = resampleTo1h(candles15m);
  console.log(`${symbol}: ${candles15m.length} 15m → ${candles1h.length} 1h`);
  
  let lastTradeIdx = 0;
  
  for (let i = 50; i < candles1h.length - 50; i++) {
    if (i < lastTradeIdx + 8) continue;
    
    const window = candles1h.slice(0, i + 1);
    const btcWindow = btcCandles1h.slice(0, i + 1);
    const current = window[window.length - 1];
    const closes = window.map(c => c.close);
    const volumes = window.map(c => c.volume);
    
    const isBullish = current.close > current.open;
    const bb = calcBB(closes, 20, 2);
    const breakout = current.close > bb.upper;
    
    if (!breakout || !isBullish) continue;
    if (!isBtcBullRegime(btcWindow)) continue;
    
    const roc10 = calcROC(closes, 10);
    const volRatio = calcVolRatio(volumes);
    const consecUp = countConsecUp(window);
    const rsi = calcRSI(closes, 14);
    const btcRoc4h = calcBtcRoc4h(btcWindow);
    
    const entryPrice = current.close;
    const atr = calcATR(window, 14);
    const trade = simulateTrade(candles1h, i, entryPrice, atr);
    
    const tradeDate = new Date(current.timestamp);
    const month = `${tradeDate.getFullYear()}-${String(tradeDate.getMonth() + 1).padStart(2, '0')}`;
    
    // Filter checks
    const rocOk = roc10 >= CONFIG.LONG.ROC_MIN;
    const volOk = volRatio >= CONFIG.LONG.VOL_MULTIPLIER;
    const consecOk = consecUp <= CONFIG.LONG.MAX_CONSEC_UP;
    const rsiOk = CONFIG.RSI_BTC_FILTER_ENABLED ? !(rsi > 75 && btcRoc4h < 0) : true; // DISABLED
    
    allTrades.push({
      symbol,
      month,
      timestamp: current.timestamp,
      ...trade,
      rocOk, volOk, consecOk, rsiOk,
      roc10, volRatio, consecUp, rsi,
      accepted: rocOk && volOk && consecOk && rsiOk
    });
    
    lastTradeIdx = i + trade.holdBars;
  }
}

console.log(`\nTotal trades simulés: ${allTrades.length}\n`);

// ============================================================================
// ANALYSIS BY FILTER CATEGORY
// ============================================================================

const categories = {
  accepted: allTrades.filter(t => t.accepted),
  blockedConsec: allTrades.filter(t => !t.consecOk && t.rocOk && t.volOk && t.rsiOk),
  blockedRoc: allTrades.filter(t => t.consecOk && !t.rocOk && t.volOk && t.rsiOk),
  blockedVol: allTrades.filter(t => t.consecOk && t.rocOk && !t.volOk && t.rsiOk),
  blockedRsi: allTrades.filter(t => t.consecOk && t.rocOk && t.volOk && !t.rsiOk),
  blockedMultiple: allTrades.filter(t => !t.accepted && 
    ((!t.consecOk ? 1 : 0) + (!t.rocOk ? 1 : 0) + (!t.volOk ? 1 : 0) + (!t.rsiOk ? 1 : 0)) > 1)
};

function analyze(trades) {
  if (trades.length === 0) return { count: 0, avgPnl: 0, wr: 0, slRate: 0, totalPnl: 0 };
  const wins = trades.filter(t => t.pnlPct > 0).length;
  const sls = trades.filter(t => t.exitReason === 'SL').length;
  const totalPnl = trades.reduce((s, t) => s + t.pnlPct, 0);
  return {
    count: trades.length,
    avgPnl: totalPnl / trades.length,
    wr: (wins / trades.length) * 100,
    slRate: (sls / trades.length) * 100,
    totalPnl
  };
}

console.log('═══ ANALYSE PAR CATÉGORIE (2 ANS) ═══\n');
console.log('Catégorie              │ Trades │ Avg PnL │  WR%  │  SL%  │ Total PnL │ Verdict');
console.log('───────────────────────┼────────┼─────────┼───────┼───────┼───────────┼─────────');

const accepted = analyze(categories.accepted);
const blockedConsec = analyze(categories.blockedConsec);
const blockedRoc = analyze(categories.blockedRoc);
const blockedVol = analyze(categories.blockedVol);
const blockedRsi = analyze(categories.blockedRsi);
const blockedMultiple = analyze(categories.blockedMultiple);

function printRow(name, stats) {
  let verdict = '—';
  if (stats.count > 0 && accepted.count > 0) {
    if (stats.avgPnl > accepted.avgPnl + 0.1) verdict = '❌ MISSED';
    else if (stats.avgPnl < 0) verdict = '✅ BLOCKED BAD';
    else if (stats.slRate > accepted.slRate + 5) verdict = '✅ RISKY';
    else if (stats.avgPnl < accepted.avgPnl * 0.7) verdict = '✅ WEAKER';
    else verdict = '⚠️ UNCLEAR';
  }
  
  console.log(
    `${name.padEnd(22)} │ ${String(stats.count).padStart(5)}  │ ${(stats.avgPnl >= 0 ? '+' : '') + stats.avgPnl.toFixed(2).padStart(6)}% │ ${stats.wr.toFixed(0).padStart(4)}% │ ${stats.slRate.toFixed(0).padStart(4)}% │ ${(stats.totalPnl >= 0 ? '+' : '') + stats.totalPnl.toFixed(0).padStart(8)}% │ ${verdict}`
  );
}

printRow('✅ ACCEPTED', accepted);
printRow('🚫 Only Consec>3', blockedConsec);
printRow('🚫 Only ROC<2.5%', blockedRoc);
printRow('🚫 Only VOL<2x', blockedVol);
printRow('🚫 Only RSI+BTC', blockedRsi);
printRow('🚫 Multiple filters', blockedMultiple);

// ============================================================================
// ANALYSIS BY MONTH
// ============================================================================

console.log('\n═══ ANALYSE PAR MOIS - Est-ce que les filtres aident dans certains mois? ═══\n');

const months = [...new Set(allTrades.map(t => t.month))].sort();
console.log('Mois     │ Accepted │ Blocked │ Acc PnL │ Block PnL │ Filtre utile?');
console.log('─────────┼──────────┼─────────┼─────────┼───────────┼──────────────');

let monthsFilterHelped = 0;
let monthsFilterHurt = 0;

for (const month of months) {
  const monthTrades = allTrades.filter(t => t.month === month);
  const acceptedMonth = monthTrades.filter(t => t.accepted);
  const blockedMonth = monthTrades.filter(t => !t.accepted);
  
  const accStats = analyze(acceptedMonth);
  const blockStats = analyze(blockedMonth);
  
  let verdict = '';
  if (accStats.count === 0 && blockStats.count === 0) verdict = '—';
  else if (blockStats.count === 0) verdict = '➖ No blocked';
  else if (accStats.count === 0) verdict = '🔴 All blocked';
  else if (accStats.avgPnl > blockStats.avgPnl + 0.2) { verdict = '✅ Filter helps'; monthsFilterHelped++; }
  else if (blockStats.avgPnl > accStats.avgPnl + 0.2) { verdict = '❌ Filter hurts'; monthsFilterHurt++; }
  else verdict = '➖ Similar';
  
  console.log(
    `${month}  │ ${String(accStats.count).padStart(7)}  │ ${String(blockStats.count).padStart(6)}  │ ${(accStats.avgPnl >= 0 ? '+' : '') + accStats.avgPnl.toFixed(2).padStart(6)}% │ ${(blockStats.avgPnl >= 0 ? '+' : '') + blockStats.avgPnl.toFixed(2).padStart(8)}% │ ${verdict}`
  );
}

console.log('─────────┼──────────┼─────────┼─────────┼───────────┼──────────────');
console.log(`Résumé: Filtres aident ${monthsFilterHelped} mois, nuisent ${monthsFilterHurt} mois\n`);

// ============================================================================
// MARKET REGIME ANALYSIS
// ============================================================================

console.log('═══ ANALYSE PAR RÉGIME DE MARCHÉ ═══\n');

// Identify bull vs consolidation vs bear months based on BTC performance
const btcMonthlyPerf = {};
for (const candle of btcCandles1h) {
  const date = new Date(candle.timestamp);
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  if (!btcMonthlyPerf[month]) btcMonthlyPerf[month] = { first: candle.open, last: candle.close };
  else btcMonthlyPerf[month].last = candle.close;
}

const monthRegimes = {};
for (const [month, perf] of Object.entries(btcMonthlyPerf)) {
  const change = ((perf.last - perf.first) / perf.first) * 100;
  if (change > 10) monthRegimes[month] = 'BULL';
  else if (change < -10) monthRegimes[month] = 'BEAR';
  else monthRegimes[month] = 'RANGE';
}

const regimeStats = {
  BULL: { accepted: [], blocked: [] },
  BEAR: { accepted: [], blocked: [] },
  RANGE: { accepted: [], blocked: [] }
};

for (const trade of allTrades) {
  const regime = monthRegimes[trade.month] || 'RANGE';
  if (trade.accepted) regimeStats[regime].accepted.push(trade);
  else regimeStats[regime].blocked.push(trade);
}

console.log('Régime │ Accepted │ Blocked │ Acc Avg PnL │ Block Avg PnL │ Verdict');
console.log('───────┼──────────┼─────────┼─────────────┼───────────────┼─────────');

for (const regime of ['BULL', 'RANGE', 'BEAR']) {
  const accStats = analyze(regimeStats[regime].accepted);
  const blockStats = analyze(regimeStats[regime].blocked);
  
  let verdict = '';
  if (blockStats.count === 0) verdict = 'No blocked';
  else if (accStats.avgPnl > blockStats.avgPnl + 0.2) verdict = '✅ Filter helps';
  else if (blockStats.avgPnl > accStats.avgPnl + 0.2) verdict = '❌ Filter hurts';
  else verdict = '➖ Similar';
  
  console.log(
    `${regime.padEnd(6)} │ ${String(accStats.count).padStart(7)}  │ ${String(blockStats.count).padStart(6)}  │ ${(accStats.avgPnl >= 0 ? '+' : '') + accStats.avgPnl.toFixed(2).padStart(10)}% │ ${(blockStats.avgPnl >= 0 ? '+' : '') + blockStats.avgPnl.toFixed(2).padStart(12)}% │ ${verdict}`
  );
}

// ============================================================================
// FINAL RECOMMENDATION
// ============================================================================

console.log('\n═══ RECOMMANDATION FINALE ═══\n');

const totalAcceptedPnl = accepted.totalPnl;
const totalBlockedPnl = blockedConsec.totalPnl + blockedRoc.totalPnl + blockedVol.totalPnl + blockedRsi.totalPnl + blockedMultiple.totalPnl;
const potentialWithoutFilters = totalAcceptedPnl + totalBlockedPnl;

console.log(`PnL avec filtres actuels:    ${totalAcceptedPnl >= 0 ? '+' : ''}${totalAcceptedPnl.toFixed(0)}% (${accepted.count} trades)`);
console.log(`PnL trades bloqués:          ${totalBlockedPnl >= 0 ? '+' : ''}${totalBlockedPnl.toFixed(0)}% (${allTrades.length - accepted.count} trades)`);
console.log(`PnL potentiel sans filtres:  ${potentialWithoutFilters >= 0 ? '+' : ''}${potentialWithoutFilters.toFixed(0)}%`);
console.log(`Différence:                  ${potentialWithoutFilters > totalAcceptedPnl ? '+' : ''}${(potentialWithoutFilters - totalAcceptedPnl).toFixed(0)}% (${((potentialWithoutFilters - totalAcceptedPnl) / totalAcceptedPnl * 100).toFixed(1)}%)\n`);

// Per-filter recommendation
console.log('Par filtre:');
if (blockedConsec.count > 0) {
  const impact = blockedConsec.avgPnl - accepted.avgPnl;
  console.log(`  ConsecUp=3: ${impact > 0 ? '❌ Perd' : '✅ Protège'} ${Math.abs(impact).toFixed(2)}%/trade | ${blockedConsec.count} trades bloqués`);
}
if (blockedRoc.count > 0) {
  const impact = blockedRoc.avgPnl - accepted.avgPnl;
  console.log(`  ROC>=2.5%:  ${impact > 0 ? '❌ Perd' : '✅ Protège'} ${Math.abs(impact).toFixed(2)}%/trade | ${blockedRoc.count} trades bloqués`);
}
if (blockedVol.count > 0) {
  const impact = blockedVol.avgPnl - accepted.avgPnl;
  console.log(`  VOL>=2x:    ${impact > 0 ? '❌ Perd' : '✅ Protège'} ${Math.abs(impact).toFixed(2)}%/trade | ${blockedVol.count} trades bloqués`);
}
if (blockedRsi.count > 0) {
  const impact = blockedRsi.avgPnl - accepted.avgPnl;
  console.log(`  RSI+BTC:    ${impact > 0 ? '❌ Perd' : '✅ Protège'} ${Math.abs(impact).toFixed(2)}%/trade | ${blockedRsi.count} trades bloqués`);
}
