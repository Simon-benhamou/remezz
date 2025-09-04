// backend/src/engine/events.ts
import { getConfig } from '../utils/env.js';
import { prisma } from '../db/client.js';
import { buildTechSnapshot, TechnicalSnapshot } from '../ai/tech.js';
import { generateStrategy } from '../ai/orchestrator.js';
import { broadcast } from '../ws/hub.js';
import { levels as calcLevels } from '../risk/brackets.js';

let running = false;
const NEAR_SR_PCT = Number(process.env.NEAR_SR_PCT || 0.4);   // 0.4%
const NEAR_PIVOT_PCT = Number(process.env.NEAR_PIVOT_PCT || 0.25); // 0.25%

// Mémoire locale pour limiter les appels IA
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

  // primaire (déjà calculé par buildTechSnapshot)
  const support = tech.support;
  const resistance = tech.resistance;

  // niveau swing le plus proche (support ou resistance)
  const ns = nearestLevel(tech.last, tech.supports);
  const nr = nearestLevel(tech.last, tech.resistances);

  // pivots
  const piv = tech.pivots;

  // broadcast complet: rétro-compatible (support/resistance) + enrichi (supports[], resistances[], pivots)
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

  // triggers
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
    await prisma.triggerLog.create({ data:{
      sessionId, symbol: sym, kind: trigger,
      payload: { price: tech.last, support, resistance, pivots: piv }
    }});
    await maybeGenerateStrategy(sym, trigger, tech.last, sessionId); // inchangé
  }

  return tech;
}
/**
 * Génère (peut-être) une nouvelle stratégie selon :
 *  - rate-limit (STRATEGY_MIN_INTERVAL_MIN)
 *  - OU sortie de la zone de la stratégie précédente (entry.zone)
 */
async function maybeGenerateStrategy(sym: string, trigger: string, price: number, sessionId: string) {
  const minIntervalMin = Number(process.env.STRATEGY_MIN_INTERVAL_MIN || 60);
  const now = Date.now();

  const canByTime = !lastStrategyAt || (now - lastStrategyAt) > minIntervalMin * 60 * 1000;
  const canByZone = leftZone(price, lastStrategyZone);

  if (!canByTime && !canByZone) return; // on évite l'appel IA

  const strat = await generateStrategy(sym, trigger); // 1 appel IA ici
  lastStrategyAt = now;
  lastStrategyZone = strat.entry?.zone || null;

  // Calcul des niveaux (SL/TP) à afficher (dans strategy.levels)
  const entryMid =
    strat.entry?.price ??
    (
      ((strat.entry?.zone?.min ?? 0) + (strat.entry?.zone?.max ?? 0)) / 2 || undefined
    );

  let lvls: any = undefined;
  if (entryMid && Number.isFinite(entryMid)) {
    const side = strat.bias === 'long' ? 'buy' : 'sell';
    lvls = calcLevels(entryMid as number, side as any, strat.risk.stop as any, strat.risk.target as any);
  }

  // Persist stratégie (tolère doublon d'id)
  try {
    await prisma.strategy.create({
      data: {
        id: strat.strategyId,
        sessionId,
        symbol: strat.symbol,
        bias: strat.bias,
        confidence: strat.confidence,
        entryJson: strat.entry,
        riskJson: strat.risk,
        validityFrom: strat.validity?.from ? new Date(strat.validity.from) : undefined,
        validityTo: strat.validity?.to ? new Date(strat.validity.to) : undefined,
        rationale: strat.rationale,
        trigger,
      },
    });
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e;
  }

  // Push WS
  broadcast('strategy', { ...strat, levels: lvls }, sym);
}

/**
 * Boucle temps réel (tick) :
 *  - lit la session active → symbole de vérité
 *  - calcule un snapshot technique (prix, S/R…)
 *  - déclenche des triggers (support/resistance/move)
 *  - broadcast tick (avec S/R) et génère stratégie si besoin (maybeGenerateStrategy)
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
    } catch (e) { /* log optionnel */ }
    finally { setTimeout(loop, pollMs); }
  }
  loop();
}