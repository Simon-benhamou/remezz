// backend/src/engine/events.ts
import { getConfig } from '../utils/env.js';
import { prisma } from '../db/client.js';
import { buildTechSnapshot, TechnicalSnapshot } from '../ai/tech.js';
import { requestStrategy, shouldEngineRegenerate } from '../ai/strategyManager.js';
import { broadcast } from '../ws/hub.js';
import { Agent } from '../agent/state.js';

let running = false;
const NEAR_SR_PCT = Number(process.env.NEAR_SR_PCT || 0.4);   // 0.4%
const NEAR_PIVOT_PCT = Number(process.env.NEAR_PIVOT_PCT || 0.25); // 0.25%
const LOG_TRIGGERS = (process.env.LOG_TRIGGERS || 'true') === 'true';

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

async function tickOnce(sessionId: string|undefined, sym: string){
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
  }, sym);

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
      try {
        created = await prisma.triggerLog.create({ data:{ sessionId, symbol: sym, kind: trigger, payload: { price: tech.last, support, resistance, pivots: piv } }});
      } catch {}
    }
    // Broadcast this trigger so UI can update live
    broadcast('trigger', created, sym);
    await maybeGenerateStrategy(sym, trigger, tech.last, sessionId);
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
  broadcast('strategy', { ...(strat as any), levels: lvls }, sym);
}

/**
 * Realtime loop: read active session symbol, compute technical snapshot,
 * trigger events (S/R/pivots), broadcast tick and maybe generate strategies.
 */


export async function startEventEngine(){
  if (running) return; running = true;
  const cfg = getConfig(); const pollMs = Number(cfg.POLL_MS || 2000);

  async function loop(){
    try {
      const s = await prisma.agentSession.findFirst({ where:{ stoppedAt:null }, orderBy:{ startedAt:'desc' } });
      const sym = s?.symbol || cfg.SYMBOL;
      const tech = await tickOnce(s?.id, sym);
      lastTick = { symbol: sym, price: tech.last, ts: Date.now() };
      // Let the agent evaluate triggers and manage positions
      await Agent.onTick().catch(()=>{});
    } catch (e) { /* log optionnel */ }
    finally { setTimeout(loop, pollMs); }
  }
  loop();
}
