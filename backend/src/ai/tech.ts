// backend/src/ai/tech.ts
import { getOHLCV } from '../data/market.js';
import { ema, rsi, atr, adx } from '../data/indicators.js';
import { classifyRegime, RegimeProfile } from './regime.js';

export type TechnicalSnapshot = {
  symbol: string;
  last: number;
  ema20: number;
  ema50: number;
  rsi14: number;
  atr14: number;
  atr14_1h?: number;
  atrPct: number;
  adx14: number;
  ema20Slope: number;
  support: number;          // primary support (closest/best)
  resistance: number;       // primary resistance
  supports: { price: number; label: string; touches: number; strength: number }[];
  resistances: { price: number; label: string; touches: number; strength: number }[];
  pivots: null | { P: number; S1: number; S2: number; R1: number; R2: number; refDay: string };
  trend: number;
  srBias: 'nearSupport'|'nearResistance'|'neutral';
  meta: { tf: string; windowBars: number; recentBarsFor24h: number };
  realizedVol: number;
  hurst: number;
  adxSlope: number;
  trendStrength: number;
  regime?: RegimeProfile;
};

// Utilities
function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}
function pct(a: number, b: number) {
  return (a - b) / b * 100;
}
function near(a: number, b: number, pPct: number) {
  return Math.abs(a - b) <= Math.abs(b) * (pPct / 100);
}

function realizedVolatility(logReturns: number[]) {
  if (!logReturns.length) return 0;
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((acc, r) => acc + Math.pow(r - mean, 2), 0) / logReturns.length;
  const stdev = Math.sqrt(variance);
  // 15m bars → 96 periods per day. Return expressed in %.
  return stdev * Math.sqrt(96) * 100;
}

function hurstExponent(values: number[]) {
  const n = values.length;
  if (n < 32) return 0.5;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let cumulative = 0;
  let maxAccum = -Infinity;
  let minAccum = Infinity;
  let varianceAccumulator = 0;
  for (let i = 0; i < n; i++) {
    const dev = values[i] - mean;
    cumulative += dev;
    if (cumulative > maxAccum) maxAccum = cumulative;
    if (cumulative < minAccum) minAccum = cumulative;
    varianceAccumulator += dev * dev;
  }
  const range = maxAccum - minAccum;
  const variance = varianceAccumulator / n;
  const std = Math.sqrt(Math.max(variance, 1e-12));
  if (std === 0 || range === 0) return 0.5;
  const rs = range / std;
  const hurst = Math.log(rs) / Math.log(n);
  return Math.max(0, Math.min(1, hurst));
}

// Compute daily pivots from OHLCV (prefer 1h or 15m).
// Uses previous UTC day High/Low/Close.
function dailyPivotsFromOHLCV(ohlcv: number[][]) {
  // ohlcv: [ ts(ms), open, high, low, close, volume ]
  if (!ohlcv?.length) return null;

  // Group by day (UTC)
  const byDay: Record<string, { high: number; low: number; close: number }> = {};
  for (const [ts, , , , close, ] of ohlcv) {
    const d = new Date(ts);
    const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
    if (!byDay[key]) byDay[key] = { high: -Infinity, low: Infinity, close };
    const o = byDay[key];
    // Update high/low/close per iteration
  }
  // Second pass to record highs/lows precisely
  for (const [ts, , high, low, close] of ohlcv) {
    const key = new Date(ts).toISOString().slice(0, 10);
    const o = byDay[key];
    if (!o) continue;
    if (high > o.high) o.high = high;
    if (low < o.low) o.low = low;
    o.close = close; // last close of that day
  }

  // Sorted days
  const days = Object.keys(byDay).sort();
  if (days.length < 2) return null; // pas de "veille"
  const prev = byDay[days[days.length - 2]];
  const H = prev.high, L = prev.low, C = prev.close;
  const P = (H + L + C) / 3;
  const R1 = 2 * P - L;
  const S1 = 2 * P - H;
  const R2 = P + (H - L);
  const S2 = P - (H - L);

  return { P, R1, R2, S1, S2, refDay: days[days.length - 2] };
}

// Swing detection (fractal highs/lows) with clustering tolerance.
function swingLevels(
  highs: number[], lows: number[], closes: number[], lookback = 2, tolerancePct = 0.15
) {
  type Lvl = { price: number; touches: number; strength: number; idx: number };
  const swingHighs: Lvl[] = [];
  const swingLows: Lvl[] = [];

  const n = highs.length;
  for (let i = lookback; i < n - lookback; i++) {
    const h = highs[i], l = lows[i];
    // swing high
    let isHigh = true;
    for (let k = 1; k <= lookback; k++) {
      if (!(h > highs[i - k] && h > highs[i + k])) { isHigh = false; break; }
    }
    if (isHigh) swingHighs.push({ price: h, touches: 1, strength: 1, idx: i });

    // swing low
    let isLow = true;
    for (let k = 1; k <= lookback; k++) {
      if (!(l < lows[i - k] && l < lows[i + k])) { isLow = false; break; }
    }
    if (isLow) swingLows.push({ price: l, touches: 1, strength: 1, idx: i });
  }

  // Cluster nearby levels within tolerancePct
  function cluster(levels: Lvl[]): Lvl[] {
    const out: Lvl[] = [];
    for (const lvl of levels) {
      const found = out.find(x => near(x.price, lvl.price, tolerancePct));
      if (!found) out.push({ ...lvl });
      else {
        // fusion simple: moyenne pondérée
        found.price = (found.price * found.touches + lvl.price) / (found.touches + 1);
        found.touches += 1;
        found.strength += 1;
        found.idx = Math.max(found.idx, lvl.idx);
      }
    }
    return out;
  }

  const clusteredHighs = cluster(swingHighs)
    .sort((a, b) => b.touches - a.touches || b.price - a.price);
  const clusteredLows = cluster(swingLows)
    .sort((a, b) => b.touches - a.touches || a.price - b.price);

  // Convert to enriched arrays
  return {
    resistances: clusteredHighs.map(l => ({ price: l.price, touches: l.touches, strength: l.strength })),
    supports: clusteredLows.map(l => ({ price: l.price, touches: l.touches, strength: l.strength })),
  };
}

// Full technical snapshot for a symbol:
// - EMA20/50, RSI14, ATR14 & ATR%
// - 24h S/R + swing S/R
// - Daily pivots (P, S1, S2, R1, R2)
// - srBias: nearSupport | nearResistance | neutral (~0.6% window)
export async function buildTechSnapshot(symbol: string): Promise<TechnicalSnapshot>{
  // 15m window for reactivity (~2 days), 1h for pivots/daily
  const o15 = await getOHLCV(symbol, '15m', 300); // [ts, o, h, l, c, v]
  if (!o15 || o15.length < 100) throw new Error('Not enough data (15m)');

  const closes15 = o15.map(r => r[4]);
  const highs15  = o15.map(r => r[2]);
  const lows15   = o15.map(r => r[3]);
  const lastPrice:any = last(closes15);

  // Indicators
  const ema20Arr = ema(closes15, 20);
  const ema50Arr = ema(closes15, 50);
  const ema20v = last(ema20Arr);
  const ema50v = last(ema50Arr);
  const ema20Slope = ema20Arr.length >= 2 ? ema20Arr.at(-1)! - ema20Arr.at(-2)! : 0;
  const rsi14Arr = rsi(closes15, 14);
  const rsi14v = rsi14Arr[rsi14Arr.length - 1] ?? 50;
  const atr14Arr = atr(o15, 14);
  const atr14v = atr14Arr[atr14Arr.length - 1] ?? 0;
  const atrPct = (atr14v / lastPrice) * 100;
  const adx14Arr = adx(o15, 14);
  const adx14v = adx14Arr[adx14Arr.length - 1] ?? 0;

  // Simple 24h S/R (~96 bars of 15m)
  const recent = closes15.length >= 96 ? o15.slice(-96) : o15;
  const support24h = Math.min(...recent.map(r => r[3]));
  const resistance24h = Math.max(...recent.map(r => r[2]));

  // Swings (fractal)
  const swings = swingLevels(highs15, lows15, closes15, 2, 0.15); // tolérance 0.15% pour regrouper
  const supports = [
    { price: support24h, label: '24h-low', touches: 1, strength: 1 },
    ...swings.supports.slice(0, 5).map(s => ({ price: s.price, label: 'swing', touches: s.touches, strength: s.strength })),
  ].sort((a, b) => Math.abs(lastPrice - a.price) - Math.abs(lastPrice - b.price));

  const resistances = [
    { price: resistance24h, label: '24h-high', touches: 1, strength: 1 },
    ...swings.resistances.slice(0, 5).map(s => ({ price: s.price, label: 'swing', touches: s.touches, strength: s.strength })),
  ].sort((a, b) => Math.abs(lastPrice - a.price) - Math.abs(lastPrice - b.price));

  // Daily pivots from 1h (fallback to 15m if needed) and 1h ATR for sturdier risk sizing
  const o1h = await getOHLCV(symbol, '1h', 600); // ~25 jours
  const atr1hArr = atr(o1h || o15, 14);
  const atr1h = atr1hArr[atr1hArr.length - 1] ?? undefined;
  const pivots = dailyPivotsFromOHLCV(o1h || o15);

  // Select primary support/resistance (closest to last price)
  const primarySupport = supports[0]?.price ?? support24h;
  const primaryResistance = resistances[0]?.price ?? resistance24h;

  // srBias
  let srBias: 'nearSupport' | 'nearResistance' | 'neutral' = 'neutral';
  if (near(lastPrice, primarySupport, 0.6)) srBias = 'nearSupport';
  if (near(lastPrice, primaryResistance, 0.6)) srBias = 'nearResistance';

  // Trend proxy
  const trend = ema20v - ema50v;
  const trendStrength = Math.abs(trend) / (lastPrice || 1) * 100;
  const logReturns: number[] = [];
  for (let i = 1; i < closes15.length; i++) {
    const prev = closes15[i - 1];
    const cur = closes15[i];
    if (prev > 0 && cur > 0) logReturns.push(Math.log(cur / prev));
  }
  const realizedVol = realizedVolatility(logReturns);
  const hurst = hurstExponent(closes15.slice(-256));
  const adxPrev = adx14Arr.length >= 2 ? adx14Arr[adx14Arr.length - 2] : adx14v;
  const adxSlope = adx14v - (adxPrev ?? adx14v);

  const snapshot: TechnicalSnapshot = {
    symbol,
    last: lastPrice,
    ema20: ema20v,
    ema50: ema50v,
    rsi14: rsi14v,
    atr14: atr14v,
    atr14_1h: atr1h,
    atrPct,
    adx14: adx14v,
    ema20Slope,
    support: primarySupport,
    resistance: primaryResistance,
    supports,       // [{ price, label, touches, strength }, ...] sorted by proximity
    resistances,    // idem
    pivots,         // { P,S1,S2,R1,R2,refDay } | null
    trend,
    srBias,
    meta: {
      tf: '15m',
      windowBars: o15.length,
      recentBarsFor24h: recent.length,
    },
    realizedVol,
    hurst,
    adxSlope,
    trendStrength,
  };

  snapshot.regime = classifyRegime(snapshot);

  return snapshot;
}
