import { buildTechSnapshot } from './tech.js';
import { getOHLCV, getTicker } from '../data/market.js';
import { ema, rsi, atr } from '../data/indicators.js';
import { llmJSON } from './llm.js';
import { getConfig } from '../utils/env.js';
// Track per-symbol daily Grok usage (in-memory)
const GROK_DAILY: Map<string, number> = new Map();
const ANALYSIS_CACHE = new Map<string,{ ts:number, data:any }>();
const ANALYSIS_TTL = Number(process.env.ANALYSIS_TTL_MIN || 360) * 60 * 1000;
export async function fullAnalysis(symbol: string) {
  // technical snapshot
  const technical = await buildTechSnapshot(symbol);
  const hit = ANALYSIS_CACHE.get(symbol);
  const now = Date.now();
  if (hit && now - hit.ts < ANALYSIS_TTL) return hit.data;


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
      .trim(), { cacheKey: `sentiment:${symbol}`, ttlMin: Number(process.env.ANALYSIS_TTL_MIN || 360), provider: useGrok ? 'grok' : undefined }
    );
    sentiment = JSON.parse(s);
  } catch {}

  try {
    const n = await llmJSON(
      `You are a crypto news summarizer. Summarize top potential narratives affecting ${symbol} in the last 24-48h (macro, ETF, exchange events, dev updates). If unknown, state uncertainty. Return JSON: {"summary":"...","bullets":["...","...","..."]}`
      .trim(), { cacheKey: `news:${symbol}`, ttlMin: Number(process.env.ANALYSIS_TTL_MIN || 360), provider: useGrok ? 'grok' : undefined }
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
  const out = { symbol, technical, indicators, sentiment, news, ticker };
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
