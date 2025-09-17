import { PlanZ, PlanJson } from '../agent/planSchema.js';
import { buildTechSnapshot, TechnicalSnapshot } from './tech.js';
import { llmJSON } from './llm.js';
import { emitAlert } from '../monitor/policy.js';
import { getConfig } from '../utils/env.js';
import { fullAnalysis } from './analysis.js';
import type { RegimeProfile } from './regime.js';

function safeParse<T=any>(s: string): T { try { return JSON.parse(s) as T; } catch { throw new Error('LLM returned non-JSON'); } }

export async function proposePlan(symbol: string, opts?: { fresh?: boolean; sessionId?: string }): Promise<PlanJson> {
  const snap = await buildTechSnapshot(symbol);
  const regime = snap.regime;
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
    const out = await llmJSON(`${sys}\nContext: ${JSON.stringify(user)}`, { cacheKey: opts?.fresh ? undefined : `plan:${day}:${symbol}`, ttlMin: 120, bypassRate: !!opts?.fresh, noCache: !!opts?.fresh, provider: cfg.USE_GROK_FOR_PLAN ? 'grok' : 'openai' });
    const j = safeParse(out);
    let plan = PlanZ.parse(j);
    plan = applyRegimePlaybook(plan, regime, snap);
    return plan;
  } catch (e:any) {
    try { await emitAlert({ sessionId: opts?.sessionId, symbol, kind:'llm_invalid', severity:'med', details:{ where:'plan', error: String(e?.message || e) } }); } catch {}
    // Fallback rule-based
    const isLong = snap.srBias !== 'nearResistance' && (snap.ema20 >= snap.ema50);
    let plan: PlanJson = {
      name: isLong ? 'Support_Rebound_v1' : 'Resistance_Rejection_v1',
      symbol,
      timeframe: '1h',
      bias: isLong ? 'long' : 'short',
      zone: { type: isLong ? 'support' : 'resistance', price: null, from: 'auto_detect' },
      entry_rule: { type: isLong ? 'rebound' : 'rejection', confirm_close: true, max_distance_pct: 0.4 },
      risk: { stop: { type: 'atr', mult: 0.9 }, tp: [{ type: 'R', value: 1.0 }, { type: 'R', value: 2.0 }], max_hold_hours: 36 },
      position: { risk_fraction: 0.015, max_leverage: 4 },
      notes: 'Auto plan based on EMA slope and S/R bias.'
    };
    plan = applyRegimePlaybook(plan, regime, snap);
    return PlanZ.parse(plan);
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
