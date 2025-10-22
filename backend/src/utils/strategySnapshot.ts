import type { RecognizedStrategyId, RecognizedStrategySignal } from '../quantai/strategies/metaAdaptive/recognizedStrategies.js';

export type StrategyEngineOption = 'intraday_dual' | 'meta_adaptive';

export type StrategyChecklistItem = {
  key: string;
  label: string;
  status: string;
  reason?: string | null;
  details?: unknown;
  source: string;
};

export type RecognizedStrategySummary = {
  id: RecognizedStrategyId;
  label: string;
  bias: 'long' | 'short' | 'both';
  confidence: number;
  score: number;
  guardrail: string | null;
  penalties: string[];
  exploration: boolean;
  active: boolean;
  reasons: string[];
  executionMode?: string | null;
  riskPct?: number | null;
  stopAtrMult?: number | null;
};

export type StrategyContextSnapshot = {
  regime: string;
  basePlaybook: string;
  effectivePlaybook: string;
  direction: 'long' | 'short' | 'none';
  strongTrend: boolean;
  moderateTrend: boolean;
  allowMomentumOverride: boolean;
  favorMeanReversion: boolean;
  confidence: number;
  notes: string[];
  hurst: number | null;
  trendStrength: number | null;
  adx: number | null;
  family: string | null;
  token: string | null;
};

export type StrategySnapshot = {
  engine: StrategyEngineOption | null;
  primary: RecognizedStrategySummary | null;
  recognized: RecognizedStrategySummary[];
  context: StrategyContextSnapshot | null;
  checklist: StrategyChecklistItem[];
};

type StrategyCheckBlueprint = {
  key: string;
  label: string;
  path: string;
};

const STRATEGY_CHECK_BLUEPRINTS: Record<RecognizedStrategyId | 'default', StrategyCheckBlueprint[]> = {
  classic_trend_following: [
    { key: 'trend_alignment', label: 'Trend alignment confirmed', path: 'checks.qualityFilters.trendAlignment' },
    { key: 'momentum_gates', label: 'Momentum gates green', path: 'checks.momentumGates' },
    { key: 'entry_confirmation', label: 'Entry confirmation locked', path: 'checks.entryConfirmation' },
    { key: 'quality_score', label: 'Quality score threshold', path: 'checks.qualityScore' },
    { key: 'liquidity', label: 'Liquidity adequate', path: 'checks.liquidity' },
  ],
  breakout_retest: [
    { key: 'zone_alignment', label: 'Breakout / zone alignment', path: 'checks.inEntryZone' },
    { key: 'momentum', label: 'Momentum confirmation', path: 'checks.momentumGates' },
    { key: 'volume', label: 'Volume expansion', path: 'checks.qualityFilters.volume' },
    { key: 'confirmation', label: 'Breakout confirmation', path: 'checks.entryConfirmation' },
    { key: 'quality', label: 'Quality score threshold', path: 'checks.qualityScore' },
  ],
  bollinger_mean_reversion: [
    { key: 'zone_alignment', label: 'Mean reversion zone alignment', path: 'checks.inEntryZone' },
    { key: 'rsi', label: 'RSI mean reversion band', path: 'checks.qualityFilters.rsiPosition' },
    { key: 'volatility', label: 'Volatility contraction', path: 'checks.qualityFilters.volatility' },
    { key: 'trend_filter', label: 'Trend filter safe', path: 'checks.qualityFilters.trendAlignment' },
    { key: 'quality', label: 'Quality score threshold', path: 'checks.qualityScore' },
  ],
  momentum_scanner_focus: [
    { key: 'momentum', label: 'Momentum gate strength', path: 'checks.momentumGates' },
    { key: 'volume', label: 'Volume confirmation', path: 'checks.qualityFilters.volume' },
    { key: 'trend_alignment', label: 'Trend alignment support', path: 'checks.qualityFilters.trendAlignment' },
    { key: 'bias_alignment', label: 'Bias alignment', path: 'checks.biasAlignment' },
    { key: 'quality', label: 'Quality score threshold', path: 'checks.qualityScore' },
  ],
  default: [
    { key: 'entry_zone', label: 'Entry zone alignment', path: 'checks.inEntryZone' },
    { key: 'momentum', label: 'Momentum confirmation', path: 'checks.momentumGates' },
    { key: 'quality', label: 'Quality score threshold', path: 'checks.qualityScore' },
  ],
};

const STRATEGY_LABEL_FALLBACK: Record<RecognizedStrategyId, string> = {
  classic_trend_following: 'Adaptive trend follower',
  breakout_retest: 'Adaptive breakout structure',
  bollinger_mean_reversion: 'Adaptive mean reversion',
  momentum_scanner_focus: 'Adaptive momentum scanner',
};

function getNested(source: any, path: string): any {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), source);
}

function sanitizeRecognizedStrategy(signal: RecognizedStrategySignal): RecognizedStrategySummary {
  return {
    id: signal.id,
    label: signal.label || STRATEGY_LABEL_FALLBACK[signal.id],
    bias: signal.bias,
    confidence: Number(signal.confidence ?? 0),
    score: Number(signal.meta?.score ?? signal.confidence ?? 0),
    guardrail: signal.meta?.guardrail ?? (signal as any).guardrail ?? null,
    penalties: Array.isArray(signal.meta?.penalties) ? signal.meta!.penalties : [],
    exploration: Boolean(signal.meta?.exploration),
    active: Boolean(signal.active),
    reasons: Array.isArray(signal.reasons) ? signal.reasons : [],
    executionMode: signal.meta?.executionMode ?? null,
    riskPct: signal.meta?.riskPct != null ? Number(signal.meta.riskPct) : null,
    stopAtrMult: signal.meta?.stopAtrMult != null ? Number(signal.meta.stopAtrMult) : null,
  };
}

export function normalizeStrategyEngine(value: unknown): StrategyEngineOption | null {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  if (lower === 'meta_adaptive' || lower.includes('meta')) return 'meta_adaptive';
  if (lower === 'intraday_dual' || lower.includes('dual')) return 'intraday_dual';
  return null;
}

export function buildStrategyChecklist(
  strategyId: RecognizedStrategyId | null,
  diagnostics: any,
): StrategyChecklistItem[] {
  if (!strategyId) return [];
  const blueprint = STRATEGY_CHECK_BLUEPRINTS[strategyId] ?? STRATEGY_CHECK_BLUEPRINTS.default;
  return blueprint.map((item) => {
    const raw = getNested(diagnostics, item.path) || {};
    const status = typeof raw.status === 'string' ? raw.status.toUpperCase() : 'UNKNOWN';
    const reason = raw.reason || raw.message || null;
    const details = raw.details ?? null;
    return {
      key: item.key,
      label: item.label,
      status,
      reason,
      details,
      source: item.path,
    };
  });
}

function buildContextSnapshot(agent: any): StrategyContextSnapshot | null {
  const context = agent?.marketContext ?? null;
  if (!context) return null;
  const notes = Array.isArray(context.notes) ? context.notes : [];
  return {
    regime: context.regime,
    basePlaybook: context.basePlaybook,
    effectivePlaybook: context.effectivePlaybook,
    direction: context.direction,
    strongTrend: Boolean(context.strongTrend),
    moderateTrend: Boolean(context.moderateTrend),
    allowMomentumOverride: Boolean(context.allowMomentumOverride),
    favorMeanReversion: Boolean(context.favorMeanReversion),
    confidence: Number(context.confidence ?? 0),
    notes,
    hurst: context.hurst != null ? Number(context.hurst) : null,
    trendStrength: context.trendStrength != null ? Number(context.trendStrength) : null,
    adx: context.adx != null ? Number(context.adx) : null,
    family: context.strategyFamily ?? null,
    token: context.strategyToken ?? null,
  };
}

type StrategySnapshotOptions = {
  includeChecklist?: boolean;
};

type ChecklistCache = {
  timestamp: number;
  checklist: StrategyChecklistItem[];
  primaryId: RecognizedStrategyId | null;
};

export async function resolveStrategySnapshot(
  agent: any | null,
  profile: Record<string, unknown> | null | undefined,
  opts: StrategySnapshotOptions = {},
): Promise<StrategySnapshot> {
  const engine = normalizeStrategyEngine(
    agent?.profile?.strategyEngine
      ?? agent?.strategyEngine
      ?? profile?.strategyEngine
      ?? profile?.strategy
      ?? profile?.strategyFamily,
  );

  const context = buildContextSnapshot(agent);
  const recognizedRaw: RecognizedStrategySignal[] = Array.isArray(agent?.marketContext?.recognizedStrategies)
    ? agent.marketContext.recognizedStrategies
    : [];
  const recognized = recognizedRaw.map(sanitizeRecognizedStrategy);
  const primaryRaw: RecognizedStrategySignal | null = agent?.marketContext?.primaryStrategy ?? null;
  const primary = primaryRaw ? sanitizeRecognizedStrategy(primaryRaw) : null;

  let checklist: StrategyChecklistItem[] = [];
  if (opts.includeChecklist && agent && typeof agent.getDiagnostics === 'function') {
    const cache: ChecklistCache | undefined = agent.__strategySnapshotCache;
    const now = Date.now();
    if (cache && cache.primaryId === (primary?.id ?? null) && now - cache.timestamp < 1_500) {
      checklist = cache.checklist;
    } else {
      try {
        const diagnostics = await agent.getDiagnostics();
        checklist = buildStrategyChecklist(primary?.id ?? null, diagnostics);
        agent.__strategySnapshotCache = { timestamp: now, checklist, primaryId: primary?.id ?? null } satisfies ChecklistCache;
      } catch {
        checklist = [];
      }
    }
  }

  return {
    engine,
    primary,
    recognized,
    context,
    checklist,
  };
}
