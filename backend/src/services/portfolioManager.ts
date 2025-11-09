import { prisma } from '../db/client.js';
import { AgentHub } from '../agent/hub.js';
import { recordOpsEvent } from '../monitor/ops.js';
import { getConfig } from '../utils/env.js';
import { derivePortfolioBudgetFraction, getBudgetFractionBounds, resolveBudgetFraction } from '../utils/budget.js';

export type PortfolioMode = 'paper' | 'live';

export type PortfolioAllocationState = {
  sessionId: string;
  symbol: string;
  capitalUsd: number;
  budgetFraction: number;
  maxLeverage: number;
  performanceScore: number;
  weight: number;
  roiPct: number;
  winRate: number;
  drawdownPct: number;
  updatedAt: string;
  correlationKey?: string;
  correlationLimited?: boolean;
};

export type PortfolioSettings = {
  balanceUsd: number;
  maxExposureMultiplier: number;
  maxCorrelatedPerGroup: number;
  lastRebalancedAt?: string;
  allocations: Record<string, PortfolioAllocationState>;
};

export type PortfolioSnapshot = {
  mode: PortfolioMode;
  balanceUsd: number;
  allocatedUsd: number;
  freeUsd: number;
  maxExposureUsd: number;
  exposureUtilizationPct: number;
  maxExposureMultiplier: number;
  lastRebalancedAt?: string;
  updatedAt: string;
  allocations: Array<{
    sessionId: string;
    symbol: string;
    capitalUsd: number;
    weightPct: number;
    budgetFraction: number;
    performanceScore: number;
    roiPct: number;
    winRate: number;
    expectancy: number;
    drawdownPct: number;
    maxLeverage: number;
    leverageCap: number;
    correlationKey: string;
    tags: string[];
  }>;
  constraints: {
    maxCorrelatedPerGroup: number;
  };
};

const SETTINGS_KEY_PREFIX = 'portfolio.settings';
const DEFAULT_SETTINGS: PortfolioSettings = {
  balanceUsd: 0,
  maxExposureMultiplier: 1.5,
  maxCorrelatedPerGroup: 2,
  allocations: {},
};

function getSettingsKey(mode: PortfolioMode) {
  return `${SETTINGS_KEY_PREFIX}:${mode}`;
}

async function loadSettings(userId: string, mode: PortfolioMode): Promise<PortfolioSettings> {
  const key = getSettingsKey(mode);
  const record = await prisma.userSetting.findUnique({
    where: { userId_key: { userId, key } },
  });
  if (!record?.value) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(record.value) as PortfolioSettings;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      allocations: parsed?.allocations ? parsed.allocations : {},
    };
  } catch (error) {
    console.warn('Failed to parse portfolio settings, using defaults:', error);
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(userId: string, mode: PortfolioMode, settings: PortfolioSettings): Promise<void> {
  const key = getSettingsKey(mode);
  await prisma.userSetting.upsert({
    where: { userId_key: { userId, key } },
    update: { value: JSON.stringify(settings) },
    create: { userId, key, value: JSON.stringify(settings) },
  });
}

function getCorrelationKey(symbol: string): string {
  if (!symbol) return 'unknown';
  const [base] = symbol.split('/');
  if (!base) return symbol;
  return base.split(':')[0] || base;
}

function ensurePositive(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

type SessionWithKpi = Awaited<ReturnType<typeof prisma.agentSession.findMany<{ include: { SessionKpi: true } }>>>[number];

type PerformanceContext = {
  roiPct: number;
  winRate: number;
  expectancy: number;
  drawdownPct: number;
  lossStreak: number;
};

function computePerformanceScore(ctx: PerformanceContext): number {
  let score = 1;
  if (Number.isFinite(ctx.roiPct)) {
    score += Math.max(-0.6, Math.min(0.6, ctx.roiPct / 40));
  }
  if (Number.isFinite(ctx.winRate)) {
    score += Math.max(-0.4, Math.min(0.4, (ctx.winRate - 50) / 75));
  }
  if (Number.isFinite(ctx.expectancy)) {
    score += Math.max(-0.2, Math.min(0.2, ctx.expectancy / 3));
  }
  if (ctx.drawdownPct > 0) {
    score -= Math.min(0.5, ctx.drawdownPct / 30);
  }
  if (ctx.lossStreak > 0) {
    score -= Math.min(0.4, ctx.lossStreak * 0.05);
  }
  if (ctx.roiPct > 8 && ctx.winRate > 55 && ctx.drawdownPct < 8) {
    score *= 1.1;
  }
  if (ctx.roiPct < -5 || ctx.drawdownPct > 10) {
    score *= 0.6;
  }
  return Math.max(0.2, score);
}

function extractStats(SessionKpi: SessionWithKpi['SessionKpi']): PerformanceContext {
  const stats = (SessionKpi?.stats as Record<string, any>) ?? {};
  const lossStreak = Number(stats.currentLossStreak ?? stats.lossStreak ?? stats.consecutiveStops ?? 0);
  return {
    roiPct: Number(SessionKpi?.roiPct ?? 0),
    winRate: Number(SessionKpi?.winRate ?? 0),
    expectancy: Number(SessionKpi?.expectancy ?? 0),
    drawdownPct: Number(SessionKpi?.maxDrawdownPct ?? 0),
    lossStreak: Number.isFinite(lossStreak) ? lossStreak : 0,
  };
}

function buildSnapshot(
  mode: PortfolioMode,
  settings: PortfolioSettings,
  sessions: SessionWithKpi[],
): PortfolioSnapshot {
  const balanceUsd = Math.max(0, Number(settings.balanceUsd || 0));
  const maxExposureUsd = balanceUsd * settings.maxExposureMultiplier;
  const budgetBounds = getBudgetFractionBounds();
  const reducedThreshold = Math.min(budgetBounds.max, budgetBounds.min + 0.05);
  const mappedAllocations: PortfolioSnapshot['allocations'] = sessions.map((session) => {
    const profile = ((session.profileJson ?? {}) as Record<string, any>) || {};
    const allocation = settings.allocations?.[session.id];
    const capitalUsd = Number(allocation?.capitalUsd ?? session.startBalanceUsd ?? 0);
    const rawBudgetFraction = allocation?.budgetFraction ?? profile?.budgetFraction;
    const budgetFraction = resolveBudgetFraction(rawBudgetFraction);
    const weightPct = balanceUsd > 0 ? (capitalUsd / balanceUsd) * 100 : 0;
    const SessionKpi = session.SessionKpi;
    const tags: string[] = [];
    if (allocation?.correlationLimited) tags.push('correlation-limited');
    if (budgetFraction <= reducedThreshold) tags.push('capital-reduced');
    const performanceScore = allocation?.performanceScore ?? allocation?.weight ?? 0;
    return {
      sessionId: session.id,
      symbol: session.symbol,
      capitalUsd,
      weightPct,
      budgetFraction,
      performanceScore,
      roiPct: Number(SessionKpi?.roiPct ?? 0),
      winRate: Number(SessionKpi?.winRate ?? 0),
      expectancy: Number(SessionKpi?.expectancy ?? 0),
      drawdownPct: Number(SessionKpi?.maxDrawdownPct ?? 0),
      maxLeverage: Number(profile?.maxLeverage ?? allocation?.maxLeverage ?? 0),
      leverageCap: Number(((profile?.leverageCap as any)?.resolved ?? allocation?.maxLeverage ?? 0)),
      correlationKey: allocation?.correlationKey ?? getCorrelationKey(session.symbol),
      tags,
    };
  });
  const allocatedUsd = mappedAllocations.reduce((sum, entry) => sum + Math.max(0, entry.capitalUsd), 0);
  const freeUsd = Math.max(0, balanceUsd - allocatedUsd);
  const exposureUtilizationPct = maxExposureUsd > 0 ? Math.min(100, (allocatedUsd / maxExposureUsd) * 100) : 0;
  return {
    mode,
    balanceUsd,
    allocatedUsd,
    freeUsd,
    maxExposureUsd,
    exposureUtilizationPct,
    maxExposureMultiplier: settings.maxExposureMultiplier,
    lastRebalancedAt: settings.lastRebalancedAt,
    updatedAt: new Date().toISOString(),
    allocations: mappedAllocations,
    constraints: {
      maxCorrelatedPerGroup: settings.maxCorrelatedPerGroup,
    },
  };
}

export async function updatePortfolioBalance(userId: string, mode: PortfolioMode, balanceUsd: number): Promise<void> {
  const settings = await loadSettings(userId, mode);
  settings.balanceUsd = Math.max(0, Number(balanceUsd || 0));
  await saveSettings(userId, mode, settings);
}

export async function getPortfolioSnapshot(userId: string, mode: PortfolioMode): Promise<PortfolioSnapshot> {
  const settings = await loadSettings(userId, mode);
  const sessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null, mode },
    include: { SessionKpi: true },
  });
  return buildSnapshot(mode, settings, sessions);
}

export async function rebalancePortfolio(params: {
  userId: string;
  mode: PortfolioMode;
  reason?: string;
  balanceOverrideUsd?: number;
}): Promise<PortfolioSnapshot> {
  const { userId, mode, reason, balanceOverrideUsd } = params;
  const nowIso = new Date().toISOString();
  const settings = await loadSettings(userId, mode);
  const cfg = getConfig();
  if (balanceOverrideUsd != null) {
    const override = Number(balanceOverrideUsd);
    if (Number.isFinite(override) && override >= 0) {
      settings.balanceUsd = override;
    }
  }

  const sessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null, mode, userId },
    include: { SessionKpi: true },
  });

  if (!sessions.length) {
    settings.allocations = {};
    settings.lastRebalancedAt = nowIso;
    await saveSettings(userId, mode, settings);
    return buildSnapshot(mode, settings, sessions);
  }

  const derivedBalance = sessions.reduce((sum, session) => sum + Math.max(0, Number(session.startBalanceUsd ?? 0)), 0);
  settings.balanceUsd = ensurePositive(settings.balanceUsd, ensurePositive(derivedBalance, 1000));

  const entries = sessions.map((session) => {
    const kpiStats = extractStats(session.SessionKpi);
    const score = computePerformanceScore(kpiStats);
    const profile = ((session.profileJson ?? {}) as Record<string, any>) || {};
    const cfg = getConfig();
    const defaultLeverage = Math.min(10, cfg.DEFAULT_MAX_LEVERAGE || 10);
    const baseMaxLeverage = Number(profile?.maxLeverage ?? (profile?.leverageCap?.resolved ?? defaultLeverage));
    return {
      session,
      profile,
      score,
      weight: score,
      performance: kpiStats,
      baseMaxLeverage: Number.isFinite(baseMaxLeverage) ? baseMaxLeverage : defaultLeverage,
      correlationKey: getCorrelationKey(session.symbol),
      correlationLimited: false,
    };
  });

  const grouped = new Map<string, typeof entries>();
  for (const entry of entries) {
    const arr = grouped.get(entry.correlationKey) ?? [];
    arr.push(entry);
    grouped.set(entry.correlationKey, arr);
  }

  for (const group of grouped.values()) {
    group.sort((a, b) => b.weight - a.weight);
    group.forEach((entry, idx) => {
      if (idx >= settings.maxCorrelatedPerGroup) {
        entry.weight *= 0.35;
        entry.correlationLimited = true;
      }
    });
  }

  const totalWeight = entries.reduce((sum, entry) => sum + Math.max(0.0001, entry.weight), 0);
  const exposureBudgetUsd = settings.balanceUsd * settings.maxExposureMultiplier;
  const unit = totalWeight > 0 ? exposureBudgetUsd / totalWeight : 0;
  const minAllocationUsd = settings.balanceUsd / Math.max(1, sessions.length) * 0.25;

  const newAllocations: Record<string, PortfolioAllocationState> = {};

  for (const entry of entries) {
    const rawCapital = Math.max(0, entry.weight * unit);
    const capitalUsd = Math.max(minAllocationUsd, Math.min(rawCapital, exposureBudgetUsd * 0.6));
    const totalBalance = settings.balanceUsd > 0 ? settings.balanceUsd : 1;
    const allocationShare = totalBalance > 0 ? capitalUsd / totalBalance : 1;
    const budgetFraction = derivePortfolioBudgetFraction(allocationShare, cfg);
    let targetMaxLeverage = Math.max(1, Math.min(10, entry.baseMaxLeverage));
    if (entry.performance.roiPct > 10 && entry.performance.winRate > 55 && entry.performance.drawdownPct < 8) {
      targetMaxLeverage = Math.min(10, targetMaxLeverage + 1);
    }
    if (entry.performance.drawdownPct > 12 || entry.performance.roiPct < -8) {
      targetMaxLeverage = Math.max(2, targetMaxLeverage - 1);
    }
    const existingCap = ((entry.profile?.leverageCap as any)?.resolved ?? targetMaxLeverage) as number;
    const resolvedCap = Math.max(1, Math.min(targetMaxLeverage, existingCap));

    const weightShare = totalWeight > 0 ? entry.weight / totalWeight : 0;
    const updatedProfile = { ...(entry.profile as Record<string, any>) };
    updatedProfile.budgetFraction = budgetFraction;
    updatedProfile.maxLeverage = targetMaxLeverage;
    updatedProfile.capitalAllocationUsd = capitalUsd;
    updatedProfile.portfolioWeight = weightShare;
    updatedProfile.portfolioScore = entry.score;
    updatedProfile.portfolioUpdatedAt = nowIso;
    updatedProfile.leverageCap = {
      ...((updatedProfile.leverageCap as any) || {}),
      resolved: resolvedCap,
    };

    await prisma.agentSession.update({
      where: { id: entry.session.id },
      data: {
        startBalanceUsd: capitalUsd,
        profileJson: updatedProfile,
      },
    });

    AgentHub.applyAllocation(entry.session.id, {
      capitalUsd,
      budgetFraction,
      maxLeverage: targetMaxLeverage,
      leverageCap: { resolved: resolvedCap },
      weight: weightShare,
      score: entry.score,
      reason,
    });

    newAllocations[entry.session.id] = {
      sessionId: entry.session.id,
      symbol: entry.session.symbol,
      capitalUsd,
      budgetFraction,
      maxLeverage: targetMaxLeverage,
      performanceScore: entry.score,
      weight: weightShare,
      roiPct: entry.performance.roiPct,
      winRate: entry.performance.winRate,
      drawdownPct: entry.performance.drawdownPct,
      updatedAt: nowIso,
      correlationKey: entry.correlationKey,
      correlationLimited: entry.correlationLimited,
    };
  }

  settings.allocations = newAllocations;
  settings.lastRebalancedAt = nowIso;
  await saveSettings(userId, mode, settings);

  recordOpsEvent({
    level: 'info',
    source: 'portfolio_manager',
    message: 'portfolio_rebalanced',
    details: {
      userId,
      mode,
      sessions: sessions.length,
      balanceUsd: settings.balanceUsd,
      reason,
    },
  });

  const refreshedSessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null, mode, userId },
    include: { SessionKpi: true },
  });
  return buildSnapshot(mode, settings, refreshedSessions);
}
