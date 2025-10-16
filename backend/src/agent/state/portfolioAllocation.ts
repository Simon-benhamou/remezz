import { PaperBroker } from '../../broker/paper.js';
import type { Broker } from '../../broker/types.js';
import { recordOpsEvent } from '../../monitor/ops.js';
import type { ResolvedLeverageCap } from '../../risk/leverageCaps.js';
import { clampBudgetFraction } from '../../utils/budget.js';
import type { ActivationProfile } from './types.js';

export type PortfolioAllocationUpdate = {
  capitalUsd?: number;
  budgetFraction?: number;
  maxLeverage?: number;
  leverageCap?: ResolvedLeverageCap | { resolved: number; requested?: number; dynamicMax?: number };
  weight?: number;
  score?: number;
  reason?: string;
};

export type PortfolioAllocationContext = {
  profile: ActivationProfile | null;
  broker: Broker | null;
  sessionId: string | null;
};

export type PortfolioAllocationResult = {
  updatedAt: number | null;
};

export function applyPortfolioAllocation(
  context: PortfolioAllocationContext,
  update: PortfolioAllocationUpdate,
): PortfolioAllocationResult {
  const { profile, broker, sessionId } = context;
  if (!profile) {
    return { updatedAt: null };
  }

  const details: Record<string, unknown> = {};

  if (typeof update.capitalUsd === 'number' && Number.isFinite(update.capitalUsd) && update.capitalUsd > 0) {
    profile.capitalAllocationUsd = update.capitalUsd;
    profile.startBalanceUsd = update.capitalUsd;
    details.capitalUsd = update.capitalUsd;
    if (broker instanceof PaperBroker && typeof broker.setBalanceUsd === 'function') {
      broker.setBalanceUsd(update.capitalUsd);
    }
  }

  if (typeof update.budgetFraction === 'number' && Number.isFinite(update.budgetFraction)) {
    const clamped = clampBudgetFraction(update.budgetFraction);
    if (clamped != null) {
      profile.budgetFraction = clamped;
      details.budgetFraction = clamped;
    }
  }

  if (typeof update.maxLeverage === 'number' && Number.isFinite(update.maxLeverage)) {
    const resolved = Math.max(1, Math.min(10, update.maxLeverage));
    profile.maxLeverage = resolved;
    details.maxLeverage = resolved;
    if (profile.leverageCap) {
      profile.leverageCap = {
        ...profile.leverageCap,
        resolved: Math.max(1, Math.min(resolved, profile.leverageCap.resolved ?? resolved)),
      } as ResolvedLeverageCap;
    }
  }

  if (update.leverageCap) {
    const resolved = Math.max(
      1,
      Math.min(10, Number((update.leverageCap as any).resolved ?? update.maxLeverage ?? profile.maxLeverage)),
    );
    profile.leverageCap = {
      ...(profile.leverageCap ?? {}),
      ...(update.leverageCap as any),
      resolved,
    } as ResolvedLeverageCap;
    details.leverageCap = profile.leverageCap;
  }

  if (typeof update.weight === 'number' && Number.isFinite(update.weight)) {
    profile.portfolioWeight = Math.max(0, update.weight);
    details.weight = profile.portfolioWeight;
  }

  if (typeof update.score === 'number' && Number.isFinite(update.score)) {
    profile.portfolioScore = update.score;
    details.score = update.score;
  }

  const now = Date.now();
  profile.portfolioUpdatedAt = new Date(now).toISOString();

  if (Object.keys(details).length) {
    recordOpsEvent({
      level: 'info',
      source: 'portfolio_manager',
      message: 'allocation_update',
      sessionId: sessionId || undefined,
      symbol: profile.symbol,
      details: {
        ...details,
        reason: update.reason,
      },
    });
  }

  return { updatedAt: now };
}

