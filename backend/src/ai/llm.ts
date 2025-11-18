import OpenAI from "openai";
import { getConfig } from "../utils/env.js";
import { recordAICall } from "../metrics/aiCalls.js";
import { createHash } from 'crypto';
import { 
  isServiceAvailable, 
  recordServiceSuccess, 
  recordServiceFailure,
  recordFallbackTriggered 
} from "../infra/serviceHealth.js";
import { createIntegrationLogger } from '../utils/integrationLogger.js';

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

export async function llmJSON(prompt: string, opts?: LLMOpts): Promise<string> {
  const logger = createIntegrationLogger({
    component: 'LLM',
    action: 'call',
    sessionId: opts?.context?.sessionId,
    symbol: opts?.context?.symbol,
  });

  const cfg = getConfig();

  // Check service health
  if (!isServiceAvailable('llm')) {
    recordFallbackTriggered('llm', 'circuit_breaker_open', { context: opts?.context });
    throw new Error('LLM service unavailable (circuit breaker open)');
  }

  // Cache hit
  const key = keyOf(prompt, opts);
  const ttl = Math.max(1, (opts?.ttlMin ?? cfg.LLM_CACHE_TTL_MIN)) * 60_000;
  const hit = opts?.noCache ? undefined : cache.get(key);
  const now = Date.now();
  if (hit && (now - hit.ts) < ttl) {
    const age = Math.floor((now - hit.ts) / 1000);
    logger.debug(`Cache hit | provider=${hit.provider} model=${hit.model} age=${age}s`, {
      tokensIn: hit.tokensIn,
      tokensOut: hit.tokensOut,
      costUsd: hit.costUsd,
    });
    return hit.data;
  }

  // Single-flight
  const inF = opts?.noCache ? undefined : inFlight.get(key);
  if (inF) {
    logger.debug('Call in-flight, waiting for completion');
    return inF;
  }

  // Rate limit: enforce min spacing by waiting instead of throwing
  const delta = now - lastCallAt;
  if (!opts?.bypassRate && delta < cfg.LLM_MIN_INTERVAL_MS) {
    const waitMs = Math.max(0, cfg.LLM_MIN_INTERVAL_MS - delta);
    logger.warn(`Rate limit wait | waitMs=${waitMs} lastCallDelta=${delta}`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  lastCallAt = Date.now();

  let provider = opts?.provider ?? pickLLM();
  if (provider === 'grok') {
    if (!cfg.GROK_API_KEY) {
      if (cfg.OPENAI_API_KEY) {
        logger.warn('Grok key missing, switching to OpenAI');
        provider = 'openai';
      } else {
        logger.error('No LLM provider available (missing both Grok and OpenAI keys)');
        throw new Error('Grok provider requested but GROK_API_KEY missing and no OpenAI fallback available');
      }
    }
  }
  try { if (process.env.DEBUG_LLM === 'true') console.log(`[llm] provider=${provider} bypassRate=${!!opts?.bypassRate} noCache=${!!opts?.noCache} key=${(opts?.cacheKey||'auto')}`); } catch {}
  const startTime = Date.now();
  
  logger.info(`Calling LLM | provider=${provider} bypassRate=${!!opts?.bypassRate} noCache=${!!opts?.noCache} kind=${opts?.context?.kind || 'unknown'}`);
  
  const p = (async () => {
    const callStart = Date.now();
    try {
      let result: LLMCallResult;
      if (provider === 'openai') result = await callOpenAI(prompt);
      else if (provider === 'grok') result = await callGrok(prompt);
      else throw new Error('No LLM configured (OPENAI_API_KEY or GROK_API_KEY missing).');
      
      // Record success
      const responseTime = Date.now() - startTime;
      recordServiceSuccess('llm', responseTime);
      
      if (!opts?.noCache) cache.set(key, { ts: Date.now(), data: result.text, provider, model: result.modelUsed, tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd });
      if (process.env.DEBUG_LLM === 'true') {
        try {
          console.log(`[llm] call provider=${provider} model=${result.modelUsed} tokens_in=${result.tokensIn || 0} tokens_out=${result.tokensOut || 0} response_time=${responseTime}ms`);
        } catch {}
      }
      return result.text;
    } catch (err) {
      // Record failure
      recordServiceFailure('llm', err as Error);
      throw err;
    } finally {
      if (!opts?.noCache) inFlight.delete(key);
    }
  })();
  
  let finalPromise: Promise<string> = p.catch(async (err) => {
    if (provider === 'grok' && cfg.OPENAI_API_KEY) {
      logger.warn('Grok call failed, attempting OpenAI fallback');
      try {
        if (process.env.DEBUG_LLM === 'true') {
          try { console.log('[llm] grok call failed, retrying with openai fallback'); } catch {}
        }
        recordFallbackTriggered('llm', 'provider_fallback_grok_to_openai', { context: opts?.context });
        const fallbackStartTime = Date.now();
        const fallback = await callOpenAI(prompt);
        const fallbackResponseTime = Date.now() - fallbackStartTime;
        recordServiceSuccess('llm', fallbackResponseTime);
        if (!opts?.noCache) cache.set(key, { ts: Date.now(), data: fallback.text, provider: 'openai', model: fallback.modelUsed, tokensIn: fallback.tokensIn, tokensOut: fallback.tokensOut, costUsd: fallback.costUsd });
        const fallbackDuration = Date.now() - fallbackStartTime;
        logger.success(`Fallback succeeded`, fallbackDuration, {
          provider: 'openai',
          model: fallback.modelUsed,
        });
        return fallback.text;
      } catch (fallbackErr) {
        recordServiceFailure('llm', fallbackErr as Error);
        throw fallbackErr;
      }
    }
    throw err;
  });
  if (!opts?.noCache) inFlight.set(key, finalPromise);
  return finalPromise;
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
  if (!GROK_API_KEY) {
    throw new Error('GROK_API_KEY missing');
  }
  const endpoint = GROK_BASE_URL || "https://api.x.ai/v1/chat/completions";
  const controller = AbortSignal.timeout(15000);
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
    signal: controller,
  });
  if (!r.ok) {
    const errorBody = await r.text().catch(() => 'Unable to read error body');
    const errorMsg = `Grok HTTP ${r.status}: ${errorBody.substring(0, 500)}`;
    console.error(`[llm] Grok API call failed: ${errorMsg}`);
    throw new Error(errorMsg);
  }
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

/**
 * Safe wrapper for llmJSON that returns null on failure instead of throwing
 * Useful for non-critical LLM calls where degraded operation is acceptable
 */
export async function llmJSONSafe(prompt: string, opts?: LLMOpts): Promise<string | null> {
  try {
    return await llmJSON(prompt, opts);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    // Only log if it's not a circuit breaker or disabled message
    if (!errorMsg.includes('circuit breaker') && !errorMsg.includes('disabled')) {
      console.warn('[llm] llmJSONSafe caught error:', errorMsg);
    }
    
    recordFallbackTriggered('llm', 'safe_wrapper_caught_error', {
      error: errorMsg,
      context: opts?.context,
    });
    
    return null;
  }
}

