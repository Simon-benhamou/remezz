// backend/src/engine/events.ts
import { getConfig } from '../utils/env.js';
import { prisma } from '../db/client.js';
import { buildTechSnapshot, TechnicalSnapshot } from '../ai/tech.js';
import { requestStrategy, shouldEngineRegenerate } from '../ai/strategyManager.js';
import { broadcast } from '../ws/hub.js';
import { AgentHub } from '../agent/hub.js';
import { hydrateActivationProfile } from '../agent/profilePersistence.js';
import { recordOpsEvent } from '../monitor/ops.js';
import { inspectExposure } from '../broker/live.js';
import { extractPersistedPlan } from '../services/planStore.js';
import { classifyRegime } from '../diagnostics/regime.js';
import { getRegimeDiagnostics, getTriggerSampleRate, setRegimeDiagnostics } from './diagnosticRegistry.js';
import { detectStrategyShift, describeShift } from './strategyShift.js';

let running = false;
const NEAR_SR_PCT = Number(process.env.NEAR_SR_PCT || 0.4);   // 0.4%
const NEAR_PIVOT_PCT = Number(process.env.NEAR_PIVOT_PCT || 0.25); // 0.25%
const LOG_TRIGGERS = (process.env.LOG_TRIGGERS || 'true') === 'true';
const TRIGGER_SAMPLE_RATE = Math.max(0, Math.min(1, Number(process.env.TRIGGER_SAMPLE_RATE || '0.25')));
const TRIGGER_RETENTION_DAYS = Math.max(0, Number(process.env.TRIGGER_RETENTION_DAYS || '3'));
let lastPurgeAt = 0;

// Local throttling to limit LLM calls
const lastStrategyAt: Record<string, number> = {};
const lastStrategyZone: Record<string, { min?: number | null; max?: number | null } | null> = {};
const lastStrategyPrice: Record<string, number | null> = {};
const lastStrategyRegime: Record<string, { label: string | null; confidence: number | null }> = {};
// Track last strategy bias per symbol and indicator refresh state
const lastStrategyBias: Record<string, 'long' | 'short' | 'none' | null> = {};
const lastRefreshAt: Record<string, number> = {};
const divergenceTicks: Record<string, number> = {};
const lastRegimeShiftAt: Record<string, number> = {};
const lastRsiBySym: Record<string, number> = {};
const lastIndicatorSig: Record<string, { price: number; emaSpread: number; rsi: number; adx: number }> = {};
let lastTick = { symbol: '', price: 0, ts: 0 };
const lastTickBySession = new Map<string, number>();

// Phase 2: Learning system - Track regeneration history per symbol
interface RegenerationHistoryEntry {
  timestamp: number;
  score: number;
  reason: string;
  sessionId: string;
  leadToTrade: boolean;
  tradeProfitable: boolean | null;
  tradeCompletedAt: number | null;
}

interface SymbolRegenerationStats {
  totalRegenerations: number;
  recentRegenerations: RegenerationHistoryEntry[];
  tradesGenerated: number;
  profitableTrades: number;
  unprofitableTrades: number;
  successRate: number; // % of regenerations that led to profitable trades
  lastCalculatedAt: number;
}

const regenerationHistory = new Map<string, SymbolRegenerationStats>();
const MAX_HISTORY_PER_SYMBOL = 20; // Keep last 20 regenerations per symbol
const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
    const diagnostics = classifyRegime(tech as any, {
      spreadBps: typeof (tech as any)?.spreadBps === 'number' ? Number((tech as any).spreadBps) : null,
      liquidityScore: typeof (tech as any)?.liquidityScore === 'number' ? Number((tech as any).liquidityScore) : null,
    });
    const atrPctVal = typeof (tech as any)?.atrPct === 'number' ? Number((tech as any).atrPct) : null;
    const atr1h = typeof (tech as any)?.atr14_1h === 'number' ? Number((tech as any).atr14_1h) : null;
    const lastPrice = typeof tech.last === 'number' ? tech.last : null;
    const atrPct1h = atr1h != null && lastPrice && lastPrice > 0 ? (atr1h / lastPrice) * 100 : null;
    const volatilityRelative = atrPctVal != null && atrPct1h != null && atrPct1h > 0 ? atrPctVal / atrPct1h : null;
    const volumeAnomaly = typeof tech.volume === 'number' && typeof tech.volumeMA === 'number' && tech.volumeMA > 0
      ? tech.volume / tech.volumeMA
      : null;
    const supports: Array<{ price: number; strength?: number }> = Array.isArray((tech as any)?.supports)
      ? (tech as any).supports
      : [];
    const resistances: Array<{ price: number; strength?: number }> = Array.isArray((tech as any)?.resistances)
      ? (tech as any).resistances
      : [];
    const clusterWindow = lastPrice && lastPrice > 0 ? lastPrice * 0.012 : 0;
    const supportCluster = clusterWindow > 0
      ? supports.filter((level) => Math.abs(level.price - lastPrice) <= clusterWindow)
      : [];
    const resistanceCluster = clusterWindow > 0
      ? resistances.filter((level) => Math.abs(level.price - lastPrice) <= clusterWindow)
      : [];
    const supportStrength = supportCluster.reduce((sum, level) => sum + (Number(level.strength) || 1), 0);
    const resistanceStrength = resistanceCluster.reduce((sum, level) => sum + (Number(level.strength) || 1), 0);
    const imbalanceDenom = supportStrength + resistanceStrength;
    const orderBookImbalance = imbalanceDenom > 0 ? (supportStrength - resistanceStrength) / imbalanceDenom : null;
    const clusterDensity = Math.max(supportCluster.length, resistanceCluster.length);
    const liquidationClusters: { bias: 'long' | 'short' | 'mixed'; density: number } | null = clusterDensity > 0
      ? {
        bias: supportCluster.length > resistanceCluster.length
          ? 'long'
          : resistanceCluster.length > supportCluster.length
            ? 'short'
            : 'mixed',
        density: clusterDensity,
      }
      : null;
    diagnostics.volatilityRelative = volatilityRelative;
    diagnostics.volumeAnomaly = volumeAnomaly;
    diagnostics.orderBookImbalance = orderBookImbalance;
    diagnostics.liquidationClusters = liquidationClusters;
    setRegimeDiagnostics(sym, diagnostics);

    broadcast('tick', {
      ts: Date.now(),
      symbol: sym,
      price: tech.last,
      support,
      resistance,
      supports: tech.supports,
      resistances: tech.resistances,
      pivots: tech.pivots,
      diagnostics,
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
      const persistedUnrealized = Number((s as any)?.kpi?.unrealizedPnlUsd || 0);
      const capital = Number(s.startBalanceUsd || 0);
      const realizedRoi = capital > 0 ? (realized / capital) * 100 : Number((s as any)?.kpi?.roiPct || 0);
      const totalUnrealized = persistedUnrealized + upnlUsd;
      const pnlUsd = realized + totalUnrealized;
      const netRoiPct = capital > 0 ? (pnlUsd / capital) * 100 : realizedRoi;
      broadcast('overview_session', {
        id: s.id,
        symbol: s.symbol,
        price: tech.last,
        pnlUsd,
        roiPct: realizedRoi,
        netRoiPct,
        ts: Date.now(),
      });
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
      const sampleRate = getTriggerSampleRate(sym, TRIGGER_SAMPLE_RATE);
      const keep = Math.random() < sampleRate;
      if (keep) {
        try {
          created = await prisma.triggerLog.create({ data:{ sessionId, symbol: sym, kind: trigger, payload: { price: tech.last, support, resistance, pivots: piv } }});
        } catch {}
      }
    }
    // Broadcast this trigger so UI can update live
    broadcast('trigger', created, sym, sessionId);
    await maybeGenerateStrategy(sym, trigger, tech.last, sessionId, false, tech);
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
 * Calculate adaptive cooldown based on market volatility
 * Higher volatility = shorter cooldown (more opportunities)
 * Lower volatility = longer cooldown (avoid chop)
 */
function getAdaptiveCooldown(tech: TechnicalSnapshot | null, baselineCooldownMin: number): number {
  // If tech snapshot not available, use baseline
  if (!tech || typeof tech.atrPct !== 'number') {
    return baselineCooldownMin;
  }

  const atrPct = tech.atrPct;
  
  // Very high volatility (>3%): reduce cooldown by 50%
  if (atrPct > 3.0) {
    return baselineCooldownMin * 0.5;
  }
  
  // High volatility (2-3%): use baseline cooldown
  if (atrPct > 2.0) {
    return baselineCooldownMin;
  }
  
  // Moderate volatility (1-2%): increase cooldown by 50%
  if (atrPct > 1.0) {
    return baselineCooldownMin * 1.5;
  }
  
  // Low volatility (<1%): double cooldown to avoid chop
  return baselineCooldownMin * 2.0;
}

/**
 * Calculate composite regeneration score based on multiple factors
 */
function calculateRegenerationScore(
  shift: { priceShift: boolean; regimeShift: boolean; priceShiftPct?: number },
  confidenceDelta: number | null,
  tech: TechnicalSnapshot | null
): { priceScore: number; regimeScore: number; volatilityScore: number; composite: number } {
  // Price score: larger moves = higher score (2% = max score of 1.0)
  const priceMovePct = Math.abs(shift.priceShiftPct || 0);
  const priceScore = Math.min(1.0, priceMovePct / 2.0);
  
  // Regime score: based on confidence change (absolute delta, capped at 1.0)
  const regimeScore = confidenceDelta != null ? Math.min(1.0, Math.abs(confidenceDelta)) : 0;
  
  // Volatility score: significant ATR changes
  const atrPct = tech?.atrPct ?? 1.0;
  const volatilityScore = atrPct > 3.0 ? 0.8 : atrPct > 2.0 ? 0.5 : 0.2;
  
  // Composite: weighted combination
  // Price changes matter most (50%), regime changes second (30%), volatility context (20%)
  const composite = (
    priceScore * 0.5 +
    regimeScore * 0.3 +
    volatilityScore * 0.2
  );
  
  return { priceScore, regimeScore, volatilityScore, composite };
}

/**
 * Phase 2: Record a regeneration event for learning system
 */
function recordRegeneration(symbol: string, score: number, reason: string, sessionId: string) {
  const now = Date.now();
  
  // Get or create stats for this symbol
  let stats = regenerationHistory.get(symbol);
  if (!stats) {
    stats = {
      totalRegenerations: 0,
      recentRegenerations: [],
      tradesGenerated: 0,
      profitableTrades: 0,
      unprofitableTrades: 0,
      successRate: 0,
      lastCalculatedAt: now,
    };
    regenerationHistory.set(symbol, stats);
  }
  
  // Add new entry
  const entry: RegenerationHistoryEntry = {
    timestamp: now,
    score,
    reason,
    sessionId,
    leadToTrade: false, // Will be updated when trade occurs
    tradeProfitable: null,
    tradeCompletedAt: null,
  };
  
  stats.recentRegenerations.push(entry);
  stats.totalRegenerations++;
  
  // Prune old entries (keep last MAX_HISTORY_PER_SYMBOL and within time window)
  const cutoffTime = now - HISTORY_WINDOW_MS;
  stats.recentRegenerations = stats.recentRegenerations
    .filter(e => e.timestamp > cutoffTime)
    .slice(-MAX_HISTORY_PER_SYMBOL);
}

/**
 * Phase 2: Update regeneration history when a trade occurs
 */
export function updateRegenerationWithTradeOutcome(
  symbol: string, 
  sessionId: string, 
  profitable: boolean,
  completedAt: number = Date.now()
) {
  const stats = regenerationHistory.get(symbol);
  if (!stats) return;
  
  // Find the most recent regeneration for this session/symbol that hasn't been updated
  const recentEntry = stats.recentRegenerations
    .filter(e => e.sessionId === sessionId && !e.leadToTrade)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  
  if (recentEntry) {
    recentEntry.leadToTrade = true;
    recentEntry.tradeProfitable = profitable;
    recentEntry.tradeCompletedAt = completedAt;
    
    // Update stats
    stats.tradesGenerated++;
    if (profitable) {
      stats.profitableTrades++;
    } else {
      stats.unprofitableTrades++;
    }
    
    // Recalculate success rate
    calculateSuccessRate(stats);
  }
}

/**
 * Phase 2: Calculate success rate for a symbol
 */
function calculateSuccessRate(stats: SymbolRegenerationStats) {
  const now = Date.now();
  
  // Only consider regenerations from the last 7 days
  const cutoffTime = now - HISTORY_WINDOW_MS;
  const recentEntries = stats.recentRegenerations.filter(e => e.timestamp > cutoffTime);
  
  if (recentEntries.length === 0) {
    stats.successRate = 0.5; // Neutral default
    stats.lastCalculatedAt = now;
    return;
  }
  
  // Success = regenerations that led to profitable trades
  const completedTrades = recentEntries.filter(e => e.leadToTrade && e.tradeProfitable !== null);
  const profitableCount = completedTrades.filter(e => e.tradeProfitable === true).length;
  
  // If not enough data, use neutral rate
  if (completedTrades.length < 3) {
    stats.successRate = 0.5;
  } else {
    stats.successRate = profitableCount / completedTrades.length;
  }
  
  stats.lastCalculatedAt = now;
}

/**
 * Phase 2: Get history-adjusted cooldown based on past effectiveness
 */
function getHistoryAdjustedCooldown(symbol: string, baselineCooldown: number): number {
  const useHistoryAdjustment = (process.env.STRATEGY_LEARN_FROM_HISTORY || 'true') === 'true';
  
  if (!useHistoryAdjustment) {
    return baselineCooldown;
  }
  
  const stats = regenerationHistory.get(symbol);
  
  // If no history, use baseline
  if (!stats || stats.recentRegenerations.length < 5) {
    return baselineCooldown;
  }
  
  // Recalculate success rate if stale (older than 1 hour)
  const now = Date.now();
  if (now - stats.lastCalculatedAt > 60 * 60 * 1000) {
    calculateSuccessRate(stats);
  }
  
  const recentCount = stats.recentRegenerations.length;
  
  // If regenerations aren't helping (low success rate), increase cooldown
  if (stats.successRate < 0.3 && recentCount > 5) {
    return baselineCooldown * 2.0; // Double cooldown
  }
  
  // If regenerations are working well, stay responsive
  if (stats.successRate > 0.7 && recentCount > 5) {
    return baselineCooldown * 0.8; // Reduce cooldown by 20%
  }
  
  // Moderate success rate: use baseline
  return baselineCooldown;
}

/**
 * Phase 2: Get regeneration statistics for monitoring
 */
export function getRegenerationStats(symbol?: string): Map<string, SymbolRegenerationStats> | SymbolRegenerationStats | null {
  if (symbol) {
    return regenerationHistory.get(symbol) || null;
  }
  return regenerationHistory;
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
 *  - adaptive cooldown based on volatility
 *  - confidence delta thresholds
 *  - composite scoring
 */
async function maybeGenerateStrategy(sym: string, trigger: string, price: number, sessionId: string, force: boolean = false, tech: TechnicalSnapshot | null = null) {
  const minIntervalMin = Number(process.env.STRATEGY_MIN_INTERVAL_MIN || 60);
  const priceShiftThreshold = Number(process.env.STRATEGY_FORCE_PRICE_PCT || 0.25);
  const regimeShiftThreshold = Number(process.env.STRATEGY_FORCE_REGIME_CONF_DELTA || 0.15);
  const minConfidenceDelta = Number(process.env.STRATEGY_MIN_CONFIDENCE_DELTA || 0.2);
  const useCompositeScore = (process.env.STRATEGY_USE_COMPOSITE_SCORE || 'true') === 'true';
  const compositeThreshold = Number(process.env.STRATEGY_COMPOSITE_THRESHOLD || 0.4);
  const useAdaptiveCooldown = (process.env.STRATEGY_VOLATILITY_ADAPTIVE || 'true') === 'true';
  const now = Date.now();

  const lastAt = lastStrategyAt[sym] || 0;
  const canByTime = !lastAt || (now - lastAt) > minIntervalMin * 60 * 1000;
  const canByZone = shouldEngineRegenerate(sym, price);

  const lastZone = lastStrategyZone[sym] ?? null;
  const lastPrice = lastStrategyPrice[sym] ?? null;
  const previousRegime = lastStrategyRegime[sym] ?? { label: null, confidence: null };
  const regimeDiagnostics = getRegimeDiagnostics(sym);
  const regimeState = regimeDiagnostics
    ? {
        label: `${regimeDiagnostics.regime}:${regimeDiagnostics.direction}`,
        confidence: (() => {
          const momentum = Number(regimeDiagnostics.momentumScore ?? 0);
          const volatility = Number(regimeDiagnostics.volatilityScore ?? 0);
          const score = Math.max(Math.abs(momentum), Math.abs(volatility));
          return Number.isFinite(score) ? score : null;
        })(),
      }
    : null;
  const shift = detectStrategyShift({
    price,
    lastPrice,
    zone: lastZone,
    priceThresholdPct: priceShiftThreshold,
    regime: regimeState,
    previousRegime,
    confidenceThreshold: regimeShiftThreshold,
  });
  
  // Calculate confidence delta for filtering
  const previousConfidence = previousRegime?.confidence ?? null;
  const nextConfidence = regimeState?.confidence ?? null;
  const confidenceDelta = previousConfidence != null && nextConfidence != null
    ? nextConfidence - previousConfidence
    : null;
  
  // Apply minimum confidence delta threshold for regime shifts
  const regimeOnlyShift = shift.regimeShift && !shift.priceShift;
  const meaningfulRegimeChange = !regimeOnlyShift || 
    (confidenceDelta != null && Math.abs(confidenceDelta) >= minConfidenceDelta);
  
  // Adaptive cooldown based on volatility
  const baselineCooldownMin = Number(process.env.STRATEGY_REGIME_COOLDOWN_MIN || 5);
  let adaptiveCooldownMin = useAdaptiveCooldown 
    ? getAdaptiveCooldown(tech, baselineCooldownMin)
    : baselineCooldownMin;
  
  // Phase 2: Apply history-based adjustment to cooldown
  adaptiveCooldownMin = getHistoryAdjustedCooldown(sym, adaptiveCooldownMin);
  
  const lastRegime = lastRegimeShiftAt[sym] || 0;
  const cooldownPassed = !regimeOnlyShift || !lastRegime || 
    (now - lastRegime) > adaptiveCooldownMin * 60 * 1000;
  
  // Calculate composite score if enabled
  let shouldRegenerate = false;
  let regenerationReason = '';
  
  if (useCompositeScore) {
    const score = calculateRegenerationScore(
      { ...shift, priceShiftPct: lastPrice && price ? Math.abs(price - lastPrice) / lastPrice * 100 : 0 },
      confidenceDelta,
      tech
    );
    
    shouldRegenerate = score.composite >= compositeThreshold && cooldownPassed && meaningfulRegimeChange;
    
    if (shouldRegenerate) {
      regenerationReason = `composite_score:${score.composite.toFixed(2)} (price:${score.priceScore.toFixed(2)}, regime:${score.regimeScore.toFixed(2)}, vol:${score.volatilityScore.toFixed(2)})`;
      
      // Phase 2: Record this regeneration for learning
      recordRegeneration(sym, score.composite, regenerationReason, sessionId);
    }
  } else {
    // Legacy logic: significant change if price shifted OR (regime shifted with cooldown passed and meaningful confidence change)
    shouldRegenerate = shift.priceShift || (shift.regimeShift && cooldownPassed && meaningfulRegimeChange);
    
    if (shouldRegenerate) {
      regenerationReason = shift.priceShift ? 'price_shift' : 'regime_shift';
    }
  }
  
  const significantChange = shouldRegenerate;
  const suppressedRegimeShift = regimeOnlyShift && (!cooldownPassed || !meaningfulRegimeChange);

  if (suppressedRegimeShift && regimeState) {
    lastStrategyRegime[sym] = {
      label: regimeState.label ?? null,
      confidence: regimeState.confidence ?? null,
    };
  }

  if (!force && !canByTime && !canByZone && !significantChange) return; // avoid excessive LLM calls unless forced by indicators

  const shouldForce = force || significantChange;
  const { strategy: strat, levels: lvls, reused } = await requestStrategy({
    symbol: sym,
    trigger,
    sessionId,
    priceHint: price,
    force: shouldForce,
  });

  if (!reused) {
    lastStrategyAt[sym] = now;
    lastStrategyZone[sym] = (strat as any)?.entry?.zone || null;
    const entryRef = (strat as any)?.entry;
    const entryPrice = Number(entryRef?.price ?? entryRef?.zone?.mid ?? entryRef?.zone?.min ?? entryRef?.zone?.max);
    lastStrategyPrice[sym] = Number.isFinite(entryPrice) ? entryPrice : (Number.isFinite(price) ? price : (lastStrategyPrice[sym] ?? null));
    const strategyRegime = (strat as any)?.regime;
    let regimeLabel: string | null = null;
    let regimeConfidence: number | null = null;
    if (strategyRegime && typeof strategyRegime === 'object') {
      const rawLabel = (strategyRegime as any).label ?? (strategyRegime as any).regime ?? null;
      if (typeof rawLabel === 'string' && rawLabel.trim().length > 0) {
        regimeLabel = rawLabel.trim();
      }
      const rawConfidence = (strategyRegime as any).confidence ?? (strategyRegime as any).score ?? null;
      const numericConfidence = Number(rawConfidence);
      if (Number.isFinite(numericConfidence)) {
        regimeConfidence = numericConfidence;
      }
    } else if (typeof strategyRegime === 'string') {
      regimeLabel = strategyRegime;
    }
    const finalRegimeState = {
      label: regimeLabel ?? regimeState?.label ?? null,
      confidence: regimeConfidence ?? regimeState?.confidence ?? null,
    };
    lastStrategyRegime[sym] = finalRegimeState; // keep last diagnostics
    try { lastStrategyBias[sym] = ((strat as any)?.bias as any) || null; } catch { lastStrategyBias[sym] = null; }
  } else if (significantChange) {
    // If we requested a refresh due to a significant change but reused the plan, keep the timestamp
    // so that the engine can try again on the next tick instead of getting stuck.
    lastStrategyAt[sym] = now;
    if (shift.priceShift) {
      lastStrategyZone[sym] = null;
      if (Number.isFinite(price)) {
        lastStrategyPrice[sym] = price;
      }
    }
    if (regimeState) {
      lastStrategyRegime[sym] = regimeState;
    }
  }

  if (shift.regimeShift && cooldownPassed) {
    lastRegimeShiftAt[sym] = now;
  }

  if (significantChange) {
    const reason = regenerationReason || describeShift(shift);
    if (reason) {
      const atrPct = tech?.atrPct ?? null;
      
      // Phase 2: Get history stats for this symbol
      const historyStats = regenerationHistory.get(sym);
      const historyInfo = historyStats ? {
        totalRegenerations: historyStats.totalRegenerations,
        successRate: historyStats.successRate,
        recentCount: historyStats.recentRegenerations.length,
      } : null;
      
      recordOpsEvent({
        level: 'info',
        source: 'strategy_regen',
        message: 'Strategy regeneration triggered by shift',
        sessionId,
        symbol: sym,
        details: {
          reason,
          price,
          lastPrice,
          zone: lastZone,
          regime: regimeState?.label ?? null,
          previousRegime: previousRegime?.label ?? null,
          previousConfidence,
          nextConfidence,
          confidenceDelta,
          adaptiveCooldownMinutes: regimeOnlyShift ? adaptiveCooldownMin : null,
          atrPct,
          useCompositeScore,
          minConfidenceDelta,
          historyStats: historyInfo, // Phase 2: Learning system stats
        },
      });
    }
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
            const profile = hydrateActivationProfile({
              id: s.id,
              symbol: s.symbol,
              mode: s.mode as string,
              startBalanceUsd: (s as any).startBalanceUsd ?? null,
              userId: (s as any).userId ?? null,
              startedAt: s.startedAt,
              profileJson: (s as any).profileJson ?? {},
            });
            if (!profile) {
              console.warn(`⚠️ Event engine could not hydrate agent ${s.id} (${s.symbol}) due to missing profile data.`);
              continue;
            }
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
          // Process meta-adaptive signals for this session
          try {
            const { processMetaAdaptiveTick } = await import('../services/metaAdaptiveOrchestrator.js');
            await processMetaAdaptiveTick(s.id, sym, tech);
          } catch (metaErr) {
            recordOpsEvent({
              level: 'error',
              source: 'meta-adaptive',
              message: 'Meta-adaptive tick processing failed',
              sessionId: s.id,
              symbol: sym,
              details: { error: String((metaErr as any)?.message || metaErr) },
            });
          }
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
    const slopeRatio = ema20 !== 0 ? (ema20Slope / ema20) : 0;
    const trendMisaligned = bias === 'long' ? (ema20 <= ema50) : (ema20 >= ema50);
    const slopeAgainst = bias === 'long' ? (slopeRatio < -0.0003) : (slopeRatio > 0.0003);
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
    const slopeRatio = ema20 !== 0 ? (ema20Slope / ema20) : 0;
    const nearRes = (typeof resistance === 'number') && nearLevel(price, resistance as number, nearPct);
    const nearSup = (typeof support === 'number') && nearLevel(price, support as number, nearPct);
    if (bias === 'long' && nearRes && slopeRatio < -0.0003) { shouldForce = true; reason = 'indicator-refresh:resistance-rejection'; }
    if (bias === 'short' && nearSup && slopeRatio > 0.0003) { shouldForce = true; reason = 'indicator-refresh:support-bounce'; }
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
    await maybeGenerateStrategy(sym, reason, price, sessionId, true, tech);
  } catch {}
}
