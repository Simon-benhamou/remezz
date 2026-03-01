/**
 * backtest-polymarket-threshold.ts — Strategy C: Threshold Sniper on Polymarket
 *
 * Monthly "BTC above $X" markets on Polymarket.
 * Resolution: if ANY Binance 1m candle HIGH >= threshold during the month -> "Yes" wins.
 *             If none does -> "No" wins. Token pays $1 if correct.
 *
 * Edge: use realized volatility to estimate TRUE probability of touching a threshold
 * (first passage time via reflection principle), then compare to the market's implied
 * probability (estimated using long-term vol). If our vol-adjusted probability diverges
 * from the market estimate by >= MIN_EDGE, we have positive EV.
 *
 * Usage:
 *   npx tsx backend/scripts/backtest-polymarket-threshold.ts [--months 6] [--bet 3] [--capital 50]
 */

import {
  fetchCandles1m,
  normalCDF,
  rollingDailyVolatility,
  getDailyCloses,
  getPriceAtTime,
  type Candle1m,
} from './lib/polymarket-bt-utils.js';

// ── CLI ─────────────────────────────────────────────────────────────────────────

function parseArg(name: string, defaultVal: string): string {
  const eqIdx = process.argv.findIndex(a => a.startsWith(`--${name}=`));
  if (eqIdx >= 0) return process.argv[eqIdx].split('=')[1];
  const spIdx = process.argv.indexOf(`--${name}`);
  if (spIdx >= 0 && spIdx + 1 < process.argv.length) return process.argv[spIdx + 1];
  return defaultVal;
}

const MONTHS = parseInt(parseArg('months', '6'), 10);
const BET = parseFloat(parseArg('bet', '3'));
const CAPITAL = parseFloat(parseArg('capital', '50'));

// ── Constants ───────────────────────────────────────────────────────────────────

const MIN_EDGE = 0.05;             // 5% edge minimum
const MIN_PROB = 0.15;             // don't buy tokens with <15% probability
const MAX_PROB = 0.90;             // don't buy tokens with >90% probability
const MAX_BETS_PER_CHECK = 1;      // max 1 new bet per 6h check
const MAX_OPEN_POSITIONS = 3;      // max 3 open threshold bets at once
const CHECK_INTERVAL_H = 6;        // check every 6 hours
const THRESHOLD_INCREMENT = 1000;   // $1000 round-number levels
const THRESHOLD_RANGE_PCT = 0.03;   // scan within 3% of current price

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 3_600_000;
const ONE_DAY_MS = 86_400_000;

// ── Types ───────────────────────────────────────────────────────────────────────

interface ThresholdBet {
  month: string;              // "YYYY-MM"
  threshold: number;          // e.g. 67000
  direction: 'YES' | 'NO';   // what we bought
  entryTime: number;          // epoch ms
  entryPrice: number;         // token price we paid (0-1)
  edge: number;               // our edge at entry
  distancePct: number;        // distance from current price to threshold at entry
  volRegime: 'Calm' | 'Normal' | 'Volatile';
  currentPriceAtEntry: number;
  // Resolution
  resolved: boolean;
  isWin: boolean;
  pnl: number;
  touchedAt?: number;         // epoch ms when threshold was first touched
  period: 'IS' | 'OOS';
}

interface PeriodMetrics {
  trades: number;
  wins: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  totalPnl: number;
  evPerTrade: number;
  avgEntryPrice: number;
  avgEdge: number;
  maxDrawdown: number;
  sharpe: number;
}

interface DistanceBucket {
  label: string;
  trades: ThresholdBet[];
}

interface VolRegimeBucket {
  label: string;
  trades: ThresholdBet[];
}

// ── Probability Model ───────────────────────────────────────────────────────────

/**
 * Probability that BTC ever touches threshold X from above (going up) within T days.
 * Uses the reflection principle for geometric Brownian motion first passage time.
 *
 * P(max(BTC) >= X | BTC_now = S) = 2 * Phi(-ln(X/S) / (sigma * sqrt(T)))
 * when X > S. If X <= S, already above => P = 1.
 */
function probTouchAbove(
  currentPrice: number,
  threshold: number,
  dailyVol: number,
  daysRemaining: number,
): number {
  if (currentPrice >= threshold) return 1.0; // already above
  if (daysRemaining <= 0 || dailyVol <= 0) return 0;
  const logDist = Math.log(threshold / currentPrice);
  const sigma = dailyVol * Math.sqrt(daysRemaining);
  if (sigma <= 0) return 0;
  return 2 * normalCDF(-logDist / sigma);
}

/**
 * Probability that BTC ever touches threshold X from below (going down) within T days.
 *
 * P(min(BTC) <= X | BTC_now = S) = 2 * Phi(-ln(S/X) / (sigma * sqrt(T)))
 * when X < S. If X >= S, already below => P = 1.
 */
function probTouchBelow(
  currentPrice: number,
  threshold: number,
  dailyVol: number,
  daysRemaining: number,
): number {
  if (currentPrice <= threshold) return 1.0; // already below
  if (daysRemaining <= 0 || dailyVol <= 0) return 0;
  const logDist = Math.log(currentPrice / threshold);
  const sigma = dailyVol * Math.sqrt(daysRemaining);
  if (sigma <= 0) return 0;
  return 2 * normalCDF(-logDist / sigma);
}

// ── Resolution ──────────────────────────────────────────────────────────────────

/**
 * Check resolution: did any 1m HIGH >= threshold between entryTime and monthEnd?
 * Returns { isWin, touchedAt } based on the bet direction.
 */
function checkResolution(
  candles: Candle1m[],
  threshold: number,
  direction: 'YES' | 'NO',
): { isWin: boolean; touchedAt?: number } {
  for (const c of candles) {
    if (c.high >= threshold) {
      return {
        isWin: direction === 'YES',
        touchedAt: c.timestamp,
      };
    }
  }
  // Never touched => NO wins
  return { isWin: direction === 'NO' };
}

// ── Threshold Scanning ──────────────────────────────────────────────────────────

/**
 * Find $1000-increment thresholds within 3% of the current price.
 */
function findNearbyThresholds(currentPrice: number): number[] {
  const range = currentPrice * THRESHOLD_RANGE_PCT;
  const low = currentPrice - range;
  const high = currentPrice + range;

  const startThreshold = Math.ceil(low / THRESHOLD_INCREMENT) * THRESHOLD_INCREMENT;
  const thresholds: number[] = [];

  for (let t = startThreshold; t <= high; t += THRESHOLD_INCREMENT) {
    thresholds.push(t);
  }

  return thresholds;
}

// ── Month Boundaries ────────────────────────────────────────────────────────────

/**
 * Get the start and end of a month in UTC.
 * Polymarket monthly markets resolve at 05:00 UTC on the 1st of the next month.
 */
function getMonthBounds(year: number, month: number): { start: number; end: number } {
  const start = Date.UTC(year, month, 1, 0, 0, 0, 0); // 1st at 00:00 UTC
  // End: 05:00 UTC on the 1st of next month (Polymarket resolution)
  const nextMonth = month + 1;
  const end = Date.UTC(year, nextMonth, 1, 5, 0, 0, 0);
  return { start, end };
}

/**
 * Generate months in range as [year, month (0-indexed)] pairs.
 */
function generateMonths(startDate: Date, endDate: Date): Array<{ year: number; month: number; label: string }> {
  const months: Array<{ year: number; month: number; label: string }> = [];
  const cursor = new Date(startDate);
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);

  while (cursor <= endDate) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    const label = `${y}-${String(m + 1).padStart(2, '0')}`;
    months.push({ year: y, month: m, label });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return months;
}

// ── Metrics ─────────────────────────────────────────────────────────────────────

function computeMetrics(bets: ThresholdBet[], capital: number): PeriodMetrics {
  if (bets.length === 0) {
    return {
      trades: 0, wins: 0, winRate: 0, avgWin: 0, avgLoss: 0,
      totalPnl: 0, evPerTrade: 0, avgEntryPrice: 0, avgEdge: 0,
      maxDrawdown: 0, sharpe: 0,
    };
  }

  const wins = bets.filter(b => b.isWin);
  const losses = bets.filter(b => !b.isWin);
  const winRate = wins.length / bets.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, b) => s + b.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, b) => s + b.pnl, 0) / losses.length) : 0;
  const totalPnl = bets.reduce((s, b) => s + b.pnl, 0);
  const evPerTrade = totalPnl / bets.length;
  const avgEntryPrice = bets.reduce((s, b) => s + b.entryPrice, 0) / bets.length;
  const avgEdge = bets.reduce((s, b) => s + b.edge, 0) / bets.length;

  // Max drawdown
  let peak = capital;
  let maxDd = 0;
  let eq = capital;
  for (const b of bets) {
    eq += b.pnl;
    peak = Math.max(peak, eq);
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    maxDd = Math.max(maxDd, dd);
  }

  // Sharpe: group PnL by day, annualized
  const dailyPnlMap = new Map<string, number>();
  for (const b of bets) {
    const dayStr = new Date(b.entryTime).toISOString().slice(0, 10);
    dailyPnlMap.set(dayStr, (dailyPnlMap.get(dayStr) ?? 0) + b.pnl);
  }
  const dailyPnls = [...dailyPnlMap.values()];
  const meanDaily = dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length;
  const stdDaily = dailyPnls.length > 1
    ? Math.sqrt(dailyPnls.reduce((s, v) => s + (v - meanDaily) ** 2, 0) / (dailyPnls.length - 1))
    : 0;
  const sharpe = stdDaily > 0 ? (meanDaily / stdDaily) * Math.sqrt(365) : 0;

  return {
    trades: bets.length, wins: wins.length, winRate, avgWin, avgLoss,
    totalPnl, evPerTrade, avgEntryPrice, avgEdge, maxDrawdown: maxDd, sharpe,
  };
}

// ── Verdict ─────────────────────────────────────────────────────────────────────

function getVerdict(ev: number, sharpe: number, sampleSize: number): string {
  if (sampleSize < 20) return 'INSUFFICIENT DATA';
  if (ev <= 0) return 'NOT VIABLE — negative EV';
  if (sharpe < 0.3) return 'MARGINAL — edge too thin';
  if (sharpe < 0.8) return 'CAUTIOUSLY VIABLE — small edge, needs more validation';
  return 'VIABLE — positive edge confirmed';
}

// ── Print Results ───────────────────────────────────────────────────────────────

function printResults(
  bets: ThresholdBet[],
  capital: number,
  bet: number,
  isCutoffDate: Date,
  startDate: Date,
  endDate: Date,
): void {
  const isBets = bets.filter(b => b.period === 'IS');
  const oosBets = bets.filter(b => b.period === 'OOS');

  const isMetrics = computeMetrics(isBets, capital);
  const oosMetrics = computeMetrics(oosBets, capital);

  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);
  const cutoffStr = isCutoffDate.toISOString().slice(0, 10);
  const verdict = getVerdict(oosMetrics.evPerTrade, oosMetrics.sharpe, oosMetrics.trades);

  const pad = (s: string, len: number) => s.padEnd(len);
  const fmtPct = (n: number) => (n * 100).toFixed(1) + '%';
  const fmtDol = (n: number) => (n >= 0 ? '+' : '') + '$' + n.toFixed(2);

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  STRATEGY C: THRESHOLD SNIPER — BACKTEST RESULTS              ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║  Period: ${startStr} -> ${endStr}  (IS/OOS: ${cutoffStr})`);
  console.log(`║  Capital: $${capital}  |  Bet: $${bet}/trade`);
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║                        IN-SAMPLE     OUT-OF-SAMPLE            ║`);
  console.log(`║  Trades              ${pad(String(isMetrics.trades), 14)}${pad(String(oosMetrics.trades), 14)}║`);
  console.log(`║  Win Rate            ${pad(fmtPct(isMetrics.winRate), 14)}${pad(fmtPct(oosMetrics.winRate), 14)}║`);
  console.log(`║  Avg Win             ${pad(fmtDol(isMetrics.avgWin), 14)}${pad(fmtDol(oosMetrics.avgWin), 14)}║`);
  console.log(`║  Avg Loss            ${pad('-$' + isMetrics.avgLoss.toFixed(2), 14)}${pad('-$' + oosMetrics.avgLoss.toFixed(2), 14)}║`);
  console.log(`║  Total PnL           ${pad(fmtDol(isMetrics.totalPnl), 14)}${pad(fmtDol(oosMetrics.totalPnl), 14)}║`);
  console.log(`║  EV/trade            ${pad(fmtDol(isMetrics.evPerTrade), 14)}${pad(fmtDol(oosMetrics.evPerTrade), 14)}║`);
  console.log(`║  Avg Entry Price     ${pad(isMetrics.avgEntryPrice.toFixed(3), 14)}${pad(oosMetrics.avgEntryPrice.toFixed(3), 14)}║`);
  console.log(`║  Avg Edge at Entry   ${pad(fmtPct(isMetrics.avgEdge), 14)}${pad(fmtPct(oosMetrics.avgEdge), 14)}║`);
  console.log(`║  Max Drawdown        ${pad(fmtPct(isMetrics.maxDrawdown), 14)}${pad(fmtPct(oosMetrics.maxDrawdown), 14)}║`);
  console.log(`║  Sharpe              ${pad(isMetrics.sharpe.toFixed(2), 14)}${pad(oosMetrics.sharpe.toFixed(2), 14)}║`);

  // By threshold distance
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log('║  BY THRESHOLD DISTANCE:                                       ║');
  const distBuckets: DistanceBucket[] = [
    { label: '<1%', trades: bets.filter(b => b.distancePct < 1) },
    { label: '1-2%', trades: bets.filter(b => b.distancePct >= 1 && b.distancePct < 2) },
    { label: '2-3%', trades: bets.filter(b => b.distancePct >= 2) },
  ];
  for (const bucket of distBuckets) {
    const n = bucket.trades.length;
    const wr = n > 0 ? bucket.trades.filter(b => b.isWin).length / n : 0;
    const ev = n > 0 ? bucket.trades.reduce((s, b) => s + b.pnl, 0) / n : 0;
    console.log(`║    ${pad(bucket.label + ':', 8)} ${pad(String(n) + ' trades,', 14)} ${pad(fmtPct(wr) + ' WR,', 12)} ${fmtDol(ev)} EV`);
  }

  // By volatility regime
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log('║  BY VOLATILITY REGIME:                                        ║');
  const volBuckets: VolRegimeBucket[] = [
    { label: 'Calm (ratio<0.8)', trades: bets.filter(b => b.volRegime === 'Calm') },
    { label: 'Normal (0.8-1.2)', trades: bets.filter(b => b.volRegime === 'Normal') },
    { label: 'Volatile (>1.2)', trades: bets.filter(b => b.volRegime === 'Volatile') },
  ];
  for (const bucket of volBuckets) {
    const n = bucket.trades.length;
    const wr = n > 0 ? bucket.trades.filter(b => b.isWin).length / n : 0;
    const ev = n > 0 ? bucket.trades.reduce((s, b) => s + b.pnl, 0) / n : 0;
    console.log(`║    ${pad(bucket.label + ':', 22)} ${pad(String(n) + ' trades,', 14)} ${pad(fmtPct(wr) + ' WR,', 12)} ${fmtDol(ev)} EV`);
  }

  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║  VERDICT: ${pad(verdict, 51)}║`);
  console.log('╚════════════════════════════════════════════════════════════════╝');

  // Per-trade table
  console.log('');
  console.log('  Date       | Thresh  | Dist%  | Dir | Edge%  | Entry  | Result | PnL     | Touch Timing         | Period');
  console.log('  -----------|---------|--------|-----|--------|--------|--------|---------|----------------------|------');
  for (const b of bets) {
    const dateStr = new Date(b.entryTime).toISOString().slice(0, 10);
    const thresh = ('$' + (b.threshold / 1000).toFixed(0) + 'K').padStart(7);
    const dist = b.distancePct.toFixed(1).padStart(5) + '%';
    const dir = b.direction.padEnd(3);
    const edge = (b.edge * 100).toFixed(1).padStart(5) + '%';
    const entry = b.entryPrice.toFixed(3).padStart(6);
    const result = b.isWin ? ' WIN ' : ' LOSS';
    const pnl = (b.pnl >= 0 ? '+' : '') + b.pnl.toFixed(2);
    const touch = b.touchedAt
      ? new Date(b.touchedAt).toISOString().slice(0, 16).replace('T', ' ')
      : 'never touched     ';
    console.log(`  ${dateStr} | ${thresh} | ${dist} | ${dir} | ${edge} | ${entry} | ${result} | ${pnl.padStart(7)} | ${touch} | ${b.period}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Date range
  const endDate = new Date();
  endDate.setUTCHours(0, 0, 0, 0);

  const startDate = new Date(endDate);
  startDate.setMonth(startDate.getMonth() - MONTHS);

  // Need 35 extra days for volatility warmup (30-day rolling vol + buffer)
  const fetchStart = new Date(startDate);
  fetchStart.setDate(fetchStart.getDate() - 35);

  console.log(`=== Strategy C: Threshold Sniper Backtest ===`);
  console.log(`Period: ${startDate.toISOString().slice(0, 10)} -> ${endDate.toISOString().slice(0, 10)}`);
  console.log(`Warmup from: ${fetchStart.toISOString().slice(0, 10)}`);
  console.log(`Capital: $${CAPITAL}, Bet: $${BET}/trade`);
  console.log(`Check interval: every ${CHECK_INTERVAL_H}h | Max open positions: ${MAX_OPEN_POSITIONS}`);
  console.log(`Min edge: ${(MIN_EDGE * 100).toFixed(0)}% | Prob range: [${(MIN_PROB * 100).toFixed(0)}%, ${(MAX_PROB * 100).toFixed(0)}%]`);
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

  // Generate months in range
  const months = generateMonths(startDate, endDate);
  console.log(`Months to simulate: ${months.length} (${months[0]?.label} -> ${months[months.length - 1]?.label})`);
  console.log('');

  // ── Backtest Loop ─────────────────────────────────────────────────────────

  const allBets: ThresholdBet[] = [];
  const openPositions: ThresholdBet[] = [];

  // Track which thresholds already have bets per month (no double-betting)
  const betTracker = new Map<string, Set<number>>(); // "YYYY-MM" -> Set of thresholds

  for (const monthInfo of months) {
    const { year, month, label } = monthInfo;
    const { start: monthStart, end: monthEnd } = getMonthBounds(year, month);

    // Skip if month is entirely before our start date
    if (monthEnd < startDate.getTime()) continue;
    // Skip if month starts after our end date
    if (monthStart > endDate.getTime()) continue;

    if (!betTracker.has(label)) {
      betTracker.set(label, new Set());
    }
    const monthBets = betTracker.get(label)!;

    // Generate check times: every 6h starting from month start
    const checkStart = Math.max(monthStart, startDate.getTime());
    const checkEnd = Math.min(monthEnd, endDate.getTime());

    for (let checkTime = checkStart; checkTime < checkEnd; checkTime += CHECK_INTERVAL_H * ONE_HOUR_MS) {
      // Skip if past last day of month (the actual last day, not resolution day)
      const lastDayOfMonth = Date.UTC(year, month + 1, 0, 23, 59, 59, 999);
      if (checkTime > lastDayOfMonth) continue;

      // Count currently open positions for this month
      const openForMonth = openPositions.filter(p => p.month === label && !p.resolved);
      if (openForMonth.length >= MAX_OPEN_POSITIONS) continue;

      // Get current price
      const currentPrice = getPriceAtTime(candleMap, checkTime);
      if (!currentPrice) continue;

      // Days remaining until month end resolution
      const daysRemaining = (monthEnd - checkTime) / ONE_DAY_MS;
      if (daysRemaining < 0.5) continue; // skip if less than 12h to resolution

      // ── Volatility calculation (NO LOOK-AHEAD) ──
      // Find daily closes before checkTime
      const checkDateStr = new Date(checkTime).toISOString().slice(0, 10);
      const checkDateIdx = dailyCloses.findIndex(d => d.date >= checkDateStr);
      const closesBeforeCheck = checkDateIdx > 0
        ? dailyCloses.slice(0, checkDateIdx).map(d => d.close)
        : dailyCloses.filter(d => d.date < checkDateStr).map(d => d.close);

      // Need sufficient data: 8 for 7-day vol, 31 for 30-day vol
      if (closesBeforeCheck.length < 31) continue;

      const vol7d = rollingDailyVolatility(closesBeforeCheck, 7);
      const vol30d = rollingDailyVolatility(closesBeforeCheck, 30);

      if (vol7d <= 0 || vol30d <= 0) continue;

      const volRatio = vol7d / vol30d;

      // Determine vol regime
      let volRegime: 'Calm' | 'Normal' | 'Volatile';
      let adjustedVol: number;

      if (volRatio < 0.8) {
        // Calm period: use long-term vol (mean reversion expected)
        volRegime = 'Calm';
        adjustedVol = vol30d;
      } else if (volRatio > 1.2) {
        // Volatile period: use short-term vol (regime shift)
        volRegime = 'Volatile';
        adjustedVol = vol7d;
      } else {
        // Normal: blend
        volRegime = 'Normal';
        adjustedVol = (vol7d + vol30d) / 2;
      }

      // ── Scan thresholds ──
      const thresholds = findNearbyThresholds(currentPrice);
      let betsThisCheck = 0;

      for (const threshold of thresholds) {
        if (betsThisCheck >= MAX_BETS_PER_CHECK) break;
        if (monthBets.has(threshold)) continue; // already bet this threshold this month

        const distancePct = Math.abs(threshold - currentPrice) / currentPrice * 100;

        // Our model probability (vol-adjusted)
        const ourProb = probTouchAbove(currentPrice, threshold, adjustedVol, daysRemaining);

        // Market's implied probability (uses long-term vol — what the "average" market participant would estimate)
        const marketProb = probTouchAbove(currentPrice, threshold, vol30d, daysRemaining);

        // Edge: the difference between our probability and the market's
        const edge = ourProb - marketProb;

        // Check YES side (buy "Above $X" YES token)
        if (edge >= MIN_EDGE && ourProb >= MIN_PROB && ourProb <= MAX_PROB) {
          // Check open position limits
          if (openPositions.filter(p => p.month === label && !p.resolved).length >= MAX_OPEN_POSITIONS) break;

          const entryPrice = Math.min(Math.max(marketProb + 0.01, 0.05), 0.95); // spread
          const pnlIfWin = BET * (1 - entryPrice) / entryPrice;
          const pnlIfLoss = -BET;

          const betObj: ThresholdBet = {
            month: label,
            threshold,
            direction: 'YES',
            entryTime: checkTime,
            entryPrice: Math.round(entryPrice * 1000) / 1000,
            edge: Math.round(edge * 1000) / 1000,
            distancePct: Math.round(distancePct * 10) / 10,
            volRegime,
            currentPriceAtEntry: currentPrice,
            resolved: false,
            isWin: false,
            pnl: 0,
            period: new Date(checkTime) < isCutoffDate ? 'IS' : 'OOS',
          };

          openPositions.push(betObj);
          allBets.push(betObj);
          monthBets.add(threshold);
          betsThisCheck++;
          continue;
        }

        // Check NO side (buy "Above $X" NO token = betting it won't touch)
        // This is edge < -MIN_EDGE, meaning market OVERESTIMATES probability of touching
        const noEdge = -edge; // (1 - ourProb) - (1 - marketProb)
        const noProb = 1 - ourProb;
        const noMarketProb = 1 - marketProb;

        if (noEdge >= MIN_EDGE && noProb >= MIN_PROB && noProb <= MAX_PROB) {
          if (openPositions.filter(p => p.month === label && !p.resolved).length >= MAX_OPEN_POSITIONS) break;

          const entryPrice = Math.min(Math.max(noMarketProb + 0.01, 0.05), 0.95);

          const betObj: ThresholdBet = {
            month: label,
            threshold,
            direction: 'NO',
            entryTime: checkTime,
            entryPrice: Math.round(entryPrice * 1000) / 1000,
            edge: Math.round(noEdge * 1000) / 1000,
            distancePct: Math.round(distancePct * 10) / 10,
            volRegime,
            currentPriceAtEntry: currentPrice,
            resolved: false,
            isWin: false,
            pnl: 0,
            period: new Date(checkTime) < isCutoffDate ? 'IS' : 'OOS',
          };

          openPositions.push(betObj);
          allBets.push(betObj);
          monthBets.add(threshold);
          betsThisCheck++;
        }
      }
    }

    // ── Resolve all bets for this month ──
    // Check all 1m candle HIGHs from each bet's entry time to month end
    const monthCandles = candles.filter(c => c.timestamp >= monthStart && c.timestamp <= monthEnd);

    for (const bet of openPositions) {
      if (bet.resolved) continue;
      if (bet.month !== label) continue;

      // Get candles from entry to month end
      const relevantCandles = monthCandles.filter(c => c.timestamp >= bet.entryTime);

      const resolution = checkResolution(relevantCandles, bet.threshold, bet.direction);
      bet.resolved = true;
      bet.isWin = resolution.isWin;
      bet.touchedAt = resolution.touchedAt;

      // PnL: binary payoff
      bet.pnl = bet.isWin
        ? Math.round(BET * (1 - bet.entryPrice) / bet.entryPrice * 100) / 100
        : -BET;
    }

    // Progress
    const monthBetCount = allBets.filter(b => b.month === label).length;
    if (monthBetCount > 0) {
      console.log(`  ${label}: ${monthBetCount} bets placed`);
    }
  }

  // ── Resolve any remaining open positions ──
  for (const bet of openPositions) {
    if (bet.resolved) continue;
    // This shouldn't happen normally, but handle gracefully
    bet.resolved = true;
    bet.isWin = bet.direction === 'NO'; // if unresolved, assume NO wins (never touched)
    bet.pnl = bet.isWin
      ? Math.round(BET * (1 - bet.entryPrice) / bet.entryPrice * 100) / 100
      : -BET;
  }

  // Sort by entry time
  allBets.sort((a, b) => a.entryTime - b.entryTime);

  console.log('');
  console.log(`Total bets: ${allBets.length}`);

  // Print results
  printResults(allBets, CAPITAL, BET, isCutoffDate, startDate, endDate);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
