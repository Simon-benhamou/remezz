// backend/src/ai/strategyManager.ts
import { prisma } from '../db/client.js';
import { generateStrategy } from './orchestrator.js';
import { markStrategyLLM, shouldAllowStrategyLLM, updateZoneState, zoneExitDebounced } from './guard.js';
import { levels as calcLevels } from '../risk/brackets.js';
import { setActiveSession } from '../metrics/aiCalls.js';
import { hydrateActivationProfile } from '../agent/profilePersistence.js';
import {
  resolveReusableStrategy,
  resolveStrategyHealth,
  mergeGuardrails,
  buildPerformanceSummary,
  type StrategyGuardrail,
  type StrategyPerformanceSummary,
} from '../services/strategyHealth.js';
import { getRegimeDiagnostics } from '../engine/diagnosticRegistry.js';
import { AgentHub } from '../agent/hub.js';
// Intraday strategy removed

const COOL_MIN = Number(process.env.LLM_STRATEGY_COOLDOWN_MIN || 3); // minutes - réduit pour réactivité
const MAX_PER_HOUR = Number(process.env.LLM_STRATEGY_MAX_PER_HOUR || 15); // augmenté pour plus de flexibilité
const ZONE_HYST_PCT = Number(process.env.ZONE_HYSTERESIS_PCT || 0.15);
const ZONE_REQUIRED_TICKS = Number(process.env.ZONE_EXIT_REQUIRED_TICKS || 3);
const ISO_8601_UTC_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

function parseIsoDate(raw: unknown): Date | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!ISO_8601_UTC_REGEX.test(raw)) return undefined;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.valueOf())) return undefined;
  return parsed;
}

export function buildStrategyPersistenceData(
  strat: any,
  req: { sessionId?: string; trigger: string },
) {
  const validityToRaw = strat?.validity?.to;
  const validityToCandidate = validityToRaw == null ? undefined : parseIsoDate(validityToRaw);
  const validityTo = validityToCandidate && Number.isFinite(validityToCandidate.valueOf())
    ? validityToCandidate
    : undefined;

  return {
    id: strat?.strategyId,
    sessionId: req.sessionId,
    symbol: strat?.symbol,
    bias: strat?.bias,
    confidence: strat?.confidence,
    entryJson: strat?.entry,
    riskJson: strat?.risk,
    validityFrom: strat?.validity?.from ? new Date(strat.validity.from) : undefined,
    validityTo,
    rationale: strat?.rationale,
    trigger: req.trigger,
  } as const;
}

export type Requested = {
  symbol: string;
  trigger: string;
  sessionId?: string;
  priceHint?: number;
  force?: boolean; // bypass throttling for critical events (eg. position-exit)
};

export async function requestStrategy(req: Requested & { fresh?: boolean }) {
  const key = req.symbol;

  // Throttle global unless forced
  const allowed = req.force ? true : shouldAllowStrategyLLM(key, { cooldownMin: COOL_MIN, maxPerHour: MAX_PER_HOUR });

  let guardrail: StrategyGuardrail | null = null;
  let performanceSummary: StrategyPerformanceSummary | null = null;
  const hydrateHealth = async () => {
    if (!req.sessionId) return;
    if (performanceSummary) return;
    const bundle = await resolveStrategyHealth(req.sessionId, req.symbol);
    performanceSummary = buildPerformanceSummary(bundle.health, bundle.samples);
    guardrail = mergeGuardrails(guardrail, bundle.health.guardrails ?? null);
  };

  if (!allowed) {
    try {
      const reuse = await resolveReusableStrategy(req.sessionId, req.symbol);
      guardrail = mergeGuardrails(guardrail, reuse.guardrail ?? null);
      if (req.sessionId && guardrail) {
        try { AgentHub.applyStrategyHealth(req.sessionId, guardrail); } catch {}
      }
      if (reuse.strategy) {
        return { strategy: reuse.strategy, levels: undefined as any, reused: true };
      }
    } catch {}

    const last = await prisma.strategy.findFirst({ where: { symbol: req.symbol }, orderBy: { createdAt: 'desc' } });
    return { strategy: last, levels: undefined as any, reused: true };
  }

  let sessionProfile: ReturnType<typeof hydrateActivationProfile> | null = null;
  if (req.sessionId) {
    try {
      const session = await prisma.agentSession.findUnique({ where: { id: req.sessionId } });
      if (session) {
        sessionProfile = hydrateActivationProfile(session as any);
      }
    } catch (error) {
      console.warn('⚠️ Failed to hydrate activation profile:', error);
    }
  }

  if (req.sessionId) {
    try { await hydrateHealth(); } catch { performanceSummary = performanceSummary ?? null; }
  }

  const regimeDiagnostics = getRegimeDiagnostics(req.symbol);

  // Ensure AI usage is attributed to the triggering session when present
  try { if (req.sessionId) await setActiveSession(req.sessionId); } catch {}
  const strat = await generateStrategy(req.symbol, req.trigger, {
    fresh: !!req.fresh || !!req.force,
    sessionId: req.sessionId,
    regime: regimeDiagnostics ?? undefined,
    performance: performanceSummary ?? undefined,
  });
  updateZoneState(key, strat.entry?.zone || null);
  markStrategyLLM(key);

  const entryMid = strat.entry?.price ?? (((strat.entry?.zone?.min ?? 0) + (strat.entry?.zone?.max ?? 0)) / 2 || undefined);
  const side = strat.bias === 'long' ? 'buy' : 'sell';
  const levels = (entryMid && Number.isFinite(entryMid))
    ? calcLevels(entryMid as number, side as any, strat.risk.stop as any, strat.risk.target as any)
    : undefined;

  try {
    await prisma.strategy.create({
      data: buildStrategyPersistenceData(strat, req),
    });
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e;
  }

  if (req.sessionId && guardrail) {
    try { AgentHub.applyStrategyHealth(req.sessionId, guardrail); } catch {}
  }

  return { strategy: strat, levels, reused: false };
}

export function shouldEngineRegenerate(symbol: string, price: number) {
  return zoneExitDebounced(symbol, price, ZONE_HYST_PCT, ZONE_REQUIRED_TICKS);
}
