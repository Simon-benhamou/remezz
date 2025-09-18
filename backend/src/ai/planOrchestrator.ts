import { PlanZ, PlanJson } from '../agent/planSchema.js';
import { buildTechSnapshot, TechnicalSnapshot } from './tech.js';
import { llmJSON } from './llm.js';
import { emitAlert } from '../monitor/policy.js';
import { getConfig } from '../utils/env.js';
import { fullAnalysis } from './analysis.js';
import type { RegimeProfile } from './regime.js';
import { recordOpsEvent } from '../monitor/ops.js';
import { markPlanLLM, shouldAllowPlanLLM } from './guard.js';

function safeParse<T=any>(s: string): T { try { return JSON.parse(s) as T; } catch { throw new Error('LLM returned non-JSON'); } }

const biasMap: Record<string, 'long'|'short'|'none'> = {
  long: 'long', buy: 'long', bullish: 'long', uptrend: 'long', up: 'long',
  short: 'short', sell: 'short', bearish: 'short', downtrend: 'short', down: 'short',
  none: 'none', neutral: 'none', standby: 'none', flat: 'none', sidelined: 'none',
};

const zoneMap: Record<string, 'support'|'resistance'> = {
  support: 'support', demand: 'support', floor: 'support', base: 'support',
  resistance: 'resistance', supply: 'resistance', ceiling: 'resistance', cap: 'resistance',
};

const entryTypeMap: Record<string, 'rebound'|'rejection'> = {
  rebound: 'rebound', bounce: 'rebound', pullback: 'rebound', retrace: 'rebound', mean_reversion: 'rebound',
  rejection: 'rejection', breakout: 'rejection', fade: 'rejection', breakdown: 'rejection',
};

function clamp(num: number, min: number, max: number) {
  return Math.min(max, Math.max(min, num));
}

function normalizePlanOutput(raw: any, symbol: string): any {
  const out = typeof raw === 'object' && raw ? { ...raw } : {};
  const biasKey = String(out.bias ?? '').toLowerCase().trim();
  let bias = biasMap[biasKey] ?? 'none';

  const zoneRaw = out.zone || {};
  const zoneKey = String(zoneRaw.type ?? '').toLowerCase().trim();
  let zoneType = zoneMap[zoneKey];
  if (!zoneType) zoneType = bias === 'short' ? 'resistance' : 'support';
  if (bias === 'long' && zoneType !== 'support') zoneType = 'support';
  if (bias === 'short' && zoneType !== 'resistance') zoneType = 'resistance';

  const entryRaw = out.entry_rule || {};
  const entryKey = String(entryRaw.type ?? '').toLowerCase().trim();
  let entryType = entryTypeMap[entryKey];
  if (!entryType) entryType = zoneType === 'support' ? 'rebound' : 'rejection';
  if (bias === 'long' && entryType === 'rejection') entryType = 'rebound';
  if (bias === 'short' && entryType === 'rebound') entryType = 'rejection';

  const timeframeRaw = String(out.timeframe || '').toLowerCase();
  const allowedTf = ['15m', '1h', '4h', '1d'];
  const timeframe = allowedTf.includes(timeframeRaw) ? timeframeRaw : '1h';

  const risk = out.risk || {};
  const position = out.position || {};
  const stopMultRaw = Number(risk?.stop?.mult ?? risk?.stop?.value ?? entryRaw?.stop?.mult ?? 1);
  const riskFractionRaw = Number(position.risk_fraction ?? position.size_fraction ?? 0.015);
  const riskFraction = clamp(Number.isFinite(riskFractionRaw) ? riskFractionRaw : 0.015, 0.005, 0.05);

  const tpRaw = Array.isArray(risk.tp) ? risk.tp : Array.isArray(out.tp) ? out.tp : [];
  const tpValues = tpRaw
    .map((item: any) => {
      if (item == null) return null;
      if (typeof item === 'number') return item;
      if (typeof item === 'string') {
        const num = Number(item.replace(/[^0-9.\-]/g, ''));
        return Number.isFinite(num) ? num : null;
      }
      if (typeof item === 'object') {
        const v = Number(item.value ?? item.r ?? item.tp);
        return Number.isFinite(v) ? v : null;
      }
      return null;
    })
    .filter((v: number | null): v is number => Number.isFinite(v) && v != null && v > 0);
  if (!tpValues.length) tpValues.push(1.6, 2.8);

  const stopMult = clamp(Number.isFinite(stopMultRaw) ? stopMultRaw : 1, 0.4, 3);
  const maxHold = clamp(Number(risk.max_hold_hours ?? risk.maxHoldHours ?? 36) || 36, 6, 72);
  const maxLevRaw = Number(position.max_leverage ?? position.leverage ?? 4);
  const maxLeverage = clamp(Number.isFinite(maxLevRaw) ? maxLevRaw : 4, 1, 10);

  const confirmClose = entryRaw.confirm_close != null ? Boolean(entryRaw.confirm_close) : (entryType === 'rebound');
  const maxDistPct = clamp(Number(entryRaw.max_distance_pct ?? entryRaw.maxDistancePct ?? 0.4) || 0.4, 0.1, 5);

  const exposureRange = position.risk_fraction_range || {};
  const rangeMin = clamp(Number(exposureRange.min ?? riskFraction * 0.8), 0.005, 0.05);
  const rangeMax = clamp(Number(exposureRange.max ?? riskFraction * 1.2), Math.max(rangeMin + 0.001, 0.006), 0.05);
  const rangeRec = clamp(Number(exposureRange.recommended ?? riskFraction), rangeMin, rangeMax);

  const plan: any = {
    name: typeof out.name === 'string' && out.name.trim() ? out.name.trim() : `LLM_${symbol}`,
    symbol: typeof out.symbol === 'string' && out.symbol.trim() ? out.symbol.trim() : symbol,
    timeframe,
    bias,
    zone: {
      type: zoneType,
      price: Number.isFinite(Number(zoneRaw.price)) ? Number(zoneRaw.price) : null,
      from: 'auto_detect',
    },
    entry_rule: {
      type: entryType,
      confirm_close: confirmClose,
      max_distance_pct: maxDistPct,
    },
    risk: {
      stop: { type: 'atr', mult: stopMult },
      tp: tpValues.map((value) => ({ type: 'R' as const, value: clamp(value, 0.5, 5) })),
      max_hold_hours: maxHold,
    },
    position: {
      risk_fraction: riskFraction,
      risk_fraction_range: { min: rangeMin, max: rangeMax, recommended: rangeRec },
      max_leverage: maxLeverage,
    },
    notes: typeof out.notes === 'string' ? out.notes : undefined,
  };

  if (out.meta && typeof out.meta === 'object') {
    plan.meta = { ...out.meta };
  }

  return plan;
}

function alignPlanForConsistency(plan: PlanJson): PlanJson {
  const clone: PlanJson = {
    ...plan,
    zone: { ...plan.zone },
    entry_rule: { ...plan.entry_rule },
    risk: { ...plan.risk, stop: { ...plan.risk.stop }, tp: plan.risk.tp.map(tp => ({ ...tp })) },
    position: { ...plan.position },
    meta: plan.meta ? { ...plan.meta } : plan.meta,
  };

  const playbook = (clone.meta as any)?.playbook;
  if (playbook === 'momentum_breakout') {
    const expectedZone = clone.bias === 'long' ? 'resistance' : clone.bias === 'short' ? 'support' : clone.zone.type;
    if (expectedZone) clone.zone.type = expectedZone as any;
  } else {
    if (clone.bias === 'long' && clone.zone.type !== 'support') clone.zone.type = 'support';
    if (clone.bias === 'short' && clone.zone.type !== 'resistance') clone.zone.type = 'resistance';
  }
  if (clone.bias === 'long' && clone.entry_rule.type === 'rejection') clone.entry_rule.type = 'rebound';
  if (clone.bias === 'short' && clone.entry_rule.type === 'rebound') clone.entry_rule.type = 'rejection';
  if (clone.bias === 'none' && clone.zone.type !== 'support' && clone.zone.type !== 'resistance') {
    clone.zone.type = 'support';
  }
  clone.risk.stop.mult = clamp(clone.risk.stop.mult, 0.4, 3);
  clone.risk.tp = clone.risk.tp.map(tp => ({ type: 'R', value: clamp(tp.value, 0.5, 5) }));
  clone.position.risk_fraction = clamp(clone.position.risk_fraction, 0.005, 0.05);
  clone.position.max_leverage = clamp(clone.position.max_leverage, 1, 10);
  if (clone.position.risk_fraction_range) {
    const { min, max, recommended } = clone.position.risk_fraction_range;
    const newMin = clamp(min ?? clone.position.risk_fraction * 0.8, 0.005, 0.05);
    const newMax = clamp(max ?? clone.position.risk_fraction * 1.2, newMin + 0.001, 0.05);
    const newRec = clamp(recommended ?? clone.position.risk_fraction, newMin, newMax);
    clone.position.risk_fraction_range = { min: newMin, max: newMax, recommended: newRec };
  }
  clone.entry_rule.max_distance_pct = clamp(clone.entry_rule.max_distance_pct, 0.1, 5);
  clone.risk.max_hold_hours = clamp(clone.risk.max_hold_hours, 6, 72);
  return clone;
}

const PLAN_CACHE_TTL_MS = Number(process.env.PLAN_CACHE_TTL_MS || 30 * 60 * 1000);
const planCache = new Map<string, { ts: number; plan: PlanJson }>();

function cacheKeyForPlan(symbol: string, regime?: RegimeProfile | null, trigger?: string, killReason?: string, signature?: string) {
  const playbook = regime?.playbook || 'unknown';
  const kill = killReason ? `:${killReason}` : '';
  const sig = signature ? `:${signature}` : '';
  return `${symbol}:${playbook}:${trigger || 'auto'}${kill}${sig}`;
}

function clonePlan(plan: PlanJson): PlanJson {
  return JSON.parse(JSON.stringify(plan));
}

function cachePlan(key: string, plan: PlanJson) {
  planCache.set(key, { ts: Date.now(), plan: clonePlan(plan) });
}

function normalizeRiskRange(position: PlanJson['position']) {
  const base = typeof position.risk_fraction === 'number' ? position.risk_fraction : 0.015;
  const minDefault = Math.max(0.005, base * 0.8);
  const maxDefault = Math.min(0.05, base * 1.2);
  let min = minDefault;
  let max = maxDefault;
  let recommended = base;
  if (position.risk_fraction_range) {
    const range = position.risk_fraction_range;
    if (typeof range.min === 'number') min = Math.max(0.005, Math.min(range.min, 0.05));
    if (typeof range.max === 'number') max = Math.max(min + 0.001, Math.min(range.max, 0.05));
    if (typeof range.recommended === 'number') recommended = range.recommended;
  }
  min = Math.min(min, max);
  max = Math.max(max, min + 0.001);
  recommended = Math.min(max, Math.max(min, recommended));
  position.risk_fraction_range = { min, max, recommended };
  position.risk_fraction = recommended;
}

export async function proposePlan(symbol: string, opts?: { fresh?: boolean; sessionId?: string; context?: { killReason?: string; killDetails?: any } }): Promise<PlanJson> {
  const snap = await buildTechSnapshot(symbol);
  const regime = snap.regime;
  const signature = `${regime?.playbook || 'na'}:${Math.round((snap.trendStrength ?? 0)*100)}:${Math.round((snap.atrPct ?? 0)*100)}:${Math.round((snap.realizedVol ?? 0)*10)}:${Math.round((snap.adxSlope ?? 0)*100)}`;
  const allowCache = !opts?.fresh && !opts?.context;
  const cacheKey = cacheKeyForPlan(symbol, regime, opts?.sessionId, opts?.context?.killReason, allowCache ? signature : undefined);
  if (allowCache) {
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
  let killSwitchNote = '';
  if (opts?.context?.killReason) {
    let detailStr = '';
    try {
      detailStr = JSON.stringify(opts.context.killDetails ?? {});
    } catch {
      detailStr = String(opts.context.killDetails ?? '');
    }
    if (detailStr.length > 400) detailStr = `${detailStr.slice(0, 400)}…`;
    killSwitchNote = `Kill switch reason previously triggered: ${opts.context.killReason}. Details: ${detailStr}. Address the underlying risk before proposing entries.`;
  }
  const nowUtc = new Date();
  const sys = `You are a market analyst. You receive an enriched technical snapshot (price, RSI, ATR, S/R, volatility, volume) plus sentiment/news and risk constraints. Output ONLY a JSON matching this schema: {"name","symbol","timeframe","bias","zone":{"type","price":null,"from":"auto_detect"},"entry_rule":{"type":"rebound|rejection","confirm_close":true,"max_distance_pct":0.4},"risk":{"stop":{"type":"atr","mult":0.9},"tp":[{"type":"R","value":1.0}],"max_hold_hours":36},"position":{"risk_fraction":0.015,"risk_fraction_range":{"min":0.01,"max":0.02,"recommended":0.015},"max_leverage":4},"notes":"..."}. Do NOT invent any prices. If unsure, return bias:"none".\n${regimeContext}\nIf playbook=momentum_breakout favor entries aligned with the trend and confirm_close may be false with tighter distance; if playbook=standby bias:"none". Provide risk_fraction_range tuned to the conviction level. Recommended should usually sit within 0.8x–1.2x of the base risk_fraction.`;
  const marketContext = `ATR% ${Number(snap.atrPct).toFixed(2)}, realizedVol ${Number(snap.realizedVol || 0).toFixed(2)}, adxSlope ${Number(snap.adxSlope || 0).toFixed(3)}, volume24h ${Math.round(snap.volume24h || 0)}, volumeChange ${Number(snap.volume24hChangePct || 0).toFixed(2)}%, hurst ${Number(snap.hurst || 0).toFixed(2)}, trendStrength ${Number(snap.trendStrength || 0).toFixed(2)}`;
  const timingContext = `UTC hour ${nowUtc.getUTCHours()}, weekday ${nowUtc.getUTCDay()}, snapshotSignature ${signature}`;
  const guidance = `When volatility is elevated or conviction is low, tighten risk_fraction_range (e.g., 0.008-0.012). When trend is strong and supportive, you may widen to max 0.022 but never exceed the configured risk guard.`;
  const enrichedSys = [sys, killSwitchNote, `Market context: ${marketContext}.`, timingContext, guidance].filter(Boolean).join('\n');
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
      volume24h: snap.volume24h,
      volumeChangePct: snap.volume24hChangePct,
      hurst: snap.hurst,
      adxSlope: snap.adxSlope,
    },
    sentiment: sent,
    news: news?.summary ? news.summary.slice(0, 280) : undefined,
    killSwitch: opts?.context ?? undefined,
    meta: { hourUTC: nowUtc.getUTCHours(), weekdayUTC: nowUtc.getUTCDay(), signature },
  };
  try {
    const cfg = getConfig();
    const day = new Date().toISOString().slice(0,10);
    const planCooldownMin = Number(process.env.PLAN_LLM_COOLDOWN_MIN || cfg.PLAN_LLM_COOLDOWN_MIN || 15);
    const planMaxPerHour = Number(process.env.PLAN_LLM_MAX_PER_HOUR || cfg.PLAN_LLM_MAX_PER_HOUR || 3);
    const allowPlanCall = opts?.fresh || opts?.context ? true : shouldAllowPlanLLM(symbol, { cooldownMin: planCooldownMin, maxPerHour: planMaxPerHour });

    if (!allowPlanCall) {
      if (allowCache) {
        const cached = planCache.get(cacheKey);
        if (cached && (Date.now() - cached.ts) < PLAN_CACHE_TTL_MS) {
          return clonePlan(cached.plan);
        }
      }
      recordOpsEvent({ level: 'info', source: 'plan_guard', message: 'llm_skipped_due_to_rate', sessionId: opts?.sessionId, symbol, details: { cooldownMin: planCooldownMin, maxPerHour: planMaxPerHour } });
      const fallback = buildFallbackPlan(symbol, snap, regime);
      if (allowCache) cachePlan(cacheKey, fallback);
      return fallback;
    }

    const out = await llmJSON(`${enrichedSys}\nContext: ${JSON.stringify(user)}`, {
      cacheKey: allowCache ? `plan:${day}:${symbol}` : undefined,
      ttlMin: 120,
      bypassRate: !!opts?.fresh || !!opts?.context,
      noCache: !!opts?.fresh || !!opts?.context,
      provider: cfg.USE_GROK_FOR_PLAN ? 'grok' : 'openai',
      context: { sessionId: opts?.sessionId, symbol, kind: 'plan' },
    });
    markPlanLLM(symbol);
    const j = safeParse(out);
    const normalized = alignPlanForConsistency(normalizePlanOutput(j, symbol));
    const parsed = PlanZ.safeParse(normalized);
    if (!parsed.success) {
      const issue = parsed.error.issues?.map(i => i.message).join(';') || 'unknown';
      throw new Error(`plan_schema_invalid:${issue}`);
    }
    let plan = alignPlanForConsistency(parsed.data);
    plan = applyRegimePlaybook(plan, regime, snap);
    plan = alignPlanForConsistency(plan);
    ensurePlanConsistency(plan, regime, snap);
    normalizeRiskRange(plan.position);
    if (allowCache) cachePlan(cacheKey, plan);
    return clonePlan(plan);
  } catch (e:any) {
    const errMsg = String(e?.message || e);
    if (/plan_schema_invalid|LLM returned non-JSON|plan_inconsistent/.test(errMsg)) {
      try { await emitAlert({ sessionId: opts?.sessionId, symbol, kind:'llm_invalid', severity:'med', details:{ where:'plan', error: errMsg } }); } catch {}
    }
    recordOpsEvent({ level: 'warn', source: 'plan_fallback', message: 'llm_plan_failure', sessionId: opts?.sessionId, symbol, details: { error: errMsg } });
    const cached = allowCache ? planCache.get(cacheKey) : undefined;
    if (cached && (Date.now() - cached.ts) < PLAN_CACHE_TTL_MS) {
      recordOpsEvent({ level: 'warn', source: 'plan_cache', message: 'reuse_cached_plan_after_failure', sessionId: opts?.sessionId, symbol, details: { playbook: regime?.playbook } });
      return clonePlan(cached.plan);
    }
    const fallback = buildFallbackPlan(symbol, snap, regime);
    if (allowCache) cachePlan(cacheKey, fallback);
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
    clone.position.risk_fraction = Math.min(0.025, Math.max(0.008, clone.position.risk_fraction * 1.1));
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

  normalizeRiskRange(clone.position);
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
  normalizeRiskRange(adjusted.position);
  return PlanZ.parse(clonePlan(adjusted));
}
