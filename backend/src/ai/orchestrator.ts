import { StrategyZ, StrategyJson } from "./schema.js";
import { rankingPrompt, strategyPrompt } from "./prompts.js";
import { llmJSON } from "./llm.js";
import { buildTechSnapshot, type TechnicalSnapshot } from './tech.js';
import { getConfig } from '../utils/env.js';
import { emitAlert } from '../monitor/policy.js';
import { randomUUID } from "crypto";

type StrategyDraft = Partial<StrategyJson> & { [key: string]: any };

function safeParseJSON<T=any>(s: string): T {
  try { return JSON.parse(s) as T; } catch { throw new Error("LLM returned non-JSON"); }
}

type ZoneContext = {
  last: number;
  atrPct?: number | null;
  support?: number | null;
  resistance?: number | null;
};

function pickFirstFinite(...values: (number | null | undefined)[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function computeAtrBand(center: number, atrPct: number | null | undefined): { min: number; max: number } {
  const pct = Number.isFinite(atrPct) ? Number(atrPct) : 0.6;
  const zonePct = Math.min(1.2, Math.max(0.25, pct * 0.6 || 0.3));
  const span = Math.max(Math.abs(center) * (zonePct / 100), Math.max(1e-4, Math.abs(center) * 1e-3));
  const half = span / 2;
  const min = center - half;
  const max = center + half;
  return min < max ? { min, max } : { min: Math.min(min, max), max: Math.max(min, max) };
}

function ensureEntryZone(draft: StrategyDraft, ctx: ZoneContext) {
  if (!draft.entry) draft.entry = {} as any;
  const entry: any = draft.entry;
  if (!entry.type) entry.type = 'limit';

  const zone = entry.zone || {};
  const zoneMin = typeof zone.min === 'number' && Number.isFinite(zone.min) ? zone.min : undefined;
  const zoneMax = typeof zone.max === 'number' && Number.isFinite(zone.max) ? zone.max : undefined;
  const hasValidZone = zoneMin !== undefined && zoneMax !== undefined && zoneMin < zoneMax;
  if (hasValidZone) {
    entry.zone = { min: zoneMin, max: zoneMax };
    return;
  }

  const price = typeof entry.price === 'number' && Number.isFinite(entry.price) ? entry.price : undefined;
  const center = pickFirstFinite(
    price,
    zoneMin,
    zoneMax,
    ctx.support,
    ctx.resistance,
    ctx.last,
  ) ?? ctx.last ?? 0;
  const band = computeAtrBand(center || ctx.last || 0, ctx.atrPct);
  entry.zone = band;
}

function applyConfidenceSizing(draft: StrategyDraft) {
  if (!draft?.risk) return;
  const risk: any = draft.risk;
  const raw = typeof risk.risk_pct_balance === 'number' && Number.isFinite(risk.risk_pct_balance)
    ? risk.risk_pct_balance
    : undefined;
  if (raw === undefined) return;
  const conf = typeof draft.confidence === 'number' && Number.isFinite(draft.confidence)
    ? Math.min(1, Math.max(0, draft.confidence))
    : undefined;
  if (conf === undefined) return;
  let multiplier = 1;
  if (conf < 0.4) multiplier = 0.25;
  else if (conf < 0.6) multiplier = 0.5;
  else if (conf < 0.8) multiplier = 0.8;
  const scaled = raw * multiplier;
  risk.risk_pct_balance = Math.max(0, Math.min(5, Number(scaled.toFixed(4))));
}

export function normalizeStrategyDraft(input: StrategyDraft, ctx: ZoneContext): StrategyDraft {
  const entry: any = { ...(input.entry ?? {}) };
  if (!entry.type) entry.type = 'limit';
  const draft: StrategyDraft = {
    ...input,
    entry,
    risk: {
      ...(input.risk ?? {}),
      stop: { ...(input.risk?.stop ?? {}) },
      target: { ...(input.risk?.target ?? {}) },
    } as any,
  };
  ensureEntryZone(draft, ctx);
  applyConfidenceSizing(draft);
  return draft;
}
export type BiasDecisionInput = Pick<TechnicalSnapshot, 'trend'|'rsi14'|'atrPct'|'srBias'|'ema20'|'ema50'>;

export function deriveDirectionalBias(feats: BiasDecisionInput): 'long'|'short'|'range' {
  const emaBullish = feats.ema20 >= feats.ema50;
  const emaBearish = feats.ema20 <= feats.ema50;
  const atrModerate = feats.atrPct <= 2.5;
  const structureSupportsLong = feats.srBias === 'nearSupport' || (feats.srBias === 'neutral' && feats.trend > 0);
  const structureSupportsShort = feats.srBias === 'nearResistance' || (feats.srBias === 'neutral' && feats.trend < 0);
  const longRsiPass = feats.rsi14 < 65;
  const longRsiOverride = feats.rsi14 <= 70 && atrModerate && emaBullish;
  const shortRsiPass = feats.rsi14 > 35;
  const shortRsiOverride = feats.rsi14 >= 30 && atrModerate && emaBearish;

  if (feats.trend > 0 && structureSupportsLong && (longRsiPass || longRsiOverride)) {
    return 'long';
  }

  if (feats.trend < 0 && structureSupportsShort && (shortRsiPass || shortRsiOverride)) {
    return 'short';
  }

  return 'range';
}

// --- 1) Multi-perp ranking --- //
export async function selectBestPerp(
  perps: string[]
): Promise<{ symbol: string; score: number; reasons: string[] }[]> {
  // Build compact features per symbol (in parallel)
  const snapshots = await Promise.all(perps.map(async (symbol) => {
    try {
      const f = await buildTechSnapshot(symbol);
      const { symbol: _, ...rest } = f;
      return { ok: true as const, symbol, ...rest };
    } catch (e: any) {
      return { ok: false as const, symbol, error: String(e?.message || e) };
    }
  }));

  const usable = snapshots.filter(s => s.ok) as any[];
  if (usable.length === 0) {
    // Ultimate fallback if market snapshot fails: randomized ranking
    return perps.map(s => ({ symbol: s, score: Math.random(), reasons: ["fallback-random"] }))
                .sort((a,b)=>b.score-a.score);
  }

  // Prompt LLM
  let items: { symbol: string; score: number; reasons: string[] }[] = [];
  try {
    const prompt = rankingPrompt({
      perps: usable.map(u => ({
        symbol: u.symbol,
        trend: u.trend,
        rsi: u.rsi14,
        volPct: u.volPct,
        atrPct: u.atrPct,
        srBias: u.srBias,
        lastPrice: u.last
      })),
    });
    const day = new Date().toISOString().slice(0,10);
    const out = await llmJSON(prompt, {
      cacheKey: `rank:${day}:${JSON.stringify((usable||[]).map((u:any)=>u.symbol).sort())}`,
      ttlMin: 60,
      context: { kind: 'perp_ranking' },
    });
    const j = safeParseJSON<{ items: { symbol:string; score:number; reasons:string[] }[] }>(out);
    items = (j.items || []).filter(x => perps.includes(x.symbol));
  } catch {
    // Heuristic fallback: trend>0, RSI 45-65, nearSupport => +score
    items = usable.map((u:any) => {
      let score = 0.5;
      if (u.trend > 0) score += 0.2;
      if (u.rsi14 >= 45 && u.rsi14 <= 65) score += 0.15;
      if (u.srBias === "nearSupport") score += 0.1;
      score -= Math.max(0, u.atrPct - 2) * 0.02; // penalize excessive volatility
      return { symbol: u.symbol, score: Math.max(0, Math.min(1, score)), reasons: ["fallback-tech"] };
    });
  }

  // Tri et borne 0..1
  items = items.map(it => ({ ...it, score: Math.max(0, Math.min(1, it.score)) }));
  items.sort((a,b)=>b.score-a.score);
  return items;
}

// --- 2) Daily strategy generation (legacy classic) --- //
export async function generateStrategy(symbol: string, trigger: string, opts?: { fresh?: boolean; sessionId?: string }): Promise<StrategyJson> {
  const feats = await buildTechSnapshot(symbol);
  const today = new Date().toISOString().slice(0,10);

  // 2.1 Ask LLM (JSON)
  try {
    const cfg = getConfig();
    const raw = await llmJSON(strategyPrompt({
      symbol, trigger,
      features: {
        ema20: feats.ema20, ema50: feats.ema50, rsi14: feats.rsi14,
        atrPct: feats.atrPct, volPct: Math.abs((feats.ema20-feats.ema50)/feats.last)*100,
        last: feats.last, support: feats.support, resistance: feats.resistance, trend: feats.trend,
        pivots: feats.pivots, srBias: feats.srBias
      }
    }), {
      cacheKey: opts?.fresh ? undefined : `strategy:${new Date().toISOString().slice(0,13)}:${symbol}:${trigger}`,
      ttlMin: 90,
      bypassRate: !!opts?.fresh,
      noCache: !!opts?.fresh,
      provider: cfg.USE_GROK_FOR_STRATEGY ? 'grok' : 'openai',
      context: { sessionId: opts?.sessionId, symbol, kind: 'strategy' },
    });
    // 2.2 Parse & validate
    const draft = safeParseJSON<StrategyDraft>(raw);
    // patch fields minimum
    if (!draft.strategyId) draft.strategyId = `${today}:${symbol}:${trigger}:${Date.now()}:${randomUUID()}`; // <-- make unique
    if (!draft.symbol) draft.symbol = symbol;
    if (!draft.trigger) draft.trigger = trigger;
    if (!draft.validity) draft.validity = { from: new Date().toISOString(), to: null as any };
    const normalized = normalizeStrategyDraft(draft, {
      last: feats.last,
      atrPct: feats.atrPct,
      support: feats.support,
      resistance: feats.resistance,
    });
    const parsed = StrategyZ.parse(normalized);
    return parsed;
  } catch (e) {
    try { await emitAlert({ sessionId: opts?.sessionId, symbol, kind:'llm_invalid', severity:'med', details:{ where:'strategy', trigger, error: String((e as any)?.message || e) } }); } catch {}
    // 2.3 Fallback rule-based
    const bias = deriveDirectionalBias(feats);
    const isLong = bias === 'long';
    const isShort = bias === 'short';

    // Entry: zone around a pertinent level
    const refLevel = isLong
      ? (feats.supports[0]?.price ?? feats.support)
      : isShort
        ? (feats.resistances[0]?.price ?? feats.resistance)
        : feats.last;

    const zonePct = Math.min(0.8, Math.max(0.3, feats.atrPct * 0.6));
    let min = refLevel * (1 - 0.001 * zonePct);
    let max = refLevel * (1 + 0.001 * zonePct);
    if (isShort && min > max) {
      const tmp = min;
      min = max;
      max = tmp;
    }

    const stopPct = Math.min(Math.max(1.0, feats.atrPct * 0.8), 2.0);
    const targetPct = 3.5;

    const confirmations = bias === 'long'
      ? ['RSI_up', 'EMA20>EMA50', 'pivot_respect']
      : bias === 'short'
        ? ['RSI_down', 'EMA20<EMA50', 'pivot_respect']
        : ['range_playbook', 'oscillator_reversal', 'pivot_respect'];

    const draft: StrategyJson = {
      strategyId: `${new Date().toISOString().slice(0,10)}:${symbol}:${trigger}:${Date.now()}:${randomUUID()}`, // <-- make unique
      symbol,
      bias: bias as any,
      confidence: bias === 'range' ? 0.5 : 0.6,
      entry: {
        type: 'limit',
        price: null as any,
        zone: { min, max },
        confirmations
      },
      risk: {
        stop: { type: 'percent', value: stopPct },
        target: { type: 'percent', value: targetPct },
        risk_pct_balance: 1.0,
        max_leverage: 10
      },
      validity: { from: new Date().toISOString(), to: null as any },
      rationale: `Rule-based: bias=${bias} (srBias=${feats.srBias}, trend=${feats.trend.toFixed(2)}, rsi=${feats.rsi14.toFixed(1)}, atrPct=${feats.atrPct.toFixed(2)}), ref=${refLevel.toFixed(2)}`,
      trigger
    };
    const normalized = normalizeStrategyDraft(draft, {
      last: feats.last,
      atrPct: feats.atrPct,
      support: feats.support,
      resistance: feats.resistance,
    });
    return StrategyZ.parse(normalized);
  }
}
