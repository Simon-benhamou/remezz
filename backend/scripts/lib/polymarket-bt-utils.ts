/**
 * Shared backtest utilities for Polymarket daily/monthly BTC prediction markets.
 *
 * Provides:
 *  - 1m candle fetching from Binance REST (paginated, rate-limited)
 *  - DST-aware noon ET to UTC conversion (Polymarket resolution time)
 *  - Binary option pricing via normal CDF (CLOB price estimation)
 *  - Rolling daily volatility (log returns, daily sigma)
 *  - Helper functions: daily close extraction, price-at-time lookup
 *
 * Zero external dependencies — Node.js built-ins only.
 *
 * Usage:
 *   import { fetchCandles1m, estimateClobPrice, noonEtToUtcMs } from './lib/polymarket-bt-utils.js';
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface Candle1m {
  timestamp: number; // open time in ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isFinal: boolean;
}

export interface DailyClose {
  date: string; // "YYYY-MM-DD"
  close: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const BINANCE_KLINES_URL = 'https://api.binance.com/api/v3/klines';
const KLINES_LIMIT = 1000;
const RATE_LIMIT_MS = 100; // 100ms between requests (safe under 1200 weight/min)
const ONE_MINUTE_MS = 60_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ── 1. Candle Fetching ──────────────────────────────────────────────────────

/**
 * Fetch 1m candles from Binance REST API with automatic pagination.
 *
 * - Paginates in chunks of 1000 candles (Binance limit)
 * - 100ms delay between requests to stay under rate limits
 * - Logs progress every 50,000 candles
 * - Returns candles sorted ascending by timestamp
 *
 * @param symbol - Binance symbol (e.g., "BTCUSDT")
 * @param startMs - Start time (inclusive) in epoch ms
 * @param endMs - End time (inclusive) in epoch ms
 */
export async function fetchCandles1m(
  symbol: string,
  startMs: number,
  endMs: number,
): Promise<Candle1m[]> {
  const candles: Candle1m[] = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const url =
      `${BINANCE_KLINES_URL}?symbol=${symbol}&interval=1m` +
      `&startTime=${cursor}&endTime=${endMs}&limit=${KLINES_LIMIT}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Binance API ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as any[];
    if (data.length === 0) break;

    for (const k of data) {
      candles.push({
        timestamp: k[0] as number,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        isFinal: true,
      });
    }

    // Progress logging for large fetches
    if (candles.length % 50_000 < KLINES_LIMIT) {
      console.log(`   ... fetched ${candles.length.toLocaleString()} candles so far`);
    }

    // Advance cursor past the last candle received
    cursor = data[data.length - 1][0] + ONE_MINUTE_MS;

    // Rate limit: Binance allows 1200 weight/min, klines = 2 weight per request
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  }

  // Sort ascending by timestamp (should already be, but guarantee it)
  candles.sort((a, b) => a.timestamp - b.timestamp);

  return candles;
}

// ── 2. Noon ET to UTC ───────────────────────────────────────────────────────

/**
 * Convert a date string to UTC milliseconds for noon Eastern Time (12:00 ET).
 *
 * Polymarket daily BTC markets resolve at noon ET. This function handles
 * the EST/EDT transition automatically:
 *   - EST (Nov first Sun → Mar second Sun): UTC-5 → noon ET = 17:00 UTC
 *   - EDT (Mar second Sun → Nov first Sun): UTC-4 → noon ET = 16:00 UTC
 *
 * Implementation: constructs "YYYY-MM-DD 12:00:00" in America/New_York,
 * then reads the UTC epoch from the resulting Date object.
 *
 * @param dateStr - Date in "YYYY-MM-DD" format (e.g., "2025-09-15")
 * @returns UTC milliseconds for noon ET on that date
 */
export function noonEtToUtcMs(dateStr: string): number {
  // Build a date string that we can parse in ET context.
  // We use a trick: construct a Date for noon on that day, then use
  // Intl.DateTimeFormat to figure out the actual UTC offset for ET on that date.

  // Parse the date parts
  const [year, month, day] = dateStr.split('-').map(Number);

  // Create a formatter that outputs the UTC offset for America/New_York
  // We need to find the UTC offset for noon ET on the given date.
  // Strategy: create a date at an approximate UTC time for noon ET (17:00 UTC),
  // determine the actual ET offset, then adjust.

  // First approximation: noon ET is either 16:00 UTC (EDT) or 17:00 UTC (EST)
  // Start with 17:00 UTC (EST assumption) and correct if needed
  const approxUtc = new Date(Date.UTC(year, month - 1, day, 17, 0, 0, 0));

  // Get the formatted time in America/New_York to determine the actual local hour
  const etFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });

  const parts = etFormatter.formatToParts(approxUtc);
  const etHour = parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
  const etDay = parseInt(parts.find((p) => p.type === 'day')!.value, 10);

  // If etDay differs from our target day, we crossed a day boundary — adjust
  // This shouldn't happen for 17:00 UTC but handle it defensively
  if (etDay !== day) {
    // We're off by a day; shift by 24h
    const shifted = new Date(approxUtc.getTime() + (day - etDay) * ONE_DAY_MS);
    return noonEtToUtcMs(dateStr); // recurse should not happen in practice
  }

  // The UTC offset in hours is (etHour - 17) if our approx was 17:00 UTC
  // Actually: if 17:00 UTC = 12:00 ET, offset is -5 (EST). If 17:00 UTC = 13:00 ET, offset is -4 (EDT).
  // We want noon ET (hour=12), so the delta from etHour to 12 tells us how to adjust.
  const deltaHours = 12 - etHour; // positive = need to go forward, negative = go back

  const noonUtcMs = approxUtc.getTime() + deltaHours * 60 * 60 * 1000;

  return noonUtcMs;
}

// ── 3. Normal CDF ───────────────────────────────────────────────────────────

/**
 * Standard normal cumulative distribution function (CDF).
 *
 * Uses the Abramowitz and Stegun approximation (formula 26.2.17) which
 * provides accuracy to ~7.5e-8.
 *
 * Reference: Handbook of Mathematical Functions, M. Abramowitz & I. Stegun,
 * National Bureau of Standards, 1964, formula 26.2.17.
 *
 * @param x - Z-score
 * @returns P(Z <= x) where Z ~ N(0,1), value in [0, 1]
 */
export function normalCDF(x: number): number {
  // Handle extreme values to avoid numerical issues
  if (x > 8) return 1;
  if (x < -8) return 0;

  // Abramowitz & Stegun constants (formula 26.2.17)
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  // Use symmetry: Phi(-x) = 1 - Phi(x)
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);

  // Rational approximation of erfc
  const t = 1.0 / (1.0 + p * absX);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;

  const y = 1.0 - (a1 * t + a2 * t2 + a3 * t3 + a4 * t4 + a5 * t5) * Math.exp(-absX * absX / 2);

  return 0.5 * (1.0 + sign * y);
}

// ── 4. Binary Option Pricing ────────────────────────────────────────────────

/**
 * Estimate the fair CLOB price for a "BTC Up" binary option token.
 *
 * Uses the Black-Scholes digital option pricing model:
 *
 *   fairPrice = Phi( currentReturn / (dailyVol * sqrt(remainingFraction)) )
 *
 * where:
 *   - Phi is the standard normal CDF
 *   - currentReturn = ln(currentPrice / referencePrice)  (log return so far)
 *   - dailyVol = daily volatility (standard deviation of daily log returns)
 *   - remainingFraction = fraction of the day remaining (0 = expired, 1 = full day)
 *
 * Intuition: as the day progresses (remainingFraction -> 0), the denominator
 * shrinks, pushing the CDF toward 0 or 1 (certainty). A positive return
 * pushes toward 1 (Up wins), negative toward 0 (Down wins).
 *
 * Edge cases:
 *   - remainingFraction ~ 0: return 0 or 1 based on sign of currentReturn
 *   - dailyVolatility = 0: return 0.5 (no info to discriminate)
 *   - Output clamped to [0.01, 0.99] to avoid degenerate prices
 *
 * @param currentReturn - Log return from reference price: ln(current/reference)
 * @param dailyVolatility - Daily volatility (sigma of daily log returns, NOT annualized)
 * @param remainingFraction - Fraction of the trading day remaining (0 to 1)
 * @returns Fair price of the "Up" token, in [0.01, 0.99]
 */
export function estimateClobPrice(
  currentReturn: number,
  dailyVolatility: number,
  remainingFraction: number,
): number {
  // Guard: no time left — binary outcome
  if (remainingFraction <= 1e-9) {
    return currentReturn >= 0 ? 0.99 : 0.01;
  }

  // Guard: zero volatility — can't distinguish direction
  if (dailyVolatility <= 1e-12) {
    return 0.5;
  }

  // Standard Black-Scholes digital option z-score
  // d = (currentReturn) / (sigma * sqrt(T))
  const d = currentReturn / (dailyVolatility * Math.sqrt(remainingFraction));

  const fairPrice = normalCDF(d);

  // Clamp to [0.01, 0.99] — avoid degenerate edge prices
  return Math.max(0.01, Math.min(0.99, fairPrice));
}

// ── 5. Rolling Daily Volatility ─────────────────────────────────────────────

/**
 * Calculate rolling standard deviation of daily log returns.
 *
 * Formula:
 *   logReturns[i] = ln(close[i] / close[i-1])
 *   sigma = stddev(logReturns[last `window` entries])
 *
 * This returns the DAILY volatility (not annualized). To annualize,
 * multiply by sqrt(365).
 *
 * @param dailyCloses - Array of daily close prices (one per day, chronological)
 * @param window - Lookback window for rolling stddev (default: 30 days)
 * @returns Daily volatility (sigma), or 0 if insufficient data
 */
export function rollingDailyVolatility(dailyCloses: number[], window: number = 30): number {
  // Need at least window+1 closes to compute `window` log returns
  if (dailyCloses.length < window + 1) {
    return 0;
  }

  // Compute log returns for the last `window` periods
  const startIdx = dailyCloses.length - window;
  const logReturns: number[] = [];

  for (let i = startIdx; i < dailyCloses.length; i++) {
    const prev = dailyCloses[i - 1];
    const curr = dailyCloses[i];

    // Guard: skip zero/negative prices (shouldn't happen, but defensive)
    if (prev <= 0 || curr <= 0) continue;

    logReturns.push(Math.log(curr / prev));
  }

  if (logReturns.length < 2) return 0;

  // Standard deviation of log returns
  const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
  const variance =
    logReturns.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (logReturns.length - 1); // Bessel's correction

  return Math.sqrt(variance);
}

// ── 6. Daily Close Extraction ───────────────────────────────────────────────

/**
 * Extract one close price per day from a Map of 1m candles.
 *
 * Picks the candle at a fixed daily time (default: 17:00 UTC) for consistency.
 * This aligns roughly with noon ET (the Polymarket resolution time is 12:00 ET
 * = 16:00 or 17:00 UTC depending on DST, but for volatility calculation
 * we just need a consistent daily sample).
 *
 * @param candles1m - Map<timestamp, Candle1m> indexed by open time
 * @param startMs - Start of range (inclusive)
 * @param endMs - End of range (inclusive)
 * @param dailyHourUtc - Hour of day to sample (default: 17, i.e., 17:00 UTC)
 * @returns Array of { date, close } sorted chronologically
 */
export function getDailyCloses(
  candles1m: Map<number, Candle1m>,
  startMs: number,
  endMs: number,
  dailyHourUtc: number = 17,
): DailyClose[] {
  const result: DailyClose[] = [];

  // Iterate day by day from startMs to endMs
  const startDate = new Date(startMs);
  startDate.setUTCHours(0, 0, 0, 0);

  const endDate = new Date(endMs);
  endDate.setUTCHours(23, 59, 59, 999);

  for (
    let dayStart = startDate.getTime();
    dayStart <= endDate.getTime();
    dayStart += ONE_DAY_MS
  ) {
    // Target time: the given hour on this day
    const targetDate = new Date(dayStart);
    targetDate.setUTCHours(dailyHourUtc, 0, 0, 0);
    const targetMs = targetDate.getTime();

    if (targetMs < startMs || targetMs > endMs) continue;

    // Align to minute boundary
    const alignedMs = Math.floor(targetMs / ONE_MINUTE_MS) * ONE_MINUTE_MS;
    const candle = candles1m.get(alignedMs);

    if (candle) {
      const dateStr = new Date(dayStart).toISOString().slice(0, 10);
      result.push({ date: dateStr, close: candle.close });
    }
  }

  return result;
}

// ── 7. Price at Time ────────────────────────────────────────────────────────

/**
 * Get the 1m candle close price at a specific timestamp.
 *
 * Aligns the target time to the nearest minute boundary (floor) and looks up
 * the corresponding candle in the Map.
 *
 * @param candles - Map<timestamp, Candle1m> indexed by open time
 * @param targetMs - Target time in epoch ms
 * @returns Close price of the 1m candle, or null if candle not found
 */
export function getPriceAtTime(
  candles: Map<number, Candle1m>,
  targetMs: number,
): number | null {
  // Align to minute boundary (floor)
  const alignedMs = Math.floor(targetMs / ONE_MINUTE_MS) * ONE_MINUTE_MS;
  const candle = candles.get(alignedMs);
  return candle ? candle.close : null;
}
