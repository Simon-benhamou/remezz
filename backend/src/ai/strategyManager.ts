// backend/src/ai/strategyManager.ts
import { prisma } from '../db/client.js';
import { generateStrategy } from './orchestrator.js';
import { markStrategyLLM, shouldAllowStrategyLLM, updateZoneState, zoneExitDebounced } from './guard.js';
import { levels as calcLevels } from '../risk/brackets.js';
import { setActiveSession } from '../metrics/aiCalls.js';

const COOL_MIN = Number(process.env.LLM_STRATEGY_COOLDOWN_MIN || 10); // minutes
const MAX_PER_HOUR = Number(process.env.LLM_STRATEGY_MAX_PER_HOUR || 6);
const ZONE_HYST_PCT = Number(process.env.ZONE_HYSTERESIS_PCT || 0.15);
const ZONE_REQUIRED_TICKS = Number(process.env.ZONE_EXIT_REQUIRED_TICKS || 3);

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
  if (!allowed) {
    // reuse last known strategy if available
    const last = await prisma.strategy.findFirst({ where: { symbol: req.symbol }, orderBy: { createdAt: 'desc' } });
    return { strategy: last, levels: undefined as any, reused: true };
  }

  // Ensure AI usage is attributed to the triggering session when present
  try { if (req.sessionId) await setActiveSession(req.sessionId); } catch {}
  const strat = await generateStrategy(req.symbol, req.trigger, { fresh: !!req.fresh || !!req.force });
  updateZoneState(key, strat.entry?.zone || null);
  markStrategyLLM(key);

  const entryMid = strat.entry?.price ?? (((strat.entry?.zone?.min ?? 0) + (strat.entry?.zone?.max ?? 0)) / 2 || undefined);
  const side = strat.bias === 'long' ? 'buy' : 'sell';
  const levels = (entryMid && Number.isFinite(entryMid))
    ? calcLevels(entryMid as number, side as any, strat.risk.stop as any, strat.risk.target as any)
    : undefined;

  try {
    await prisma.strategy.create({
      data: {
        id: (strat as any).strategyId,
        sessionId: req.sessionId,
        symbol: (strat as any).symbol,
        bias: (strat as any).bias,
        confidence: (strat as any).confidence,
        entryJson: (strat as any).entry,
        riskJson: (strat as any).risk,
        validityFrom: (strat as any).validity?.from ? new Date((strat as any).validity.from) : undefined,
        validityTo: (strat as any).validity?.to ? new Date((strat as any).validity.to) : undefined,
        rationale: (strat as any).rationale,
        trigger: req.trigger,
      },
    });
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e;
  }

  return { strategy: strat, levels, reused: false };
}

export function shouldEngineRegenerate(symbol: string, price: number) {
  return zoneExitDebounced(symbol, price, ZONE_HYST_PCT, ZONE_REQUIRED_TICKS);
}
