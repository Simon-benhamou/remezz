import { prisma } from '../db/client.js';
import type { PlanJson } from '../agent/planSchema.js';

export type PlanContainer = {
  plan?: PlanJson | null;
  intelligentHistory?: any[];
  planMeta?: Record<string, any>;
  [key: string]: any;
};

export function normalizePlanContainer(raw: any): PlanContainer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  if ('plan' in raw || 'intelligentHistory' in raw || 'planMeta' in raw) {
    return { ...raw } as PlanContainer;
  }
  if ('zone' in raw && 'risk' in raw && 'position' in raw) {
    return { plan: raw as PlanJson };
  }
  return {};
}

export function extractPersistedPlan(raw: any): PlanJson | null {
  const container = normalizePlanContainer(raw);
  if (container.plan) return container.plan as PlanJson;
  return null;
}

export async function updatePlanContainer(
  sessionId: string,
  updater: (current: PlanContainer) => PlanContainer
): Promise<PlanContainer> {
  const existing = await prisma.agentSession.findUnique({
    where: { id: sessionId },
    select: { planJson: true }
  });
  const base = normalizePlanContainer(existing?.planJson);
  const updated = updater({ ...base });
  await prisma.agentSession.update({
    where: { id: sessionId },
    data: { planJson: updated as any }
  });
  return updated;
}

export async function mergePlanContainer(
  sessionId: string,
  partial: Partial<PlanContainer>
): Promise<PlanContainer> {
  return updatePlanContainer(sessionId, (current) => ({ ...current, ...partial }));
}

export async function savePlan(
  sessionId: string,
  plan: PlanJson,
  extras: Partial<PlanContainer> = {}
): Promise<PlanContainer> {
  const nowIso = new Date().toISOString();
  return updatePlanContainer(sessionId, (current) => {
    const next: PlanContainer = { ...current, ...extras };
    next.plan = plan;
    const existingMeta = current.planMeta || {};
    const extraMeta = (extras.planMeta || {}) as Record<string, any>;
    next.planMeta = {
      ...existingMeta,
      ...extraMeta,
      symbol: plan.symbol,
      updatedAt: nowIso,
    };
    return next;
  });
}
