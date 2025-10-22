export type StrategyEngineOption = 'intraday_dual' | 'meta_adaptive';

type StrategyMeta = {
  label: string;
  description: string;
  color: string;
};

export const STRATEGY_META: Record<StrategyEngineOption, StrategyMeta> = {
  intraday_dual: {
    label: 'Intraday Dual',
    description:
      'Momentum and mean-reversion tactics with rapid execution, tuned for scalping intraday orderflow.',
    color: '#0ea5e9',
  },
  meta_adaptive: {
    label: 'Meta Adaptive',
    description:
      'Reinforcement-guided swing entries blending technical and AI signals for adaptive positioning.',
    color: '#a855f7',
  },
};

export const STRATEGY_DESCRIPTIONS: Record<StrategyEngineOption, string> = {
  intraday_dual: STRATEGY_META.intraday_dual.description,
  meta_adaptive: STRATEGY_META.meta_adaptive.description,
};

export function normalizeStrategyEngine(value?: string | null): StrategyEngineOption | null {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const lower = value.toLowerCase();
  if (lower === 'intraday_dual' || lower.includes('dual')) {
    return 'intraday_dual';
  }
  if (lower === 'meta_adaptive' || lower.includes('meta')) {
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
  strategy?: string | null;
  strategyFamily?: string | null;
  profile?: Record<string, any> | null;
};

export function inferSessionStrategyEngine(session?: SessionLike | null): StrategyEngineOption | null {
  if (!session) return null;
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
  const engine = inferSessionStrategyEngine(session);
  if (engine) {
    return STRATEGY_META[engine].label;
  }
  if (session?.strategy) return session.strategy;
  if (session?.strategyFamily) return session.strategyFamily;
  if (session?.profile?.strategy) return session.profile.strategy;
  if (session?.profile?.strategyFamily) return session.profile.strategyFamily;
  return 'Adaptive';
}
