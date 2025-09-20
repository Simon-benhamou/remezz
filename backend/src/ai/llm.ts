import OpenAI from "openai";
import { getConfig } from "../utils/env.js";
import { recordAICall } from "../metrics/aiCalls.js";
import { createHash } from 'crypto';
import { prisma } from '../db/client.js';

export type LLMChoice = "openai" | "grok" | "none";
type LLMContext = { sessionId?: string; symbol?: string; kind?: string };
type LLMOpts = { cacheKey?: string; ttlMin?: number; bypassRate?: boolean; noCache?: boolean; provider?: Exclude<LLMChoice, 'none'>; context?: LLMContext };
type LLMCallResult = { text: string; modelUsed?: string; tokensIn?: number; tokensOut?: number; costUsd?: number };
type CacheEntry = { ts: number; data: string; provider: string; model?: string; tokensIn?: number; tokensOut?: number; costUsd?: number };

function pickLLM(): LLMChoice {
  const cfg = getConfig();
  if (cfg.OPENAI_API_KEY) return "openai";
  if (cfg.USE_GROK && cfg.GROK_API_KEY) return "grok";
  return "none";
}

// --- Basic cache + single-flight + rate limit --- //
const inFlight = new Map<string, Promise<string>>();
const cache = new Map<string, CacheEntry>();
let lastCallAt = 0;

function keyOf(prompt: string, opts?: LLMOpts) {
  if (opts?.cacheKey) return opts.cacheKey;
  const h = createHash('sha1').update(prompt).digest('hex');
  return `prompt:${h}`;
}

async function logPrompt(entry: { prompt: string; response?: string | null; provider: string; model?: string; cached?: boolean; tokensIn?: number; tokensOut?: number; costUsd?: number; context?: LLMContext; error?: string }) {
  try {
    const trimmedPrompt = entry.prompt.length > 6000 ? `${entry.prompt.slice(0, 6000)}…` : entry.prompt;
    const responsePayload = entry.response ? (() => {
      if (entry.response.length > 6000) return { text: `${entry.response.slice(0, 6000)}…` };
      try { return JSON.parse(entry.response); } catch { return { text: entry.response }; }
    })() : null;
    await prisma.aiPromptLog.create({
      data: {
        sessionId: entry.context?.sessionId,
        symbol: entry.context?.symbol,
        kind: entry.context?.kind,
        provider: entry.provider,
        model: entry.model,
        prompt: trimmedPrompt,
        response: responsePayload,
        cached: !!entry.cached,
        tokensIn: entry.tokensIn ?? undefined,
        tokensOut: entry.tokensOut ?? undefined,
        costUsd: entry.costUsd ?? undefined,
        error: entry.error,
      }
    });
  } catch {}
}

export async function llmJSON(prompt: string, opts?: LLMOpts): Promise<string> {
  const cfg = getConfig();
  if (cfg.LLM_DISABLE) throw new Error('LLM disabled');

  // Cache hit
  const key = keyOf(prompt, opts);
  const ttl = Math.max(1, (opts?.ttlMin ?? cfg.LLM_CACHE_TTL_MIN)) * 60_000;
  const hit = opts?.noCache ? undefined : cache.get(key);
  const now = Date.now();
  if (hit && (now - hit.ts) < ttl) {
    logPrompt({ prompt, response: hit.data, provider: hit.provider, model: hit.model, cached: true, tokensIn: hit.tokensIn, tokensOut: hit.tokensOut, costUsd: hit.costUsd, context: opts?.context }).catch(()=>{});
    return hit.data;
  }

  // Single-flight
  const inF = opts?.noCache ? undefined : inFlight.get(key);
  if (inF) return inF;

  // Rate limit: enforce min spacing by waiting instead of throwing
  const delta = now - lastCallAt;
  if (!opts?.bypassRate && delta < cfg.LLM_MIN_INTERVAL_MS) {
    const waitMs = Math.max(0, cfg.LLM_MIN_INTERVAL_MS - delta);
    await new Promise(r => setTimeout(r, waitMs));
  }
  lastCallAt = Date.now();

  const which = opts?.provider ?? pickLLM();
  try { if (process.env.DEBUG_LLM === 'true') console.log(`[llm] provider=${which} bypassRate=${!!opts?.bypassRate} noCache=${!!opts?.noCache} key=${(opts?.cacheKey||'auto')}`); } catch {}
  const p = (async () => {
    try {
      let result: LLMCallResult;
      if (which === 'openai') result = await callOpenAI(prompt);
      else if (which === 'grok') result = await callGrok(prompt);
      else throw new Error('No LLM configured (OPENAI_API_KEY or GROK_API_KEY missing).');
      if (!opts?.noCache) cache.set(key, { ts: Date.now(), data: result.text, provider: which, model: result.modelUsed, tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd });
      logPrompt({ prompt, response: result.text, provider: which, model: result.modelUsed, tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd, context: opts?.context }).catch(()=>{});
      return result.text;
    } finally {
      if (!opts?.noCache) inFlight.delete(key);
    }
  })();
  if (!opts?.noCache) inFlight.set(key, p);
  return p;
}

async function callOpenAI(prompt: string): Promise<LLMCallResult> {
  const cfg = getConfig();
  const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
  const primaryModel = cfg.OPENAI_MODEL || "gpt-5-mini-2025-08-07";

  async function invoke(model: string): Promise<LLMCallResult> {
    const resp = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a trading strategy assistant. Output strictly valid JSON." },
        { role: "user", content: prompt },
      ],
    });
    const msg = resp.choices[0]?.message?.content?.trim() || "{}";
    let inTok = 0;
    let outTok = 0;
    let cost = 0;
    try {
      const usage: any = (resp as any).usage || {};
      inTok = Number(usage?.prompt_tokens || 0);
      outTok = Number(usage?.completion_tokens || 0);
      cost = (inTok/1000)*cfg.OPENAI_COST_IN_PER_1K + (outTok/1000)*cfg.OPENAI_COST_OUT_PER_1K;
      recordAICall({ model: `openai:${model}`, inputTokens: inTok, outputTokens: outTok, costUsd: isFinite(cost) ? cost : 0 });
    } catch {}
    return { text: msg, modelUsed: model, tokensIn: inTok, tokensOut: outTok, costUsd: cost };
  }

  try {
    return await invoke(primaryModel);
  } catch (e: any) {
    const msg = String(e?.message || e);
    const status = (e as any)?.status || (e as any)?.code;
    const modelInvalid = /model/i.test(msg) || status === 404;
    // Retry once with a safe default if the configured model is invalid
    if (modelInvalid && primaryModel !== 'gpt-5-mini-2025-08-07') {
      try { return await invoke('gpt-5-mini-2025-08-07'); } catch {}
    }
    throw e;
  }
}

// NB: Grok: on passe par HTTP générique. Ajuste GROK endpoint si besoin.
// Par défaut, beaucoup utilisent `https://api.x.ai/v1/chat/completions`.
async function callGrok(prompt: string): Promise<LLMCallResult> {
  const { GROK_API_KEY, GROK_BASE_URL } = getConfig();
  const endpoint = GROK_BASE_URL || "https://api.x.ai/v1/chat/completions";
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-4-fast-reasoning",
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
  let inTok = 0;
  let outTok = 0;
  let cost = 0;
  try {
    // Try OpenAI-like usage; otherwise, estimate zero and rely on per-1K cost if tokens known via vendor later
    const usage: any = (j as any).usage || {};
    inTok = Number(usage?.prompt_tokens || 0);
    outTok = Number(usage?.completion_tokens || 0);
    const cfg = getConfig();
    cost = (inTok/1000)*cfg.GROK_COST_IN_PER_1K + (outTok/1000)*cfg.GROK_COST_OUT_PER_1K;
    recordAICall({ model: `grok-4-fast-reasoning`, inputTokens: inTok, outputTokens: outTok, costUsd: isFinite(cost) ? cost : 0 });
  } catch {}
  return { text: content, modelUsed: 'grok-4-fast-reasoning', tokensIn: inTok, tokensOut: outTok, costUsd: cost };
}
