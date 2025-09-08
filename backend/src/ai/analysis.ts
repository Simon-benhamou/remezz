import { buildTechSnapshot } from './tech.js';
import { getOHLCV, getTicker } from '../data/market.js';
import { ema, rsi, atr } from '../data/indicators.js';
import { llmJSON } from './llm.js';
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
  try {
    const s = await llmJSON(
      `You are a crypto market sentiment analyzer. Given the context, estimate sentiment for ${symbol} now (bullish/bearish/neutral) and give a 0..1 score + 3 bullets. Return JSON: {"label":"bullish|bearish|neutral","score":0.0-1.0,"bullets":["...","...","..."]}\nContext: ${JSON.stringify(base)}`
      .trim()
    );
    sentiment = JSON.parse(s);
  } catch {}

  try {
    const n = await llmJSON(
      `You are a crypto news summarizer. Summarize top potential narratives affecting ${symbol} in the last 24-48h (macro, ETF, exchange events, dev updates). If unknown, state uncertainty. Return JSON: {"summary":"...","bullets":["...","...","..."]}`
      .trim()
    );
    news = JSON.parse(n);
  } catch {}
  let ticker: any = null;
  try {
    const t = await getTicker(symbol);
    ticker = { last: t?.last, percentage: t?.percentage, baseVolume: t?.baseVolume };
  } catch {}
  const out = { symbol, technical, indicators, sentiment, news, ticker };
  ANALYSIS_CACHE.set(symbol, { ts: now, data: out });
  return out;
}
