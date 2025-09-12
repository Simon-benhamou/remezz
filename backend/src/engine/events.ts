// backend/src/engine/events.ts
import { getConfig } from '../utils/env.js';
import { prisma } from '../db/client.js';
import { buildTechSnapshot, TechnicalSnapshot } from '../ai/tech.js';
import { requestStrategy, shouldEngineRegenerate } from '../ai/strategyManager.js';
import { broadcast } from '../ws/hub.js';
import { AgentHub } from '../agent/hub.js';

let running = false;
const NEAR_SR_PCT = Number(process.env.NEAR_SR_PCT || 0.4);   // 0.4%
const NEAR_PIVOT_PCT = Number(process.env.NEAR_PIVOT_PCT || 0.25); // 0.25%
const LOG_TRIGGERS = (process.env.LOG_TRIGGERS || 'true') === 'true';
const TRIGGER_SAMPLE_RATE = Math.max(0, Math.min(1, Number(process.env.TRIGGER_SAMPLE_RATE || '1')));
const TRIGGER_RETENTION_DAYS = Math.max(0, Number(process.env.TRIGGER_RETENTION_DAYS || '7'));
let lastPurgeAt = 0;

// Local throttling to limit LLM calls
let lastStrategyAt: number | null = null;
let lastStrategyZone: { min?: number | null; max?: number | null } | null = null;
let lastTick = { symbol: '', price: 0, ts: 0 };

function pctDiff(a: number, b: number) {
  if (!a || !b) return 0;
  return Math.abs(a - b) / Math.abs(b);
}
function near(a:number,b:number,p:number){ return Math.abs(a-b) <= Math.abs(b)*(p/100); }

function leftZone(price: number, z?: { min?: number | null; max?: number | null } | null) {
  if (!z || z.min == null || z.max == null) return false;
  return price < (z.min as number) || price > (z.max as number);
}
function nearestLevel(price:number, levels:{price:number}[]) {
  if (!levels?.length) return null;
  return levels.reduce((best,cur)=> !best || Math.abs(cur.price-price) < Math.abs(best.price-price) ? cur : best, null as any);
}

async function tickOnce(sessionId: string, sym: string){
  const tech = await buildTechSnapshot(sym);

  // Primary support/resistance
  const support = tech.support;
  const resistance = tech.resistance;

  // Nearest swing levels (support/resistance)
  const ns = nearestLevel(tech.last, tech.supports);
  const nr = nearestLevel(tech.last, tech.resistances);

  // Daily pivots
  const piv = tech.pivots;

  // Broadcast a rich tick payload (supports/resistances/pivots)
  broadcast('tick', {
    ts: Date.now(),
    symbol: sym,
    price: tech.last,
    support,
    resistance,
    supports: tech.supports,
    resistances: tech.resistances,
    pivots: tech.pivots
  }, sym, sessionId);

  // Triggers: touch support/resistance or pivots
  let trigger: string | null = null;
  if (near(tech.last, support, NEAR_SR_PCT)) trigger = 'support-touch';
  if (near(tech.last, resistance, NEAR_SR_PCT)) trigger = 'resistance-touch';
  if (!trigger && ns && near(tech.last, ns.price, NEAR_SR_PCT)) trigger = 'swing-support-touch';
  if (!trigger && nr && near(tech.last, nr.price, NEAR_SR_PCT)) trigger = 'swing-resistance-touch';
  if (!trigger && piv) {
    if (near(tech.last, piv.S1, NEAR_PIVOT_PCT)) trigger = 'pivot-S1-touch';
    else if (near(tech.last, piv.R1, NEAR_PIVOT_PCT)) trigger = 'pivot-R1-touch';
  }

  if (trigger && sessionId) {
    let created: any = { sessionId, symbol: sym, kind: trigger, payload: { price: tech.last, support, resistance, pivots: piv }, createdAt: new Date() };
    if (LOG_TRIGGERS) {
      const keep = Math.random() < TRIGGER_SAMPLE_RATE;
      if (keep) {
        try {
          created = await prisma.triggerLog.create({ data:{ sessionId, symbol: sym, kind: trigger, payload: { price: tech.last, support, resistance, pivots: piv } }});
        } catch {}
      }
    }
    // Broadcast this trigger so UI can update live
    broadcast('trigger', created, sym, sessionId);
    await maybeGenerateStrategy(sym, trigger, tech.last, sessionId);
  }

  // Periodic retention purge (hourly)
  if (TRIGGER_RETENTION_DAYS > 0 && Date.now() - lastPurgeAt > 60*60*1000) {
    lastPurgeAt = Date.now();
    try {
      const cutoff = new Date(Date.now() - TRIGGER_RETENTION_DAYS * 24 * 3600 * 1000);
      await prisma.triggerLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    } catch {}
  }

  return tech;
}
/**
 * Possibly generate a new classic strategy and PlanZ based on:
 *  - rate limit (STRATEGY_MIN_INTERVAL_MIN)
 *  - leaving the previous strategy entry zone
 */
async function maybeGenerateStrategy(sym: string, trigger: string, price: number, sessionId: string) {
  const minIntervalMin = Number(process.env.STRATEGY_MIN_INTERVAL_MIN || 60);
  const now = Date.now();

  const canByTime = !lastStrategyAt || (now - lastStrategyAt) > minIntervalMin * 60 * 1000;
  const canByZone = shouldEngineRegenerate(sym, price);

  if (!canByTime && !canByZone) return; // avoid excessive LLM calls

  const { strategy: strat, levels: lvls, reused } = await requestStrategy({ symbol: sym, trigger, sessionId, priceHint: price });
  if (!reused) {
    lastStrategyAt = now;
    lastStrategyZone = (strat as any)?.entry?.zone || null;
  }

  // Push WS (classic strategy preview)
  broadcast('strategy', { ...(strat as any), levels: lvls }, sym, sessionId);
}

/**
 * Realtime loop: read active session symbol, compute technical snapshot,
 * trigger events (S/R/pivots), broadcast tick and maybe generate strategies.
 */


export async function startEventEngine(){
  if (running) return; running = true;
  const cfg = getConfig(); const pollMs = Number(cfg.POLL_MS || 2000);
  let booted = false;

  async function loop(){
    try {
      if (!booted) {
        booted = true;
        try {
          const sessions = await prisma.agentSession.findMany({ where:{ stoppedAt:null } });
          for (const s of sessions) {
            const p:any = (s as any).profileJson || {};
            const profile = {
              symbol: s.symbol,
              mode: s.mode as any,
              maxLeverage: Math.min(5, Math.max(1, p.maxLeverage ?? 4)),
              riskPerTradePct: Math.min(2, Math.max(1, p.riskPerTradePct ?? 1.5)),
              dailyLossLimitPct: Math.min(4, Math.max(3, p.dailyLossLimitPct ?? 3.5)),
              timestamp: new Date().toISOString(),
              startBalanceUsd: p.startBalanceUsd,
              budgetFraction: (()=>{ let bf = typeof p.budgetPct==='number'? p.budgetPct:1; if (bf>1) bf/=100; return Math.min(1, Math.max(0.1, bf)); })(),
            };
            try { await (await import('../agent/hub.js')).AgentHub.activate(s.id, profile as any); } catch {}
          }
        } catch {}
      }
      const sessions = await prisma.agentSession.findMany({ where:{ stoppedAt:null }, orderBy:{ startedAt:'asc' } });
      for (const s of sessions) {
        const sym = s.symbol || cfg.SYMBOL;
        const tech = await tickOnce(s.id, sym);
        lastTick = { symbol: sym, price: tech.last, ts: Date.now() };
        try { await (await import('../agent/hub.js')).AgentHub.onTick(s.id); } catch {}
      }
    } catch (e) { /* log optionnel */ }
    finally { setTimeout(loop, pollMs); }
  }
  loop();
}
