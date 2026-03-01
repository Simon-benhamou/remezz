/**
 * backtest-polymarket-daily.ts — Strategy A: Daily BTC Up/Down on Polymarket
 *
 * Multi-timeframe momentum signal for daily BTC prediction markets.
 * Resolution: Binance BTC/USDT 1m candle close at noon ET (17:00 UTC winter, 16:00 UTC summer)
 * day D vs day D-1. If noon D close > noon D-1 close -> "Up" wins.
 *
 * Usage:
 *   npx tsx backend/scripts/backtest-polymarket-daily.ts [--months 6] [--bet 3] [--capital 50]
 */

import {
  fetchCandles1m,
  noonEtToUtcMs,
  estimateClobPrice,
  rollingDailyVolatility,
  getDailyCloses,
  getPriceAtTime,
  type Candle1m,
  type DailyClose,
} from './lib/polymarket-bt-utils.js';

// ── CLI ────────────────────────────────────────────────────────────────────────

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
const DECISION_HOURS = [6, 12, 18]; // test all three entry timings

// ── Types ──────────────────────────────────────────────────────────────────────

interface Candle1h {
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  timestamp: number;
}

interface DailySignal {
  direction: 'UP' | 'DOWN';
  confidence: number;
  skip: boolean;
}

interface TradeResult {
  date: string;
  decisionHours: number;
  direction: 'UP' | 'DOWN';
  confidence: number;
  groundTruth: 'UP' | 'DOWN';
  isCorrect: boolean;
  entryPrice: number;
  pnl: number;
  equity: number;
  noonOpen: number;
  noonClose: number;
  currentPrice: number;
  period: 'IS' | 'OOS';
}

interface TradingDay {
  today: string;    // "YYYY-MM-DD"
  yesterday: string; // "YYYY-MM-DD"
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Aggregate 1m candles into 1h candles for the given time range.
 * Only includes candles with timestamp <= endMs (no look-ahead).
 */
function aggregate1mTo1h(
  candleMap: Map<number, Candle1m>,
  startMs: number,
  endMs: number,
): Candle1h[] {
  const ONE_HOUR_MS = 3600_000;
  const ONE_MINUTE_MS = 60_000;

  // Align start to hour boundary (floor)
  const alignedStart = Math.floor(startMs / ONE_HOUR_MS) * ONE_HOUR_MS;

  const hourlyCandles: Candle1h[] = [];

  for (let hourStart = alignedStart; hourStart < endMs; hourStart += ONE_HOUR_MS) {
    let open: number | null = null;
    let close: number | null = null;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    let count = 0;

    for (let minTs = hourStart; minTs < hourStart + ONE_HOUR_MS; minTs += ONE_MINUTE_MS) {
      if (minTs > endMs) break; // no look-ahead
      const c = candleMap.get(minTs);
      if (!c) continue;
      if (open === null) open = c.open;
      close = c.close;
      high = Math.max(high, c.high);
      low = Math.min(low, c.low);
      volume += c.volume;
      count++;
    }

    if (count > 0 && open !== null && close !== null) {
      hourlyCandles.push({
        open,
        close,
        high,
        low,
        volume,
        timestamp: hourStart,
      });
    }
  }

  return hourlyCandles;
}

/**
 * Generate all trading days (crypto = every day) as {today, yesterday} pairs.
 */
function generateTradingDays(startDate: Date, endDate: Date): TradingDay[] {
  const days: TradingDay[] = [];
  const ONE_DAY_MS = 86_400_000;

  const start = new Date(startDate);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(endDate);
  end.setUTCHours(0, 0, 0, 0);

  for (let ts = start.getTime(); ts <= end.getTime(); ts += ONE_DAY_MS) {
    const today = new Date(ts).toISOString().slice(0, 10);
    const yesterday = new Date(ts - ONE_DAY_MS).toISOString().slice(0, 10);
    days.push({ today, yesterday });
  }

  return days;
}

/**
 * Compute the 4-component daily signal.
 *
 * CRITICAL: Only uses candles with timestamp <= decisionTimeMs (no look-ahead).
 */
function computeDailySignal(
  candleMap: Map<number, Candle1m>,
  dailyCloses: DailyClose[],
  noonYesterdayMs: number,
  decisionTimeMs: number,
  currentPrice: number,
  noonOpenPrice: number,
  todayDateStr: string,
): DailySignal {
  const SKIP: DailySignal = { direction: 'UP', confidence: 0, skip: true };

  // ── Component 1: Intraday Momentum (weight 40) ──
  const roc = (currentPrice - noonOpenPrice) / noonOpenPrice;
  const absRoc = Math.abs(roc);
  let momentumScore = 0;
  if (absRoc >= 0.02) momentumScore = 40;
  else if (absRoc >= 0.01) momentumScore = 30;
  else if (absRoc >= 0.005) momentumScore = 20;
  else if (absRoc >= 0.002) momentumScore = 10;
  const momentumDirection: 'UP' | 'DOWN' = roc > 0 ? 'UP' : 'DOWN';

  // ── Component 2: 1h Trend Alignment (weight 30) ──
  const hourlyCandles = aggregate1mTo1h(
    candleMap,
    decisionTimeMs - 4 * 3600_000,
    decisionTimeMs,
  );
  const bullishCount = hourlyCandles.filter(c => c.close > c.open).length;
  let trendScore = 0;
  let trendDirection: 'UP' | 'DOWN' | null = null;

  if (bullishCount >= 4) { trendScore = 30; trendDirection = 'UP'; }
  else if (bullishCount >= 3) { trendScore = 20; trendDirection = 'UP'; }
  else if (bullishCount === 0) { trendScore = 30; trendDirection = 'DOWN'; }
  else if (bullishCount <= 1) { trendScore = 20; trendDirection = 'DOWN'; }
  // bullishCount === 2 → mixed → trendScore = 0, trendDirection = null

  // If momentum and trend disagree, skip (too risky)
  if (trendDirection !== null && momentumDirection !== trendDirection) {
    return SKIP;
  }

  // ── Component 3: Volume Confirmation (weight 15) ──
  const ONE_MINUTE_MS = 60_000;
  const FOUR_HOURS_MS = 4 * 3600_000;

  // Recent 4h volume
  let recent4hVol = 0;
  for (let ts = decisionTimeMs - FOUR_HOURS_MS; ts < decisionTimeMs; ts += ONE_MINUTE_MS) {
    const aligned = Math.floor(ts / ONE_MINUTE_MS) * ONE_MINUTE_MS;
    const c = candleMap.get(aligned);
    if (c) recent4hVol += c.volume;
  }

  // Average same 4h window over past 7 days
  let totalHistVol = 0;
  let histDayCount = 0;
  for (let d = 1; d <= 7; d++) {
    const dayOffset = d * 86_400_000;
    let dayVol = 0;
    let hasData = false;
    for (let ts = decisionTimeMs - FOUR_HOURS_MS - dayOffset; ts < decisionTimeMs - dayOffset; ts += ONE_MINUTE_MS) {
      const aligned = Math.floor(ts / ONE_MINUTE_MS) * ONE_MINUTE_MS;
      const c = candleMap.get(aligned);
      if (c) { dayVol += c.volume; hasData = true; }
    }
    if (hasData) {
      totalHistVol += dayVol;
      histDayCount++;
    }
  }

  const avg4hVol = histDayCount > 0 ? totalHistVol / histDayCount : 0;
  let volumeScore = 0;
  if (avg4hVol > 0) {
    const volRatio = recent4hVol / avg4hVol;
    if (volRatio >= 1.5) volumeScore = 15;
    else if (volRatio >= 1.2) volumeScore = 10;
    else if (volRatio >= 0.8) volumeScore = 5;
  }

  // ── Component 4: Daily Regime (weight 15) ──
  // Need at least 25 daily closes before today for SMA20 + 5 for slope
  const todayIdx = dailyCloses.findIndex(d => d.date === todayDateStr);
  let regimeScore = 0;
  let regimeDirection: 'UP' | 'DOWN' | null = null;

  if (todayIdx >= 25) {
    // Only closes BEFORE today (no look-ahead)
    const closesBeforeToday = dailyCloses.slice(0, todayIdx).map(d => d.close);

    // SMA20 of most recent 20
    const last20 = closesBeforeToday.slice(-20);
    const sma20 = last20.reduce((s, v) => s + v, 0) / last20.length;

    // SMA20 from 5 days ago
    const last20_5dAgo = closesBeforeToday.slice(-25, -5);
    if (last20_5dAgo.length >= 20) {
      const sma20_5dAgo = last20_5dAgo.reduce((s, v) => s + v, 0) / last20_5dAgo.length;
      const smaSlope = (sma20 - sma20_5dAgo) / sma20_5dAgo;

      if (smaSlope > 0.003) { regimeScore = 15; regimeDirection = 'UP'; }
      else if (smaSlope < -0.003) { regimeScore = 15; regimeDirection = 'DOWN'; }
    }
  }

  // ── Composite Signal ──
  const totalScore = momentumScore + trendScore + volumeScore + regimeScore;

  // Direction: majority vote of non-null directions
  const directions: ('UP' | 'DOWN')[] = [momentumDirection];
  if (trendDirection) directions.push(trendDirection);
  if (regimeDirection) directions.push(regimeDirection);

  const upVotes = directions.filter(d => d === 'UP').length;
  const downVotes = directions.filter(d => d === 'DOWN').length;

  let direction: 'UP' | 'DOWN' | null = null;
  if (upVotes > downVotes) direction = 'UP';
  else if (downVotes > upVotes) direction = 'DOWN';
  // Tied → skip

  if (!direction) return SKIP;
  if (totalScore < 60) return SKIP;

  return { direction, confidence: totalScore, skip: false };
}

// ── Metrics ────────────────────────────────────────────────────────────────────

interface PeriodMetrics {
  trades: number;
  wins: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  totalPnl: number;
  evPerTrade: number;
  breakevenWr: number;
  maxConsecLoss: number;
  maxDrawdown: number;
  sharpe: number;
  kellyFraction: number;
}

function computeMetrics(results: TradeResult[], capital: number): PeriodMetrics {
  if (results.length === 0) {
    return {
      trades: 0, wins: 0, winRate: 0, avgWin: 0, avgLoss: 0,
      totalPnl: 0, evPerTrade: 0, breakevenWr: 0, maxConsecLoss: 0,
      maxDrawdown: 0, sharpe: 0, kellyFraction: 0,
    };
  }

  const wins = results.filter(r => r.isCorrect);
  const losses = results.filter(r => !r.isCorrect);
  const winRate = wins.length / results.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, r) => s + r.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, r) => s + r.pnl, 0) / losses.length) : 0;
  const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
  const evPerTrade = totalPnl / results.length;

  // Breakeven win rate: avgLoss / (avgWin + avgLoss)
  const breakevenWr = (avgWin + avgLoss) > 0 ? avgLoss / (avgWin + avgLoss) : 0.5;

  // Max consecutive losses
  let maxConsecLoss = 0;
  let currentConsec = 0;
  for (const r of results) {
    if (!r.isCorrect) {
      currentConsec++;
      maxConsecLoss = Math.max(maxConsecLoss, currentConsec);
    } else {
      currentConsec = 0;
    }
  }

  // Max drawdown
  let peak = capital;
  let maxDd = 0;
  let eq = capital;
  for (const r of results) {
    eq += r.pnl;
    peak = Math.max(peak, eq);
    const dd = (peak - eq) / peak;
    maxDd = Math.max(maxDd, dd);
  }

  // Sharpe: daily PnL std dev, annualized sqrt(365)
  // Group by date for daily PnL
  const dailyPnlMap = new Map<string, number>();
  for (const r of results) {
    dailyPnlMap.set(r.date, (dailyPnlMap.get(r.date) ?? 0) + r.pnl);
  }
  const dailyPnls = [...dailyPnlMap.values()];
  const meanDaily = dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length;
  const stdDaily = dailyPnls.length > 1
    ? Math.sqrt(dailyPnls.reduce((s, v) => s + (v - meanDaily) ** 2, 0) / (dailyPnls.length - 1))
    : 0;
  const sharpe = stdDaily > 0 ? (meanDaily / stdDaily) * Math.sqrt(365) : 0;

  // Kelly fraction: f* = (p * b - q) / b where p = win rate, q = 1-p, b = avgWin/avgLoss
  const b = avgLoss > 0 ? avgWin / avgLoss : 0;
  const kellyFraction = b > 0 ? (winRate * b - (1 - winRate)) / b : 0;

  return {
    trades: results.length,
    wins: wins.length,
    winRate,
    avgWin,
    avgLoss,
    totalPnl,
    evPerTrade,
    breakevenWr,
    maxConsecLoss,
    maxDrawdown: maxDd,
    sharpe,
    kellyFraction,
  };
}

// ── Verdict ────────────────────────────────────────────────────────────────────

function getVerdict(ev: number, sharpe: number, sampleSize: number): string {
  if (sampleSize < 20) return 'INSUFFICIENT DATA';
  if (ev <= 0) return 'NOT VIABLE — negative EV';
  if (sharpe < 0.3) return 'MARGINAL — edge too thin';
  if (sharpe < 0.8) return 'CAUTIOUSLY VIABLE — small edge, needs more validation';
  return 'VIABLE — positive edge confirmed';
}

// ── Print Results ──────────────────────────────────────────────────────────────

function printResults(
  decisionHours: number,
  results: TradeResult[],
  capital: number,
  bet: number,
  isCutoffDate: Date,
): void {
  const isResults = results.filter(r => r.period === 'IS');
  const oosResults = results.filter(r => r.period === 'OOS');

  const isMetrics = computeMetrics(isResults, capital);
  const oosMetrics = computeMetrics(oosResults, capital);

  const startDate = results.length > 0 ? results[0].date : 'N/A';
  const endDate = results.length > 0 ? results[results.length - 1].date : 'N/A';
  const cutoffStr = isCutoffDate.toISOString().slice(0, 10);
  const verdict = getVerdict(oosMetrics.evPerTrade, oosMetrics.sharpe, oosMetrics.trades);

  const pad = (s: string, len: number) => s.padEnd(len);
  const fmtPct = (n: number) => (n * 100).toFixed(1) + '%';
  const fmtDol = (n: number) => (n >= 0 ? '+' : '') + '$' + n.toFixed(2);

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════════╗');
  console.log(`║  STRATEGY A: DAILY BTC UP/DOWN — DECISION AT T+${decisionHours}h${' '.repeat(Math.max(0, 21 - `T+${decisionHours}h`.length))}║`);
  console.log('╠════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Period: ${startDate} -> ${endDate}  (IS/OOS split: ${cutoffStr})${' '.repeat(Math.max(0, 16 - cutoffStr.length))}║`);
  console.log(`║  Capital: $${capital}  |  Bet: $${bet}/trade${' '.repeat(Math.max(0, 40 - `Capital: $${capital}  |  Bet: $${bet}/trade`.length))}║`);
  console.log('╠════════════════════════════════════════════════════════════════════════╣');
  console.log(`║                          IN-SAMPLE        OUT-OF-SAMPLE               ║`);
  console.log(`║  Trades               ${pad(String(isMetrics.trades), 18)}${pad(String(oosMetrics.trades), 16)}║`);
  console.log(`║  Win Rate             ${pad(fmtPct(isMetrics.winRate), 18)}${pad(fmtPct(oosMetrics.winRate), 16)}║`);
  console.log(`║  Avg Win              ${pad(fmtDol(isMetrics.avgWin), 18)}${pad(fmtDol(oosMetrics.avgWin), 16)}║`);
  console.log(`║  Avg Loss             ${pad('-$' + isMetrics.avgLoss.toFixed(2), 18)}${pad('-$' + oosMetrics.avgLoss.toFixed(2), 16)}║`);
  console.log(`║  Total PnL            ${pad(fmtDol(isMetrics.totalPnl), 18)}${pad(fmtDol(oosMetrics.totalPnl), 16)}║`);
  console.log(`║  EV/trade             ${pad(fmtDol(isMetrics.evPerTrade), 18)}${pad(fmtDol(oosMetrics.evPerTrade), 16)}║`);
  console.log(`║  Breakeven WR         ${pad(fmtPct(isMetrics.breakevenWr), 18)}${pad(fmtPct(oosMetrics.breakevenWr), 16)}║`);
  console.log(`║  Max Consec Loss      ${pad(String(isMetrics.maxConsecLoss), 18)}${pad(String(oosMetrics.maxConsecLoss), 16)}║`);
  console.log(`║  Max Drawdown         ${pad(fmtPct(isMetrics.maxDrawdown), 18)}${pad(fmtPct(oosMetrics.maxDrawdown), 16)}║`);
  console.log(`║  Sharpe (daily)       ${pad(isMetrics.sharpe.toFixed(2), 18)}${pad(oosMetrics.sharpe.toFixed(2), 16)}║`);
  console.log(`║  Kelly Fraction       ${pad(fmtPct(isMetrics.kellyFraction), 18)}${pad(fmtPct(oosMetrics.kellyFraction), 16)}║`);
  console.log('╠════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  VERDICT: ${pad(verdict, 61)}║`);
  console.log('╚════════════════════════════════════════════════════════════════════════╝');

  // Per-trade table
  console.log('');
  console.log('  Date        | Dir  | Conf | Entry  | Truth | Result | PnL     | Equity   | Period');
  console.log('  --------------|------|------|--------|-------|--------|---------|----------|------');
  for (const r of results) {
    const dir = r.direction.padEnd(4);
    const conf = String(r.confidence).padStart(4);
    const entry = r.entryPrice.toFixed(3).padStart(6);
    const truth = r.groundTruth.padEnd(5);
    const result = r.isCorrect ? ' WIN ' : ' LOSS';
    const pnl = (r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2);
    const equity = r.equity.toFixed(2);
    console.log(`  ${r.date} | ${dir} | ${conf} | ${entry} | ${truth} | ${result} | ${pnl.padStart(7)} | ${equity.padStart(8)} | ${r.period}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Date range
  const endDate = new Date();
  endDate.setUTCHours(0, 0, 0, 0);

  const startDate = new Date(endDate);
  startDate.setMonth(startDate.getMonth() - MONTHS);

  // Need 35 extra days for volatility warmup (30-day rolling + SMA20 + 5-day slope)
  const fetchStart = new Date(startDate);
  fetchStart.setDate(fetchStart.getDate() - 35);

  console.log(`=== Strategy A: Daily BTC Up/Down Backtest ===`);
  console.log(`Period: ${startDate.toISOString().slice(0, 10)} -> ${endDate.toISOString().slice(0, 10)}`);
  console.log(`Warmup from: ${fetchStart.toISOString().slice(0, 10)}`);
  console.log(`Capital: $${CAPITAL}, Bet: $${BET}/trade`);
  console.log(`Decision hours tested: T+${DECISION_HOURS.join('h, T+')}h`);
  console.log('');

  // Fetch ALL 1m candles for the full range
  console.log(`Fetching ${MONTHS + 2} months of BTC 1m candles from Binance...`);
  const candles = await fetchCandles1m('BTCUSDT', fetchStart.getTime(), endDate.getTime());
  console.log(`Fetched ${candles.length.toLocaleString()} candles`);

  // Build map for O(1) lookup
  const candleMap = new Map<number, Candle1m>(candles.map(c => [c.timestamp, c]));

  // Get daily closes for volatility and regime (using 17:00 UTC default)
  const dailyCloses = getDailyCloses(candleMap, fetchStart.getTime(), endDate.getTime());
  console.log(`Daily closes extracted: ${dailyCloses.length}`);

  // Walk-forward split: first 2/3 = in-sample, last 1/3 = out-of-sample
  const isCutoffDate = new Date(startDate);
  isCutoffDate.setMonth(isCutoffDate.getMonth() + Math.floor(MONTHS * 2 / 3));

  console.log(`IS/OOS cutoff: ${isCutoffDate.toISOString().slice(0, 10)}`);

  // Generate all trading days
  const tradingDays = generateTradingDays(startDate, endDate);
  console.log(`Trading days: ${tradingDays.length}`);

  // For each decision_hours config, run the full backtest
  for (const decisionHours of DECISION_HOURS) {
    const results: TradeResult[] = [];
    let equity = CAPITAL;

    for (const day of tradingDays) {
      const noonYesterday = noonEtToUtcMs(day.yesterday); // noon ET day D-1
      const noonToday = noonEtToUtcMs(day.today);         // noon ET day D

      // Ground truth: noon-to-noon Binance 1m close comparison
      const openPrice = getPriceAtTime(candleMap, noonYesterday);
      const closePrice = getPriceAtTime(candleMap, noonToday);
      if (!openPrice || !closePrice) continue; // missing data
      const groundTruth: 'UP' | 'DOWN' = closePrice > openPrice ? 'UP' : 'DOWN';

      // Decision time = noon yesterday + decisionHours
      const decisionTimeMs = noonYesterday + decisionHours * 3600_000;
      const currentPrice = getPriceAtTime(candleMap, decisionTimeMs);
      if (!currentPrice) continue;

      // Compute signal (ONLY using data <= decisionTimeMs)
      const signal = computeDailySignal(
        candleMap,
        dailyCloses,
        noonYesterday,
        decisionTimeMs,
        currentPrice,
        openPrice,
        day.today,
      );
      if (signal.skip) continue;

      // Estimate CLOB entry price using Black-Scholes binary option model
      const currentReturn = Math.log(currentPrice / openPrice);
      const remainingHours = (noonToday - decisionTimeMs) / 3_600_000;
      const remainingFraction = remainingHours / 24;

      // Get rolling 30-day volatility (using closes BEFORE today only)
      const dayIndex = dailyCloses.findIndex(d => d.date === day.today);
      const volWindow = dayIndex > 0
        ? dailyCloses.slice(Math.max(0, dayIndex - 31), dayIndex).map(d => d.close)
        : [];
      const dailyVol = rollingDailyVolatility(volWindow, 30) || 0.02; // fallback 2%

      const fairUpPrice = estimateClobPrice(
        currentReturn,
        dailyVol,
        Math.max(remainingFraction, 0.01),
      );

      // Entry price for the token we are buying (with 0.005 spread)
      let entryPrice: number;
      if (signal.direction === 'UP') {
        entryPrice = Math.min(fairUpPrice + 0.005, 0.95); // buy Up token + spread
      } else {
        entryPrice = Math.min((1 - fairUpPrice) + 0.005, 0.95); // buy Down token + spread
      }
      entryPrice = Math.max(entryPrice, 0.10); // minimum realistic price

      // PnL calculation (binary option payoff)
      const isCorrect = signal.direction === groundTruth;
      const pnl = isCorrect
        ? BET * (1 - entryPrice) / entryPrice  // win: tokens pay $1 each
        : -BET;                                  // loss: tokens worth $0

      equity += pnl;

      results.push({
        date: day.today,
        decisionHours,
        direction: signal.direction,
        confidence: signal.confidence,
        groundTruth,
        isCorrect,
        entryPrice: Math.round(entryPrice * 1000) / 1000,
        pnl: Math.round(pnl * 100) / 100,
        equity: Math.round(equity * 100) / 100,
        noonOpen: Math.round(openPrice * 100) / 100,
        noonClose: Math.round(closePrice * 100) / 100,
        currentPrice: Math.round(currentPrice * 100) / 100,
        period: new Date(noonToday) < isCutoffDate ? 'IS' : 'OOS',
      });
    }

    printResults(decisionHours, results, CAPITAL, BET, isCutoffDate);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
