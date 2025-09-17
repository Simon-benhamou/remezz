import { PlanZ, PlanJson } from '../agent/planSchema.js';
import { buildTechSnapshot, TechnicalSnapshot } from './tech.js';
import { llmJSON } from './llm.js';
import { emitAlert } from '../monitor/policy.js';
import { getConfig } from '../utils/env.js';
import { fullAnalysis } from './analysis.js';
import type { RegimeProfile } from './regime.js';
import { recordOpsEvent } from '../monitor/ops.js';

function safeParse<T=any>(s: string): T { try { return JSON.parse(s) as T; } catch { throw new Error('LLM returned non-JSON'); } }

const PLAN_CACHE_TTL_MS = Number(process.env.PLAN_CACHE_TTL_MS || 30 * 60 * 1000);
const planCache = new Map<string, { ts: number; plan: PlanJson }>();

function cacheKeyForPlan(symbol: string, regime?: RegimeProfile | null, trigger?: string) {
  const playbook = regime?.playbook || 'unknown';
  return `${symbol}:${playbook}:${trigger || 'auto'}`;
}

function clonePlan(plan: PlanJson): PlanJson {
  return JSON.parse(JSON.stringify(plan));
}

function cachePlan(key: string, plan: PlanJson) {
  planCache.set(key, { ts: Date.now(), plan: clonePlan(plan) });
}

export async function proposePlan(symbol: string, opts?: { fresh?: boolean; sessionId?: string }): Promise<PlanJson> {
  const snap = await buildTechSnapshot(symbol);
  const regime = snap.regime;
  const cacheKey = cacheKeyForPlan(symbol, regime, opts?.sessionId);
  if (!opts?.fresh) {
    const cached = planCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < PLAN_CACHE_TTL_MS) {
      try { recordOpsEvent({ level: 'info', source: 'plan_cache', message: 'reuse_cached_plan', sessionId: opts?.sessionId, symbol, details: { playbook: regime?.playbook } }); } catch {}
      return clonePlan(cached.plan);
    }
  }
  // Fetch sentiment/news (cached) to gently influence the plan bias
  let sent: { label?: string; score?: number } | null = null;
  let news: { summary?: string } | null = null;
  try {
    const a = await fullAnalysis(symbol);
    sent = a?.sentiment || null;
    news = a?.news || null;
  } catch {}
  const regimeContext = regime
    ? `Regime assessment: trend=${regime.trend}, volatility=${regime.volatility}, playbook=${regime.playbook}. ${regime.shouldTrade ? 'Risk-on' : 'Prefer standby.'}`
    : 'Regime assessment unavailable.';
  const sys = `You are a market analyst. You receive a clean technical snapshot (price, RSI, ATR, S/R), optional sentiment/news, and a regime classification. Output ONLY a JSON matching this schema: {"name","symbol","timeframe","bias","zone":{"type","price":null,"from":"auto_detect"},"entry_rule":{"type":"rebound|rejection","confirm_close":true,"max_distance_pct":0.4},"risk":{"stop":{"type":"atr","mult":0.9},"tp":[{"type":"R","value":1.0}],"max_hold_hours":36},"position":{"risk_fraction":0.015,"max_leverage":4},"notes":"..."}. Do NOT invent any prices. If unsure, return bias:"none".\n${regimeContext}\nIf playbook=momentum_breakout favor entries aligned with the trend bias and allow confirm_close=false with tighter distance; if playbook=standby bias:"none".`;
  const user = {
    symbol, timeframe: '1h',
    technical: {
      last: snap.last,
      ema20: snap.ema20, ema50: snap.ema50,
      rsi14: snap.rsi14, atrPct: snap.atrPct,
      support: snap.support, resistance: snap.resistance,
      srBias: snap.srBias,
      trendStrength: snap.trendStrength,
      realizedVol: snap.realizedVol,
    },
    sentiment: sent,
    news: news?.summary ? news.summary.slice(0, 280) : undefined,
  };
  try {
    const cfg = getConfig();
    const day = new Date().toISOString().slice(0,10);
    const out = await llmJSON(`${sys}\nContext: ${JSON.stringify(user)}`, {
      cacheKey: opts?.fresh ? undefined : `plan:${day}:${symbol}`,
      ttlMin: 120,
      bypassRate: !!opts?.fresh,
      noCache: !!opts?.fresh,
      provider: cfg.USE_GROK_FOR_PLAN ? 'grok' : 'openai',
      context: { sessionId: opts?.sessionId, symbol, kind: 'plan' },
    });
    const j = safeParse(out);
    let plan = PlanZ.parse(j);
    plan = applyRegimePlaybook(plan, regime, snap);
    ensurePlanConsistency(plan, regime, snap);
    cachePlan(cacheKey, plan);
    return clonePlan(plan);
  } catch (e:any) {
    try { await emitAlert({ sessionId: opts?.sessionId, symbol, kind:'llm_invalid', severity:'med', details:{ where:'plan', error: String(e?.message || e) } }); } catch {}
    try { recordOpsEvent({ level: 'warn', source: 'plan_fallback', message: 'llm_plan_failure', sessionId: opts?.sessionId, symbol, details: { error: String(e?.message || e) } }); } catch {}
    const cached = !opts?.fresh ? planCache.get(cacheKey) : undefined;
    if (cached && (Date.now() - cached.ts) < PLAN_CACHE_TTL_MS) {
      try { recordOpsEvent({ level: 'warn', source: 'plan_cache', message: 'reuse_cached_plan_after_failure', sessionId: opts?.sessionId, symbol, details: { playbook: regime?.playbook } }); } catch {}
      return clonePlan(cached.plan);
    }
    const fallback = buildFallbackPlan(symbol, snap, regime);
    cachePlan(cacheKey, fallback);
    return fallback;
  }
}

function applyRegimePlaybook(plan: PlanJson, regime: RegimeProfile | undefined, snap: TechnicalSnapshot): PlanJson {
  if (!regime) return plan;
  const clone: PlanJson = {
    ...plan,
    zone: { ...plan.zone },
    entry_rule: { ...plan.entry_rule },
    risk: { ...plan.risk, stop: { ...plan.risk.stop }, tp: plan.risk.tp.map(tp => ({ ...tp })) },
    position: { ...plan.position },
    meta: { ...(plan.meta || {}) },
  };

  clone.meta = {
    ...(clone.meta || {}),
    playbook: regime.playbook,
    regime: regime.trend,
    volatility: regime.volatility,
  };

  if (regime.playbook === 'standby') {
    clone.bias = 'none';
    clone.entry_rule.confirm_close = true;
    clone.notes = `${clone.notes || ''} [Regime standby: holding fire]`.trim();
    return clone;
  }

  if (regime.playbook === 'momentum_breakout') {
    const trendingUp = regime.trend !== 'downtrend';
    clone.bias = trendingUp ? 'long' : 'short';
    clone.zone.type = trendingUp ? 'resistance' : 'support';
    clone.entry_rule.confirm_close = false;
    clone.entry_rule.max_distance_pct = Math.min(0.6, Math.max(0.2, clone.entry_rule.max_distance_pct));
    clone.risk.stop.mult = Math.min(2.2, Math.max(0.6, clone.risk.stop.mult * 0.9));
    clone.risk.tp = [{ type: 'R', value: 1.5 }, { type: 'R', value: 3 }];
    clone.notes = `${clone.notes || ''} Momentum breakout playbook (${regime.trend}).`.trim();
  } else {
    // mean reversion adjustments: ensure bias aligns with local SR bias if none provided
    if (clone.bias === 'none') {
      clone.bias = snap.srBias === 'nearResistance' ? 'short' : 'long';
    }
    clone.zone.type = clone.bias === 'long' ? 'support' : 'resistance';
    clone.entry_rule.confirm_close = true;
    clone.entry_rule.max_distance_pct = Math.max(clone.entry_rule.max_distance_pct, 0.4);
    clone.risk.stop.mult = Math.max(clone.risk.stop.mult, 0.9);
    if (clone.risk.tp.length === 1) clone.risk.tp.push({ type: 'R', value: 2.0 });
    clone.notes = `${clone.notes || ''} Mean reversion playbook.`.trim();
  }

  return clone;
}

function ensurePlanConsistency(plan: PlanJson, regime: RegimeProfile | undefined, snap: TechnicalSnapshot) {
  const issues: string[] = [];
  if (regime?.playbook === 'momentum_breakout') {
    const expectedBias = regime.trend === 'downtrend' ? 'short' : 'long';
    if (plan.bias !== expectedBias) issues.push(`bias_mismatch:${plan.bias}->${expectedBias}`);
    const expectedZone = expectedBias === 'long' ? 'resistance' : 'support';
    if (plan.zone.type !== expectedZone) issues.push(`zone_mismatch:${plan.zone.type}->${expectedZone}`);
  }
  if (plan.bias === 'long' && plan.zone.type === 'resistance') issues.push('long_zone_resistance');
  if (plan.bias === 'short' && plan.zone.type === 'support') issues.push('short_zone_support');
  if (plan.risk.stop.mult < 0.4 || plan.risk.stop.mult > 3.5) issues.push('stop_mult_out_of_bounds');
  if (!plan.risk.tp.length || plan.risk.tp.some(tp => tp.value <= 0)) issues.push('tp_invalid');
  if (plan.position.risk_fraction <= 0 || plan.position.risk_fraction > 0.05) issues.push('risk_fraction_out_of_bounds');
  if (issues.length) throw new Error(`plan_inconsistent:${issues.join(',')}`);
}

function buildFallbackPlan(symbol: string, snap: TechnicalSnapshot, regime: RegimeProfile | undefined): PlanJson {
  const momentum = regime?.playbook === 'momentum_breakout';
  const standby = regime?.playbook === 'standby';
  const trendUp = regime?.trend !== 'downtrend';
  const baselineLong = snap.srBias !== 'nearResistance' && snap.trend >= 0;
  const bias = standby ? 'none' : momentum ? (trendUp ? 'long' : 'short') : (baselineLong ? 'long' : 'short');
  const zoneType = bias === 'long' ? 'support' : bias === 'short' ? 'resistance' : (trendUp ? 'support' : 'resistance');
  const refLevel = zoneType === 'support'
    ? (snap.supports[0]?.price ?? snap.support)
    : (snap.resistances[0]?.price ?? snap.resistance);
  const zonePct = Math.min(0.8, Math.max(0.25, snap.atrPct * 0.5));
  const half = Math.abs(refLevel) * (zonePct / 100);
  const from = refLevel - half;
  const to = refLevel + half;
  const stopMult = Math.min(Math.max(momentum ? 0.7 : 0.9, snap.atrPct * 0.6), 2.5);
  const tpValues = momentum ? [1.6, 3.2] : [1.2, 2.4];
  const basePlan: PlanJson = {
    name: momentum ? 'Breakout_Fallback' : 'Reversion_Fallback',
    symbol,
    timeframe: '1h',
    bias: bias as any,
    zone: { type: zoneType as any, price: null, from: 'auto_detect' },
    entry_rule: { type: zoneType === 'support' ? 'rebound' : 'rejection', confirm_close: !momentum, max_distance_pct: momentum ? 0.35 : 0.45 },
    risk: { stop: { type: 'atr', mult: stopMult }, tp: tpValues.map(v => ({ type: 'R', value: v })), max_hold_hours: momentum ? 30 : 36 },
    position: { risk_fraction: 0.015, max_leverage: 4 },
    notes: `Fallback plan (${momentum ? 'momentum breakout' : 'mean reversion'}) around ${zoneType}`,
    meta: { playbook: regime?.playbook || (momentum ? 'momentum_breakout' : 'mean_reversion'), regime: regime?.trend || (snap.trend >= 0 ? 'uptrend' : 'downtrend'), volatility: regime?.volatility },
  };
  const adjusted = applyRegimePlaybook(basePlan, regime, snap);
  ensurePlanConsistency(adjusted, regime, snap);
  return PlanZ.parse(clonePlan(adjusted));
}
