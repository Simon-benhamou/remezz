import { StrategyZ, StrategyJson } from "./schema.js";
import { rankingPrompt, strategyPrompt } from "./prompts.js";
import { llmJSON } from "./llm.js";
import { buildTechSnapshot, type TechnicalSnapshot } from './tech.js';
import type { RegimeDiagnostics } from '../diagnostics/regime.js';
import type { StrategyPerformanceSummary } from '../services/strategyHealth.js';

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

function coerceRiskShape(input: StrategyDraft): StrategyDraft {
  const draft: StrategyDraft = { ...input };
  const risk = (draft.risk = draft.risk ? { ...draft.risk } : {} as any);

  const topStop = (draft as any).stop ?? (draft as any).risk_stop ?? (draft as any).riskStop;
  if (!risk.stop && topStop && typeof topStop === 'object') {
    const type = typeof topStop.type === 'string' && (topStop.type === 'percent' || topStop.type === 'price')
      ? topStop.type
      : typeof topStop.kind === 'string' && (topStop.kind === 'percent' || topStop.kind === 'price')
        ? topStop.kind
        : undefined;
    const rawValue = Number(topStop.value ?? topStop.amount ?? topStop.level);
    if (type && Number.isFinite(rawValue)) {
      risk.stop = { type, value: rawValue };
    }
  }

  const topTarget = (draft as any).target ?? (draft as any).risk_target ?? (draft as any).riskTarget;
  if (!risk.target && topTarget && typeof topTarget === 'object') {
    const type = typeof topTarget.type === 'string' && (topTarget.type === 'percent' || topTarget.type === 'price')
      ? topTarget.type
      : typeof topTarget.kind === 'string' && (topTarget.kind === 'percent' || topTarget.kind === 'price')
        ? topTarget.kind
        : undefined;
    const rawValue = Number(topTarget.value ?? topTarget.amount ?? topTarget.level);
    if (type && Number.isFinite(rawValue)) {
      risk.target = { type, value: rawValue };
    }
  }

  if (risk.stop && !Number.isFinite(risk.stop.value)) {
    const parsed = Number(risk.stop.value);
    if (Number.isFinite(parsed)) risk.stop.value = parsed;
    else delete risk.stop;
  }

  if (risk.target && !Number.isFinite(risk.target.value)) {
    const parsed = Number(risk.target.value);
    if (Number.isFinite(parsed)) risk.target.value = parsed;
    else delete risk.target;
  }

  if (risk.stop && risk.stop.type !== 'percent' && risk.stop.type !== 'price') {
    risk.stop.type = risk.stop.type === 'price' ? 'price' : 'percent';
  }

  if (risk.target && risk.target.type !== 'percent' && risk.target.type !== 'price') {
    risk.target.type = risk.target.type === 'price' ? 'price' : 'percent';
  }

  const riskPctTop = (draft as any).risk_pct_balance ?? (draft as any).riskPctBalance;
  if (risk.risk_pct_balance === undefined && Number.isFinite(Number(riskPctTop))) {
    risk.risk_pct_balance = Number(riskPctTop);
  }
  if (risk.risk_pct_balance !== undefined && !Number.isFinite(risk.risk_pct_balance)) {
    const parsed = Number(risk.risk_pct_balance);
    if (Number.isFinite(parsed)) risk.risk_pct_balance = parsed;
    else delete risk.risk_pct_balance;
  }

  const maxLevTop = (draft as any).max_leverage ?? (draft as any).maxLeverage;
  if (risk.max_leverage === undefined && Number.isFinite(Number(maxLevTop))) {
    risk.max_leverage = Number(maxLevTop);
  }
  if (risk.max_leverage !== undefined && !Number.isFinite(risk.max_leverage)) {
    const parsed = Number(risk.max_leverage);
    if (Number.isFinite(parsed)) risk.max_leverage = parsed;
    else delete risk.max_leverage;
  }

  draft.risk = risk;
  return draft;
}

export function normalizeStrategyDraft(input: StrategyDraft, ctx: ZoneContext): StrategyDraft {
  const coerced = coerceRiskShape(input);
  const entry: any = { ...(coerced.entry ?? {}) };
  if (!entry.type) entry.type = 'limit';
  const draft: StrategyDraft = {
    ...coerced,
    entry,
    risk: {
      ...(coerced.risk ?? {}),
      stop: { ...(coerced.risk?.stop ?? {}) },
      target: { ...(coerced.risk?.target ?? {}) },
    } as any,
  };
  ensureEntryZone(draft, ctx);
  applyConfidenceSizing(draft);
  if (draft.risk) {
    const risk: any = draft.risk;
    const rawLev = Number(risk.max_leverage);
    if (!Number.isFinite(rawLev)) {
      risk.max_leverage = 5; // sensible default if LLM omits or mangles the value
    } else {
      risk.max_leverage = clamp(rawLev, 1, 50);
    }
  }
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

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function normalizeSymbol(symbol: string) {
  const upper = (symbol || '').toUpperCase();
  const base = upper.split(/[\/:]/)[0] || upper;
  const match = base.match(/[A-Z]+/);
  return match ? match[0] : base;
}

function instrumentTier(symbol: string): 'major' | 'large' | 'alt' {
  const base = normalizeSymbol(symbol);
  if (base === 'BTC' || base === 'ETH') return 'major';
  const largeCaps = new Set([
    'BNB','SOL','XRP','ADA','DOGE','TRX','MATIC','LTC','LINK','DOT','ATOM','AVAX','APT','ARB','OP','TON','TIA','RNDR'
  ]);
  return largeCaps.has(base) ? 'large' : 'alt';
}

const ATR_TIER_BOUNDS: Record<'major'|'large'|'alt', { stop: [number, number]; target: [number, number] }> = {
  major: { stop: [0.4, 3.0], target: [0.9, 6.0] },
  large: { stop: [0.6, 3.8], target: [1.2, 7.0] },
  alt: { stop: [0.8, 5.5], target: [1.8, 9.0] },
};

type AtrRiskParams = {
  stopPct: number;
  targetPct: number;
  stopBounds: { min: number; max: number };
  targetBounds: { min: number; max: number };
};

function pickStopRange(atr: number): [number, number] {
  if (atr <= 0.6) return [1.5, 1.9];
  if (atr >= 2.8) return [1.1, 1.5];
  return [1.2, 1.7];
}

function pickTargetRange(atr: number): [number, number] {
  if (atr <= 0.6) return [2.0, 2.4];
  if (atr >= 2.8) return [1.6, 2.1];
  return [1.7, 2.2];
}

function clampRange([minMult, maxMult]: [number, number], atr: number, [floor, ceil]: [number, number]) {
  let min = clamp(atr * minMult, floor, ceil);
  let max = clamp(atr * maxMult, floor, ceil);
  if (min > max) {
    const mid = clamp((min + max) / 2, floor, ceil);
    min = mid;
    max = mid;
  }
  return { min, max };
}

export function computeAtrRiskParams(symbol: string, atrPctRaw: number): AtrRiskParams {
  const atr = clamp(Number.isFinite(atrPctRaw) ? atrPctRaw : 0.1, 0.1, 6.0);
  const tier = instrumentTier(symbol);
  const bounds = ATR_TIER_BOUNDS[tier];
  const stopRange = pickStopRange(atr);
  const targetRange = pickTargetRange(atr);
  const stopBounds = clampRange(stopRange, atr, bounds.stop);
  const targetBounds = clampRange(targetRange, atr, bounds.target);
  let stopPct = clamp(atr * ((stopRange[0] + stopRange[1]) / 2), stopBounds.min, stopBounds.max);
  let targetPct = clamp(atr * ((targetRange[0] + targetRange[1]) / 2), targetBounds.min, targetBounds.max);
  if (targetPct <= stopPct) {
    const uplift = Math.max(0.2, atr * 0.5);
    targetPct = clamp(stopPct + uplift, targetBounds.min, targetBounds.max);
    if (targetPct <= stopPct) {
      targetPct = clamp(stopBounds.max + uplift, targetBounds.min, targetBounds.max);
    }
  }
  return {
    stopPct,
    targetPct,
    stopBounds,
    targetBounds,
  };
}

function enforceAtrRiskBounds(draft: StrategyJson, symbol: string, atrPct: number): StrategyJson {
  const clone: StrategyJson = {
    ...draft,
    entry: draft.entry ? { ...draft.entry, zone: draft.entry.zone ? { ...draft.entry.zone } : undefined } : (draft.entry as any),
    risk: draft.risk ? {
      ...draft.risk,
      stop: draft.risk.stop ? { ...draft.risk.stop } : (draft.risk.stop as any),
      target: draft.risk.target ? { ...draft.risk.target } : (draft.risk.target as any)
    } : (draft.risk as any)
  };
  if (!clone.risk) return clone;
  const params = computeAtrRiskParams(symbol, atrPct);
  if (clone.risk.stop?.type === 'percent') {
    const raw = Number(clone.risk.stop.value);
    clone.risk.stop.value = clamp(Number.isFinite(raw) ? raw : params.stopPct, params.stopBounds.min, params.stopBounds.max);
  }
  if (clone.risk.target?.type === 'percent') {
    const raw = Number(clone.risk.target.value);
    let next = clamp(Number.isFinite(raw) ? raw : params.targetPct, params.targetBounds.min, params.targetBounds.max);
    if (clone.risk.stop?.type === 'percent' && next <= clone.risk.stop.value) {
      next = clamp(clone.risk.stop.value + Math.max(0.2, atrPct * 0.5), params.targetBounds.min, params.targetBounds.max);
      if (next <= clone.risk.stop.value) {
        next = clamp(params.targetPct, params.targetBounds.min, params.targetBounds.max);
      }
    }
    clone.risk.target.value = next;
  }
  return clone;
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
type GenerateOpts = {
  fresh?: boolean;
  sessionId?: string;
  llm?: typeof llmJSON;
  snapshot?: TechnicalSnapshot;
  regime?: RegimeDiagnostics | null;
  performance?: StrategyPerformanceSummary | null;
};

export async function generateStrategy(symbol: string, trigger: string, opts?: GenerateOpts): Promise<StrategyJson> {
  const feats = opts?.snapshot ?? await buildTechSnapshot(symbol);
  const today = new Date().toISOString().slice(0,10);

  // 2.1 Ask LLM (JSON)
  try {
    const cfg = getConfig();
    const callLLM = opts?.llm ?? llmJSON;
    const raw = await callLLM(strategyPrompt({
      symbol, trigger,
      features: {
        ema20: feats.ema20,
        ema50: feats.ema50,
        ema100: feats.ema100,
        ema200: feats.ema200,
        rsi14: feats.rsi14,
        atrPct: feats.atrPct,
        volPct: Math.abs((feats.ema20 - feats.ema50) / Math.max(1e-6, feats.last)) * 100,
        last: feats.last,
        support: feats.support,
        resistance: feats.resistance,
        trend: feats.trend,
        trendStrength: feats.trendStrength,
        trendBias: feats.trendBias,
        adx14: feats.adx14,
        volume: feats.volume,
        volumeMA: feats.volumeMA,
        volume24hChangePct: feats.volume24hChangePct,
        pivots: feats.pivots,
        srBias: feats.srBias,
      },
      regime: opts?.regime ?? null,
      performance: opts?.performance ?? null,
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

    const bounded = enforceAtrRiskBounds(normalized as StrategyJson, symbol, feats.atrPct);
    return StrategyZ.parse(bounded);
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

    const atrRisk = computeAtrRiskParams(symbol, feats.atrPct);
    const stopPct = atrRisk.stopPct;
    const targetPct = Math.max(atrRisk.targetPct, stopPct + Math.max(0.2, feats.atrPct * 0.5));

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
        target: { type: 'percent', value: clamp(targetPct, atrRisk.targetBounds.min, atrRisk.targetBounds.max) },
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
    const bounded = enforceAtrRiskBounds(normalized as StrategyJson, symbol, feats.atrPct);
    return StrategyZ.parse(bounded);
  }
}
