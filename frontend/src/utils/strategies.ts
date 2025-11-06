import type { StrategyEngineOption, StrategySnapshot } from '../types/strategies';

export type { StrategyEngineOption } from '../types/strategies';

type StrategyMeta = {
  label: string;
  description: string;
  color: string;
};

export const STRATEGY_META: Record<StrategyEngineOption, StrategyMeta> = {
  meta_adaptive: {
    label: 'Meta Adaptive',
    description:
      'Reinforcement-guided swing entries blending technical and AI signals for adaptive positioning.',
    color: '#a855f7',
  },
};

export const STRATEGY_DESCRIPTIONS: Record<StrategyEngineOption, string> = {
  meta_adaptive: STRATEGY_META.meta_adaptive.description,
};

export function normalizeStrategyEngine(value: unknown): StrategyEngineOption | null {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const lower = value.toLowerCase();
  if (lower === 'meta_adaptive' || lower.includes('meta') || lower.includes('adaptive')) {
    return 'meta_adaptive';
  }
  // Intraday removed - map to meta_adaptive
  if (lower.includes('intraday') || lower.includes('dual')) {
    return 'meta_adaptive';
  }
  return null;
}

export function resolveStrategyLabel(value?: string | null): string {
  const normalized = normalizeStrategyEngine(value);
  if (normalized) {
    return STRATEGY_META[normalized].label;
  }
  if (!value) {
    return 'Unspecified';
  }
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

type SessionLike = {
  strategyEngine?: string | null;
  strategy?: string | StrategySnapshot | null;
  strategyFamily?: string | null;
  profile?: Record<string, any> | null;
};

function asStrategySnapshot(value: unknown): StrategySnapshot | null {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'engine' in (value as any)) {
    return value as StrategySnapshot;
  }
  return null;
}

export function inferSessionStrategyEngine(session?: SessionLike | null): StrategyEngineOption | null {
  if (!session) return null;

  const snapshot = asStrategySnapshot(session.strategy);
  if (snapshot?.engine) {
    const normalized = normalizeStrategyEngine(snapshot.engine);
    if (normalized) return normalized;
  }

  const fromSession = normalizeStrategyEngine(session.strategyEngine);
  if (fromSession) return fromSession;

  const profile = session.profile || undefined;
  if (profile && typeof profile === 'object') {
    const fromProfile =
      normalizeStrategyEngine(profile.strategyEngine)
      || normalizeStrategyEngine(profile.strategy)
      || normalizeStrategyEngine(profile.strategyFamily);
    if (fromProfile) return fromProfile;
  }
  return null;
}

export function resolveSessionStrategyLabel(session?: SessionLike | null): string {
  if (!session) return 'Adaptive';

  const snapshot = asStrategySnapshot(session.strategy);
  if (snapshot?.primary?.label) {
    const engineLabel = snapshot.engine ? STRATEGY_META[snapshot.engine].label : null;
    return engineLabel ? `${snapshot.primary.label} • ${engineLabel}` : snapshot.primary.label;
  }

  const engine = inferSessionStrategyEngine(session);
  if (engine) {
    return STRATEGY_META[engine].label;
  }

  if (typeof session.strategy === 'string') return session.strategy;
  if (session.strategyFamily) return session.strategyFamily;
  if (session.profile?.strategy) return session.profile.strategy;
  if (session.profile?.strategyFamily) return session.profile.strategyFamily;
  return 'Adaptive';
}
