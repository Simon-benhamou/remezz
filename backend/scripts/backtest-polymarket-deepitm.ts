/**
 * backtest-polymarket-deepitm.ts -- Strategy D: Deep In-The-Money Sniper (93-96c sweet spot)
 *
 * Buy YES tokens at 0.93-0.96 on daily "BTC above $X" markets where $X is
 * well below current spot price (2-6% below). These are "deep in-the-money" --
 * BTC would need to crash significantly in hours for the bet to lose.
 *
 * Win:  token pays $1 -> profit = (1 - entryPrice) / entryPrice x bet = 4-7% in ~12-24h
 * Lose: BTC crashes below threshold -> lose full bet
 *
 * Resolution: STRICT -- if any 1m candle LOW drops below threshold between entry
 * and resolution time, the trade is a loss. Conservative (worst-case) interpretation.
 *
 * Usage:
 *   npx tsx backend/scripts/backtest-polymarket-deepitm.ts [--months 6] [--bet 10] [--resolution same-day]
 *
 * Options:
 *   --months      Lookback period (default: 6)
 *   --bet         Dollar amount per bet (default: 10)
 *   --resolution  Resolution window: same-day | next-noon | 48h (default: same-day)
 */

import {
  fetchCandles1m,
  normalCDF,
  rollingDailyVolatility,
  getDailyCloses,
  getPriceAtTime,
  noonEtToUtcMs,
  type Candle1m,
} from './lib/polymarket-bt-utils.js';

// -- CLI -------------------------------------------------------------------

function parseArg(name: string, defaultVal: string): string {
  const eqIdx = process.argv.findIndex(a => a.startsWith(`--${name}=`));
  if (eqIdx >= 0) return process.argv[eqIdx].split('=')[1];
  const spIdx = process.argv.indexOf(`--${name}`);
  if (spIdx >= 0 && spIdx + 1 < process.argv.length) return process.argv[spIdx + 1];
  return defaultVal;
}

const MONTHS = parseInt(parseArg('months', '6'), 10);
const BET = parseFloat(parseArg('bet', '10'));
const RESOLUTION_MODE = parseArg('resolution', 'same-day') as 'same-day' | 'next-noon' | '48h';

// -- Constants -------------------------------------------------------------

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 3_600_000;
const ONE_DAY_MS = 86_400_000;

const CHECK_HOUR_UTC = 12;        // noon UTC = when we scan daily markets
const THRESHOLD_INCREMENT = 1000; // $1000 round-number thresholds
const ENTRY_PRICE_MIN = 0.93;     // sweet spot lower bound
const ENTRY_PRICE_MAX = 0.96;     // sweet spot upper bound
const HALF_SPREAD = 0.005;        // 0.5 cent bid-ask half-spread
const DISTANCE_PCT_MIN = 2;       // minimum 2% below current price
const DISTANCE_PCT_MAX = 6;       // maximum 6% below current price
const MAX_BETS_PER_DAY = 3;       // max simultaneous bets on same day

// -- Types -----------------------------------------------------------------

interface DeepITMTrade {
  date: string;               // "YYYY-MM-DD"
  checkTime: number;          // epoch ms when we scan
  resolutionTime: number;     // epoch ms when market resolves
  holdHours: number;          // holding period in hours
  currentPrice: number;       // BTC price at check time
  threshold: number;          // the $X level (e.g., 64000)
  distancePct: number;        // how far below current price (%)
  fairPrice: number;          // model fair probability
  entryPrice: number;         // fairPrice + spread
  vol30d: number;             // 30-day vol at entry (no look-ahead)
  daysRemaining: number;      // fraction of day remaining to resolution
  isWin: boolean;             // did BTC stay above threshold?
  minPriceSeen: number;       // lowest 1m LOW during holding period
  minPriceTime: number;       // epoch ms of the min low
  minDistancePct: number;     // how close to threshold it got (%)
  pnl: number;               // dollar PnL
  returnPct: number;          // return as % of bet
  period: 'IS' | 'OOS';
}

interface PeriodMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  totalPnl: number;
  evPerTrade: number;
  roi: number;
  maxConsecLoss: number;
  maxDrawdown: number;
  sharpe: number;
  kellyFraction: number;
}

// -- Probability Model -----------------------------------------------------

/**
 * Probability that BTC stays above threshold for entire holding period.
 * Uses reflection principle for geometric Brownian motion:
 *   P(min > X) = 1 - 2 * Phi(-ln(S/X) / (sigma * sqrt(T)))
 * where S = current price, X = threshold, sigma = daily vol, T = time in days.
 */
function probStaysAbove(
  currentPrice: number,
  threshold: number,
  dailyVol: number,
  daysRemaining: number,
): number {
  if (currentPrice <= threshold) return 0;
  if (daysRemaining <= 0) return currentPrice > threshold ? 1 : 0;

  const logDist = Math.log(currentPrice / threshold);
  const sigma = dailyVol * Math.sqrt(daysRemaining);

  if (sigma <= 0) return 1;

  // P(min > threshold) = 1 - 2 * Phi(-logDist / sigma)
  return 1 - 2 * normalCDF(-logDist / sigma);
}

// -- Resolution Logic (STRICT: uses 1m LOW) ---------------------------------

/**
 * Check if BTC ever dips below threshold during the holding window.
 * Uses 1m candle LOWs -- if any LOW < threshold, the trade is a loss.
 * This is MORE STRICT than some Polymarket markets but ensures
 * the backtest doesn't overestimate win rate.
 *
 * Returns { isWin, minLow, minLowTime }.
 */
function checkDailyThresholdResult(
  candles: Candle1m[],
  entryTimeMs: number,
  resolutionTimeMs: number,
  threshold: number,
): { isWin: boolean; minLow: number; minLowTime: number } {
  let minLow = Infinity;
  let minLowTime = 0;

  for (const c of candles) {
    if (c.timestamp >= entryTimeMs && c.timestamp <= resolutionTimeMs) {
      if (c.low < minLow) {
        minLow = c.low;
        minLowTime = c.timestamp;
      }
    }
  }

  if (minLow === Infinity) {
    // No candles in window (shouldn't happen, but handle gracefully)
    return { isWin: true, minLow: 0, minLowTime: 0 };
  }

  return {
    isWin: minLow >= threshold,
    minLow,
    minLowTime,
  };
}

// -- Resolution Time Calculation -------------------------------------------

/**
 * Compute the resolution time based on the mode.
 *   same-day:   23:59 UTC on the same day (12h hold)
 *   next-noon:  noon ET on the next day (24h hold)
 *   48h:        noon ET two days later (48h hold)
 */
function getResolutionTime(checkTime: number, mode: 'same-day' | 'next-noon' | '48h'): number {
  const checkDate = new Date(checkTime);
  const dateStr = checkDate.toISOString().slice(0, 10);
  const [year, month, day] = dateStr.split('-').map(Number);

  switch (mode) {
    case 'same-day': {
      // End of same day UTC: 23:59 UTC
      return Date.UTC(year, month - 1, day, 23, 59, 0, 0);
    }
    case 'next-noon': {
      // Noon ET next day
      const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
      const nextDateStr = nextDay.toISOString().slice(0, 10);
      return noonEtToUtcMs(nextDateStr);
    }
    case '48h': {
      // Noon ET two days later
      const twoDaysLater = new Date(Date.UTC(year, month - 1, day + 2));
      const twoDayStr = twoDaysLater.toISOString().slice(0, 10);
      return noonEtToUtcMs(twoDayStr);
    }
  }
}

// -- Threshold Scanning ----------------------------------------------------

/**
 * Generate candidate thresholds: $1000 increments that are 2-6% below current price.
 */
function findDeepITMThresholds(currentPrice: number): number[] {
  const lowBound = currentPrice * (1 - DISTANCE_PCT_MAX / 100);
  const highBound = currentPrice * (1 - DISTANCE_PCT_MIN / 100);

  const startThreshold = Math.ceil(lowBound / THRESHOLD_INCREMENT) * THRESHOLD_INCREMENT;
  const thresholds: number[] = [];

  for (let t = startThreshold; t <= highBound; t += THRESHOLD_INCREMENT) {
    thresholds.push(t);
  }

  return thresholds;
}

// -- Metrics ---------------------------------------------------------------

function computeMetrics(trades: DeepITMTrade[], bet: number): PeriodMetrics {
  if (trades.length === 0) {
    return {
      trades: 0, wins: 0, losses: 0, winRate: 0,
      avgWin: 0, avgLoss: 0, totalPnl: 0, evPerTrade: 0,
      roi: 0, maxConsecLoss: 0, maxDrawdown: 0, sharpe: 0, kellyFraction: 0,
    };
  }

  const wins = trades.filter(t => t.isWin);
  const losses = trades.filter(t => !t.isWin);
  const winRate = wins.length / trades.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const evPerTrade = totalPnl / trades.length;
  const totalRisked = trades.length * bet;
  const roi = totalRisked > 0 ? (totalPnl / totalRisked) * 100 : 0;

  // Max consecutive losses
  let maxConsecLoss = 0;
  let currentStreak = 0;
  for (const t of trades) {
    if (!t.isWin) {
      currentStreak++;
      maxConsecLoss = Math.max(maxConsecLoss, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  // Max drawdown (dollar-based from cumulative PnL)
  let peak = 0;
  let maxDd = 0;
  let cumPnl = 0;
  for (const t of trades) {
    cumPnl += t.pnl;
    peak = Math.max(peak, cumPnl);
    const dd = peak - cumPnl;
    maxDd = Math.max(maxDd, dd);
  }

  // Sharpe: group PnL by day, annualize
  const dailyPnlMap = new Map<string, number>();
  for (const t of trades) {
    dailyPnlMap.set(t.date, (dailyPnlMap.get(t.date) ?? 0) + t.pnl);
  }
  const dailyPnls = [...dailyPnlMap.values()];
  const meanDaily = dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length;
  const stdDaily = dailyPnls.length > 1
    ? Math.sqrt(dailyPnls.reduce((s, v) => s + (v - meanDaily) ** 2, 0) / (dailyPnls.length - 1))
    : 0;
  const sharpe = stdDaily > 0 ? (meanDaily / stdDaily) * Math.sqrt(365) : 0;

  // Kelly fraction: f* = (p * b - q) / b where p = WR, q = 1-WR, b = avgWin/avgLoss
  let kellyFraction = 0;
  if (avgLoss > 0 && winRate > 0 && winRate < 1) {
    const b = avgWin / avgLoss;
    kellyFraction = (winRate * b - (1 - winRate)) / b;
    kellyFraction = Math.max(0, kellyFraction); // clamp to 0 if negative
  }

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    totalPnl,
    evPerTrade,
    roi,
    maxConsecLoss,
    maxDrawdown: maxDd,
    sharpe,
    kellyFraction,
  };
}

// -- Verdict ---------------------------------------------------------------

function getVerdict(
  oosWR: number,
  oosEV: number,
  oosSharpe: number,
  oosCount: number,
  maxConsecLoss: number,
): string {
  if (oosCount < 30) return 'INSUFFICIENT DATA -- need 30+ OOS trades';
  if (oosEV <= 0) return 'NOT VIABLE -- negative EV out-of-sample';
  if (oosWR < 0.90) return 'DANGEROUS -- loss rate too high for this strategy (need 90%+)';
  if (maxConsecLoss >= 3) return 'DANGEROUS -- consecutive losses can wipe capital';
  if (oosSharpe < 1.0) return 'MARGINAL -- edge exists but thin';
  if (oosSharpe < 2.0) return 'VIABLE -- positive edge, manage position sizing carefully';
  return 'STRONG -- high Sharpe, consistent returns';
}

// -- Print Results ---------------------------------------------------------

function printResults(
  trades: DeepITMTrade[],
  bet: number,
  startDate: Date,
  endDate: Date,
  isCutoffDate: Date,
  resolutionMode: string,
): void {
  const isTrades = trades.filter(t => t.period === 'IS');
  const oosTrades = trades.filter(t => t.period === 'OOS');

  const isMetrics = computeMetrics(isTrades, bet);
  const oosMetrics = computeMetrics(oosTrades, bet);
  const allMetrics = computeMetrics(trades, bet);

  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);
  const cutoffStr = isCutoffDate.toISOString().slice(0, 10);

  const verdict = getVerdict(
    oosMetrics.winRate,
    oosMetrics.evPerTrade,
    oosMetrics.sharpe,
    oosMetrics.trades,
    oosMetrics.maxConsecLoss,
  );

  const pad = (s: string, len: number) => s.padEnd(len);
  const fmtPct = (n: number) => (n * 100).toFixed(1) + '%';
  const fmtDol = (n: number) => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);

  const holdLabelMap: Record<string, string> = {
    'same-day': 'Same-day (12h hold)',
    'next-noon': 'Next-noon ET (24h hold)',
    '48h': '48h hold',
  };
  const holdLabel = holdLabelMap[resolutionMode] ?? resolutionMode;

  console.log('');
  console.log('='.repeat(70));
  console.log('  STRATEGY D: DEEP IN-THE-MONEY SNIPER (93-96c sweet spot)');
  console.log('='.repeat(70));
  console.log(`  Period: ${startStr} -> ${endStr}  (IS/OOS split: ${cutoffStr})`);
  console.log(`  Resolution: ${holdLabel}`);
  console.log(`  Bet: $${bet}/trade`);
  console.log('-'.repeat(70));

  // -- Main metrics table --
  console.log(`${''.padEnd(24)}IN-SAMPLE       OUT-OF-SAMPLE`);
  console.log(`  Trades              ${pad(String(isMetrics.trades), 16)}${String(oosMetrics.trades)}`);
  console.log(`  Win Rate            ${pad(fmtPct(isMetrics.winRate), 16)}${fmtPct(oosMetrics.winRate)}`);
  console.log(`  Wins                ${pad(String(isMetrics.wins), 16)}${String(oosMetrics.wins)}`);
  console.log(`  Losses              ${pad(String(isMetrics.losses), 16)}${String(oosMetrics.losses)}`);
  console.log(`  Avg Win             ${pad(fmtDol(isMetrics.avgWin), 16)}${fmtDol(oosMetrics.avgWin)}  (~4-7% of bet)`);
  console.log(`  Avg Loss            ${pad('-$' + isMetrics.avgLoss.toFixed(2), 16)}-$${oosMetrics.avgLoss.toFixed(2)}  (full bet)`);
  console.log(`  Total PnL           ${pad(fmtDol(isMetrics.totalPnl), 16)}${fmtDol(oosMetrics.totalPnl)}`);
  console.log(`  EV/trade            ${pad(fmtDol(isMetrics.evPerTrade), 16)}${fmtDol(oosMetrics.evPerTrade)}`);
  console.log(`  ROI                 ${pad(isMetrics.roi.toFixed(1) + '%', 16)}${oosMetrics.roi.toFixed(1)}%`);
  console.log(`  Max Consec Loss     ${pad(String(isMetrics.maxConsecLoss), 16)}${String(oosMetrics.maxConsecLoss)}`);
  console.log(`  Max Drawdown        ${pad('$' + isMetrics.maxDrawdown.toFixed(2), 16)}$${oosMetrics.maxDrawdown.toFixed(2)}`);
  console.log(`  Sharpe (annual)     ${pad(isMetrics.sharpe.toFixed(2), 16)}${oosMetrics.sharpe.toFixed(2)}`);
  console.log(`  Kelly Fraction      ${pad(fmtPct(isMetrics.kellyFraction), 16)}${fmtPct(oosMetrics.kellyFraction)}`);

  // -- By threshold distance --
  console.log('-'.repeat(70));
  console.log('  BY THRESHOLD DISTANCE:');
  const distBuckets = [
    { label: '2-3%', min: 2, max: 3 },
    { label: '3-4%', min: 3, max: 4 },
    { label: '4-5%', min: 4, max: 5 },
    { label: '5-6%', min: 5, max: 6 },
  ];
  for (const bucket of distBuckets) {
    const bTrades = trades.filter(t => t.distancePct >= bucket.min && t.distancePct < bucket.max);
    const n = bTrades.length;
    if (n === 0) {
      console.log(`    ${bucket.label} below: 0 trades`);
      continue;
    }
    const wr = bTrades.filter(t => t.isWin).length / n;
    const ev = bTrades.reduce((s, t) => s + t.pnl, 0) / n;
    const avgEntry = bTrades.reduce((s, t) => s + t.entryPrice, 0) / n;
    console.log(`    ${bucket.label} below: ${pad(String(n) + ' trades,', 14)}${pad(fmtPct(wr) + ' WR,', 12)}EV ${fmtDol(ev)}, avg entry ${avgEntry.toFixed(3)}`);
  }

  // -- Loss analysis (EVERY SINGLE LOSS) --
  console.log('-'.repeat(70));
  const allLosses = trades.filter(t => !t.isWin);
  console.log(`  LOSS ANALYSIS (${allLosses.length} losses -- every loss listed):`);
  if (allLosses.length === 0) {
    console.log('    No losses!');
  } else {
    for (const loss of allLosses) {
      const crashPct = ((loss.currentPrice - loss.minPriceSeen) / loss.currentPrice * 100).toFixed(1);
      const minTimeStr = new Date(loss.minPriceTime).toISOString().slice(0, 16).replace('T', ' ');
      console.log(
        `    ${loss.date}: BTC $${loss.currentPrice.toFixed(0)} -> min $${loss.minPriceSeen.toFixed(0)} ` +
        `(-${crashPct}%), threshold $${loss.threshold.toFixed(0)}, ` +
        `dist ${loss.distancePct.toFixed(1)}%, entry ${loss.entryPrice.toFixed(3)}, ` +
        `min at ${minTimeStr} [${loss.period}]`
      );
    }
  }

  // -- Monthly breakdown --
  console.log('-'.repeat(70));
  console.log('  MONTHLY BREAKDOWN:');
  const monthlyMap = new Map<string, DeepITMTrade[]>();
  for (const t of trades) {
    const month = t.date.slice(0, 7);
    if (!monthlyMap.has(month)) monthlyMap.set(month, []);
    monthlyMap.get(month)!.push(t);
  }
  const sortedMonths = [...monthlyMap.keys()].sort();
  for (const month of sortedMonths) {
    const mTrades = monthlyMap.get(month)!;
    const mWins = mTrades.filter(t => t.isWin).length;
    const mLosses = mTrades.filter(t => !t.isWin).length;
    const mPnl = mTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`    ${month}: ${pad(String(mTrades.length) + ' trades,', 14)}${pad(String(mWins) + ' wins,', 10)}${pad(String(mLosses) + ' losses,', 12)}PnL ${fmtDol(mPnl)}`);
  }

  // -- Risk analysis --
  console.log('-'.repeat(70));
  console.log('  RISK ANALYSIS:');
  const worstLoss = allLosses.length > 0
    ? allLosses.reduce((worst, t) => t.pnl < worst.pnl ? t : worst, allLosses[0])
    : null;

  if (worstLoss) {
    console.log(`    Worst single-day loss:     -$${Math.abs(worstLoss.pnl).toFixed(2)} (${worstLoss.date})`);
  } else {
    console.log(`    Worst single-day loss:     $0.00 (no losses)`);
  }

  // Max capital at risk: max bets outstanding on same day
  const dayBetCounts = new Map<string, number>();
  for (const t of trades) {
    dayBetCounts.set(t.date, (dayBetCounts.get(t.date) ?? 0) + 1);
  }
  const maxDayBets = Math.max(...dayBetCounts.values(), 0);
  console.log(`    Max capital at risk:       $${(maxDayBets * bet).toFixed(2)} (${maxDayBets} positions x $${bet} bet)`);

  // Annual return
  const totalDays = (endDate.getTime() - startDate.getTime()) / ONE_DAY_MS;
  const annualReturn = totalDays > 0 ? (allMetrics.totalPnl / (totalDays / 365)) : 0;
  console.log(`    Annual return if repeated: ${fmtDol(annualReturn)}`);

  // Breakeven win rate: WR where EV = 0
  // EV = WR * avgWin - (1-WR) * avgLoss = 0
  // WR * avgWin = (1-WR) * bet
  // WR = bet / (avgWin_per_unit + bet)
  // For entry price p: avgWin = bet * (1-p)/p, so WR_be = p
  const avgEntry = trades.length > 0
    ? trades.reduce((s, t) => s + t.entryPrice, 0) / trades.length
    : 0;
  console.log(`    Breakeven WR:              ${fmtPct(avgEntry)} (= avg entry price)`);

  // -- Verdict --
  console.log('-'.repeat(70));
  console.log(`  VERDICT: ${verdict}`);
  console.log('='.repeat(70));

  // -- Near-miss analysis (closest calls that DIDN'T lose) --
  console.log('');
  console.log('  CLOSEST CALLS (wins where BTC almost breached):');
  const closeCalls = trades
    .filter(t => t.isWin && t.minDistancePct < 2.0)
    .sort((a, b) => a.minDistancePct - b.minDistancePct)
    .slice(0, 10);

  if (closeCalls.length === 0) {
    console.log('    None within 2% of threshold.');
  } else {
    for (const t of closeCalls) {
      const minTimeStr = new Date(t.minPriceTime).toISOString().slice(0, 16).replace('T', ' ');
      console.log(
        `    ${t.date}: BTC min $${t.minPriceSeen.toFixed(0)} vs threshold $${t.threshold.toFixed(0)} ` +
        `(${t.minDistancePct.toFixed(2)}% above), at ${minTimeStr}`
      );
    }
  }

  console.log('');
}

// -- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  // Date range
  const endDate = new Date();
  endDate.setUTCHours(0, 0, 0, 0);

  const startDate = new Date(endDate);
  startDate.setMonth(startDate.getMonth() - MONTHS);

  // Need 35 extra days for volatility warmup (30-day rolling vol + buffer)
  const fetchStart = new Date(startDate);
  fetchStart.setDate(fetchStart.getDate() - 35);

  console.log(`=== Strategy D: Deep In-The-Money Sniper Backtest ===`);
  console.log(`Period: ${startDate.toISOString().slice(0, 10)} -> ${endDate.toISOString().slice(0, 10)}`);
  console.log(`Warmup from: ${fetchStart.toISOString().slice(0, 10)}`);
  console.log(`Bet: $${BET}/trade  |  Resolution: ${RESOLUTION_MODE}`);
  console.log(`Entry sweet spot: ${ENTRY_PRICE_MIN}-${ENTRY_PRICE_MAX}  |  Distance: ${DISTANCE_PCT_MIN}-${DISTANCE_PCT_MAX}%`);
  console.log('');

  // Fetch ALL 1m candles
  console.log(`Fetching ${MONTHS + 2} months of BTC 1m candles from Binance...`);
  const candles = await fetchCandles1m('BTCUSDT', fetchStart.getTime(), endDate.getTime());
  console.log(`Fetched ${candles.length.toLocaleString()} candles`);

  // Build map for O(1) lookup
  const candleMap = new Map<number, Candle1m>(candles.map(c => [c.timestamp, c]));

  // Get daily closes for volatility (17:00 UTC default)
  const dailyCloses = getDailyCloses(candleMap, fetchStart.getTime(), endDate.getTime());
  console.log(`Daily closes extracted: ${dailyCloses.length}`);

  // Walk-forward split: first 2/3 = in-sample, last 1/3 = out-of-sample
  const isCutoffDate = new Date(startDate);
  isCutoffDate.setMonth(isCutoffDate.getMonth() + Math.floor(MONTHS * 2 / 3));

  console.log(`IS/OOS cutoff: ${isCutoffDate.toISOString().slice(0, 10)}`);
  console.log('');

  // -- Generate check days --
  const allTrades: DeepITMTrade[] = [];
  let daysProcessed = 0;
  let daysWithTrades = 0;

  const currentDay = new Date(startDate);
  currentDay.setUTCHours(0, 0, 0, 0);

  while (currentDay < endDate) {
    const dateStr = currentDay.toISOString().slice(0, 10);

    // Check time: noon UTC on this day
    const checkTime = Date.UTC(
      currentDay.getUTCFullYear(),
      currentDay.getUTCMonth(),
      currentDay.getUTCDate(),
      CHECK_HOUR_UTC, 0, 0, 0,
    );

    // Resolution time based on mode
    const resolutionTime = getResolutionTime(checkTime, RESOLUTION_MODE);
    const holdHours = (resolutionTime - checkTime) / ONE_HOUR_MS;

    // Get current BTC price at check time
    const currentPrice = getPriceAtTime(candleMap, checkTime);
    if (!currentPrice) {
      currentDay.setUTCDate(currentDay.getUTCDate() + 1);
      continue;
    }

    // Compute rolling 30-day volatility (NO LOOK-AHEAD)
    const checkDateIdx = dailyCloses.findIndex(d => d.date >= dateStr);
    const closesBeforeCheck = checkDateIdx > 0
      ? dailyCloses.slice(0, checkDateIdx).map(d => d.close)
      : dailyCloses.filter(d => d.date < dateStr).map(d => d.close);

    if (closesBeforeCheck.length < 31) {
      currentDay.setUTCDate(currentDay.getUTCDate() + 1);
      continue;
    }

    const vol30d = rollingDailyVolatility(closesBeforeCheck, 30);
    if (vol30d <= 0) {
      currentDay.setUTCDate(currentDay.getUTCDate() + 1);
      continue;
    }

    const daysRemaining = (resolutionTime - checkTime) / ONE_DAY_MS;

    // Scan candidate thresholds
    const thresholds = findDeepITMThresholds(currentPrice);
    let betsToday = 0;

    for (const threshold of thresholds) {
      if (betsToday >= MAX_BETS_PER_DAY) break;

      const distancePct = (currentPrice - threshold) / currentPrice * 100;

      // Model the fair token price
      const fairPrice = probStaysAbove(currentPrice, threshold, vol30d, daysRemaining);
      const entryPrice = fairPrice + HALF_SPREAD;

      // Only enter if in the 93-96c sweet spot
      if (entryPrice < ENTRY_PRICE_MIN || entryPrice > ENTRY_PRICE_MAX) continue;

      // Check if BTC ever dips below threshold before resolution (STRICT: uses LOW)
      const result = checkDailyThresholdResult(candles, checkTime, resolutionTime, threshold);

      const pnlIfWin = BET * (1 - entryPrice) / entryPrice;
      const pnl = result.isWin ? pnlIfWin : -BET;
      const returnPct = result.isWin ? ((1 - entryPrice) / entryPrice) * 100 : -100;

      // How close did price get to threshold (in %)
      const minDistancePct = result.minLow > 0
        ? ((result.minLow - threshold) / threshold) * 100
        : 0;

      const trade: DeepITMTrade = {
        date: dateStr,
        checkTime,
        resolutionTime,
        holdHours,
        currentPrice,
        threshold,
        distancePct: Math.round(distancePct * 100) / 100,
        fairPrice: Math.round(fairPrice * 1000) / 1000,
        entryPrice: Math.round(entryPrice * 1000) / 1000,
        vol30d: Math.round(vol30d * 10000) / 10000,
        daysRemaining: Math.round(daysRemaining * 100) / 100,
        isWin: result.isWin,
        minPriceSeen: result.minLow,
        minPriceTime: result.minLowTime,
        minDistancePct: Math.round(minDistancePct * 100) / 100,
        pnl: Math.round(pnl * 100) / 100,
        returnPct: Math.round(returnPct * 100) / 100,
        period: currentDay < isCutoffDate ? 'IS' : 'OOS',
      };

      allTrades.push(trade);
      betsToday++;
    }

    daysProcessed++;
    if (betsToday > 0) daysWithTrades++;

    // Progress logging
    if (daysProcessed % 30 === 0) {
      console.log(`  ... processed ${daysProcessed} days, ${allTrades.length} trades so far`);
    }

    currentDay.setUTCDate(currentDay.getUTCDate() + 1);
  }

  console.log('');
  console.log(`Days processed: ${daysProcessed} | Days with trades: ${daysWithTrades} | Total trades: ${allTrades.length}`);

  if (allTrades.length === 0) {
    console.log('');
    console.log('NO TRADES GENERATED. This means no thresholds fell in the 93-96c sweet spot.');
    console.log('This can happen if volatility is too high or too low for the distance range.');
    console.log('Try adjusting --months or check the ENTRY_PRICE_MIN/MAX constants.');
    return;
  }

  // Sort by date
  allTrades.sort((a, b) => a.checkTime - b.checkTime);

  // Print results
  printResults(allTrades, BET, startDate, endDate, isCutoffDate, RESOLUTION_MODE);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
