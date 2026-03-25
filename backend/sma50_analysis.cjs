// SMA50 Daily Trend Following — Comprehensive Analysis
// =====================================================
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SYMBOLS = ['BTC','ETH','SOL','XRP','AVAX','ADA','DOT','FET','WIF','STX','IMX','RENDER'];
const FEE_RT = 0.0004; // 0.04% round trip
const FEE_SIDE = 0.0002; // 0.02% per side

// ── Helpers ──────────────────────────────────────────
function loadDaily(symbol) {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${symbol}_USDT_15m.json`), 'utf8'));
  // Group by UTC day
  const dayMap = {};
  for (const c of raw) {
    const d = new Date(c.openTime);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    if (!dayMap[key] || c.openTime > dayMap[key].openTime) {
      dayMap[key] = { date: key, close: c.close, openTime: c.openTime, high: c.high, low: c.low };
    }
    // track daily high/low
    if (dayMap[key].dailyHigh === undefined) {
      dayMap[key].dailyHigh = c.high;
      dayMap[key].dailyLow = c.low;
    } else {
      if (c.high > dayMap[key].dailyHigh) dayMap[key].dailyHigh = c.high;
      if (c.low < dayMap[key].dailyLow) dayMap[key].dailyLow = c.low;
    }
  }
  return Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));
}

function sma(arr, period) {
  if (arr.length < period) return null;
  let s = 0;
  for (let i = arr.length - period; i < arr.length; i++) s += arr[i];
  return s / period;
}

// ── Part 1: Per-Symbol Analysis ──────────────────────
function runSingleSymbol(symbol, capital, leverage, sizePct) {
  const daily = loadDaily(symbol);
  const closes = [];
  const trades = [];
  let inPosition = false;
  let entryPrice = 0, entryDate = '';

  for (let i = 0; i < daily.length; i++) {
    closes.push(daily[i].close);
    if (closes.length < 51) continue; // need 50 prior closes + current

    // SMA50 using previous day's closes (no look-ahead)
    const prevCloses = closes.slice(0, closes.length - 1);
    const sma50 = sma(prevCloses, 50);
    if (!sma50) continue;

    const todayClose = daily[i].close;
    const prevClose = daily[i - 1] ? daily[i - 1].close : todayClose;

    if (!inPosition) {
      // Entry: previous day close > SMA50 of previous days
      if (prevClose > sma50) {
        inPosition = true;
        entryPrice = todayClose; // enter at today's close
        entryDate = daily[i].date;
      }
    } else {
      // Exit: previous day close < SMA50
      if (prevClose < sma50) {
        const exitPrice = todayClose;
        const pctRaw = (exitPrice - entryPrice) / entryPrice;
        const pctLev = pctRaw * leverage;
        const pctNet = pctLev - FEE_RT;
        const margin = capital * sizePct;
        const pnl = margin * pctNet;
        const entryD = new Date(entryDate);
        const exitD = new Date(daily[i].date);
        const holdDays = Math.round((exitD - entryD) / 86400000);
        trades.push({
          symbol, entryDate, exitDate: daily[i].date,
          entryPrice, exitPrice, pctRaw, pctLev, pctNet,
          pnl, margin, holdDays
        });
        inPosition = false;
      }
    }
  }
  return trades;
}

function analyzeByYear(trades, year) {
  const t = trades.filter(tr => tr.entryDate.startsWith(String(year)));
  if (t.length === 0) return { trades: 0, wr: 0, pnl: 0, avgWin: 0, avgLoss: 0 };
  const wins = t.filter(tr => tr.pctNet > 0);
  const losses = t.filter(tr => tr.pctNet <= 0);
  return {
    trades: t.length,
    wr: (wins.length / t.length * 100),
    pnl: t.reduce((s, tr) => s + tr.pnl, 0),
    avgWin: wins.length ? wins.reduce((s, tr) => s + tr.pctNet, 0) / wins.length * 100 : 0,
    avgLoss: losses.length ? losses.reduce((s, tr) => s + tr.pctNet, 0) / losses.length * 100 : 0,
  };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  PART 1: Per-Symbol SMA50 Daily Trend Following Performance');
console.log('  Capital: $2000 | Leverage: 2x | Size: 10% | Fees: 0.04% RT');
console.log('═══════════════════════════════════════════════════════════════\n');

const symbolResults = [];
for (const sym of SYMBOLS) {
  try {
    const trades = runSingleSymbol(sym, 2000, 2, 0.10);
    const y24 = analyzeByYear(trades, 2024);
    const y25 = analyzeByYear(trades, 2025);
    const combined = y24.pnl + y25.pnl;
    symbolResults.push({ sym, trades, y24, y25, combined });
  } catch (e) {
    console.log(`  ${sym}: ERROR - ${e.message}`);
  }
}

// Sort by combined PnL
symbolResults.sort((a, b) => b.combined - a.combined);

console.log('Symbol  | 2024 Trades | 2024 WR | 2024 PnL  | AvgW% | AvgL% | 2025 Trades | 2025 WR | 2025 PnL  | AvgW% | AvgL% | Combined');
console.log('--------|-------------|---------|-----------|-------|-------|-------------|---------|-----------|-------|-------|---------');
for (const r of symbolResults) {
  const { sym, y24, y25, combined } = r;
  console.log(
    `${sym.padEnd(7)} | ${String(y24.trades).padStart(11)} | ${y24.wr.toFixed(1).padStart(6)}% | $${y24.pnl.toFixed(2).padStart(8)} | ${y24.avgWin.toFixed(1).padStart(5)}% | ${y24.avgLoss.toFixed(1).padStart(5)}% | ${String(y25.trades).padStart(11)} | ${y25.wr.toFixed(1).padStart(6)}% | $${y25.pnl.toFixed(2).padStart(8)} | ${y25.avgWin.toFixed(1).padStart(5)}% | ${y25.avgLoss.toFixed(1).padStart(5)}% | $${combined.toFixed(2).padStart(8)}`
  );
}

const topSymbols = symbolResults.map(r => r.sym);
console.log(`\nRanking: ${topSymbols.join(', ')}\n`);

// ── Part 2: Optimal Combo Search ─────────────────────
console.log('═══════════════════════════════════════════════════════════════');
console.log('  PART 2: Optimal Combination Search ($350 capital)');
console.log('═══════════════════════════════════════════════════════════════\n');

function runMultiSymbol(symbols, capital, leverage, sizePct, maxPositions) {
  // Load all daily data
  const allDaily = {};
  for (const sym of symbols) {
    allDaily[sym] = loadDaily(sym);
  }

  // Build unified date list
  const allDates = new Set();
  for (const sym of symbols) {
    for (const d of allDaily[sym]) allDates.add(d.date);
  }
  const dates = [...allDates].sort();

  // Build lookup: sym -> date -> close
  const lookup = {};
  for (const sym of symbols) {
    lookup[sym] = {};
    for (const d of allDaily[sym]) lookup[sym][d.date] = d.close;
  }

  // Track state
  const openPositions = {}; // sym -> { entryPrice, entryDate, margin }
  const closesHistory = {}; // sym -> [close, close, ...]
  for (const sym of symbols) closesHistory[sym] = [];

  const trades = [];
  let peakEquity = capital;
  let equity = capital;
  let maxDD = 0;
  const equityCurve = [];

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di];

    for (const sym of symbols) {
      const close = lookup[sym][date];
      if (close === undefined) continue;
      closesHistory[sym].push(close);

      if (closesHistory[sym].length < 51) continue;

      const prevCloses = closesHistory[sym].slice(0, closesHistory[sym].length - 1);
      const sma50 = sma(prevCloses, 50);
      if (!sma50) continue;

      const prevClose = prevCloses[prevCloses.length - 1];

      if (openPositions[sym]) {
        // Check exit
        if (prevClose < sma50) {
          const pos = openPositions[sym];
          const exitPrice = close;
          const pctRaw = (exitPrice - pos.entryPrice) / pos.entryPrice;
          const pctLev = pctRaw * leverage;
          const pctNet = pctLev - FEE_RT;
          const pnl = pos.margin * pctNet;
          equity += pnl;
          const entryD = new Date(pos.entryDate);
          const exitD = new Date(date);
          const holdDays = Math.round((exitD - entryD) / 86400000);
          trades.push({
            symbol: sym, entryDate: pos.entryDate, exitDate: date,
            entryPrice: pos.entryPrice, exitPrice, pctRaw, pctLev, pctNet,
            pnl, margin: pos.margin, holdDays
          });
          delete openPositions[sym];
        }
      } else {
        // Check entry
        if (prevClose > sma50) {
          const openCount = Object.keys(openPositions).length;
          if (openCount >= maxPositions) continue;

          const totalMarginInUse = Object.values(openPositions).reduce((s, p) => s + p.margin, 0);
          const margin = capital * sizePct;
          if (totalMarginInUse + margin > equity) continue;

          openPositions[sym] = { entryPrice: close, entryDate: date, margin };
        }
      }
    }

    // Track equity & drawdown (mark-to-market)
    let unrealized = 0;
    for (const sym of Object.keys(openPositions)) {
      const pos = openPositions[sym];
      const close = lookup[sym][date];
      if (close !== undefined) {
        const pctRaw = (close - pos.entryPrice) / pos.entryPrice;
        unrealized += pos.margin * pctRaw * leverage;
      }
    }
    const totalEquity = equity + unrealized;
    if (totalEquity > peakEquity) peakEquity = totalEquity;
    const dd = (peakEquity - totalEquity) / peakEquity;
    if (dd > maxDD) maxDD = dd;
    equityCurve.push({ date, equity: totalEquity });
  }

  // Close any remaining open positions (don't count them)
  const totalPnl = equity - capital;
  return {
    trades, totalPnl, equity, maxDD, tradesPerYear: trades.length / 2,
    equityCurve
  };
}

const combos = [
  { label: 'Top 4', symbols: topSymbols.slice(0, 4) },
  { label: 'Top 6', symbols: topSymbols.slice(0, 6) },
  { label: 'Top 8', symbols: topSymbols.slice(0, 8) },
  { label: 'Top 10', symbols: topSymbols.slice(0, 10) },
  { label: 'All 12', symbols: topSymbols.slice(0, 12) },
];

const leverages = [2, 3, 5];
const sizes = [0.05, 0.10, 0.15, 0.20];
const maxPositionsList = [2, 3, 4, 6];

const allConfigs = [];

for (const combo of combos) {
  for (const lev of leverages) {
    for (const sz of sizes) {
      for (const maxP of maxPositionsList) {
        const result = runMultiSymbol(combo.symbols, 350, lev, sz, maxP);
        const wr = result.trades.length > 0
          ? result.trades.filter(t => t.pctNet > 0).length / result.trades.length * 100
          : 0;
        const config = {
          label: combo.label,
          symbols: combo.symbols,
          leverage: lev,
          sizePct: sz,
          maxPositions: maxP,
          trades: result.trades.length,
          wr,
          totalPnl: result.totalPnl,
          finalEquity: result.equity,
          maxDD: result.maxDD,
          tradesPerYear: result.tradesPerYear,
          allTrades: result.trades,
          equityCurve: result.equityCurve,
        };
        allConfigs.push(config);
      }
    }
  }
}

// Sort by total PnL
allConfigs.sort((a, b) => b.totalPnl - a.totalPnl);

console.log('Top 30 Configurations:');
console.log('Rank | Symbols   | Lev | Size | MaxP | Trades | WR    | PnL $     | Final $ | MaxDD   | Tr/Yr');
console.log('-----|-----------|-----|------|------|--------|-------|-----------|---------|---------|------');
for (let i = 0; i < Math.min(30, allConfigs.length); i++) {
  const c = allConfigs[i];
  console.log(
    `${String(i+1).padStart(4)} | ${c.label.padEnd(9)} | ${String(c.leverage).padStart(2)}x | ${(c.sizePct*100).toFixed(0).padStart(3)}% | ${String(c.maxPositions).padStart(4)} | ${String(c.trades).padStart(6)} | ${c.wr.toFixed(1).padStart(5)}% | $${c.totalPnl.toFixed(2).padStart(8)} | $${c.finalEquity.toFixed(2).padStart(6)} | ${(c.maxDD*100).toFixed(1).padStart(5)}%  | ${c.tradesPerYear.toFixed(0).padStart(4)}`
  );
}

// Also show configs with good risk-adjusted returns (PnL/MaxDD)
console.log('\nTop 15 by Risk-Adjusted (PnL / MaxDD):');
const riskAdj = allConfigs.filter(c => c.maxDD > 0.01).sort((a, b) => (b.totalPnl / b.maxDD) - (a.totalPnl / a.maxDD));
console.log('Rank | Symbols   | Lev | Size | MaxP | Trades | WR    | PnL $     | MaxDD   | PnL/DD');
console.log('-----|-----------|-----|------|------|--------|-------|-----------|---------|-------');
for (let i = 0; i < Math.min(15, riskAdj.length); i++) {
  const c = riskAdj[i];
  console.log(
    `${String(i+1).padStart(4)} | ${c.label.padEnd(9)} | ${String(c.leverage).padStart(2)}x | ${(c.sizePct*100).toFixed(0).padStart(3)}% | ${String(c.maxPositions).padStart(4)} | ${String(c.trades).padStart(6)} | ${c.wr.toFixed(1).padStart(5)}% | $${c.totalPnl.toFixed(2).padStart(8)} | ${(c.maxDD*100).toFixed(1).padStart(5)}%  | ${(c.totalPnl / c.maxDD).toFixed(1).padStart(6)}`
  );
}

// ── Part 3: Walk-Forward Validation ──────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  PART 3: Walk-Forward Validation (Top 3 Configs)');
console.log('═══════════════════════════════════════════════════════════════\n');

function runMultiSymbolPeriod(symbols, capital, leverage, sizePct, maxPositions, startDate, endDate) {
  const result = runMultiSymbol(symbols, capital, leverage, sizePct, maxPositions);
  const periodTrades = result.trades.filter(t => t.entryDate >= startDate && t.entryDate < endDate);
  const pnl = periodTrades.reduce((s, t) => s + t.pnl, 0);
  const wr = periodTrades.length > 0
    ? periodTrades.filter(t => t.pctNet > 0).length / periodTrades.length * 100
    : 0;
  return { trades: periodTrades.length, pnl, wr };
}

const top3 = allConfigs.slice(0, 3);
const periods = [
  { name: '2024 H1', start: '2024-01-01', end: '2024-07-01' },
  { name: '2024 H2', start: '2024-07-01', end: '2025-01-01' },
  { name: '2025 H1', start: '2025-01-01', end: '2025-07-01' },
  { name: '2025 H2', start: '2025-07-01', end: '2026-01-01' },
];

for (let ci = 0; ci < top3.length; ci++) {
  const c = top3[ci];
  console.log(`Config #${ci+1}: ${c.label} | ${c.leverage}x | ${(c.sizePct*100)}% | MaxP=${c.maxPositions} | Symbols: ${c.symbols.join(',')}`);
  console.log('Period    | Trades | WR     | PnL $');
  console.log('----------|--------|--------|--------');

  let passesValidation = true;
  for (const p of periods) {
    const periodTrades = c.allTrades.filter(t => t.entryDate >= p.start && t.entryDate < p.end);
    const pnl = periodTrades.reduce((s, t) => s + t.pnl, 0);
    const wr = periodTrades.length > 0
      ? periodTrades.filter(t => t.pctNet > 0).length / periodTrades.length * 100
      : 0;
    const status = pnl > 0 ? 'PASS' : 'FAIL';
    if (pnl <= 0) passesValidation = false;
    console.log(`${p.name.padEnd(9)} | ${String(periodTrades.length).padStart(6)} | ${wr.toFixed(1).padStart(5)}% | $${pnl.toFixed(2).padStart(7)} ${status}`);
  }
  console.log(`Walk-forward: ${passesValidation ? 'ALL PERIODS POSITIVE' : 'SOME PERIODS NEGATIVE'}\n`);
}

// ── Part 4: Trade-by-Trade for Best Config ───────────
console.log('═══════════════════════════════════════════════════════════════');
console.log('  PART 4: Trade-by-Trade Analysis (Best Config)');
console.log('═══════════════════════════════════════════════════════════════\n');

const best = allConfigs[0];
console.log(`Config: ${best.label} | ${best.leverage}x | ${(best.sizePct*100)}% | MaxP=${best.maxPositions}`);
console.log(`Symbols: ${best.symbols.join(', ')}`);
console.log(`Total trades: ${best.trades} | WR: ${best.wr.toFixed(1)}% | PnL: $${best.totalPnl.toFixed(2)} | MaxDD: ${(best.maxDD*100).toFixed(1)}%\n`);

const sortedTrades = best.allTrades.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
console.log('#   | Date       | Symbol  | Entry $    | Exit $     | PnL %   | PnL $    | Days | Reason');
console.log('----|------------|---------|------------|------------|---------|----------|------|-------');
let runningPnl = 0;
for (let i = 0; i < sortedTrades.length; i++) {
  const t = sortedTrades[i];
  runningPnl += t.pnl;
  const reason = t.pctNet > 0 ? 'TP (close<SMA50)' : 'SL (close<SMA50)';
  console.log(
    `${String(i+1).padStart(3)} | ${t.entryDate} | ${t.symbol.padEnd(7)} | $${t.entryPrice.toFixed(4).padStart(9)} | $${t.exitPrice.toFixed(4).padStart(9)} | ${(t.pctNet*100).toFixed(2).padStart(6)}% | $${t.pnl.toFixed(2).padStart(7)} | ${String(t.holdDays).padStart(4)} | ${reason}`
  );
}

// ── Summary stats ────────────────────────────────────
console.log('\n── Running PnL by month ──');
const monthlyPnl = {};
for (const t of sortedTrades) {
  const m = t.exitDate.substring(0, 7);
  if (!monthlyPnl[m]) monthlyPnl[m] = 0;
  monthlyPnl[m] += t.pnl;
}
let cumPnl = 0;
for (const m of Object.keys(monthlyPnl).sort()) {
  cumPnl += monthlyPnl[m];
  console.log(`${m}: $${monthlyPnl[m].toFixed(2).padStart(8)} | Cumulative: $${cumPnl.toFixed(2).padStart(8)}`);
}

// ── Final Recommendation ─────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  FINAL RECOMMENDATION');
console.log('═══════════════════════════════════════════════════════════════\n');

// Find best config that passes walk-forward
let recommended = null;
for (const c of allConfigs) {
  let passes = true;
  for (const p of periods) {
    const periodTrades = c.allTrades.filter(t => t.entryDate >= p.start && t.entryDate < p.end);
    const pnl = periodTrades.reduce((s, t) => s + t.pnl, 0);
    if (pnl <= 0) passes = false;
  }
  if (passes) {
    recommended = c;
    break;
  }
}

if (!recommended) {
  console.log('No config passes all walk-forward periods. Recommending best overall:');
  recommended = allConfigs[0];
}

const rec = recommended;
console.log(`RECOMMENDED CONFIG:`);
console.log(`  Symbols:        ${rec.symbols.join(', ')}`);
console.log(`  Leverage:       ${rec.leverage}x`);
console.log(`  Position Size:  ${(rec.sizePct * 100)}% of $350 = $${(350 * rec.sizePct).toFixed(2)} per trade`);
console.log(`  Max Concurrent: ${rec.maxPositions}`);
console.log(`  Starting Cap:   $350`);
console.log('');

const y24Trades = rec.allTrades.filter(t => t.entryDate.startsWith('2024'));
const y25Trades = rec.allTrades.filter(t => t.entryDate.startsWith('2025'));
const y24Pnl = y24Trades.reduce((s, t) => s + t.pnl, 0);
const y25Pnl = y25Trades.reduce((s, t) => s + t.pnl, 0);

console.log(`PERFORMANCE:`);
console.log(`  Total Trades:   ${rec.trades} over ~2 years`);
console.log(`  Trades/Year:    ~${rec.tradesPerYear.toFixed(0)}`);
console.log(`  Win Rate:       ${rec.wr.toFixed(1)}%`);
console.log(`  2024 PnL:       $${y24Pnl.toFixed(2)} (${(y24Pnl/350*100).toFixed(1)}%)`);
console.log(`  2025 PnL:       $${y25Pnl.toFixed(2)} (${(y25Pnl/350*100).toFixed(1)}%)`);
console.log(`  Total PnL:      $${rec.totalPnl.toFixed(2)} (${(rec.totalPnl/350*100).toFixed(1)}%)`);
console.log(`  Final Equity:   $${rec.finalEquity.toFixed(2)}`);
console.log(`  Max Drawdown:   ${(rec.maxDD * 100).toFixed(1)}%`);
console.log('');

// Avg win / avg loss
const wins = rec.allTrades.filter(t => t.pctNet > 0);
const losses = rec.allTrades.filter(t => t.pctNet <= 0);
const avgWinPct = wins.length ? wins.reduce((s, t) => s + t.pctNet, 0) / wins.length * 100 : 0;
const avgLossPct = losses.length ? losses.reduce((s, t) => s + t.pctNet, 0) / losses.length * 100 : 0;
const avgWin$ = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
const avgLoss$ = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

console.log(`TRADE STATS:`);
console.log(`  Avg Win:        ${avgWinPct.toFixed(2)}% ($${avgWin$.toFixed(2)})`);
console.log(`  Avg Loss:       ${avgLossPct.toFixed(2)}% ($${avgLoss$.toFixed(2)})`);
console.log(`  Profit Factor:  ${losses.length ? (wins.reduce((s,t)=>s+t.pnl,0) / Math.abs(losses.reduce((s,t)=>s+t.pnl,0))).toFixed(2) : 'N/A'}`);
console.log(`  Avg Hold Days:  ${(rec.allTrades.reduce((s,t)=>s+t.holdDays,0)/rec.allTrades.length).toFixed(1)}`);
console.log('');

// Walk-forward check
let wfPasses = true;
for (const p of periods) {
  const periodTrades = rec.allTrades.filter(t => t.entryDate >= p.start && t.entryDate < p.end);
  const pnl = periodTrades.reduce((s, t) => s + t.pnl, 0);
  if (pnl <= 0) wfPasses = false;
}

console.log(`VALIDATION:`);
console.log(`  Walk-Forward:   ${wfPasses ? 'PASS (all half-years positive)' : 'PARTIAL (not all half-years positive)'}`);
console.log(`  MaxDD < 20%:    ${rec.maxDD < 0.20 ? 'PASS' : 'FAIL'} (${(rec.maxDD*100).toFixed(1)}%)`);
console.log(`  WR > 35%:       ${rec.wr > 35 ? 'PASS' : 'FAIL'} (${rec.wr.toFixed(1)}%)`);
console.log(`  Profit Factor:  ${losses.length && (wins.reduce((s,t)=>s+t.pnl,0) / Math.abs(losses.reduce((s,t)=>s+t.pnl,0))) > 1.2 ? 'PASS' : 'FAIL'}`);

// Expected PnL range
const tradeReturns = rec.allTrades.map(t => t.pnl);
const mean = tradeReturns.reduce((s,v)=>s+v,0) / tradeReturns.length;
const stdDev = Math.sqrt(tradeReturns.reduce((s,v)=>s+(v-mean)**2,0) / tradeReturns.length);
const annualMean = mean * rec.tradesPerYear;
const annualStd = stdDev * Math.sqrt(rec.tradesPerYear);

console.log('');
console.log(`EXPECTED ANNUAL RANGE:`);
console.log(`  Mean:           $${annualMean.toFixed(2)}`);
console.log(`  Optimistic:     $${(annualMean + annualStd).toFixed(2)}`);
console.log(`  Pessimistic:    $${(annualMean - annualStd).toFixed(2)}`);
console.log(`  On $350 capital: ${(annualMean/350*100).toFixed(1)}% expected return`);
