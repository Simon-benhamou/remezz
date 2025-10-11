// backend/src/ai/tech.ts
import { getOHLCV, getOhlcvWarmupState } from '../data/market.js';
import { ema, rsi, atr, adx } from '../data/indicators.js';
import { classifyRegime, RegimeProfile } from './regime.js';
import { getConfig } from '../utils/env.js';
import { InsufficientDataError } from '../data/errors.js';

export type TechnicalSnapshot = {
  symbol: string;
  last: number;
  ema20: number;
  ema50: number;
  ema100: number;
  ema200: number;
  rsi14: number;
  atr14: number;
  atr14_1h?: number;
  atrPct: number;
  adx14: number;
  ema20Slope: number;
  // Volume/flow
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
  trendBias: 'bullish' | 'bearish' | 'neutral';
  regime?: RegimeProfile;
  // Volume snapshot for diagnostics
  volume?: number;      // latest 15m bar volume
  volumeMA?: number;    // smoothed (EMA20) volume baseline
  volumeAvg?: number;
  volume24h?: number;
  volume24hChangePct?: number;
  // Chaikin Money Flow 20 (15m)
  cmf20?: number;
};

// Utilities
function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}
function pct(a: number, b: number) {
  if (b === 0) return 0; // Éviter division par zéro
  return (a - b) / b * 100;
}
function near(a: number, b: number, pPct: number) {
  return Math.abs(a - b) <= Math.abs(b) * (pPct / 100);
}

export function computeSwingTolerancePct(params: {
  atrPct: number;
  realizedVol: number;
  override?: number;
  minPct?: number;
  maxPct?: number;
}): number {
  const { atrPct, realizedVol, override, minPct = 0.1, maxPct = 0.7 } = params;

  if (override !== undefined && override > 0 && Number.isFinite(override)) {
    return Math.max(minPct, Math.min(maxPct, override));
  }

  const atrComponent = Number.isFinite(atrPct) ? Math.max(0, atrPct) * 0.25 : 0;
  const realizedComponent = Number.isFinite(realizedVol) ? Math.max(0, realizedVol) * 0.004 : 0;
  const blended = atrComponent + realizedComponent;
  const bounded = Math.max(minPct, Math.min(maxPct, blended || minPct));

  return Number(bounded.toFixed(3));
}

function realizedVolatility(logReturns: number[]) {
  if (!logReturns.length) return 0;
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((acc, r) => acc + Math.pow(r - mean, 2), 0) / logReturns.length;
  const stdev = Math.sqrt(variance);
  // 15m bars → 96 periods per day. Return expressed in %.
  return stdev * Math.sqrt(96) * 100;
}

// Chaikin Money Flow over `period` bars
function chaikinMoneyFlow(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
  period: number
): number {
  const n = Math.min(highs.length, lows.length, closes.length, volumes.length);
  if (n === 0) return 0;
  const look = Math.max(1, Math.min(period, n));
  let mfvSum = 0;
  let volSum = 0;
  for (let i = n - look; i < n; i++) {
    const high = highs[i];
    const low = lows[i];
    const close = closes[i];
    const vol = Number(volumes[i] || 0);
    const range = Math.max(1e-12, high - low);
    const mfm = ((close - low) - (high - close)) / range; // (2*close - high - low)/(high-low)
    const mfv = mfm * vol;
    mfvSum += mfv;
    volSum += vol;
  }
  if (volSum <= 0) return 0;
  return mfvSum / volSum;
}

function hurstExponent(values: number[]) {
  const n = values.length;
  if (n < 10) return 0.5; // Réduction du seuil minimal de 32 à 10
  
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
  
  // Si range ou std sont nuls/très petits, retourner 0.5 (marche aléatoire)
  if (std <= 1e-12 || range <= 1e-12) return 0.5;
  
  const rs = range / std;
  const hurst = Math.log(rs) / Math.log(n);
  
  // Clamp between 0 and 1
  return Math.max(0, Math.min(1, hurst));
}

function computeTrendBias(ema100: number, ema200: number, neutralBandBps: number): 'bullish' | 'bearish' | 'neutral' {
  if (!isFinite(ema100) || !isFinite(ema200) || ema100 === 0 || ema200 === 0) {
    return 'neutral';
  }
  const diffPct = ((ema100 - ema200) / ema200) * 100;
  const band = Math.abs(neutralBandBps) / 10000 * 100; // convert bps to percent
  if (diffPct > band) return 'bullish';
  if (diffPct < -band) return 'bearish';
  return 'neutral';
}

export function swingLevels(highs: number[], lows: number[], closes: number[], period: number, tolerancePct: number) {
  const supports: { price: number; touches: number; strength: number }[] = [];
  const resistances: { price: number; touches: number; strength: number }[] = [];

  for (let i = period; i < highs.length - period; i++) {
    const isHigh = highs[i] > Math.max(...highs.slice(i - period, i), ...highs.slice(i + 1, i + 1 + period));
    const isLow = lows[i] < Math.min(...lows.slice(i - period, i), ...lows.slice(i + 1, i + 1 + period));

    if (isHigh) {
      const price = highs[i];
      let merged = false;
      for (const r of resistances) {
        if (near(price, r.price, tolerancePct)) {
          r.price = (r.price * r.touches + price) / (r.touches + 1);
          r.touches++;
          r.strength = Math.min(5, r.touches);
          merged = true;
          break;
        }
      }
      if (!merged) resistances.push({ price, touches: 1, strength: 1 });
    }

    if (isLow) {
      const price = lows[i];
      let merged = false;
      for (const s of supports) {
        if (near(price, s.price, tolerancePct)) {
          s.price = (s.price * s.touches + price) / (s.touches + 1);
          s.touches++;
          s.strength = Math.min(5, s.touches);
          merged = true;
          break;
        }
      }
      if (!merged) supports.push({ price, touches: 1, strength: 1 });
    }
  }
  return { supports, resistances };
}

function dailyPivotsFromOHLCV(ohlcv: number[][]) {
  if (!ohlcv || ohlcv.length < 2) return null;
  const yesterday = ohlcv[ohlcv.length - 2];
  const [ts, o, h, l, c] = yesterday;
  const P = (h + l + c) / 3;
  const R1 = (2 * P) - l;
  const S1 = (2 * P) - h;
  const R2 = P + (h - l);
  const S2 = P - (h - l);
  return { P, S1, S2, R1, R2, refDay: new Date(ts).toISOString().slice(0, 10) };
}

const snapCache = new Map<string, { ts: number; data: TechnicalSnapshot }>();
const SNAP_TTL_MS = 1000 * 15; // 15s
const cacheKey = (symbol: string) => `snap_${symbol}`;
const MIN_MEANINGFUL_VOLUME = 1e-8; // effectively zero in base currency units

// Full technical snapshot for a symbol:
// - EMA20/50, RSI14, ATR14 & ATR%
// - 24h S/R + swing S/R
// - Daily pivots (P, S1, S2, R1, R2)
// - srBias: nearSupport | nearResistance | neutral (~0.6% window)
export async function buildTechSnapshot(symbol: string, userId?: string): Promise<TechnicalSnapshot>{
  try {
    const key = cacheKey(symbol);
    const cached = snapCache.get(key);
    if (cached && (Date.now() - cached.ts) < SNAP_TTL_MS) {
      return { ...(cached.data) };
    }
  } catch {}
  const cfg = getConfig();
  const minBars15m = Math.max(50, Number(cfg.DIAGNOSTICS_MIN_BARS_15M || 100));
  // 15m window for reactivity (~2 days), 1h for pivots/daily
  const o15 = await getOHLCV(symbol, '15m', Math.max(300, minBars15m), userId); // [ts, o, h, l, c, v]
  if (!o15 || o15.length < minBars15m) {
    const warmup = getOhlcvWarmupState(symbol, '15m');
    throw new InsufficientDataError('Not enough data (15m)', {
      symbol,
      timeframe: '15m',
      availableBars: o15?.length ?? 0,
      minBarsNeeded: minBars15m,
      firstBarAt: o15?.length ? o15[0][0] : null,
      lastBarAt: o15?.length ? o15[o15.length - 1][0] : null,
      warmupState: warmup,
    });
  }

  // 🔍 DEBUG RAW OHLCV: Compare avec API publique
  console.log(`[RAW OHLCV DEBUG] ${symbol}: Last 5 candles from getOHLCV:`, 
    o15.slice(-5).map(r => ({
      ts: new Date(r[0]).toISOString(),
      close: r[4],
      volume: r[5],
      'row[5]': r[5]
    }))
  );

  const closes15 = o15.map(r => r[4]);
  const highs15  = o15.map(r => r[2]);
  const lows15   = o15.map(r => r[3]);
  const volumes15 = o15.map(r => Number(r[5] || 0));
  const lastPrice:any = last(closes15);

  const recentVolumeWindow = volumes15.slice(-Math.min(volumes15.length, 48));
  const meaningfulVolumes = recentVolumeWindow.filter(v => Math.abs(v) > MIN_MEANINGFUL_VOLUME);
  if (recentVolumeWindow.length > 0 && meaningfulVolumes.length === 0) {
    const warmup = getOhlcvWarmupState(symbol, '15m');
    const anomalyDetails = {
      windowSize: recentVolumeWindow.length,
      threshold: MIN_MEANINGFUL_VOLUME,
      sample: recentVolumeWindow.slice(-Math.min(5, recentVolumeWindow.length)),
      lastClose: lastPrice,
    };
    console.warn(`[TECH SNAPSHOT] ${symbol}: Detected zero-volume anomaly across recent 15m candles.`, anomalyDetails);
    throw new InsufficientDataError('Market data contains no usable recent volume (15m)', {
      symbol,
      timeframe: '15m',
      availableBars: o15.length,
      minBarsNeeded: minBars15m,
      firstBarAt: o15?.length ? o15[0][0] : null,
      lastBarAt: o15?.length ? o15[o15.length - 1][0] : null,
      warmupState: warmup,
      reason: 'zero_volume',
      details: anomalyDetails,
    });
  }

  // DEBUG: Log volume data for troubleshooting
  const latestVolRaw = o15[o15.length - 1]?.[5];
  if (latestVolRaw === undefined || latestVolRaw === null || latestVolRaw === 0) {
    console.warn(`[VOLUME DEBUG] ${symbol}: Latest volume is ${latestVolRaw}. Sample OHLCV:`, {
      latestBar: o15[o15.length - 1],
      prev5Bars: o15.slice(-6, -1).map(r => ({ ts: r[0], close: r[4], vol: r[5] })),
      allVolumesZero: volumes15.every(v => v === 0),
      volumesNonZero: volumes15.filter(v => v > 0).length,
    });
  }

  // Indicators
  const ema20Arr = ema(closes15, 20);
  const ema50Arr = ema(closes15, 50);
  const ema100Arr = ema(closes15, 100);
  const ema200Arr = ema(closes15, 200);
  const ema20v = last(ema20Arr);
  const ema50v = last(ema50Arr);
  const ema100v = ema100Arr.length ? ema100Arr.at(-1)! : ema20v;
  const ema200v = ema200Arr.length ? ema200Arr.at(-1)! : ema50v;
  const ema20Slope = ema20Arr.length >= 2 ? ema20Arr.at(-1)! - ema20Arr.at(-2)! : 0;
  const rsi14Arr = rsi(closes15, 14);
  const rsi14v = rsi14Arr[rsi14Arr.length - 1] ?? 50;
  const atr14Arr = atr(o15, 14);
  const atr14v = atr14Arr[atr14Arr.length - 1] ?? 0;
  const atrPct = (atr14v / lastPrice) * 100;
  const adx14Arr = adx(o15, 14);
  const adx14v = adx14Arr[adx14Arr.length - 1] ?? 0;
  // CMF20 (15m)
  const cmf20v = chaikinMoneyFlow(highs15, lows15, closes15, volumes15, 20);
  // Volume baseline: use EMA20 of 15m volumes for responsiveness
  const volEma20 = ema(volumes15, 20);
  const latestVol = volumes15.length ? volumes15[volumes15.length - 1] : 0;
  const volMA = volEma20.length ? volEma20[volEma20.length - 1] : 0;

  // Enhanced volume logging for clarity when the last 15m bar volume is very low vs MA
  try {
    if (volMA > 0 && latestVol <= volMA / 10) {
      const last5Vols = o15.slice(-5).map(r => ({ vol: r[5], ts: new Date(r[0]).toISOString() }));
      console.warn(`[VOLUME CLARITY] ${symbol}: Low last 15m volume vs MA`, {
        last15mVolume: latestVol,
        volumeMA20: volMA,
        ratioPct: Number(((latestVol / volMA) * 100).toFixed(1)),
        last5Volumes: last5Vols,
        note: 'Entry confirmation compares the last closed 15m volume to its EMA20. Low ratio often indicates consolidation despite high 24h volume.'
      });
    }
  } catch {}

  // Enhanced volume logging for clarity
  if (latestVolRaw === undefined || latestVolRaw === null || latestVolRaw <= (volMA / 10)) {
    const last5Vols = o15.slice(-5).map(r => ({ vol: r[5], ts: new Date(r[0]).toISOString() }));
    console.warn(`[VOLUME CLARITY] ${symbol}: Low volume detected for entry confirmation.`, {
      'Last 15m Candle Volume': latestVol,
      'Volume MA (20 periods)': volMA,
      'Ratio (Current/MA)': volMA > 0 ? `${((latestVol / volMA) * 100).toFixed(1)}%` : 'N/A',
      'Reason': 'This check compares the last closed 15m candle volume to its 20-period moving average. A low ratio can indicate a pause or consolidation, even if 24h volume is high.',
      'Last 5 Raw Volumes (15m candles)': last5Vols,
    });
  }

  // Simple 24h S/R (~96 bars of 15m)
  const recent = closes15.length >= 96 ? o15.slice(-96) : o15;
  const recentVolume = recent.reduce((sum, row) => sum + Number(row[5] || 0), 0);
  const prevWindow = o15.length >= 192 ? o15.slice(-192, -96) : [];
  const prevVolume = prevWindow.reduce((sum, row) => sum + Number(row[5] || 0), 0);
  const avgVolume = volumes15.reduce((sum, v) => sum + v, 0) / Math.max(1, volumes15.length);
  const volumeChangePct = prevVolume > 0 ? ((recentVolume - prevVolume) / prevVolume) * 100 : 0;
  
  // Convert volume from tokens to USD (recentVolume is in base currency, multiply by price)
  const recentVolumeUSD = recentVolume * lastPrice;
  const support24h = Math.min(...recent.map(r => r[3]));
  const resistance24h = Math.max(...recent.map(r => r[2]));

  const logReturns: number[] = [];
  for (let i = 1; i < closes15.length; i++) {
    const prev = closes15[i - 1];
    const cur = closes15[i];
    if (prev > 0 && cur > 0) logReturns.push(Math.log(cur / prev));
  }
  const realizedVol = realizedVolatility(logReturns);

  // Swings (fractal)
  const swingTolerancePct = computeSwingTolerancePct({
    atrPct,
    realizedVol,
    override: cfg.TECH_SNAPSHOT_SWING_TOLERANCE_PCT,
  });
  const swings = swingLevels(highs15, lows15, closes15, 2, swingTolerancePct);
  const supports = [
    { price: support24h, label: '24h-low', touches: 1, strength: 1 },
    ...swings.supports.slice(0, 5).map(s => ({ price: s.price, label: 'swing', touches: s.touches, strength: s.strength })),
  ].sort((a, b) => Math.abs(lastPrice - a.price) - Math.abs(lastPrice - b.price));

  const resistances = [
    { price: resistance24h, label: '24h-high', touches: 1, strength: 1 },
    ...swings.resistances.slice(0, 5).map(s => ({ price: s.price, label: 'swing', touches: s.touches, strength: s.strength })),
  ].sort((a, b) => Math.abs(lastPrice - a.price) - Math.abs(lastPrice - b.price));

  // Daily pivots from 1h (fallback to 15m if needed) and 1h ATR for sturdier risk sizing
  const o1h = await getOHLCV(symbol, '1h', 600, userId); // ~25 jours
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
  const hurst = hurstExponent(closes15.slice(-256));
  const adxPrev = adx14Arr.length >= 2 ? adx14Arr[adx14Arr.length - 2] : adx14v;
  const adxSlope = adx14v - (adxPrev ?? adx14v);
  const { TREND_FILTER_NEUTRAL_BAND_BPS } = getConfig();
  const trendBias = computeTrendBias(ema100v, ema200v, TREND_FILTER_NEUTRAL_BAND_BPS);

  const snapshot: TechnicalSnapshot = {
    symbol,
    last: lastPrice,
    ema20: ema20v,
    ema50: ema50v,
    ema100: ema100v,
    ema200: ema200v,
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
    trendBias,
    // Provide both instantaneous and smoothed volume for diagnostics
    volume: latestVol,
    volumeMA: volMA || avgVolume,
    volumeAvg: avgVolume,
    volume24h: recentVolumeUSD, // Volume in USD (tokens * price)
    volume24hChangePct: volumeChangePct,
    cmf20: cmf20v,
  };

  snapshot.regime = classifyRegime(snapshot);

  try { snapCache.set(cacheKey(symbol), { ts: Date.now(), data: snapshot }); } catch {}
  return snapshot;
}
