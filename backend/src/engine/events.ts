// backend/src/engine/events.ts
import { getConfig } from '../utils/env.js';
import { prisma } from '../db/client.js';
import { buildTechSnapshot, TechnicalSnapshot } from '../ai/tech.js';
import { requestStrategy, shouldEngineRegenerate } from '../ai/strategyManager.js';
import { broadcast } from '../ws/hub.js';
import { AgentHub } from '../agent/hub.js';
import { recordOpsEvent } from '../monitor/ops.js';
import { inspectExposure } from '../broker/live.js';

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
const lastTickBySession = new Map<string, number>();

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
  try { lastTickBySession.set(sessionId, Date.now()); } catch {}

  // Broadcast a lightweight overview update for this session (live ROI/PnL)
  try {
    const s = await prisma.agentSession.findUnique({ where:{ id: sessionId }, include: { kpi: true } });
    if (s) {
      const a = AgentHub.get(sessionId) as any;
      let upnlUsd = 0;
      if (a?.pos) {
        const dir = a.pos.side === 'buy' ? 1 : -1;
        upnlUsd = dir * (tech.last - a.pos.entry) * a.pos.qty;
      }
      const realized = Number((s as any)?.kpi?.realizedPnlUsd || 0);
      const unrealized = Number((s as any)?.kpi?.unrealizedPnlUsd || 0);
      const pnlUsd = realized + unrealized + upnlUsd;
      const capital = Number(s.startBalanceUsd || 0);
      const roiPct = capital > 0 ? (pnlUsd / capital) * 100 : Number((s as any)?.kpi?.roiPct || 0);
      broadcast('overview_session', { id: s.id, symbol: s.symbol, price: tech.last, pnlUsd, roiPct, ts: Date.now() });
    }
  } catch {}

  // Policy audit: check conformance (late invalidation, missed partial, overtrading)
  try { (await import('../monitor/policy.js')).auditTick(sessionId, sym, tech.last); } catch {}

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

async function reconcileExposure(sessionId: string, symbol: string, mode: string) {
  if (mode !== 'live') return;
  const agent = AgentHub.get(sessionId) as any;
  try {
    const exposure = await inspectExposure(symbol);
    const remoteQty = exposure?.qty || 0;
    const remoteSide = exposure?.side || null;
    const localQty = agent?.pos?.qty || 0;
    const localSide = agent?.pos?.side || null;
    const diff = Math.abs(remoteQty - localQty);
    const tolerance = Math.max(1e-6, localQty * 0.1);
    if (diff > tolerance || (remoteQty > 0 && localQty > 0 && remoteSide !== localSide)) {
      recordOpsEvent({
        level: 'warn',
        source: 'reconciliation',
        message: 'Exposure mismatch',
        sessionId,
        symbol,
        details: { remoteQty, localQty, remoteSide, localSide },
      });
    }
    if (remoteQty > 0 && !localQty) {
      recordOpsEvent({
        level: 'warn',
        source: 'reconciliation',
        message: 'Exchange shows open position but agent is flat',
        sessionId,
        symbol,
        details: { remoteQty, remoteSide },
      });
    }
  } catch (e) {
    recordOpsEvent({ level: 'error', source: 'reconciliation', message: 'inspectExposure failed', sessionId, symbol, details: { error: String((e as any)?.message || e) } });
  }
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
              maxLeverage: Math.min(10, Math.max(1, p.maxLeverage ?? 4)),
              riskPerTradePct: Math.min(5, Math.max(0.5, p.riskPerTradePct ?? 1.5)),
              dailyLossLimitPct: Math.min(4, Math.max(3, p.dailyLossLimitPct ?? 3.5)),
              timestamp: new Date().toISOString(),
              startBalanceUsd: p.startBalanceUsd,
              budgetFraction: (()=>{ let bf = typeof p.budgetPct==='number'? p.budgetPct:1; if (bf>1) bf/=100; return Math.min(1, Math.max(0.1, bf)); })(),
              aggressiveness: (p.aggressiveness === 'reactive' || p.aggressiveness === 'aggressive') ? p.aggressiveness : 'conservative',
            };
            try { await (await import('../agent/hub.js')).AgentHub.activate(s.id, profile as any); } catch {}
            // If a persisted plan exists, re-arm the agent automatically without calling LLM again
            try {
              const a = (await import('../agent/hub.js')).AgentHub.get(s.id) as any;
              const planJson = (s as any).planJson;
              if (a && planJson) {
                await a.propose(planJson);
                await a.validateAndArm();
              }
            } catch {}
          }
        } catch {}
      }
      const sessions = await prisma.agentSession.findMany({ where:{ stoppedAt:null }, orderBy:{ startedAt:'asc' } });
      for (const s of sessions) {
        const sym = s.symbol || cfg.SYMBOL;
        try {
          const tech = await tickOnce(s.id, sym);
          lastTick = { symbol: sym, price: tech.last, ts: Date.now() };
          try { await (await import('../agent/hub.js')).AgentHub.onTick(s.id); } catch {}
          await reconcileExposure(s.id, sym, s.mode as string);
        } catch (err) {
          recordOpsEvent({
            level: 'error',
            source: 'heartbeat',
            message: 'Tick processing failed',
            sessionId: s.id,
            symbol: sym,
            details: { error: String((err as any)?.message || err) },
          });
        }
      }
      // Stale data monitoring
      try {
        const { STALE_TICK_SEC } = getConfig();
        const now = Date.now();
        for (const s of await prisma.agentSession.findMany({ where:{ stoppedAt:null }, select:{ id:true, symbol:true } })) {
          const ts = lastTickBySession.get(s.id) || 0;
          if (ts > 0 && (now - ts) > STALE_TICK_SEC * 1000) {
            try {
              const { emitAlert } = await import('../monitor/policy.js');
              await emitAlert({ sessionId: s.id, symbol: s.symbol, kind:'stale_data', severity:'med', details:{ lastTickSec: Math.round((now-ts)/1000) } });
              recordOpsEvent({ level: 'warn', source: 'heartbeat', message: 'Stale data detected', sessionId: s.id, symbol: s.symbol, details: { staleSec: Math.round((now - ts)/1000) } });
              lastTickBySession.set(s.id, now); // avoid spamming; emit at most once per window
            } catch {}
          }
        }
      } catch {}
    } catch (e) { /* log optionnel */ }
    finally { setTimeout(loop, pollMs); }
  }
  loop();
}
