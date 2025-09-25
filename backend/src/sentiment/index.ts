import { getConfig } from '../utils/env.js';
import { getTicker } from '../data/market.js';

export type ProviderSentiment = {
  label: 'bullish' | 'bearish' | 'neutral';
  score: number;
  confidence?: number;
  mentions?: number;
  velocity?: number;
  keywords?: string[];
  source: string;
  fetchedAt: string;
  raw?: any;
};

export type HybridSentiment = ProviderSentiment & {
  sources: ProviderSentiment[];
};

const cache = new Map<string, { expires: number; data: ProviderSentiment }>();

function normalizeLabel(label?: string | null): 'bullish' | 'bearish' | 'neutral' {
  const value = (label || '').toLowerCase();
  if (value.includes('bull')) return 'bullish';
  if (value.includes('bear')) return 'bearish';
  return 'neutral';
}

async function fetchProviderSentiment(symbol: string): Promise<ProviderSentiment | null> {
  const cfg = getConfig();
  if (!cfg.SENTIMENT_ENABLED) return null;

  const key = symbol.toUpperCase();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.data;

  const provider = cfg.SENTIMENT_API_URL && cfg.SENTIMENT_API_KEY
    ? () => callExternalProvider(symbol, cfg)
    : cfg.GROK_API_KEY
      ? () => callGrokProvider(symbol, cfg)
      : null;

  if (!provider) return null;

  try {
    const data = await provider();
    if (!data) return null;
    cache.set(key, {
      data,
      expires: now + Math.max(10, cfg.SENTIMENT_CACHE_TTL_SEC) * 1000,
    });
    return data;
  } catch (error) {
    console.warn('Sentiment provider error:', error);
    return null;
  }
}

async function callExternalProvider(symbol: string, cfg: ReturnType<typeof getConfig>): Promise<ProviderSentiment | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  const resp = await fetch(cfg.SENTIMENT_API_URL!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.SENTIMENT_API_KEY}`,
    },
    body: JSON.stringify({ symbol }),
    signal: controller.signal,
  });
  clearTimeout(timeout);
  if (!resp.ok) {
    console.warn(`Sentiment provider HTTP ${resp.status}`);
    return null;
  }
  const json: any = await resp.json();
  return {
    label: normalizeLabel(json?.label),
    score: Number(json?.score ?? 0.5),
    confidence: json?.confidence != null ? Number(json.confidence) : undefined,
    mentions: json?.mentions != null ? Number(json.mentions) : undefined,
    velocity: json?.velocity != null ? Number(json.velocity) : undefined,
    keywords: Array.isArray(json?.keywords) ? json.keywords.slice(0, 8) : undefined,
    source: json?.source || 'realtime_provider',
    fetchedAt: new Date().toISOString(),
    raw: json,
  };
}

async function callGrokProvider(symbol: string, cfg: ReturnType<typeof getConfig>): Promise<ProviderSentiment | null> {
  const endpoint = cfg.GROK_BASE_URL || 'https://api.x.ai/v1/chat/completions';
  const prompt = `You monitor real-time sentiment from X/Twitter, Reddit, news and on-chain chatter for crypto markets. ` +
    `Provide a JSON summary for ${symbol} covering {"label":"bullish|bearish|neutral","score":0..1,"confidence":0..1,"mentions":number,"velocity":number,"keywords":[...]}. ` +
    `Do not add extra text.`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.GROK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-4-fast-reasoning',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a crypto sentiment data agent. Respond with strict JSON.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!resp.ok) {
    console.warn(`Grok sentiment HTTP ${resp.status}`);
    return null;
  }
  const json = await resp.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  return {
    label: normalizeLabel(parsed?.label),
    score: Number(parsed?.score ?? 0.5),
    confidence: parsed?.confidence != null ? Number(parsed.confidence) : undefined,
    mentions: parsed?.mentions != null ? Number(parsed.mentions) : undefined,
    velocity: parsed?.velocity != null ? Number(parsed.velocity) : undefined,
    keywords: Array.isArray(parsed?.keywords) ? parsed.keywords.slice(0, 8) : undefined,
    source: 'grok_sentiment',
    fetchedAt: new Date().toISOString(),
    raw: parsed,
  };
}

async function buildHeuristicSentiment(symbol: string): Promise<ProviderSentiment | null> {
  try {
    const ticker = await getTicker(symbol);
    if (!ticker) return null;
    const pct = Number(ticker.percentage || 0);
    const label = pct > 0.6 ? 'bullish' : pct < -0.6 ? 'bearish' : 'neutral';
    const score = Math.max(0, Math.min(1, 0.5 + pct / 20));
    return {
      label,
      score: Number(score.toFixed(3)),
      source: 'heuristic_24h_change',
      fetchedAt: new Date().toISOString(),
      raw: { percentage: pct },
    };
  } catch (error) {
    console.warn('Heuristic sentiment error:', error);
    return null;
  }
}

function combineSentiments(sentiments: ProviderSentiment[]): HybridSentiment {
  const nonNull = sentiments.filter(Boolean) as ProviderSentiment[];
  const weights = nonNull.map((s) => Math.max(0.05, s.confidence ?? 0.5));
  const total = weights.reduce((acc, w) => acc + w, 0) || 1;
  const score = nonNull.reduce((acc, sentiment, idx) => acc + sentiment.score * weights[idx], 0) / total;

  const bullishVotes = nonNull.filter((s) => s.label === 'bullish').length;
  const bearishVotes = nonNull.filter((s) => s.label === 'bearish').length;
  let label: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (bullishVotes > bearishVotes) label = 'bullish';
  else if (bearishVotes > bullishVotes) label = 'bearish';
  else if (score > 0.55) label = 'bullish';
  else if (score < 0.45) label = 'bearish';

  return {
    label,
    score: Number(score.toFixed(3)),
    confidence: Number(Math.min(1, total / (weights.length * 1.5)).toFixed(3)),
    source: 'hybrid',
    fetchedAt: new Date().toISOString(),
    raw: undefined,
    sources: nonNull,
  };
}

export async function getHybridSentiment(symbol: string): Promise<HybridSentiment | null> {
  const cfg = getConfig();
  if (!cfg.SENTIMENT_ENABLED) {
    return null;
  }

  const sentiments: ProviderSentiment[] = [];

  const providerSentiment = await fetchProviderSentiment(symbol);
  if (providerSentiment && providerSentiment.score >= cfg.SENTIMENT_MIN_CONFIDENCE) {
    sentiments.push(providerSentiment);
  }

  const heuristic = await buildHeuristicSentiment(symbol);
  if (heuristic) sentiments.push(heuristic);

  if (!sentiments.length) return null;

  return combineSentiments(sentiments);
}

export function clearSentimentCache(symbol?: string) {
  if (symbol) {
    cache.delete(symbol.toUpperCase());
  } else {
    cache.clear();
  }
}
