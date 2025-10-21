import { ema, rsi } from '../data/indicators.js';
import { getOHLCV } from '../data/market.js';

type TfMetrics = {
  tf: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  momentumPct: number;
  rsi: number;
  adx?: number;
};

export type Diagnostics = {
  timeframes: Record<string, TfMetrics>;
  agreementScore: number;
  divergenceScore: number;
};

const cache = new Map<string, { diag: Diagnostics; ts: number }>();
const TTL_MS = 60 * 1000;

type PreloadedSeries = Partial<Record<string, number[][]>>;

export type ComputeMultiTimeframeOptions = {
  preloaded?: PreloadedSeries;
  userId?: string;
};

function computeBias(closes: number[]): 'bullish' | 'bearish' | 'neutral' {
  if (closes.length < 30) return 'neutral';
  const fast = ema(closes, 10).at(-1) ?? closes.at(-1)!;
  const slow = ema(closes, 30).at(-1) ?? closes.at(-1)!;
  const diff = ((fast - slow) / slow) * 100;
  if (Math.abs(diff) < 0.1) return 'neutral';
  return diff > 0 ? 'bullish' : 'bearish';
}

async function computeTf(
  symbol: string,
  tf: string,
  limit = 200,
  options?: ComputeMultiTimeframeOptions,
): Promise<TfMetrics> {
  const preloaded = options?.preloaded?.[tf];
  const source = Array.isArray(preloaded) && preloaded.length ? preloaded : null;
  const ohlcv = source ?? await getOHLCV(symbol, tf, limit, options?.userId);
  if (!ohlcv?.length) {
    return { tf, bias: 'neutral', momentumPct: 0, rsi: 50 };
  }
  const closes = ohlcv.map(row => Number(row[4] || 0));
  const last = closes.at(-1) ?? 0;
  const prev = closes.at(-2) ?? last;
  const momentumPct = prev ? ((last - prev) / prev) * 100 : 0;
  const bias = computeBias(closes);
  const rsiArr = rsi(closes, 14);
  const rsiVal = rsiArr.at(-1) ?? 50;
  return {
    tf,
    bias,
    momentumPct,
    rsi: rsiVal,
  };
}

function computeScores(metrics: TfMetrics[]): Diagnostics {
  let bullish = 0;
  let bearish = 0;
  let neutral = 0;
  for (const metric of metrics) {
    if (metric.bias === 'bullish') bullish += 1;
    else if (metric.bias === 'bearish') bearish += 1;
    else neutral += 1;
  }
  const agreementScore = Math.max(bullish, bearish);
  const divergenceScore = bullish && bearish ? bullish + bearish : Math.max(0, neutral - 1);
  const timeframes: Record<string, TfMetrics> = {};
  metrics.forEach(m => { timeframes[m.tf] = m; });
  return {
    timeframes,
    agreementScore,
    divergenceScore,
  };
}

export async function computeMultiTimeframeDiagnostics(
  symbol: string,
  options?: ComputeMultiTimeframeOptions,
): Promise<Diagnostics> {
  const useCache = !options?.preloaded;
  if (useCache) {
    const cached = cache.get(symbol);
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.diag;
  }

  const metrics = await Promise.all([
    computeTf(symbol, '4h', 240, options),
    computeTf(symbol, '1h', 240, options),
    computeTf(symbol, '15m', 300, options),
    computeTf(symbol, '5m', 240, options),
  ]);

  const diag = computeScores(metrics);
  if (useCache) {
    cache.set(symbol, { diag, ts: Date.now() });
  }
  return diag;
}
