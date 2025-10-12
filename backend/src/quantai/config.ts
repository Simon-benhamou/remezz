import fs from 'fs';
import path from 'path';
import { load as loadYaml } from 'js-yaml';

export type QuantAIRiskConfig = {
  maxConsecutiveLosses: number;
  cooldownMinutes: number;
  dailyLossLimitPct: number;
  dailyTradeLimit: number;
  reduceSizeAfterLosses: boolean;
  sizeReductionAfterLosses: number;
  sizeReductionFactor: number;
  baseRiskPerTradePct: number;
};

export type QuantAIFeesConfig = {
  takerFeeBps: number;
  makerFeeBps: number;
  defaultSlippageBps: number;
};

export type EntryFilterThresholds = {
  minAdx: number;
  minDollarVolume: number;
  minRr: number;
  minAtrPct: number;
  maxSpreadBps: number;
  confidenceThreshold: number;
  useConfidenceFilter: boolean;
  maxAtrPct?: number | null;
};

export type QuantAIEntryFilterTierOverride = Partial<EntryFilterThresholds> & {
  minAtrPctMultiplier?: number;
  minRrDelta?: number;
  confidenceThresholdDelta?: number;
  spreadAtrRatioLimit?: number;
};

export type QuantAIVolatilityProfileOverride = {
  minDollarVolume?: number;
  minAtrPct?: number;
  maxAtrPct?: number;
  minAdx?: number;
  spreadAtrRatioLimit?: number;
};

export type QuantAIDrySpellConfig = {
  enabled: boolean;
  minMinutesWithoutTrade: number;
  rejectionsForStep: number;
  relaxationStepMinutes: number;
  maxSteps: number;
  minAdxDeltaPerStep: number;
  minRrDeltaPerStep: number;
  confidenceDeltaPerStep: number;
  minAtrPctDeltaPerStep: number;
};

export type QuantAIEntryFilterDynamicConfig = {
  baselineAtrMultiplier?: number;
  atrHighVolThresholdPct?: number;
  atrHighVolMinAdx?: number;
  atrExtremeVolThresholdPct?: number;
  atrExtremeVolMinAdx?: number;
  atrExtremeVolMinRr?: number;
  atrMaxPct?: number;
  atrMaxPctByTier?: Record<string, number>;
  spreadAtrRatioLimit?: number;
  drySpell?: QuantAIDrySpellConfig;
  aggressivenessAdjustments?: Record<string, {
    minRrDelta?: number;
    minAdxDelta?: number;
    confidenceDelta?: number;
    minAtrPctDelta?: number;
  }>;
  confidenceTierAdjustments?: Record<string, number>;
  rrTierAdjustments?: Record<string, number>;
};

export type QuantAIEntryFilterConfig = EntryFilterThresholds & {
  tierOverrides?: Record<string, QuantAIEntryFilterTierOverride>;
  dynamic?: QuantAIEntryFilterDynamicConfig;
  volatilityProfileOverrides?: Record<string, QuantAIVolatilityProfileOverride>;
};

export type QuantAIExitConfig = {
  atrPeriod: number;
  slAtrMult: number;
  slAtrMultReversal?: number;
  slAtrMultImpulse?: number;
  tpRMultiples: number[];
  trailAfterR: number;
  trailAfterRReversal?: number;
  trailAfterRImpulse?: number;
  trailAtrMult: number;
  earlyExit: {
    adxBelow: number;
    cmfNegative: boolean;
    tightenProfitR: number;
    cutLossR: number;
    tightenOnlyIfProfitGtR?: number;
    cutIfLossGtR?: number;
  };
  maxHoldingMin?: number;
};

export type QuantAIRegimeConfig = {
  emaFastPeriod: number;
  emaSlowPeriod: number;
  adxTrendMin: number;
  neutralBandBps: number;
};

export type QuantAIConfig = {
  risk: QuantAIRiskConfig;
  feesSlippage: QuantAIFeesConfig;
  filters: QuantAIEntryFilterConfig;
  exits: QuantAIExitConfig;
  regime: QuantAIRegimeConfig;
};

const DEFAULT_CONFIG: QuantAIConfig = {
  risk: {
    maxConsecutiveLosses: 3,
    cooldownMinutes: 60,
    dailyLossLimitPct: 3.0,
    dailyTradeLimit: 24,
    reduceSizeAfterLosses: true,
    sizeReductionAfterLosses: 2,
    sizeReductionFactor: 0.5,
    baseRiskPerTradePct: 0.5,
  },
  feesSlippage: {
    takerFeeBps: 7.5,
    makerFeeBps: 2.5,
    defaultSlippageBps: 2.0,
  },
  filters: {
    minAdx: 14,
    minDollarVolume: 150_000,
    minRr: 1.15,
    minAtrPct: 0.08,
    maxSpreadBps: 16,
    confidenceThreshold: 0.55,
    useConfidenceFilter: true,
    maxAtrPct: 12,
    tierOverrides: {
      tier1: {
        minRr: 1.3,
        minDollarVolume: 3_000_000,
        maxSpreadBps: 8,
        confidenceThresholdDelta: 0.01,
        maxAtrPct: 6,
      },
      tier2: {
        minDollarVolume: 500_000,
        minRr: 1.2,
        maxSpreadBps: 12,
      },
      tier3: {
        minAdx: 18,
        minRr: 1.4,
        minDollarVolume: 150_000,
        maxSpreadBps: 18,
        confidenceThresholdDelta: 0.02,
        minAtrPctMultiplier: 0.6,
        maxAtrPct: 12,
        spreadAtrRatioLimit: 0.6,
      },
    },
    volatilityProfileOverrides: {
      HIGH_VOLATILITY: {
        minDollarVolume: 300_000,
        minAtrPct: 0.12,
        spreadAtrRatioLimit: 0.45,
      },
      EXTREME_VOLATILITY: {
        minDollarVolume: 400_000,
        minAtrPct: 0.18,
        maxAtrPct: 10,
        minAdx: 10,
      },
      LOW_VOLATILITY: {
        minDollarVolume: 800_000,
        minAtrPct: 0.2,
        maxAtrPct: 5,
        minAdx: 16,
        spreadAtrRatioLimit: 0.3,
      },
      MODERATE_VOLATILITY: {},
      MODERATE: {},
    },
    dynamic: {
      baselineAtrMultiplier: 0.45,
      atrHighVolThresholdPct: 1.5,
      atrHighVolMinAdx: 18,
      atrExtremeVolThresholdPct: 4.0,
      atrExtremeVolMinAdx: 22,
      atrExtremeVolMinRr: 1.35,
      atrMaxPct: 12,
      atrMaxPctByTier: {
        tier1: 6,
        tier2: 9,
        tier3: 12,
      },
      spreadAtrRatioLimit: 0.55,
      confidenceTierAdjustments: {
        tier3: 0.02,
      },
      rrTierAdjustments: {
        tier1: 0.15,
        tier3: 0.2,
      },
      drySpell: {
        enabled: true,
        minMinutesWithoutTrade: 30,
        rejectionsForStep: 4,
        relaxationStepMinutes: 20,
        maxSteps: 4,
        minAdxDeltaPerStep: -2.5,
        minRrDeltaPerStep: -0.15,
        confidenceDeltaPerStep: -0.03,
        minAtrPctDeltaPerStep: -0.04,
      },
      aggressivenessAdjustments: {
        conservative: {
          minRrDelta: 0.05,
          confidenceDelta: 0.015,
        },
        aggressive: {
          minRrDelta: -0.25,
          minAdxDelta: -3,
          confidenceDelta: -0.04,
          minAtrPctDelta: -0.06,
        },
      },
    },
  },
  exits: {
    atrPeriod: 14,
    slAtrMult: 1.5,
    slAtrMultReversal: 1.2,
    slAtrMultImpulse: 1.5,
    tpRMultiples: [0.5, 1.0, 2.0],
    trailAfterR: 1.0,
    trailAfterRReversal: 0.8,
    trailAfterRImpulse: 1.0,
    trailAtrMult: 1.0,
    earlyExit: {
      adxBelow: 18,
      cmfNegative: true,
      tightenProfitR: 0.2,
      cutLossR: 0.5,
    },
    maxHoldingMin: 20,
  },
  regime: {
    emaFastPeriod: 50,
    emaSlowPeriod: 200,
    adxTrendMin: 16,
    neutralBandBps: 10,
  },
};

let cachedConfig: QuantAIConfig | null = null;
let cachedMtimeMs = 0;

function normalizeRisk(raw: any): QuantAIRiskConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_CONFIG.risk;
  return {
    maxConsecutiveLosses: Number(raw.max_consecutive_losses ?? raw.maxConsecutiveLosses ?? DEFAULT_CONFIG.risk.maxConsecutiveLosses),
    cooldownMinutes: Number(raw.cooldown_minutes ?? raw.cooldownMinutes ?? DEFAULT_CONFIG.risk.cooldownMinutes),
    dailyLossLimitPct: Number(raw.daily_loss_limit_pct ?? raw.dailyLossLimitPct ?? DEFAULT_CONFIG.risk.dailyLossLimitPct),
    dailyTradeLimit: Number(raw.daily_trade_limit ?? raw.dailyTradeLimit ?? DEFAULT_CONFIG.risk.dailyTradeLimit),
    reduceSizeAfterLosses: Boolean(raw.reduce_size_after_losses ?? raw.reduceSizeAfterLosses ?? DEFAULT_CONFIG.risk.reduceSizeAfterLosses),
    sizeReductionAfterLosses: Number(raw.size_reduction_after_n_losses ?? raw.sizeReductionAfterLosses ?? DEFAULT_CONFIG.risk.sizeReductionAfterLosses),
    sizeReductionFactor: Number(raw.size_reduction_factor ?? raw.sizeReductionFactor ?? DEFAULT_CONFIG.risk.sizeReductionFactor),
    baseRiskPerTradePct: Number(raw.base_risk_per_trade_pct ?? raw.baseRiskPerTradePct ?? DEFAULT_CONFIG.risk.baseRiskPerTradePct),
  };
}

function normalizeFees(raw: any): QuantAIFeesConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_CONFIG.feesSlippage;
  return {
    takerFeeBps: Number(raw.taker_fee_bps ?? raw.takerFeeBps ?? DEFAULT_CONFIG.feesSlippage.takerFeeBps),
    makerFeeBps: Number(raw.maker_fee_bps ?? raw.makerFeeBps ?? DEFAULT_CONFIG.feesSlippage.makerFeeBps),
    defaultSlippageBps: Number(raw.default_slippage_bps ?? raw.defaultSlippageBps ?? DEFAULT_CONFIG.feesSlippage.defaultSlippageBps),
  };
}

function normalizeNumber(value: any, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeOptionalNumber(value: any): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function cloneTierOverrides(
  overrides?: Record<string, QuantAIEntryFilterTierOverride>,
): Record<string, QuantAIEntryFilterTierOverride> | undefined {
  if (!overrides) return undefined;
  const cloned: Record<string, QuantAIEntryFilterTierOverride> = {};
  for (const [key, value] of Object.entries(overrides)) {
    cloned[key] = { ...value };
  }
  return Object.keys(cloned).length ? cloned : undefined;
}

function cloneDynamic(
  dynamic?: QuantAIEntryFilterDynamicConfig,
): QuantAIEntryFilterDynamicConfig | undefined {
  if (!dynamic) return undefined;
  const cloned: QuantAIEntryFilterDynamicConfig = { ...dynamic };
  if (dynamic.atrMaxPctByTier) cloned.atrMaxPctByTier = { ...dynamic.atrMaxPctByTier };
  if (dynamic.confidenceTierAdjustments) {
    cloned.confidenceTierAdjustments = { ...dynamic.confidenceTierAdjustments };
  }
  if (dynamic.rrTierAdjustments) {
    cloned.rrTierAdjustments = { ...dynamic.rrTierAdjustments };
  }
  if (dynamic.drySpell) {
    cloned.drySpell = { ...dynamic.drySpell };
  }
  if (dynamic.aggressivenessAdjustments) {
    cloned.aggressivenessAdjustments = {};
    for (const [key, value] of Object.entries(dynamic.aggressivenessAdjustments)) {
      cloned.aggressivenessAdjustments[key] = { ...value };
    }
  }
  return cloned;
}

function normalizeFilters(raw: any): QuantAIEntryFilterConfig {
  const defaults = DEFAULT_CONFIG.filters;
  const cfg: QuantAIEntryFilterConfig = {
    minAdx: defaults.minAdx,
    minDollarVolume: defaults.minDollarVolume,
    minRr: defaults.minRr,
    minAtrPct: defaults.minAtrPct,
    maxSpreadBps: defaults.maxSpreadBps,
    confidenceThreshold: defaults.confidenceThreshold,
    useConfidenceFilter: defaults.useConfidenceFilter,
    maxAtrPct: defaults.maxAtrPct,
    tierOverrides: cloneTierOverrides(defaults.tierOverrides),
    dynamic: cloneDynamic(defaults.dynamic),
  };

  if (!raw || typeof raw !== 'object') return cfg;

  cfg.minAdx = normalizeNumber(raw.min_adx ?? raw.minAdx, cfg.minAdx);
  cfg.minDollarVolume = normalizeNumber(
    raw.min_dollar_volume ?? raw.minDollarVolume,
    cfg.minDollarVolume,
  );
  cfg.minRr = normalizeNumber(raw.min_rr ?? raw.minRr, cfg.minRr);
  cfg.minAtrPct = normalizeNumber(raw.min_atr_pct ?? raw.minAtrPct, cfg.minAtrPct);
  cfg.maxSpreadBps = normalizeNumber(raw.max_spread_bps ?? raw.maxSpreadBps, cfg.maxSpreadBps);
  cfg.confidenceThreshold = normalizeNumber(
    raw.confidence_threshold ?? raw.confidenceThreshold,
    cfg.confidenceThreshold,
  );
  cfg.useConfidenceFilter = Boolean(
    raw.use_confidence_filter ?? raw.useConfidenceFilter ?? cfg.useConfidenceFilter,
  );
  const maxAtrPct = normalizeOptionalNumber(raw.max_atr_pct ?? raw.maxAtrPct);
  if (maxAtrPct != null) cfg.maxAtrPct = maxAtrPct;

  const tierOverridesRaw = raw.tier_overrides ?? raw.tierOverrides;
  if (tierOverridesRaw && typeof tierOverridesRaw === 'object') {
    cfg.tierOverrides = cfg.tierOverrides ? { ...cfg.tierOverrides } : {};
    for (const [key, value] of Object.entries(tierOverridesRaw)) {
      if (!value || typeof value !== 'object') continue;
      const obj = value as Record<string, any>;
      const target: QuantAIEntryFilterTierOverride = { ...(cfg.tierOverrides[key] ?? {}) };
      if (obj['min_adx'] != null || obj['minAdx'] != null) {
        const val = normalizeOptionalNumber(obj['min_adx'] ?? obj['minAdx']);
        if (val != null) target.minAdx = val;
      }
      if (obj['min_dollar_volume'] != null || obj['minDollarVolume'] != null) {
        const val = normalizeOptionalNumber(obj['min_dollar_volume'] ?? obj['minDollarVolume']);
        if (val != null) target.minDollarVolume = val;
      }
      if (obj['min_rr'] != null || obj['minRr'] != null) {
        const val = normalizeOptionalNumber(obj['min_rr'] ?? obj['minRr']);
        if (val != null) target.minRr = val;
      }
      if (obj['min_atr_pct'] != null || obj['minAtrPct'] != null) {
        const val = normalizeOptionalNumber(obj['min_atr_pct'] ?? obj['minAtrPct']);
        if (val != null) target.minAtrPct = val;
      }
      if (obj['max_spread_bps'] != null || obj['maxSpreadBps'] != null) {
        const val = normalizeOptionalNumber(obj['max_spread_bps'] ?? obj['maxSpreadBps']);
        if (val != null) target.maxSpreadBps = val;
      }
      if (obj['confidence_threshold'] != null || obj['confidenceThreshold'] != null) {
        const val = normalizeOptionalNumber(obj['confidence_threshold'] ?? obj['confidenceThreshold']);
        if (val != null) target.confidenceThreshold = val;
      }
      if (obj['use_confidence_filter'] != null || obj['useConfidenceFilter'] != null) {
        target.useConfidenceFilter = Boolean(
          obj['use_confidence_filter'] ?? obj['useConfidenceFilter'],
        );
      }
      if (obj['max_atr_pct'] != null || obj['maxAtrPct'] != null) {
        const val = normalizeOptionalNumber(obj['max_atr_pct'] ?? obj['maxAtrPct']);
        if (val != null) target.maxAtrPct = val;
      }
      if (obj['min_atr_pct_multiplier'] != null || obj['minAtrPctMultiplier'] != null) {
        const val = normalizeOptionalNumber(obj['min_atr_pct_multiplier'] ?? obj['minAtrPctMultiplier']);
        if (val != null) target.minAtrPctMultiplier = val;
      }
      if (obj['min_rr_delta'] != null || obj['minRrDelta'] != null) {
        const val = normalizeOptionalNumber(obj['min_rr_delta'] ?? obj['minRrDelta']);
        if (val != null) target.minRrDelta = val;
      }
      if (obj['confidence_threshold_delta'] != null || obj['confidenceThresholdDelta'] != null) {
        const val = normalizeOptionalNumber(obj['confidence_threshold_delta'] ?? obj['confidenceThresholdDelta']);
        if (val != null) target.confidenceThresholdDelta = val;
      }
      if (obj['spread_atr_ratio_limit'] != null || obj['spreadAtrRatioLimit'] != null) {
        const val = normalizeOptionalNumber(obj['spread_atr_ratio_limit'] ?? obj['spreadAtrRatioLimit']);
        if (val != null) target.spreadAtrRatioLimit = val;
      }
      cfg.tierOverrides![key] = target;
    }
  }
  if (cfg.tierOverrides && Object.keys(cfg.tierOverrides).length === 0) {
    cfg.tierOverrides = undefined;
  }

  const dynamicRaw = raw.dynamic ?? raw.dynamic_adjustments ?? raw.adaptive;
  if (dynamicRaw && typeof dynamicRaw === 'object') {
    cfg.dynamic = cfg.dynamic ? { ...cfg.dynamic } : {};
    const numFields: Array<[keyof QuantAIEntryFilterDynamicConfig, any]> = [
      ['baselineAtrMultiplier', dynamicRaw.baseline_atr_multiplier ?? dynamicRaw.baselineAtrMultiplier],
      ['atrHighVolThresholdPct', dynamicRaw.atr_high_vol_threshold_pct ?? dynamicRaw.atrHighVolThresholdPct],
      ['atrHighVolMinAdx', dynamicRaw.atr_high_vol_min_adx ?? dynamicRaw.atrHighVolMinAdx],
      ['atrExtremeVolThresholdPct', dynamicRaw.atr_extreme_vol_threshold_pct ?? dynamicRaw.atrExtremeVolThresholdPct],
      ['atrExtremeVolMinAdx', dynamicRaw.atr_extreme_vol_min_adx ?? dynamicRaw.atrExtremeVolMinAdx],
      ['atrExtremeVolMinRr', dynamicRaw.atr_extreme_vol_min_rr ?? dynamicRaw.atrExtremeVolMinRr],
      ['atrMaxPct', dynamicRaw.atr_max_pct ?? dynamicRaw.atrMaxPct],
      ['spreadAtrRatioLimit', dynamicRaw.spread_atr_ratio_limit ?? dynamicRaw.spreadAtrRatioLimit],
    ];
    for (const [field, value] of numFields) {
      const val = normalizeOptionalNumber(value);
      if (val != null) (cfg.dynamic as any)[field] = val;
    }
    const atrMaxByTier = (dynamicRaw as Record<string, any>)['atr_max_pct_by_tier']
      ?? (dynamicRaw as Record<string, any>)['atrMaxPctByTier'];
    if (atrMaxByTier && typeof atrMaxByTier === 'object') {
      const src = atrMaxByTier as Record<string, any>;
      cfg.dynamic!.atrMaxPctByTier = cfg.dynamic!.atrMaxPctByTier
        ? { ...cfg.dynamic!.atrMaxPctByTier }
        : {};
      for (const [key, value] of Object.entries(src)) {
        const val = normalizeOptionalNumber(value);
        if (val != null) cfg.dynamic!.atrMaxPctByTier![key] = val;
      }
    }
    const confidenceAdjust = (dynamicRaw as Record<string, any>)['confidence_tier_adjustments']
      ?? (dynamicRaw as Record<string, any>)['confidenceTierAdjustments'];
    if (confidenceAdjust && typeof confidenceAdjust === 'object') {
      const src = confidenceAdjust as Record<string, any>;
      cfg.dynamic!.confidenceTierAdjustments = cfg.dynamic!.confidenceTierAdjustments
        ? { ...cfg.dynamic!.confidenceTierAdjustments }
        : {};
      for (const [key, value] of Object.entries(src)) {
        const val = normalizeOptionalNumber(value);
        if (val != null) cfg.dynamic!.confidenceTierAdjustments![key] = val;
      }
    }
    const rrAdjust = (dynamicRaw as Record<string, any>)['rr_tier_adjustments']
      ?? (dynamicRaw as Record<string, any>)['rrTierAdjustments'];
    if (rrAdjust && typeof rrAdjust === 'object') {
      const src = rrAdjust as Record<string, any>;
    cfg.dynamic!.rrTierAdjustments = cfg.dynamic!.rrTierAdjustments
      ? { ...cfg.dynamic!.rrTierAdjustments }
      : {};
      for (const [key, value] of Object.entries(src)) {
        const val = normalizeOptionalNumber(value);
        if (val != null) cfg.dynamic!.rrTierAdjustments![key] = val;
      }
    }
    const drySpellRaw = (dynamicRaw as Record<string, any>)['dry_spell']
      ?? (dynamicRaw as Record<string, any>)['drySpell'];
    if (drySpellRaw && typeof drySpellRaw === 'object') {
      const base = defaults.dynamic?.drySpell;
      const normalize = (field: string, fallback: number): number => {
        const value = (drySpellRaw as Record<string, any>)[field]
          ?? (drySpellRaw as Record<string, any>)[field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)];
        const num = Number(value);
        return Number.isFinite(num) ? num : fallback;
      };
      const enabledValue = (drySpellRaw as Record<string, any>)['enabled'];
      let enabled: boolean;
      if (typeof enabledValue === 'boolean') {
        enabled = enabledValue;
      } else if (typeof enabledValue === 'string') {
        enabled = enabledValue.trim().length === 0
          ? (base?.enabled ?? true)
          : enabledValue.trim().toLowerCase() !== 'false';
      } else if (typeof enabledValue === 'number') {
        enabled = enabledValue !== 0;
      } else {
        enabled = base?.enabled ?? true;
      }
      const defaultsDry = base ?? DEFAULT_CONFIG.filters.dynamic?.drySpell!;
      cfg.dynamic!.drySpell = {
        enabled,
        minMinutesWithoutTrade: normalize('minMinutesWithoutTrade', defaultsDry.minMinutesWithoutTrade),
        rejectionsForStep: normalize('rejectionsForStep', defaultsDry.rejectionsForStep),
        relaxationStepMinutes: normalize('relaxationStepMinutes', defaultsDry.relaxationStepMinutes),
        maxSteps: normalize('maxSteps', defaultsDry.maxSteps),
        minAdxDeltaPerStep: normalize('minAdxDeltaPerStep', defaultsDry.minAdxDeltaPerStep),
        minRrDeltaPerStep: normalize('minRrDeltaPerStep', defaultsDry.minRrDeltaPerStep),
        confidenceDeltaPerStep: normalize('confidenceDeltaPerStep', defaultsDry.confidenceDeltaPerStep),
        minAtrPctDeltaPerStep: normalize('minAtrPctDeltaPerStep', defaultsDry.minAtrPctDeltaPerStep),
      };
    }
    const aggrAdjust = (dynamicRaw as Record<string, any>)['aggressiveness_adjustments']
      ?? (dynamicRaw as Record<string, any>)['aggressivenessAdjustments'];
    if (aggrAdjust && typeof aggrAdjust === 'object') {
      const src = aggrAdjust as Record<string, any>;
      cfg.dynamic!.aggressivenessAdjustments = cfg.dynamic!.aggressivenessAdjustments
        ? { ...cfg.dynamic!.aggressivenessAdjustments }
        : {};
      for (const [key, value] of Object.entries(src)) {
        if (!value || typeof value !== 'object') continue;
        const obj = value as Record<string, any>;
        const adj = { ...(cfg.dynamic!.aggressivenessAdjustments?.[key] ?? {}) };
        const minRrDelta = normalizeOptionalNumber(obj['min_rr_delta'] ?? obj['minRrDelta']);
        const minAdxDelta = normalizeOptionalNumber(obj['min_adx_delta'] ?? obj['minAdxDelta']);
        const confidenceDelta = normalizeOptionalNumber(obj['confidence_delta'] ?? obj['confidenceDelta']);
        const minAtrPctDelta = normalizeOptionalNumber(obj['min_atr_pct_delta'] ?? obj['minAtrPctDelta']);
        if (minRrDelta != null) adj.minRrDelta = minRrDelta;
        if (minAdxDelta != null) adj.minAdxDelta = minAdxDelta;
        if (confidenceDelta != null) adj.confidenceDelta = confidenceDelta;
        if (minAtrPctDelta != null) adj.minAtrPctDelta = minAtrPctDelta;
        if (Object.keys(adj).length > 0) {
          cfg.dynamic!.aggressivenessAdjustments![key] = adj;
        }
      }
    }
    if (cfg.dynamic && Object.keys(cfg.dynamic).length === 0) {
      cfg.dynamic = undefined;
    }
  }

  return cfg;
}

function normalizeExits(raw: any): QuantAIExitConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_CONFIG.exits;
  const earlyExitRaw = raw.early_exit ?? raw.earlyExit ?? {};
  const slBase = Number(raw.sl_atr_mult ?? raw.slAtrMult ?? DEFAULT_CONFIG.exits.slAtrMult);
  const slReversal = Number(
    raw.sl_atr_mult_reversal ??
    raw.slAtrMultReversal ??
    DEFAULT_CONFIG.exits.slAtrMultReversal ??
    slBase,
  );
  const slImpulse = Number(
    raw.sl_atr_mult_impulse ??
    raw.slAtrMultImpulse ??
    DEFAULT_CONFIG.exits.slAtrMultImpulse ??
    slBase,
  );
  const trailBase = Number(raw.trail_after_r ?? raw.trailAfterR ?? DEFAULT_CONFIG.exits.trailAfterR);
  const trailReversal = Number(
    raw.trail_after_r_reversal ??
    raw.trailAfterRReversal ??
    DEFAULT_CONFIG.exits.trailAfterRReversal ??
    trailBase,
  );
  const trailImpulse = Number(
    raw.trail_after_r_impulse ??
    raw.trailAfterRImpulse ??
    DEFAULT_CONFIG.exits.trailAfterRImpulse ??
    trailBase,
  );
  const tightenProfitR = Number(
    earlyExitRaw.tighten_profit_r ??
    earlyExitRaw.tightenProfitR ??
    earlyExitRaw.tighten_only_if_profit_gt_r ??
    earlyExitRaw.tightenOnlyIfProfitGtR ??
    DEFAULT_CONFIG.exits.earlyExit.tightenProfitR ??
    DEFAULT_CONFIG.exits.earlyExit.tightenOnlyIfProfitGtR,
  );
  const cutLossR = Number(
    earlyExitRaw.cut_loss_r ??
    earlyExitRaw.cutLossR ??
    earlyExitRaw.cut_if_loss_gt_r ??
    earlyExitRaw.cutIfLossGtR ??
    DEFAULT_CONFIG.exits.earlyExit.cutLossR ??
    DEFAULT_CONFIG.exits.earlyExit.cutIfLossGtR,
  );
  const maxHoldingRaw = raw.max_holding_min ?? raw.maxHoldingMin;
  const maxHolding = maxHoldingRaw != null
    ? Number(maxHoldingRaw)
    : DEFAULT_CONFIG.exits.maxHoldingMin;
  return {
    atrPeriod: Number(raw.atr_period ?? raw.atrPeriod ?? DEFAULT_CONFIG.exits.atrPeriod),
    slAtrMult: slBase,
    slAtrMultReversal: slReversal,
    slAtrMultImpulse: slImpulse,
    tpRMultiples: Array.isArray(raw.tp_r_multiples ?? raw.tpRMultiples)
      ? (raw.tp_r_multiples ?? raw.tpRMultiples).map((v: any) => Number(v)).filter((v: number) => Number.isFinite(v) && v > 0)
      : DEFAULT_CONFIG.exits.tpRMultiples,
    trailAfterR: trailBase,
    trailAfterRReversal: trailReversal,
    trailAfterRImpulse: trailImpulse,
    trailAtrMult: Number(raw.trail_atr_mult ?? raw.trailAtrMult ?? DEFAULT_CONFIG.exits.trailAtrMult),
    earlyExit: {
      adxBelow: Number(earlyExitRaw.adx_below ?? earlyExitRaw.adxBelow ?? DEFAULT_CONFIG.exits.earlyExit.adxBelow),
      cmfNegative: Boolean(earlyExitRaw.cmf_negative ?? earlyExitRaw.cmfNegative ?? DEFAULT_CONFIG.exits.earlyExit.cmfNegative),
      tightenProfitR,
      cutLossR,
      tightenOnlyIfProfitGtR: tightenProfitR,
      cutIfLossGtR: cutLossR,
    },
    maxHoldingMin: Number.isFinite(maxHolding) ? maxHolding : DEFAULT_CONFIG.exits.maxHoldingMin,
  };
}

function normalizeRegime(raw: any): QuantAIRegimeConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_CONFIG.regime;
  return {
    emaFastPeriod: Number(raw.ema_trend_period_fast ?? raw.emaFastPeriod ?? DEFAULT_CONFIG.regime.emaFastPeriod),
    emaSlowPeriod: Number(raw.ema_trend_period_slow ?? raw.emaSlowPeriod ?? DEFAULT_CONFIG.regime.emaSlowPeriod),
    adxTrendMin: Number(raw.adx_trend_min ?? raw.adxTrendMin ?? DEFAULT_CONFIG.regime.adxTrendMin),
    neutralBandBps: Number(raw.neutral_band_bps ?? raw.neutralBandBps ?? DEFAULT_CONFIG.regime.neutralBandBps),
  };
}

function readConfigFile(): QuantAIConfig {
  const configPath = path.resolve(process.cwd(), 'quantailabs_patch', 'config.yaml');
  try {
    const stats = fs.statSync(configPath);
    if (cachedConfig && cachedMtimeMs === stats.mtimeMs) {
      return cachedConfig;
    }
    const file = fs.readFileSync(configPath, 'utf8');
    const raw = (loadYaml(file) || {}) as Record<string, unknown>;
    const config: QuantAIConfig = {
      risk: normalizeRisk(raw?.risk),
      feesSlippage: normalizeFees(raw?.fees_slippage ?? raw?.feesSlippage),
      filters: normalizeFilters(raw?.filters),
      exits: normalizeExits(raw?.exits),
      regime: normalizeRegime(raw?.regime),
    };
    cachedConfig = config;
    cachedMtimeMs = stats.mtimeMs;
    return config;
  } catch (error) {
    if (!cachedConfig) {
      cachedConfig = DEFAULT_CONFIG;
    }
    return cachedConfig;
  }
}

export function getQuantAIConfig(): QuantAIConfig {
  if (cachedConfig) {
    return cachedConfig;
  }
  return readConfigFile();
}

export function reloadQuantAIConfig(): QuantAIConfig {
  cachedConfig = null;
  cachedMtimeMs = 0;
  return readConfigFile();
}
