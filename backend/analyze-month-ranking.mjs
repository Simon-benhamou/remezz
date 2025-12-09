/**
 * Analyze all months performance to understand where December stands
 */
import fs from 'fs';
import path from 'path';

const SYMBOLS = ['SOL/USDT:USDT', 'ETH/USDT:USDT', 'BTC/USDT:USDT', 'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'DOT/USDT:USDT', 'DOGE/USDT:USDT', 'XRP/USDT:USDT', 'ATOM/USDT:USDT'];
const LEVERAGE = { 'SOL/USDT:USDT': 4.5, 'ETH/USDT:USDT': 4.5, 'BTC/USDT:USDT': 4, 'AVAX/USDT:USDT': 4, 'LINK/USDT:USDT': 4, 'DOT/USDT:USDT': 4, 'DOGE/USDT:USDT': 4, 'XRP/USDT:USDT': 4, 'ATOM/USDT:USDT': 4 };

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
  const emaFast = calculateEMA(closes, 12), emaSlow = calculateEMA(closes, 26);
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = calculateEMA(macdLine, 9);
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

function runBacktest(candles, symbol) {
  const closes = candles.map(c => c.close);
  const rsi = calculateRSI(closes), macd = calculateMACD(closes), atr = calculateATR(candles);
  const trades = [];
  let position = null;
  
  for (let i = 50; i < candles.length; i++) {
    const candle = candles[i], price = candle.close, ts = new Date(candle.timestamp);
    if (position) {
      if (candle.high > position.highWaterMark) {
        position.highWaterMark = candle.high;
        const pnlPct = ((candle.high - position.entryPrice) / position.entryPrice) * 100;
        if (pnlPct >= 0.5 && !position.trailingActive) { 
          position.trailingActive = true; 
          position.trailingStop = candle.high * 0.997; 
        }
        if (position.trailingActive) {
          position.trailingStop = Math.max(position.trailingStop, candle.high * 0.997);
        }
      }
      let exitPrice = null, exitReason = null;
      if (candle.low <= position.stopLoss) { exitPrice = position.stopLoss; exitReason = 'SL'; }
      else if (position.trailingActive && candle.low <= position.trailingStop) { exitPrice = position.trailingStop; exitReason = 'TRAIL'; }
      if (exitPrice) {
        const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
        const notional = 1000, fees = notional * 0.0004 * 2;
        trades.push({ 
          symbol, 
          entryTime: position.entryTime, 
          exitTime: ts, 
          pnlPct, 
          pnlUsd: (pnlPct / 100) * notional - fees, 
          exitReason, 
          month: position.entryTime.getMonth() + 1, 
          year: position.entryTime.getFullYear() 
        });
        position = null;
      }
    }
    if (!position) {
      const rsiCrossUp = rsi[i - 1] < 35 && rsi[i] >= 35;
      const macdCrossUp = macd.histogram[i - 1] < 0 && macd.histogram[i] >= 0;
      if (rsiCrossUp && macdCrossUp && atr[i] > 0) {
        const slPct = Math.max(1.0, Math.min(4.5, (atr[i] / price) * 100 * 3.0));
        position = { entryPrice: price, entryTime: ts, stopLoss: price * (1 - slPct / 100), highWaterMark: price, trailingActive: false, trailingStop: 0 };
      }
    }
  }
  return trades;
}

// Load and process all data
const allTrades = [];
for (const symbol of SYMBOLS) {
  const filename = symbol.replace('/', '_').replace(':USDT', '') + '_1h.json';
  const filepath = path.join(process.cwd(), 'data', filename);
  if (!fs.existsSync(filepath)) continue;
  const candles = JSON.parse(fs.readFileSync(filepath, 'utf-8')).map(c => ({ 
    timestamp: c.timestamp || c.openTime, 
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume 
  }));
  allTrades.push(...runBacktest(candles, symbol));
}

// Group by month
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const byMonth = {};
for (const t of allTrades) {
  const key = t.year + '-' + String(t.month).padStart(2, '0');
  if (!byMonth[key]) byMonth[key] = [];
  byMonth[key].push(t);
}

// Calculate stats per month
const monthStats = Object.entries(byMonth).map(([ym, trades]) => {
  const wins = trades.filter(t => t.pnlUsd > 0).length;
  const slCount = trades.filter(t => t.exitReason === 'SL').length;
  return {
    yearMonth: ym,
    monthName: monthNames[parseInt(ym.split('-')[1]) - 1],
    year: parseInt(ym.split('-')[0]),
    monthNum: parseInt(ym.split('-')[1]),
    trades: trades.length,
    wins, losses: trades.length - wins,
    winRate: (wins / trades.length) * 100,
    totalPnl: trades.reduce((s, t) => s + t.pnlUsd, 0),
    slCount, slRate: (slCount / trades.length) * 100
  };
}).sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));

console.log('╔════════════════════════════════════════════════════════════════════╗');
console.log('║          MONTHLY PERFORMANCE ANALYSIS - V5.11 Strategy            ║');
console.log('╚════════════════════════════════════════════════════════════════════╝\n');

console.log('═══ ALL MONTHS CHRONOLOGICAL ═══\n');
console.log('Month      │ Trades │  WR%  │    PnL    │  SL%  │ Status');
console.log('───────────┼────────┼───────┼───────────┼───────┼────────');
for (const m of monthStats) {
  const status = m.totalPnl > 20 ? '🟢 GOOD' : m.totalPnl < -20 ? '🔴 BAD' : '🟡 FLAT';
  const pnlStr = (m.totalPnl >= 0 ? '+' : '') + m.totalPnl.toFixed(0) + '$';
  console.log(
    `${m.monthName} ${m.year}  │   ${String(m.trades).padStart(2)}   │ ${m.winRate.toFixed(0).padStart(3)}%  │ ${pnlStr.padStart(7)}   │ ${m.slRate.toFixed(0).padStart(3)}%  │ ${status}`
  );
}

// December specific analysis
console.log('\n═══ DECEMBER HISTORICAL PERFORMANCE ═══\n');
const decMonths = monthStats.filter(m => m.monthName === 'Dec');
if (decMonths.length > 0) {
  for (const d of decMonths) {
    const status = d.totalPnl > 20 ? '🟢' : d.totalPnl < -20 ? '🔴' : '🟡';
    console.log(`Dec ${d.year}: ${d.trades} trades, ${d.winRate.toFixed(0)}% WR, ${d.totalPnl >= 0 ? '+' : ''}${d.totalPnl.toFixed(0)}$ ${status}`);
  }
  console.log(`\nDecember Average: ${(decMonths.reduce((s, m) => s + m.totalPnl, 0) / decMonths.length).toFixed(0)}$ PnL, ${(decMonths.reduce((s, m) => s + m.winRate, 0) / decMonths.length).toFixed(0)}% WR`);
}

// Ranking by PnL
console.log('\n═══ MONTHS RANKED BY PNL (Best to Worst) ═══\n');
const ranked = [...monthStats].sort((a, b) => b.totalPnl - a.totalPnl);
ranked.forEach((m, i) => {
  const marker = m.yearMonth.startsWith('2025-12') ? ' ⬅️ CURRENT DEC' : '';
  const emoji = i < 5 ? '🏆' : i >= ranked.length - 5 ? '💀' : '  ';
  console.log(`${String(i + 1).padStart(2)}. ${emoji} ${m.monthName} ${m.year}: ${(m.totalPnl >= 0 ? '+' : '')}${m.totalPnl.toFixed(0)}$ (${m.winRate.toFixed(0)}% WR)${marker}`);
});

// Seasonality analysis - average by calendar month
console.log('\n═══ SEASONALITY - Average by Calendar Month ═══\n');
const seasonality = {};
for (let m = 1; m <= 12; m++) {
  const monthData = monthStats.filter(s => s.monthNum === m);
  if (monthData.length > 0) {
    seasonality[m] = {
      name: monthNames[m - 1],
      count: monthData.length,
      avgPnl: monthData.reduce((s, d) => s + d.totalPnl, 0) / monthData.length,
      avgWR: monthData.reduce((s, d) => s + d.winRate, 0) / monthData.length,
      avgTrades: monthData.reduce((s, d) => s + d.trades, 0) / monthData.length
    };
  }
}

const sortedSeasonality = Object.values(seasonality).sort((a, b) => b.avgPnl - a.avgPnl);
console.log('Month │ Samples │ Avg PnL │ Avg WR │ Avg Trades');
console.log('──────┼─────────┼─────────┼────────┼───────────');
for (const s of sortedSeasonality) {
  const marker = s.name === 'Dec' ? ' ⬅️' : '';
  console.log(`${s.name.padEnd(5)} │    ${s.count}    │ ${(s.avgPnl >= 0 ? '+' : '')}${s.avgPnl.toFixed(0).padStart(4)}$  │  ${s.avgWR.toFixed(0)}%  │    ${s.avgTrades.toFixed(0)}${marker}`);
}

// Summary
const totalMonths = monthStats.length;
const profitableMonths = monthStats.filter(m => m.totalPnl > 0).length;
const avgMonthlyPnl = monthStats.reduce((s, m) => s + m.totalPnl, 0) / totalMonths;

console.log('\n═══ SUMMARY ═══\n');
console.log(`Total months analyzed: ${totalMonths}`);
console.log(`Profitable months: ${profitableMonths}/${totalMonths} (${(profitableMonths/totalMonths*100).toFixed(0)}%)`);
console.log(`Average monthly PnL: ${avgMonthlyPnl >= 0 ? '+' : ''}${avgMonthlyPnl.toFixed(0)}$`);
console.log(`Best month: ${ranked[0].monthName} ${ranked[0].year} (+${ranked[0].totalPnl.toFixed(0)}$)`);
console.log(`Worst month: ${ranked[ranked.length-1].monthName} ${ranked[ranked.length-1].year} (${ranked[ranked.length-1].totalPnl.toFixed(0)}$)`);
