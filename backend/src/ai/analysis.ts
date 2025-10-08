import { buildTechSnapshot } from './tech.js';
import { getOHLCV, getTicker } from '../data/market.js';
import { ema, rsi, atr } from '../data/indicators.js';
import { llmJSON } from './llm.js';
import { getConfig } from '../utils/env.js';
import { getHybridSentiment } from '../sentiment/index.js';
import { isInsufficientDataError } from '../data/errors.js';
// Track per-symbol daily Grok usage (in-memory)
const GROK_DAILY: Map<string, number> = new Map();
const ANALYSIS_CACHE = new Map<string,{ ts:number, data:any }>();
const ANALYSIS_TTL = Number(process.env.ANALYSIS_TTL_MIN || 360) * 60 * 1000;
export async function fullAnalysis(symbol: string) {
  let technical;
  try {
    technical = await buildTechSnapshot(symbol);
  } catch (error) {
    if (isInsufficientDataError(error)) {
      const now = Date.now();
      const warmup = {
        ...error.meta,
        firstBarAtIso: error.meta.firstBarAt ? new Date(error.meta.firstBarAt).toISOString() : null,
        lastBarAtIso: error.meta.lastBarAt ? new Date(error.meta.lastBarAt).toISOString() : null,
        retryMs: error.meta.warmupState?.nextRetryTs ? Math.max(0, error.meta.warmupState.nextRetryTs - now) : undefined,
      };
      const payload = {
        symbol,
        dataReady: false,
        phase: 'warming',
        reason: 'data.insufficient_bars',
        errorCode: 'data.insufficient_bars',
        warmup,
        technical: null,
      };
      const warmupTtlMs = 15_000;
      ANALYSIS_CACHE.set(symbol, { ts: now - (ANALYSIS_TTL - warmupTtlMs), data: payload });
      return payload;
    }
    throw error;
  }
  const hit = ANALYSIS_CACHE.get(symbol);
  const now = Date.now();
  if (hit && now - hit.ts < ANALYSIS_TTL) return hit.data;

  // Data readiness guard: avoid mixing invalid 15m with valid 1h and producing incoherent output
  const vol = Number((technical as any)?.volume || 0);
  const volMA = Number((technical as any)?.volumeMA || 0);
  const lastPx = Number((technical as any)?.last || 0);
  const dataReady = lastPx > 0 && (vol > 0 || volMA > 0);
  if (!dataReady) {
    const out = {
      symbol,
      technical,
      indicators: null,
      sentiment: null,
      news: null,
      ticker: null,
      sentimentSources: [],
      projection: null,
      dataReady: false,
      reason: 'waiting_for_market_data'
    } as any;
    ANALYSIS_CACHE.set(symbol, { ts: now, data: out });
    return out;
  }


  // extra indicators (different timeframes if needed)
  const o = await getOHLCV(symbol, '1h', 200);
  const c = o.map(r => r[4]);
  const indicators = {
    ema20: ema(c,20).at(-1),
    ema50: ema(c,50).at(-1),
    rsi14: rsi(c,14).at(-1),
    atr14: atr(o,14).at(-1),
  };

  // sentiment + news via LLM (can be enriched with external sources)
  const base = {
    symbol,
    last: technical.last,
    rsi14: technical.rsi14,
    trend: technical.ema20 - technical.ema50,
    atrPct: technical.atrPct,
    srBias: technical.srBias,
  };

  let sentiment:any = null, news:any = null;
  const sentimentSources:any[] = [];
  let hybridSentiment: any = null;
  try {
    hybridSentiment = await getHybridSentiment(symbol);
    if (hybridSentiment) {
      sentimentSources.push({
        source: 'hybrid',
        score: hybridSentiment.score,
        label: hybridSentiment.label,
        confidence: hybridSentiment.confidence,
        fetchedAt: hybridSentiment.fetchedAt,
        providers: hybridSentiment.sources,
      });
    }
  } catch (error) {
    console.warn('Hybrid sentiment failed:', error);
  }

  const cfg = getConfig();
  // decide whether to use Grok today (once/day) or if major reversal
  let useGrok = false;
  let tickerPct: number | null = null;
  try {
    const t = await getTicker(symbol);
    tickerPct = Number(t?.percentage ?? 0);
  } catch {}
  if (cfg.USE_GROK_FOR_ANALYSIS) {
    const day = new Date().toISOString().slice(0,10);
    const key = `${symbol}:${day}`;
    const used = GROK_DAILY.get(key) || 0;
    const major = tickerPct != null ? Math.abs(tickerPct) >= cfg.GROK_REVERSAL_PCT_THRESHOLD : false;
    useGrok = (used < cfg.GROK_ANALYSIS_DAILY_MAX) || major;
  }
  try {
    const s = await llmJSON(
      `You are a crypto market sentiment analyzer. Given the context, estimate sentiment for ${symbol} now (bullish/bearish/neutral) and give a 0..1 score + 3 bullets. Return JSON: {"label":"bullish|bearish|neutral","score":0.0-1.0,"bullets":["...","...","..."]}\nContext: ${JSON.stringify(base)}`
      .trim(), { cacheKey: `sentiment:${symbol}`, ttlMin: Number(process.env.ANALYSIS_TTL_MIN || 360), provider: useGrok ? 'grok' : undefined, context: { symbol, kind: 'analysis_sentiment' } }
    );
    sentiment = JSON.parse(s);
    sentimentSources.push({ source: 'llm', ...sentiment });
  } catch {}

  try {
    const n = await llmJSON(
      `You are a crypto news summarizer. Summarize top potential narratives affecting ${symbol} in the last 24-48h (macro, ETF, exchange events, dev updates). If unknown, state uncertainty. Return JSON: {"summary":"...","bullets":["...","...","..."]}`
      .trim(), { cacheKey: `news:${symbol}`, ttlMin: Number(process.env.ANALYSIS_TTL_MIN || 360), provider: useGrok ? 'grok' : undefined, context: { symbol, kind: 'analysis_news' } }
    );
    news = JSON.parse(n);
  } catch {}

  // Fallbacks when LLM is disabled/unavailable
  if (!sentiment) {
    try {
      const rsi = Number(technical.rsi14 || 50);
      const tr = Number(technical.ema20 - technical.ema50);
      const bullish = rsi >= 60 && tr > 0;
      const bearish = rsi <= 40 && tr < 0;
      const label = bullish ? 'bullish' : bearish ? 'bearish' : 'neutral';
      const score = bullish ? Math.min(1, 0.55 + Math.min(0.25, Math.abs(tr)/(technical.last||1)))
                   : bearish ? Math.min(1, 0.55 + Math.min(0.25, Math.abs(tr)/(technical.last||1)))
                   : 0.5;
      sentiment = {
        label,
        score: Number(score.toFixed(2)),
        bullets: [
          `RSI14 at ${rsi.toFixed(1)} suggests ${rsi>=50?'momentum':'weakness'}`,
          `EMA20-EMA50 ${tr>=0?'positive':'negative'} (${tr.toFixed(2)})`,
          `ATR% ${Number(technical.atrPct||0).toFixed(2)} — volatility context`
        ]
      };
    } catch {}
  }

  if (hybridSentiment || sentiment) {
    const combined = combineSentiments(hybridSentiment, sentiment);
    sentiment = combined.sentiment;
    if (combined.extra) sentimentSources.push(...combined.extra);
  }

  if (!news) {
    try {
      news = {
        summary: `No curated news available. Falling back to technical context for ${symbol}. Consider exchange updates and macro catalysts; verify with external sources.`,
        bullets: [
          `24h momentum proxy: ${Number(technical.trend || (technical.ema20-technical.ema50)).toFixed?.(2)}`,
          `S/R bias: ${technical.srBias}`,
          `ATR%: ${Number(technical.atrPct||0).toFixed(2)} (volatility)`
        ]
      };
    } catch {}
  }
  let ticker: any = null;
  try {
    if (tickerPct == null) {
      const t = await getTicker(symbol);
      tickerPct = Number(t?.percentage ?? 0);
      ticker = { last: t?.last, percentage: t?.percentage, baseVolume: t?.baseVolume };
    }
  } catch {}
  const price = Number(technical?.last ?? ticker?.last ?? 0);
  const projection = computeProjection(technical, sentiment, price);
  const out = { symbol, technical, indicators, sentiment, news, ticker, sentimentSources, projection };
  ANALYSIS_CACHE.set(symbol, { ts: now, data: out });
  try {
    if (useGrok) {
      const day = new Date().toISOString().slice(0,10);
      const key = `${symbol}:${day}`;
      const used = GROK_DAILY.get(key) || 0;
      GROK_DAILY.set(key, used + 1);
    }
  } catch {}
  return out;
}

function combineSentiments(hybrid: any, llm: any) {
  if (!hybrid && !llm) return { sentiment: null, extra: [] };
  if (hybrid && !llm) {
    return {
      sentiment: {
        label: hybrid.label,
        score: hybrid.score,
        confidence: hybrid.confidence,
        bullets: buildHybridBullets(hybrid),
      },
      extra: [],
    };
  }
  if (!hybrid && llm) {
    return { sentiment: llm, extra: [] };
  }

  const sources: any[] = [];
  if (hybrid) sources.push({ source: 'hybrid', score: hybrid.score, label: hybrid.label, confidence: hybrid.confidence });
  if (llm) sources.push({ source: 'llm', score: llm.score, label: llm.label });

  const avgScore = (Number(hybrid?.score ?? 0.5) + Number(llm?.score ?? 0.5)) / 2;
  let label: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  const votes = [hybrid?.label, llm?.label].filter(Boolean);
  const bulls = votes.filter((x) => x === 'bullish').length;
  const bears = votes.filter((x) => x === 'bearish').length;
  if (bulls > bears) label = 'bullish';
  else if (bears > bulls) label = 'bearish';
  else if (avgScore > 0.55) label = 'bullish';
  else if (avgScore < 0.45) label = 'bearish';

  const bullets: string[] = [];
  if (Array.isArray(llm?.bullets)) bullets.push(...llm.bullets.slice(0, 2));
  if (hybrid) {
    bullets.push(...buildHybridBullets(hybrid).slice(0, 2));
  }

  const sentiment = {
    label,
    score: Number(avgScore.toFixed(3)),
    confidence: hybrid?.confidence ?? undefined,
    bullets,
  };

  return { sentiment, extra: sources };
}

function buildHybridBullets(hybrid: any): string[] {
  const bullets: string[] = [];
  if (hybrid?.sources?.length) {
    const provider = hybrid.sources[0];
    if (provider?.mentions != null) {
      bullets.push(`Mentions: ${provider.mentions}`);
    }
    if (provider?.velocity != null) {
      bullets.push(`Sentiment velocity: ${(provider.velocity * 100).toFixed(1)}%`);
    }
    if (Array.isArray(provider?.keywords) && provider.keywords.length) {
      bullets.push(`Hot keywords: ${provider.keywords.slice(0, 3).join(', ')}`);
    }
  }
  bullets.push(`Hybrid score ${(hybrid?.score ?? 0.5).toFixed(2)} (${hybrid?.label || 'neutral'})`);
  return bullets;
}

function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function computeProjection(technical: any, sentiment: any, price: number) {
  if (!technical || !Number.isFinite(price) || price <= 0) return null;

  const atrPct = Number(technical.atrPct ?? 0);
  const realizedVol = Number(technical.realizedVol ?? 0);
  let rangePct = Math.max(
    atrPct > 0 ? atrPct * Math.sqrt(24) : 0,
    realizedVol > 0 ? realizedVol : 0,
    atrPct > 0 ? atrPct * 3 : 0
  );
  if (!Number.isFinite(rangePct) || rangePct <= 0) rangePct = atrPct > 0 ? atrPct * 2 : 1;
  rangePct = clamp(rangePct, 0.5, 25);

  const ema20 = Number(technical.ema20 ?? price);
  const ema50 = Number(technical.ema50 ?? price);
  const emaSpreadPct = Number.isFinite(ema50) && Math.abs(ema50) > 1e-6
    ? ((ema20 - ema50) / Math.abs(ema50)) * 100
    : 0;
  const emaSlope = Number(technical.ema20Slope ?? 0);
  const emaSlopePct = Math.abs(ema20) > 1e-6 ? (emaSlope / Math.abs(ema20)) * 100 : 0;
  const srBias = technical.srBias;
  const adx = Number(technical.adx14 ?? 0);

  let biasScore = 0;
  if (emaSpreadPct > 0.5) biasScore += 0.35;
  if (emaSpreadPct < -0.5) biasScore -= 0.35;
  if (emaSlopePct > 0.03) biasScore += 0.2;
  if (emaSlopePct < -0.03) biasScore -= 0.2;
  if (srBias === 'nearSupport') biasScore += 0.1;
  if (srBias === 'nearResistance') biasScore -= 0.1;
  if (technical?.trendStrength != null) {
    const trendStrength = Number(technical.trendStrength);
    biasScore += clamp(trendStrength / 10, -0.25, 0.25);
  }
  if (sentiment?.score != null) {
    const sentimentDelta = clamp((Number(sentiment.score) - 0.5) * 1.2, -0.7, 0.7);
    biasScore += sentimentDelta;
  }
  biasScore = clamp(biasScore, -1, 1);

  const biasDirection = biasScore > 0.2 ? 'bullish' : biasScore < -0.2 ? 'bearish' : 'neutral';

  const adxComponent = clamp(adx / 40, 0, 1);
  const slopeComponent = clamp(Math.abs(emaSlopePct) / 0.08, 0, 1);
  const spreadComponent = clamp(Math.abs(emaSpreadPct) / 2.0, 0, 1);
  const sentimentComponent = clamp(Math.abs((Number(sentiment?.score ?? 0.5)) - 0.5) * 2, 0, 1);
  const biasComponent = clamp(Math.abs(biasScore), 0, 1);

  const confidence = Number(clamp(
    (biasComponent * 0.35) +
    (adxComponent * 0.25) +
    (slopeComponent * 0.15) +
    (sentimentComponent * 0.15) +
    (spreadComponent * 0.10),
    0.15,
    0.95
  ).toFixed(3));

  const baseHalfRangePct = rangePct / 2;
  const upPct = Number((baseHalfRangePct * (1 + Math.max(0, biasScore))).toFixed(2));
  const downPct = Number((baseHalfRangePct * (1 + Math.max(0, -biasScore))).toFixed(2));
  const rangeUpPrice = Number((price * (1 + upPct / 100)).toFixed(price >= 2 ? 4 : 6));
  const rangeDownPriceRaw = price * (1 - downPct / 100);
  const rangeDownPrice = Number(Math.max(rangeDownPriceRaw, 0).toFixed(price >= 2 ? 4 : 6));

  return {
    rangePct: Number(rangePct.toFixed(2)),
    rangeUpPct: upPct,
    rangeDownPct: downPct,
    rangeUpPrice,
    rangeDownPrice,
    biasDirection,
    biasScore: Number(biasScore.toFixed(3)),
    confidence,
    components: {
      adx: Number(adxComponent.toFixed(3)),
      slope: Number(slopeComponent.toFixed(3)),
      spread: Number(spreadComponent.toFixed(3)),
      sentiment: Number(sentimentComponent.toFixed(3)),
      bias: Number(biasComponent.toFixed(3)),
    }
  };
}
