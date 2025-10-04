// backend/src/engine/events.ts
import { getConfig } from '../utils/env.js';
import { prisma } from '../db/client.js';
import { buildTechSnapshot, TechnicalSnapshot } from '../ai/tech.js';
import { requestStrategy, shouldEngineRegenerate } from '../ai/strategyManager.js';
import { broadcast } from '../ws/hub.js';
import { AgentHub } from '../agent/hub.js';
import { recordOpsEvent } from '../monitor/ops.js';
import { inspectExposure } from '../broker/live.js';
import { extractPersistedPlan } from '../services/planStore.js';

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
// Track last strategy bias per symbol and indicator refresh state
const lastStrategyBias: Record<string, 'long' | 'short' | 'none' | null> = {};
const lastRefreshAt: Record<string, number> = {};
const divergenceTicks: Record<string, number> = {};
const lastRsiBySym: Record<string, number> = {};
const lastIndicatorSig: Record<string, { price: number; emaSpread: number; rsi: number; adx: number }> = {};
let lastTick = { symbol: '', price: 0, ts: 0 };
const lastTickBySession = new Map<string, number>();

// Expose last tick info for health checks
export function getLastTickAgeSec(sessionId: string): number | null {
  try {
    const ts = lastTickBySession.get(sessionId) || 0;
    if (!ts) return null;
    return Math.round((Date.now() - ts) / 1000);
  } catch { return null; }
}

function pctDiff(a: number, b: number) {
  if (!a || !b || b === 0) return 0; // Protection contre division par zéro
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
  let tech: any = null;
  let support: any = null;
  let resistance: any = null;
  let ns: any = null;
  let nr: any = null;
  let piv: any = null;
  
  try {
    // Update timestamp BEFORE processing to avoid stale_data alerts
    lastTickBySession.set(sessionId, Date.now());
    
    // Add timeout to buildTechSnapshot to prevent hanging
    tech = await Promise.race([
      buildTechSnapshot(sym),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Tech snapshot timeout')), 30000))
    ]) as any;

    // Primary support/resistance
    support = tech.support;
    resistance = tech.resistance;

    // Nearest swing levels (support/resistance)
    ns = nearestLevel(tech.last, tech.supports);
    nr = nearestLevel(tech.last, tech.resistances);

    // Daily pivots
    piv = tech.pivots;

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
    
  } catch (error) {
    // Even on error, update timestamp to prevent stale_data cascade
    lastTickBySession.set(sessionId, Date.now());
    recordOpsEvent({
      level: 'error',
      source: 'tickOnce',
      message: 'Failed to build tech snapshot',
      sessionId,
      symbol: sym,
      details: { error: String((error as any)?.message || error) }
    });
    throw error;
  }

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

  // Intelligent indicator-based refresh (event-driven, debounced)
  try { await maybeRefreshStrategyIndicators(sessionId, sym, tech); } catch {}

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
async function maybeGenerateStrategy(sym: string, trigger: string, price: number, sessionId: string, force: boolean = false) {
  const minIntervalMin = Number(process.env.STRATEGY_MIN_INTERVAL_MIN || 60);
  const now = Date.now();

  const canByTime = !lastStrategyAt || (now - lastStrategyAt) > minIntervalMin * 60 * 1000;
  const canByZone = shouldEngineRegenerate(sym, price);

  if (!force && !canByTime && !canByZone) return; // avoid excessive LLM calls unless forced by indicators

  const { strategy: strat, levels: lvls, reused } = await requestStrategy({ symbol: sym, trigger, sessionId, priceHint: price, force });
  if (!reused) {
    lastStrategyAt = now;
    lastStrategyZone = (strat as any)?.entry?.zone || null;
    try { lastStrategyBias[sym] = ((strat as any)?.bias as any) || null; } catch { lastStrategyBias[sym] = null; }
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
              startBalanceUsd: (typeof p.startBalanceUsd === 'number' && p.startBalanceUsd > 0)
                ? p.startBalanceUsd
                : (typeof s.startBalanceUsd === 'number' && s.startBalanceUsd > 0 ? Number(s.startBalanceUsd) : undefined),
              budgetFraction: (()=>{ let bf = typeof p.budgetPct==='number'? p.budgetPct:1; if (bf>1) bf/=100; return Math.min(1, Math.max(0.1, bf)); })(),
              aggressiveness: (p.aggressiveness === 'reactive' || p.aggressiveness === 'aggressive') ? p.aggressiveness : 'conservative',
              userId: s.userId ?? undefined,
            };
            try { await (await import('../agent/hub.js')).AgentHub.activate(s.id, profile as any); } catch {}
            // If a persisted plan exists, re-arm the agent automatically without calling LLM again
            try {
              const a = (await import('../agent/hub.js')).AgentHub.get(s.id) as any;
              const plan = extractPersistedPlan((s as any).planJson);
              if (a && plan) {
                await a.propose(plan);
                await a.validateAndArm();
                // Seed lastStrategyBias with persisted plan's bias to allow indicator refresh before next LLM call
                try { lastStrategyBias[s.symbol] = (plan as any)?.bias || null; } catch { lastStrategyBias[s.symbol] = null; }
              }
            } catch {}
          }
        } catch {}
      }
      const sessions = await prisma.agentSession.findMany({ where:{ stoppedAt:null }, orderBy:{ startedAt:'asc' } });
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        // Use currentSymbol for Smart Agents, fallback to original symbol
        const sym = (s as any).currentSymbol || s.symbol || cfg.SYMBOL;
        try {
          // Add progressive delay between sessions to spread API load
          if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay between sessions
          }
          
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

// Indicator-driven refresh gate. Calls strategy refresh when signals contradict current bias.
async function maybeRefreshStrategyIndicators(sessionId: string, sym: string, tech: TechnicalSnapshot) {
  const cfg = getConfig();
  if (!cfg.STRAT_REFRESH_ENABLED) return;

  const now = Date.now();
  const debounceMs = Math.max(0, (cfg.STRAT_REFRESH_DEBOUNCE_SEC || 60) * 1000);
  const last = lastRefreshAt[sym] || 0;
  if (last && now - last < debounceMs) return; // debounce per symbol

  const bias = lastStrategyBias[sym] || null;
  if (!bias || bias === 'none') return; // no basis to compare – skip

  const ema20 = Number((tech as any).ema20 || 0);
  const ema50 = Number((tech as any).ema50 || 0);
  const ema20Slope = Number((tech as any).ema20Slope || 0);
  const rsi = Number((tech as any).rsi14 || 50);
  const adx = Number((tech as any).adx14 || 0);
  const price = Number((tech as any).last || 0);
  const support = (tech as any).support;
  const resistance = (tech as any).resistance;

  // Skip refresh if indicators haven't changed significantly since last signature
  if (price > 0 && ema50 !== 0) {
    const emaSpread = ((ema20 - ema50) / ema50) * 100; // percent
    const prev = lastIndicatorSig[sym];
    if (prev) {
      // Base thresholds from env
      let minPriceBps = Math.max(0, cfg.STRAT_REFRESH_MIN_PRICE_BPS || 10);
      let minSpreadBps = Math.max(0, cfg.STRAT_REFRESH_MIN_EMA_SPREAD_BPS || 8);
      let minRsi = Math.max(0, cfg.STRAT_REFRESH_MIN_RSI_DELTA || 2);
      let minAdx = Math.max(0, cfg.STRAT_REFRESH_MIN_ADX_DELTA || 2);

      // Adaptive tuning per symbol volatility/liquidity (optional)
      if (cfg.STRAT_REFRESH_ADAPTIVE_ENABLED) {
        const atrPct = Number((tech as any).atrPct || 0);
        const realized = Number((tech as any).realizedVol || 0);
        const volProfile = ((): 'LOW'|'MOD'|'HIGH'|'EXTREME' => {
          if (atrPct > 4.0 || realized > 180) return 'EXTREME';
          if (atrPct > 2.0 || realized > 120) return 'HIGH';
          if (atrPct < 0.8 && realized < 60) return 'LOW';
          return 'MOD';
        })();
        const base = (x:number)=>x;
        const clamp = (v:number, lo:number, hi:number)=> Math.max(lo, Math.min(hi, v));
        let volFactor = 1.0;
        if (volProfile === 'LOW') volFactor = 0.75;
        else if (volProfile === 'MOD') volFactor = 1.0;
        else if (volProfile === 'HIGH') volFactor = 1.25;
        else if (volProfile === 'EXTREME') volFactor = 1.5;

        // Tier factor by symbol class
        const baseSym = String((tech as any).symbol || sym).split('/')[0].toUpperCase();
        const tier1 = ['BTC','ETH','SOL','XRP','BNB'];
        const meme = ['DOGE','SHIB','PEPE','WIF','BONK','FLOKI'];
        let tierFactor = 1.0;
        if (tier1.includes(baseSym)) tierFactor = 0.9;     // more reactive for majors
        else if (meme.includes(baseSym)) tierFactor = 1.2;  // more robust for memes

        const factor = volFactor * tierFactor;
        minPriceBps = clamp(minPriceBps * factor, 6, 40);
        minSpreadBps = clamp(minSpreadBps * factor, 4, 30);
        minRsi = clamp(minRsi * Math.max(0.8, Math.min(1.4, factor)), 1, 6);
        minAdx = clamp(minAdx * Math.max(0.8, Math.min(1.4, factor)), 1, 6);
      }

      const priceBps = Math.abs((price - prev.price) / price) * 10000; // bps
      const spreadBps = Math.abs(emaSpread - prev.emaSpread) * 100;    // percent->bps
      const rsiDelta = Math.abs(rsi - prev.rsi);
      const adxDelta = Math.abs(adx - prev.adx);

      const significant = (priceBps >= minPriceBps) || (spreadBps >= minSpreadBps) || (rsiDelta >= minRsi) || (adxDelta >= minAdx);
      if (!significant) {
        // Update signature to latest anyway
        lastIndicatorSig[sym] = { price, emaSpread, rsi, adx };
        return; // no meaningful change → skip refresh
      }
    }
    // Update signature prior to potential refresh
    lastIndicatorSig[sym] = { price, emaSpread, rsi, adx };
  }

  let shouldForce = false;
  let reason = '';

  // 1) Bias divergence (EMA alignment + slope against bias) for N consecutive ticks
  if (cfg.STRAT_REFRESH_BIAS_DIVERGENCE_ENABLED && ema20 > 0 && ema50 > 0) {
    const slopePct = ema20 !== 0 ? (ema20Slope / ema20) * 100 : 0;
    const trendMisaligned = bias === 'long' ? (ema20 <= ema50) : (ema20 >= ema50);
    const slopeAgainst = bias === 'long' ? (slopePct < -0.03) : (slopePct > 0.03);
    if (trendMisaligned && slopeAgainst) {
      divergenceTicks[sym] = (divergenceTicks[sym] || 0) + 1;
    } else {
      divergenceTicks[sym] = 0;
    }
    if (divergenceTicks[sym] >= Math.max(1, cfg.STRAT_REFRESH_BIAS_DIVERGENCE_TICKS || 3)) {
      shouldForce = true; reason = 'indicator-refresh:bias-divergence';
    }
  }

  // 2) SR rejection against bias (near level + slope against bias)
  if (!shouldForce && cfg.STRAT_REFRESH_SR_REJECTION_ENABLED && price > 0) {
    const nearPct = Number(process.env.NEAR_SR_PCT || 0.4);
    const nearLevel = (a:number,b:number,p:number)=> Math.abs(a-b) <= Math.abs(b)*(p/100);
    const slopePct = ema20 !== 0 ? (ema20Slope / ema20) * 100 : 0;
    const nearRes = (typeof resistance === 'number') && nearLevel(price, resistance as number, nearPct);
    const nearSup = (typeof support === 'number') && nearLevel(price, support as number, nearPct);
    if (bias === 'long' && nearRes && slopePct < -0.03) { shouldForce = true; reason = 'indicator-refresh:resistance-rejection'; }
    if (bias === 'short' && nearSup && slopePct > 0.03) { shouldForce = true; reason = 'indicator-refresh:support-bounce'; }
  }

  // 3) RSI cross against bias
  if (!shouldForce && cfg.STRAT_REFRESH_RSI_CROSS_ENABLED) {
    const prev = lastRsiBySym[sym];
    const ob = cfg.STRAT_REFRESH_RSI_OVERBOUGHT || 70;
    const os = cfg.STRAT_REFRESH_RSI_OVERSOLD || 30;
    if (prev != null) {
      if (bias === 'long' && prev >= os && rsi < os) { shouldForce = true; reason = 'indicator-refresh:rsi-oversold-cross'; }
      if (bias === 'short' && prev <= ob && rsi > ob) { shouldForce = true; reason = 'indicator-refresh:rsi-overbought-cross'; }
    }
    lastRsiBySym[sym] = rsi;
  }

  if (!shouldForce) return;
  lastRefreshAt[sym] = now;
  try {
    await maybeGenerateStrategy(sym, reason, price, sessionId, true);
  } catch {}
}
