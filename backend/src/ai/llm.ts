import OpenAI from "openai";
import { getConfig } from "../utils/env.js";
import { recordAICall } from "../metrics/aiCalls.js";
import { createHash } from 'crypto';

export type LLMChoice = "openai" | "grok" | "none";
type LLMOpts = { cacheKey?: string; ttlMin?: number };

function pickLLM(): LLMChoice {
  const cfg = getConfig();
  if (cfg.OPENAI_API_KEY) return "openai";
  if (cfg.USE_GROK && cfg.GROK_API_KEY) return "grok";
  return "none";
}

// --- Basic cache + single-flight + rate limit --- //
const inFlight = new Map<string, Promise<string>>();
const cache = new Map<string, { ts: number; data: string }>();
let lastCallAt = 0;

function keyOf(prompt: string, opts?: LLMOpts) {
  if (opts?.cacheKey) return opts.cacheKey;
  const h = createHash('sha1').update(prompt).digest('hex');
  return `prompt:${h}`;
}

export async function llmJSON(prompt: string, opts?: LLMOpts): Promise<string> {
  const cfg = getConfig();
  if (cfg.LLM_DISABLE) throw new Error('LLM disabled');

  // Cache hit
  const key = keyOf(prompt, opts);
  const ttl = Math.max(1, (opts?.ttlMin ?? cfg.LLM_CACHE_TTL_MIN)) * 60_000;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && (now - hit.ts) < ttl) return hit.data;

  // Single-flight
  const inF = inFlight.get(key);
  if (inF) return inF;

  // Rate limit: simple min-interval gate
  const delta = now - lastCallAt;
  if (delta < cfg.LLM_MIN_INTERVAL_MS) throw new Error('LLM rate-limited');
  lastCallAt = now;

  const which = pickLLM();
  const p = (async () => {
    try {
      let out: string;
      if (which === 'openai') out = await callOpenAI(prompt);
      else if (which === 'grok') out = await callGrok(prompt);
      else throw new Error('No LLM configured (OPENAI_API_KEY or GROK_API_KEY missing).');
      cache.set(key, { ts: Date.now(), data: out });
      return out;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

async function callOpenAI(prompt: string): Promise<string> {
  const cfg = getConfig();
  const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
  const model = cfg.OPENAI_MODEL || "gpt-4o-mini";
  const resp = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are a trading strategy assistant. Output strictly valid JSON." },
      { role: "user", content: prompt },
    ],
  });
  const msg = resp.choices[0]?.message?.content?.trim() || "{}";
  try {
    const usage: any = (resp as any).usage || {};
    const inTok = Number(usage?.prompt_tokens || 0);
    const outTok = Number(usage?.completion_tokens || 0);
    const cfg = getConfig();
    const cost = (inTok/1000)*cfg.OPENAI_COST_IN_PER_1K + (outTok/1000)*cfg.OPENAI_COST_OUT_PER_1K;
    recordAICall({ model: `openai:${model}`, inputTokens: inTok, outputTokens: outTok, costUsd: isFinite(cost) ? cost : 0 });
  } catch {}
  return msg;
}

// NB: Grok: on passe par HTTP générique. Ajuste GROK endpoint si besoin.
// Par défaut, beaucoup utilisent `https://api.x.ai/v1/chat/completions`.
async function callGrok(prompt: string): Promise<string> {
  const { GROK_API_KEY } = getConfig();
  const endpoint = process.env.GROK_BASE_URL || "https://api.x.ai/v1/chat/completions";
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-4",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a trading strategy assistant. Output strictly valid JSON." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!r.ok) throw new Error(`Grok HTTP ${r.status}`);
  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content?.trim() || "{}";
  try {
    // Try OpenAI-like usage; otherwise, estimate zero and rely on per-1K cost if tokens known via vendor later
    const usage: any = (j as any).usage || {};
    const inTok = Number(usage?.prompt_tokens || 0);
    const outTok = Number(usage?.completion_tokens || 0);
    const cfg = getConfig();
    const cost = (inTok/1000)*cfg.GROK_COST_IN_PER_1K + (outTok/1000)*cfg.GROK_COST_OUT_PER_1K;
    recordAICall({ model: `grok:grok-4`, inputTokens: inTok, outputTokens: outTok, costUsd: isFinite(cost) ? cost : 0 });
  } catch {}
  return content;
}
