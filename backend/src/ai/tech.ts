// backend/src/ai/tech.ts
import { getOHLCV, getOhlcvWarmupState } from '../data/market.js';
import { ema, rsi, atr, adx, dmi } from '../data/indicators.js';
import { classifyRegime, RegimeProfile } from './regime.js';
import { getConfig } from '../utils/env.js';
import { InsufficientDataError, UnusableMarketDataError } from '../data/errors.js';
import { computeMultiTimeframeDiagnostics, type Diagnostics as MultiTimeframeDiagnostics } from './multiTimeframe.js';

export type TechnicalSnapshot = {
  symbol: string;
  last: number;
  ema9?: number;
  ema12?: number;
  ema20: number;
  ema26?: number;
  ema50: number;
  ema100: number;
  ema200: number;
  ema20Slope: number;
  ema50Slope?: number;
  emaTrendSpread?: number;
  emaRatio9_20?: number;
  emaRatio20_200?: number;
  emaRatio50_200?: number;
  rsi14: number;
  rsi7?: number;
  rsi21?: number;
  atr14: number;
  atr14_1h?: number;
  atr14_4h?: number;
  atrPct: number;
  adx14: number;
  adxPos14?: number;
  adxNeg14?: number;
  diPlus14?: number;
  diMinus14?: number;
  stochK?: number;
  stochD?: number;
  macd?: number;
  macdSignal?: number;
  macdDiff?: number;
  rsiSlope?: number;
  momentum3?: number;
  momentum5?: number;
  momentum10?: number;
  momentum20?: number;
  atr7?: number;
  bbWidth?: number;
  bbPosition?: number;
  volatilityRegime?: number;
  volumeRatio?: number;
  // Volume/flow
  support: number;          // primary support (closest/best)
  resistance: number;       // primary resistance
  supports: { price: number; label: string; touches: number; strength: number }[];
  resistances: { price: number; label: string; touches: number; strength: number }[];
  pivots: null | { P: number; S1: number; S2: number; R1: number; R2: number; refDay: string };
  trend: number;
  srBias: 'nearSupport'|'nearResistance'|'neutral';
  meta: { tf: string; contextTf?: string; windowBars: number; recentBarsFor24h: number };
  realizedVol: number;
  hurst: number;
  adxSlope: number;
  trendStrength: number;
  trendBias: 'bullish' | 'bearish' | 'neutral';
  regime?: RegimeProfile;
  // Volume snapshot for diagnostics
  volume?: number;      // latest 15m bar volume
  volumeMA?: number;    // smoothed (EMA20) volume baseline
  volumeZScore?: number;
  volumeAvg?: number;
  volume24h?: number;
  volume24hChangePct?: number;
  // Chaikin Money Flow 20 (15m)
  cmf20?: number;
  obvSlope?: number;
  volPriceConfirmation?: number;
  spreadProxy?: number;
  distEma20?: number;
  distEma50?: number;
  distEma200?: number;
  atrPct1h?: number;
  atrPct4h?: number;
  rsi14_1h?: number;
  rsi14_4h?: number;
  microImbalance?: number;
  mtfAgreement?: number;
  volAdjustedMomentum?: number;
  rsiEmaDiv?: number;
  multiTimeframe?: MultiTimeframeDiagnostics;
  microstructure?: {
    orderFlowImbalance: number;
    aggressionRatio: number;
    deltaVolumeSlope: number;
    midpricePressure: number;
    microAtr: number;
    trendStrength: number;
    priceVelocity: number;
    normalizedCloses: number[];
    normalizedVolumes: number[];
    rsiSequence: number[];
    obiSequence: number[];
    deltaRsi: number;
    deltaObi: number;
  };
};

// Utilities
function last<T>(arr: T[]): T {
  if (arr.length === 0) {
    throw new Error('Cannot get last element of empty array');
  }
  return arr[arr.length - 1];
}

function lastFiniteNumber(values: number[]): number | undefined {
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function resolveDirectionalIndicators(
  diPlusSeries: number[],
  diMinusSeries: number[],
): { diPlus?: number; diMinus?: number } {
  return {
    diPlus: lastFiniteNumber(diPlusSeries),
    diMinus: lastFiniteNumber(diMinusSeries),
  };
}
function pct(a: number, b: number) {
  if (b === 0) return 0; // Éviter division par zéro
  return (a - b) / b * 100;
}
function near(a: number, b: number, pPct: number) {
  return Math.abs(a - b) <= Math.abs(b) * (pPct / 100);
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function std(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / values.length;
  return Math.sqrt(Math.max(variance, 0));
}

function computeStochasticSeries(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
  smooth = 3,
): { k: number | null; d: number | null } {
  if (highs.length < period || lows.length < period || closes.length < period) {
    return { k: null, d: null };
  }
  const kValues: number[] = [];
  for (let i = period - 1; i < closes.length; i += 1) {
    const windowHigh = Math.max(...highs.slice(i - period + 1, i + 1));
    const windowLow = Math.min(...lows.slice(i - period + 1, i + 1));
    const close = closes[i];
    const denom = windowHigh - windowLow;
    const k = denom === 0 ? 50 : ((close - windowLow) / denom) * 100;
    kValues.push(k);
  }
  if (!kValues.length) {
    return { k: null, d: null };
  }
  const k = kValues.at(-1)!;
  const dSlice = kValues.slice(-smooth);
  const d = dSlice.length ? mean(dSlice) : k;
  return { k, d };
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

function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - meanX;
    num += dx * (values[i] - meanY);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

function computeMicrostructureFeatures(params: {
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  rsiSeries: number[];
}): TechnicalSnapshot['microstructure'] {
  const seqLen = 20;
  const closes = params.closes.slice(-seqLen);
  const highs = params.highs.slice(-seqLen);
  const lows = params.lows.slice(-seqLen);
  const volumes = params.volumes.slice(-seqLen);
  const rsiSeqRaw = params.rsiSeries.slice(-seqLen);
  const normalizedCloses = closes.map((value, idx) => {
    const ref = closes[0] || value || 1;
    return ref === 0 ? 0 : (value - ref) / Math.abs(ref);
  });
  const volumeBaseline = volumes.reduce((sum, value) => sum + value, 0) / Math.max(volumes.length, 1);
  const normalizedVolumes = volumes.map(value => {
    if (!Number.isFinite(value) || volumeBaseline === 0) return 0;
    return (value - volumeBaseline) / (Math.abs(volumeBaseline) + 1e-9);
  });
  const mfMultipliers: number[] = [];
  for (let i = 0; i < closes.length; i += 1) {
    const high = highs[i] ?? closes[i];
    const low = lows[i] ?? closes[i];
    const close = closes[i];
    const range = Math.max(1e-9, high - low);
    const multiplier = ((close - low) - (high - close)) / range;
    mfMultipliers.push(multiplier);
  }
  const orderFlowImbalance = mfMultipliers.reduce((sum, value) => sum + value, 0) / Math.max(mfMultipliers.length, 1);
  let positive = 0;
  let negative = 0;
  for (const value of mfMultipliers) {
    if (value >= 0) positive += value;
    else negative += Math.abs(value);
  }
  const aggressionRatio = positive + negative === 0 ? 0 : positive / (positive + negative);
  const volumeSlope = linearSlope(normalizedVolumes);
  const midPressure = mfMultipliers.reduce((sum, value) => sum + value, 0) / Math.max(mfMultipliers.length, 1);
  const trSeries: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const high = highs[i] ?? closes[i];
    const low = lows[i] ?? closes[i];
    const prevClose = closes[i - 1];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSeries.push(tr);
  }
  const lastClose = closes.at(-1) ?? closes[0] ?? 1;
  const microAtr = trSeries.length === 0 ? 0 : (trSeries.reduce((sum, value) => sum + value, 0) / trSeries.length) / Math.max(Math.abs(lastClose), 1e-9);
  const priceVelocity = linearSlope(closes.map(close => Math.log(Math.max(close, 1e-9))));
  const obiSequence: number[] = [];
  let obiCumulative = 0;
  for (const value of mfMultipliers) {
    obiCumulative += value;
    obiSequence.push(obiCumulative);
  }
  const rsiSequence = rsiSeqRaw.map(value => (Number.isFinite(value) ? (value - 50) / 50 : 0));
  const deltaRsi = rsiSequence.length >= 2 ? rsiSequence.at(-1)! - rsiSequence[0]! : 0;
  const deltaObi = obiSequence.length >= 2 ? obiSequence.at(-1)! - obiSequence[0]! : 0;
  return {
    orderFlowImbalance,
    aggressionRatio,
    deltaVolumeSlope: volumeSlope,
    midpricePressure: midPressure,
    microAtr,
    trendStrength: linearSlope(normalizedCloses),
    priceVelocity,
    normalizedCloses,
    normalizedVolumes,
    rsiSequence,
    obiSequence,
    deltaRsi,
    deltaObi,
  };
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
const pendingSnaps = new Map<string, Promise<TechnicalSnapshot>>(); // Share pending requests
const SNAP_TTL_MS = 1000 * 10; // 10s - Reduced from 15s for more frequent updates
const MAX_CACHE_SIZE = 1000; // Limit cache size to prevent memory leaks
const cacheKey = (symbol: string) => `snap_${symbol}`;
const MIN_MEANINGFUL_VOLUME = 1e-8; // effectively zero in base currency units

// Clean up old cache entries periodically
function cleanupCache() {
  const now = Date.now();
  
  // First, remove expired entries
  const entriesToDelete: string[] = [];
  for (const [key, entry] of snapCache.entries()) {
    if (now - entry.ts > SNAP_TTL_MS * 2) {
      entriesToDelete.push(key);
    }
  }
  
  for (const key of entriesToDelete) {
    snapCache.delete(key);
  }
  
  // If still at or above 90% capacity, remove oldest entries
  const targetSize = Math.floor(MAX_CACHE_SIZE * 0.8); // Clean down to 80%
  if (snapCache.size >= Math.floor(MAX_CACHE_SIZE * 0.9)) {
    const sortedEntries = Array.from(snapCache.entries()).sort((a, b) => a[1].ts - b[1].ts);
    const toDelete = sortedEntries.slice(0, Math.max(0, snapCache.size - targetSize));
    for (const [key] of toDelete) {
      snapCache.delete(key);
    }
  }
}

export async function ensureRecentVolumeIntegrity(options: {
  symbol: string;
  timeframe: string;
  ohlcv: number[][];
  minWindow: number;
  threshold: number;
  backfillAttempts: number;
  refetch: (limit: number, attempt: number) => Promise<number[][]>;
}): Promise<number[][]> {
  const { symbol, timeframe, minWindow, threshold, backfillAttempts, refetch } = options;
  let data = options.ohlcv;

  const evaluate = (series: number[][]) => {
    const window = series.slice(-Math.min(series.length, minWindow));
    const volumes = window.map((row) => row?.[5]);
    const zeroCount = volumes.filter((v) => v === 0).length;
    const nullCount = volumes.filter((v) => v == null).length;
    const invalidCount = zeroCount + nullCount;
    const windowSize = window.length;
    const ratio = windowSize > 0 ? invalidCount / windowSize : 0;
    return { ratio, zeroCount, nullCount, windowSize };
  };

  let attempt = 0;
  while (true) {
    const { ratio, zeroCount, nullCount, windowSize } = evaluate(data);
    if (windowSize === 0 || ratio < threshold) {
      return data;
    }

    console.warn(
      `[TECH SNAPSHOT] ${symbol}(${timeframe}): volume anomaly ratio=${ratio.toFixed(2)} zero=${zeroCount} null=${nullCount} attempt ${attempt}/${backfillAttempts}`,
    );

    if (attempt >= backfillAttempts) {
      throw new UnusableMarketDataError('Recent OHLCV volume is unusable', {
        symbol,
        timeframe,
        invalidRatio: ratio,
        windowSize,
        zeroCount,
        nullCount,
        attempts: attempt,
      });
    }

    attempt += 1;
    try {
      data = await refetch(data.length + 10, attempt);
    } catch (refetchError) {
      const errorMsg = refetchError instanceof Error ? refetchError.message : String(refetchError);
      if (errorMsg.includes('websocket_warmup_pending')) {
        throw new UnusableMarketDataError('Data source temporarily unavailable during warmup', {
          symbol,
          timeframe,
          invalidRatio: ratio,
          windowSize,
          zeroCount,
          nullCount,
          attempts: attempt,
        });
      }
      throw refetchError;
    }
  }
}

// Full technical snapshot for a symbol:
// - EMA20/50, RSI14, ATR14 & ATR%
// - 24h S/R + swing S/R
// - Daily pivots (P, S1, S2, R1, R2)
// - srBias: nearSupport | nearResistance | neutral (~0.6% window)
export async function buildTechSnapshot(symbol: string, userId?: string, options?: { bypassCache?: boolean }): Promise<TechnicalSnapshot>{
  try {
    // Allow bypassing cache for critical evaluations
    if (!options?.bypassCache) {
      const key = cacheKey(symbol);
      
      // Check if already computing for this symbol (share the promise)
      const pending = pendingSnaps.get(key);
      if (pending) {
        return pending;
      }
      
      // Check cache
      const cached = snapCache.get(key);
      if (cached && (Date.now() - cached.ts) < SNAP_TTL_MS) {
        return { ...(cached.data) };
      }
    }
  } catch (error) {
    console.warn(`[buildTechSnapshot] Cache read failed for ${symbol}:`, error);
  }
  
  // Create promise and store it to share with concurrent requests
  const key = cacheKey(symbol);
  const promise = buildTechSnapshotInternal(symbol, userId, options);
  
  // Store pending promise
  if (!options?.bypassCache) {
    pendingSnaps.set(key, promise);
    
    // Clean up when done (success or failure)
    promise.finally(() => {
      pendingSnaps.delete(key);
    });
  }
  
  return promise;
}

async function buildTechSnapshotInternal(symbol: string, userId?: string, options?: { bypassCache?: boolean }): Promise<TechnicalSnapshot>{
  const cfg = getConfig();
  const minBars15m = Math.max(50, Number(cfg.DIAGNOSTICS_MIN_BARS_15M || 100));
  // 15m window for reactivity (~2 days), 1h for pivots/daily
  let o15: number[][];
  try {
    o15 = await getOHLCV(symbol, '15m', Math.max(300, minBars15m), userId); // [ts, o, h, l, c, v]
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('websocket_warmup_pending')) {
      const warmup = getOhlcvWarmupState(symbol, '15m');
      throw new InsufficientDataError('WebSocket warmup in progress', {
        symbol,
        timeframe: '15m',
        availableBars: 0,
        minBarsNeeded: minBars15m,
        firstBarAt: null,
        lastBarAt: null,
        warmupState: warmup,
      });
    }
    throw error; // Re-throw other errors
  }
  
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

  const failFastThreshold = Math.max(0, Math.min(1, cfg.OHLCV_FAILFAST_THRESHOLD ?? 0.2));
  const backfillRetry = Math.max(0, Math.floor(cfg.OHLCV_BACKFILL_RETRY ?? 1));
  const MIN_VOLUME_WINDOW = 30;

  o15 = await ensureRecentVolumeIntegrity({
    symbol,
    timeframe: '15m',
    ohlcv: o15,
    minWindow: MIN_VOLUME_WINDOW,
    threshold: failFastThreshold,
    backfillAttempts: backfillRetry,
    async refetch(limit, attempt) {
      const baseLimit = Math.max(300, minBars15m);
      const computedLimit = Math.max(limit, baseLimit + attempt * 10);
      const preferWebSocket = attempt === 0;
      return getOHLCV(symbol, '15m', computedLimit, userId, {
        preferWebSocket,
        allowSyntheticFallback: preferWebSocket,
      });
    },
  });

  const o1hPromise = getOHLCV(symbol, '1h', 600, userId).catch(error => {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('websocket_warmup_pending')) {
      console.warn(`[buildTechSnapshot] 1h data not ready for ${symbol}, will fallback to 15m`);
      return null;
    }
    throw error;
  });
  
  const o4hPromise = getOHLCV(symbol, '4h', 600, userId).catch(error => {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('websocket_warmup_pending')) {
      console.warn(`[buildTechSnapshot] 4h data not ready for ${symbol}, will fallback to lower timeframe`);
      return null;
    }
    throw error;
  });

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
  const ema9Arr = ema(closes15, 9);
  const ema12Arr = ema(closes15, 12);
  const ema20Arr = ema(closes15, 20);
  const ema26Arr = ema(closes15, 26);
  const ema50Arr = ema(closes15, 50);
  const ema100Arr = ema(closes15, 100);
  const ema200Arr = ema(closes15, 200);
  const ema9v = ema9Arr.length ? ema9Arr.at(-1)! : lastPrice;
  const ema12v = ema12Arr.length ? ema12Arr.at(-1)! : lastPrice;
  const ema20v = last(ema20Arr);
  const ema26v = ema26Arr.length ? ema26Arr.at(-1)! : ema20v;
  const ema50v = last(ema50Arr);
  const ema100v = ema100Arr.length ? ema100Arr.at(-1)! : ema20v;
  const ema200v = ema200Arr.length ? ema200Arr.at(-1)! : ema50v;
  const ema20Slope = ema20Arr.length >= 2 ? ema20Arr.at(-1)! - ema20Arr.at(-2)! : 0;
  const ema50Slope = ema50Arr.length >= 2 ? ema50Arr.at(-1)! - ema50Arr.at(-2)! : 0;
  const emaTrendSpread = Number.isFinite(ema20v) && Number.isFinite(ema50v) && Math.abs(ema50v) > 1e-9
    ? (ema20v - ema50v) / ema50v
    : 0;
  const emaRatio9_20 = ema20v !== 0 ? ema9v / ema20v : 0;
  const emaRatio20_200 = ema200v !== 0 ? ema20v / ema200v : 0;
  const emaRatio50_200 = ema200v !== 0 ? ema50v / ema200v : 0;
  const rsi14Arr = rsi(closes15, 14);
  const rsi14v = rsi14Arr[rsi14Arr.length - 1] ?? 50;
  const rsiPrev = rsi14Arr.length >= 2 ? rsi14Arr[rsi14Arr.length - 2] ?? rsi14v : rsi14v;
  const rsiSlope = rsi14v - rsiPrev;
  const rsi7Arr = rsi(closes15, 7);
  const rsi21Arr = rsi(closes15, 21);
  const rsi7v = rsi7Arr.length ? rsi7Arr.at(-1)! : rsi14v;
  const rsi21v = rsi21Arr.length ? rsi21Arr.at(-1)! : rsi14v;
  const atr14Arr = atr(o15, 14);
  const atr14v = atr14Arr[atr14Arr.length - 1] ?? 0;
  const atr7Arr = atr(o15, 7);
  const atr7v = atr7Arr.length ? atr7Arr.at(-1)! : atr14v;
  const atrPct = (atr14v / lastPrice) * 100;
  const adx14Arr = adx(o15, 14);
  const adx14v = adx14Arr[adx14Arr.length - 1] ?? 0;
  const { plusDi: diPlusArr, minusDi: diMinusArr } = dmi(o15, 14);
  const { diPlus: diPlusVal, diMinus: diMinusVal } = resolveDirectionalIndicators(diPlusArr, diMinusArr);
  const adxPos14 = diPlusArr.length ? diPlusArr.at(-1)! : diPlusVal ?? 0;
  const adxNeg14 = diMinusArr.length ? diMinusArr.at(-1)! : diMinusVal ?? 0;
  // CMF20 (15m)
  const cmf20v = chaikinMoneyFlow(highs15, lows15, closes15, volumes15, 20);
  // Volume baseline: use EMA20 of 15m volumes for responsiveness
  const volEma20 = ema(volumes15, 20);
  const latestVol = volumes15.length ? volumes15[volumes15.length - 1] : 0;
  const volMA = volEma20.length ? volEma20[volEma20.length - 1] : 0;
  const volumeRatio = volMA > 0 ? latestVol / volMA : 0;
  const volumeWindow = volumes15.slice(-40);
  const volumeMean40 = volumeWindow.reduce((sum, value) => sum + value, 0) / Math.max(1, volumeWindow.length);
  const volumeStd40 = Math.sqrt(
    volumeWindow.reduce((sum, value) => sum + Math.pow(value - volumeMean40, 2), 0) / Math.max(1, volumeWindow.length),
  );
  const volumeZScore = volumeStd40 > 1e-12 ? (latestVol - volumeMean40) / volumeStd40 : 0;
  function momentumOver(period: number): number {
    if (closes15.length <= period) return 0;
    const reference = closes15[closes15.length - period - 1];
    if (!reference) return 0;
    return (lastPrice - reference) / reference;
  }

  const momentum3 = momentumOver(3);
  const momentum5 = momentumOver(5);
  const momentum10 = momentumOver(10);
  const momentum20 = momentumOver(20);

  const bbPeriod = 20;
  const bbWindow = closes15.slice(-bbPeriod);
  const bbMean = bbWindow.length ? mean(bbWindow) : lastPrice;
  const bbStd = bbWindow.length ? std(bbWindow) : 0;
  const bbUpper = bbMean + 2 * bbStd;
  const bbLower = bbMean - 2 * bbStd;
  const bbWidth = bbMean !== 0 ? (bbUpper - bbLower) / bbMean : 0;
  const bbPosition = bbUpper !== bbLower ? (lastPrice - bbLower) / (bbUpper - bbLower) : 0.5;

  const macdSeries = ema12Arr.map((value, idx) => value - (ema26Arr[idx] ?? value));
  const macdValue = macdSeries.length ? macdSeries.at(-1)! : 0;
  const macdSignalSeries = macdSeries.length ? ema(macdSeries, 9) : [];
  const macdSignalValue = macdSignalSeries.length ? macdSignalSeries.at(-1)! : 0;
  const macdDiffValue = macdValue - macdSignalValue;

  const stochastic = computeStochasticSeries(highs15, lows15, closes15, 14, 3);
  const stochK = stochastic.k ?? 50;
  const stochD = stochastic.d ?? stochK;

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
  } catch (error) {
    console.warn(`[VOLUME CLARITY] Failed to log volume clarity for ${symbol}:`, error);
  }

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

  const atrPctRatios: number[] = [];
  const atr14Offset = closes15.length - atr14Arr.length;
  for (let i = 0; i < atr14Arr.length; i += 1) {
    const closeIdx = Math.min(closes15.length - 1, Math.max(0, atr14Offset + i));
    const close = closes15[closeIdx] || lastPrice;
    atrPctRatios.push(close ? atr14Arr[i] / close : 0);
  }
  const volatilityRegime = atrPctRatios.length ? mean(atrPctRatios.slice(-20)) * 100 : atrPct;

  const obvSeries: number[] = [];
  let obv = 0;
  for (let i = 1; i < closes15.length; i += 1) {
    const current = closes15[i];
    const previous = closes15[i - 1];
    const vol = volumes15[i] ?? 0;
    if (current > previous) obv += vol;
    else if (current < previous) obv -= vol;
    obvSeries.push(obv);
  }
  const obvSlope = obvSeries.length ? obvSeries.at(-1)! - (obvSeries.at(-2) ?? 0) : 0;

  const momentum3Series: number[] = [];
  for (let i = 3; i < closes15.length; i += 1) {
    const reference = closes15[i - 3];
    const value = reference ? (closes15[i] - reference) / reference : 0;
    momentum3Series.push(value);
  }
  const microImbalance = momentum3Series.length ? mean(momentum3Series.slice(-5)) : momentum3;

  const atrPctRatio = atrPct / 100;
  const volAdjustedMomentum = atrPctRatio !== 0 ? momentum10 / Math.max(Math.abs(atrPctRatio), 1e-6) : 0;
  const rsiEmaDiv = (rsi14v - 50) * Math.sign(ema20Slope || 0);
  const volPriceConfirmation = Math.sign(momentum3) * volumeRatio;
  const spreadProxy = (() => {
    const lastBar = o15.at(-1);
    if (!lastBar || !lastPrice) return 0;
    const high = Number(lastBar[2] || 0);
    const low = Number(lastBar[3] || 0);
    if (lastPrice === 0) return 0;
    return (high - low) / lastPrice;
  })();
  const distEma20 = lastPrice ? (lastPrice - ema20v) / lastPrice : 0;
  const distEma50 = lastPrice ? (lastPrice - ema50v) / lastPrice : 0;
  const distEma200 = lastPrice ? (lastPrice - ema200v) / lastPrice : 0;
  const mtfAgreement = Math.sign(ema20v - ema50v) + Math.sign(ema50v - ema100v) + Math.sign(ema100v - ema200v);

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
  const [o1h, o4h] = await Promise.all([o1hPromise, o4hPromise]);
  const atr1hArr = atr(o1h || o15, 14);
  const atr1h = atr1hArr.at(-1) ?? undefined;
  const atr4hArr = atr(o4h || o1h || o15, 14);
  const atr4h = atr4hArr.at(-1) ?? undefined;
  const ohlcv1hSource = Array.isArray(o1h) && o1h.length ? o1h : o15;
  const closes1h = ohlcv1hSource.map(c => Number(c[4] ?? 0));
  const rsi1hArr = rsi(closes1h, 14);
  const rsi1h = rsi1hArr.at(-1) ?? undefined;
  const ohlcv4hSource = Array.isArray(o4h) && o4h.length ? o4h : ohlcv1hSource;
  const closes4h = ohlcv4hSource.map(c => Number(c[4] ?? 0));
  const rsi4hArr = rsi(closes4h, 14);
  const rsi4h = rsi4hArr.at(-1) ?? undefined;
  const lastPrice1h = Number((o1h && o1h.length ? o1h.at(-1)?.[4] : undefined) ?? lastPrice) || lastPrice;
  const lastPrice4h = Number((o4h && o4h.length ? o4h.at(-1)?.[4] : undefined) ?? lastPrice1h) || lastPrice1h;
  const atrPct1h = atr1h && lastPrice1h ? (atr1h / lastPrice1h) * 100 : undefined;
  const atrPct4h = atr4h && lastPrice4h ? (atr4h / lastPrice4h) * 100 : undefined;
  const pivots = dailyPivotsFromOHLCV(o1h || o15);

  let multiTimeframe: MultiTimeframeDiagnostics | undefined;
  try {
    const preloaded: Record<string, number[][]> = {
      '15m': o15,
    };
    if (Array.isArray(o1h) && o1h.length) {
      preloaded['1h'] = o1h;
    }
    if (Array.isArray(o4h) && o4h.length) {
      preloaded['4h'] = o4h;
    }
    multiTimeframe = await computeMultiTimeframeDiagnostics(symbol, { preloaded, userId });
  } catch (error) {
    console.warn(`⚠️ Failed to compute multi-timeframe diagnostics for ${symbol}:`, error);
  }

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
    ema9: ema9v,
    ema12: ema12v,
    ema20: ema20v,
    ema26: ema26v,
    ema50: ema50v,
    ema100: ema100v,
    ema200: ema200v,
    rsi14: rsi14v,
    rsi7: rsi7v,
    rsi21: rsi21v,
    atr14: atr14v,
    atr14_1h: atr1h,
    atr14_4h: atr4h,
    atrPct,
    atrPct1h,
    atrPct4h,
    adx14: adx14v,
    ema20Slope,
    ema50Slope,
    emaTrendSpread,
    emaRatio9_20,
    emaRatio20_200,
    emaRatio50_200,
    diPlus14: diPlusVal,
    diMinus14: diMinusVal,
    support: primarySupport,
    resistance: primaryResistance,
    supports,       // [{ price, label, touches, strength }, ...] sorted by proximity
    resistances,    // idem
    pivots,         // { P,S1,S2,R1,R2,refDay } | null
    trend,
    srBias,
    meta: {
      tf: '15m',  // exécution
      contextTf: '4h', // 🆕 contexte
      windowBars: o15.length,
      recentBarsFor24h: recent.length,
    },
    realizedVol,
    hurst,
    adxSlope,
    trendStrength,
    trendBias,
    rsiSlope,
    // Provide both instantaneous and smoothed volume for diagnostics
    volume: latestVol,
    volumeMA: volMA || avgVolume,
    volumeZScore,
    volumeAvg: avgVolume,
    volume24h: recentVolumeUSD, // Volume in USD (tokens * price)
    volume24hChangePct: volumeChangePct,
    cmf20: cmf20v,
    momentum3,
    momentum5,
    momentum10,
    momentum20,
    atr7: atr7v,
    bbWidth,
    bbPosition,
    volatilityRegime,
    volumeRatio,
    stochK,
    stochD,
    macd: macdValue,
    macdSignal: macdSignalValue,
    macdDiff: macdDiffValue,
    obvSlope,
    volPriceConfirmation,
    spreadProxy,
    distEma20,
    distEma50,
    distEma200,
    rsi14_1h: rsi1h,
    rsi14_4h: rsi4h,
    microImbalance,
    mtfAgreement,
    volAdjustedMomentum,
    rsiEmaDiv,
    multiTimeframe,
  };

  snapshot.microstructure = computeMicrostructureFeatures({
    closes: closes15,
    highs: highs15,
    lows: lows15,
    volumes: volumes15,
    rsiSeries: rsi14Arr,
  });

  snapshot.regime = classifyRegime(snapshot);

  try { 
    // Cleanup cache periodically to prevent memory leaks
    if (snapCache.size >= Math.floor(MAX_CACHE_SIZE * 0.9)) {
      cleanupCache();
    }
    if (!options?.bypassCache) {
      snapCache.set(cacheKey(symbol), { ts: Date.now(), data: snapshot }); 
    }
  } catch (error) {
    console.warn(`[buildTechSnapshot] Cache write failed for ${symbol}:`, error);
  }
  return snapshot;
}
