import fs from 'fs';
import path from 'path';
import { load as loadYaml } from 'js-yaml';

export type QuantAIRiskConfig = {
  maxConsecutiveLosses: number;
  cooldownMinutes: number;
  dailyLossLimitPct: number;
  dailyTradeLimit: number;
  catastrophicTradeDrawdownPct?: number;
  catastrophicTradeConsecutiveLosses?: number;
  reduceSizeAfterLosses: boolean;
  sizeReductionAfterLosses: number;
  sizeReductionFactor: number;
  baseRiskPerTradePct: number;
  winStreakForIncrease?: number;
  sizeIncreaseFactor?: number;
  sizeIncreaseMaxMultiplier?: number;
  dailyLossRiskReductionMultiplier?: number;
  dailyLossCooldownMinutes?: number;
  dailyLossRecoveryWins?: number;
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

export type QuantAISymbolEntryFilterOverride = Partial<EntryFilterThresholds> & {
  spreadAtrRatioLimit?: number;
  volatilityProfileOverrides?: Record<string, QuantAIVolatilityProfileOverride>;
};

export type QuantAIPlaybookEntryFilterOverride = Partial<EntryFilterThresholds> & {
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

export type QuantAIDirectionalFilterConfig = {
  enabled?: boolean;
  trendAdx?: number;
  rangeAdx?: number;
  minDiTrend?: number;
  minDiRange?: number;
  minDiStrong?: number;
  minRsiTrend?: number;
  maxRsiTrend?: number;
  rangeNeutralBand?: number;
  requireDiSignal?: boolean;
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
  spreadSoftPenalty?: number;
  rrNearThresholdFactor?: number;
  momentumFastTrack?: {
    enabled?: boolean;
    minAdx?: number;
    minVolumeRatio?: number;
    minSlopePct?: number;
    minCmf?: number;
    minWeightedRr?: number;
    minRr?: number;
    rrFloor?: number;
    minAtrPct?: number;
    nearThresholdFactor?: number;
  };
  drySpell?: QuantAIDrySpellConfig;
  aggressivenessAdjustments?: Record<string, {
    minRrDelta?: number;
    minAdxDelta?: number;
    confidenceDelta?: number;
    minAtrPctDelta?: number;
  }>;
  confidenceTierAdjustments?: Record<string, number>;
  rrTierAdjustments?: Record<string, number>;
  directionalFilter?: QuantAIDirectionalFilterConfig;
};

export type QuantAIEntryFilterConfig = EntryFilterThresholds & {
  tierOverrides?: Record<string, QuantAIEntryFilterTierOverride>;
  dynamic?: QuantAIEntryFilterDynamicConfig;
  volatilityProfileOverrides?: Record<string, QuantAIVolatilityProfileOverride>;
  symbolOverrides?: Record<string, QuantAISymbolEntryFilterOverride>;
  playbookOverrides?: Record<string, QuantAIPlaybookEntryFilterOverride>;
};

export type QuantAIPeakDrawdownConfig = {
  enabled: boolean;
  thresholds: Record<number, number>; // R-multiple -> drawdown threshold (e.g., { 1.0: 0.05, 2.0: 0.04, 3.0: 0.03 })
};

export type QuantAIPositionFlippingConfig = {
  enabled: boolean;
  minCounterSignalConfidence: number; // Minimum confidence required to flip (e.g., 0.7)
  minRMultiple: number; // Minimum R-multiple profit required to flip (e.g., 2.0)
  cooldownMinutes: number; // Time-based cooldown between flips (e.g., 30)
  maxFlipsPerHour: number; // Maximum number of flips allowed per hour (e.g., 3)
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
  trailingAdaptive?: QuantAITrailingAdaptiveConfig;
  minStopAtrMult?: number;
  profitLock?: {
    minRMultiple: number;
    allowPartialBeforeMinR?: boolean;
    preLockTrailMultiplier?: number;
    preLockMinRMultiple?: number;
    minHoldBypassRMultiple?: number;
    breakevenOffsetR?: number;
  };
  volatilityExit?: {
    atrPctSpikeThreshold: number;
    widenMultiplier: number;
  };
  percentGainLock?: QuantAIPercentGainLockConfig;
  peakDrawdown?: QuantAIPeakDrawdownConfig;
  positionFlipping?: QuantAIPositionFlippingConfig;
  earlyExit: {
    adxBelow: number;
    cmfNegative: boolean;
    tightenProfitR: number;
    cutLossR: number;
    tightenOnlyIfProfitGtR?: number;
    cutIfLossGtR?: number;
    minHoldMinutes?: number;
  };
  maxHoldingMin?: number;
  reentryCooldownMin?: number;
  enforceHardMinHold?: boolean;
  exitOnBarClose?: boolean;
  trailingPriceSource?: 'last' | 'mid' | 'bid' | 'ask';
  slipTicks?: number;
  strategyOverrides?: Record<string, QuantAIExitOverride>;
};

export type QuantAITrailingAtrBands = {
  low: number;
  high: number;
  extreme?: number;
  lowMultiplier: number;
  midMultiplier?: number;
  highMultiplier: number;
  extremeMultiplier?: number;
};

export type QuantAITrailingAdaptiveConfig = {
  mode?: 'atr' | 'percent';
  percent?: number;
  atrBands?: QuantAITrailingAtrBands;
  clampMultiplier?: { min?: number; max?: number };
};

export type QuantAIExitOverride = {
  slAtrMult?: number;
  slAtrMultReversal?: number;
  slAtrMultImpulse?: number;
  tpRMultiples?: number[];
  trailAfterR?: number;
  trailAfterRReversal?: number;
  trailAfterRImpulse?: number;
  trailAtrMult?: number;
  minStopAtrMult?: number;
  enforceHardMinHold?: boolean;
  exitOnBarClose?: boolean;
  trailingPriceSource?: 'last' | 'mid' | 'bid' | 'ask';
  slipTicks?: number;
  profitLock?: {
    minRMultiple?: number;
    allowPartialBeforeMinR?: boolean;
    preLockTrailMultiplier?: number;
    preLockMinRMultiple?: number;
    minHoldBypassRMultiple?: number;
    breakevenOffsetR?: number;
  };
  volatilityExit?: {
    atrPctSpikeThreshold?: number;
    widenMultiplier?: number;
  };
  maxHoldingMin?: number;
  reentryCooldownMin?: number;
  earlyExit?: {
    adxBelow?: number;
    cmfNegative?: boolean;
    tightenProfitR?: number;
    cutLossR?: number;
    tightenOnlyIfProfitGtR?: number;
    cutIfLossGtR?: number;
    minHoldMinutes?: number;
  };
  trailingAdaptive?: Partial<QuantAITrailingAdaptiveConfig> & {
    atrBands?: Partial<QuantAITrailingAtrBands>;
    clampMultiplier?: { min?: number; max?: number };
  };
  percentGainLock?: {
    enabled?: boolean;
    activationGainPct?: number;
    lockFraction?: number;
    minGainStepPct?: number;
  };
};

export type QuantAIPercentGainLockConfig = {
  enabled: boolean;
  activationGainPct: number;
  lockFraction: number;
  minGainStepPct?: number;
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

const DEFAULT_DYNAMIC_FILTERS: QuantAIEntryFilterDynamicConfig = {
  baselineAtrMultiplier: 0.35,
  atrHighVolThresholdPct: 1.8,
  atrHighVolMinAdx: 16,
  atrExtremeVolThresholdPct: 4.5,
  atrExtremeVolMinAdx: 20,
  atrExtremeVolMinRr: 1.25,
  atrMaxPct: 12,
  atrMaxPctByTier: {
    tier1: 6,
    tier2: 9,
    tier3: 12,
  },
  spreadAtrRatioLimit: 0.45,
  spreadSoftPenalty: 0.85,
  rrNearThresholdFactor: 0.9,
  momentumFastTrack: {
    enabled: true,
    minAdx: 35,
    minVolumeRatio: 1.2,
    minSlopePct: 0.2,
    minCmf: 0,
    minWeightedRr: 0.9,
    minRr: 1.05,
    rrFloor: 1.0,
    minAtrPct: 0.8,
    nearThresholdFactor: 0.9,
  },
  confidenceTierAdjustments: {
    tier3: 0.00,
  },
  rrTierAdjustments: {
    tier1: 0.10,
    tier3: 0.15,
  },
  directionalFilter: {
    enabled: true,
    trendAdx: 24,
    rangeAdx: 16,
    minDiTrend: 3,
    minDiRange: 1.25,
    minDiStrong: 4.5,
    minRsiTrend: 54,
    rangeNeutralBand: 10,
    requireDiSignal: false,
  },
  drySpell: {
    enabled: true,
    minMinutesWithoutTrade: 20,
    rejectionsForStep: 3,
    relaxationStepMinutes: 15,
    maxSteps: 5,
    minAdxDeltaPerStep: -3,
    minRrDeltaPerStep: -0.18,
    confidenceDeltaPerStep: -0.04,
    minAtrPctDeltaPerStep: -0.05,
  },
};

DEFAULT_DYNAMIC_FILTERS.aggressivenessAdjustments = {
  conservative: {
    minRrDelta: 0.03,
    confidenceDelta: 0.01,
  },
  aggressive: {
    minRrDelta: -0.30,
    minAdxDelta: -4,
    confidenceDelta: -0.06,
    minAtrPctDelta: -0.08,
  },
};

const DEFAULT_CONFIG: QuantAIConfig = {
  risk: {
    maxConsecutiveLosses: 3,
    cooldownMinutes: 60,
    dailyLossLimitPct: 3.0,
    dailyTradeLimit: 24,
    catastrophicTradeDrawdownPct: 2.0,
    catastrophicTradeConsecutiveLosses: 4,
    reduceSizeAfterLosses: true,
    sizeReductionAfterLosses: 2,
    sizeReductionFactor: 0.5,
    baseRiskPerTradePct: 0.5,
    winStreakForIncrease: 2,
    sizeIncreaseFactor: 1.1,
    sizeIncreaseMaxMultiplier: 1.35,
    dailyLossRiskReductionMultiplier: 0.35,
    dailyLossCooldownMinutes: 75,
    dailyLossRecoveryWins: 2,
  },
  feesSlippage: {
    takerFeeBps: 4.0,
    makerFeeBps: 4.0,
    defaultSlippageBps: 2.0,
  },
  filters: {
    minAdx: 16,
    minDollarVolume: 350_000,
    minRr: 1.05,
    minAtrPct: 0.05,
    maxSpreadBps: 12,
    confidenceThreshold: 0.62,
    useConfidenceFilter: true,
    maxAtrPct: 12,
    tierOverrides: {
      tier1: {
        minRr: 1.2,
        minDollarVolume: 2_000_000,
        maxSpreadBps: 10,
        confidenceThresholdDelta: 0.05,
        maxAtrPct: 6,
      },
      tier2: {
        minDollarVolume: 400_000,
        minRr: 1.1,
        maxSpreadBps: 14,
      },
      tier3: {
        minAdx: 14,
        minRr: 1.25,
        minDollarVolume: 100_000,
        maxSpreadBps: 20,
        confidenceThresholdDelta: 0.03,
        minAtrPctMultiplier: 0.4,
        maxAtrPct: 12,
        spreadAtrRatioLimit: 0.7,
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
      MEME_VOLATILITY: {
        minDollarVolume: 250_000,
        minAtrPct: 0.14,
        maxAtrPct: 14,
        minAdx: 12,
        spreadAtrRatioLimit: 0.65,
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
    symbolOverrides: {
      ETH: {
        spreadAtrRatioLimit: 0.65,
        volatilityProfileOverrides: {
          LOW_VOLATILITY: { spreadAtrRatioLimit: 0.45 },
          MODERATE_VOLATILITY: { spreadAtrRatioLimit: 0.62 },
          MODERATE: { spreadAtrRatioLimit: 0.62 },
          HIGH_VOLATILITY: { spreadAtrRatioLimit: 0.55 },
        },
      },
      SOL: {
        spreadAtrRatioLimit: 0.68,
        volatilityProfileOverrides: {
          LOW_VOLATILITY: { spreadAtrRatioLimit: 0.48 },
          MODERATE_VOLATILITY: { spreadAtrRatioLimit: 0.64 },
          MODERATE: { spreadAtrRatioLimit: 0.64 },
          HIGH_VOLATILITY: { spreadAtrRatioLimit: 0.57 },
        },
      },
    },
    playbookOverrides: undefined,
    dynamic: DEFAULT_DYNAMIC_FILTERS,
  },
  exits: {
    atrPeriod: 14,
    slAtrMult: 2.5,  // FIXED: Was 1.5 (too tight!) - now 2.5x ATR for safer stops
    slAtrMultReversal: 2.0,  // FIXED: Was 1.2 - increased for reversal patterns
    slAtrMultImpulse: 2.5,  // FIXED: Was 1.5 - impulse moves need room
    tpRMultiples: [1.4, 2.4, 3.5],
    trailAfterR: 1.2,
    trailAfterRReversal: 0.9,
    trailAfterRImpulse: 1.2,
    trailAtrMult: 1.0,
    trailingAdaptive: {
      mode: 'atr',
      atrBands: {
        low: 0.9,
        high: 3.5,
        extreme: 6.0,
        lowMultiplier: 1.35,
        midMultiplier: 1.0,
        highMultiplier: 0.85,
        extremeMultiplier: 0.65,
      },
      clampMultiplier: { min: 0.55, max: 1.75 },
    },
    minStopAtrMult: 1.5,  // FIXED: Was 0.9 (too tight!) - minimum stop distance increased
    profitLock: {
      minRMultiple: 1.8,  // CRYPTO: Lock profit at 1.8R (was 1.0R) - let winners run
      allowPartialBeforeMinR: true,  // Allow tactical partial exits before profit lock
      preLockTrailMultiplier: 0.8,
      preLockMinRMultiple: 0.6,  // CRYPTO: Trail at 0.6R (was 0.35R) - don't trail too early
      minHoldBypassRMultiple: 0.5,
      breakevenOffsetR: 0,
    },
    volatilityExit: {
      atrPctSpikeThreshold: 0.35,
      widenMultiplier: 1.25,
    },
    percentGainLock: {
      enabled: true,
      activationGainPct: 0.01,
      lockFraction: 0.7,
      minGainStepPct: 0.001,
    },
    peakDrawdown: {
      enabled: true,
      thresholds: {
        1.0: 0.12,  // CRYPTO: 12% drawdown at 1R (was 5%) - allow normal consolidation
        2.0: 0.10,  // CRYPTO: 10% drawdown at 2R (was 4%) - winners need breathing room
        3.0: 0.08,  // CRYPTO: 8% drawdown at 3R (was 3%) - protect big winners
        5.0: 0.06,  // CRYPTO: 6% drawdown at 5R+ (was 2%) - let runners breathe
      },
    },
    positionFlipping: {
      enabled: true,  // Disabled by default - must be explicitly enabled
      minCounterSignalConfidence: 0.7,  // Require 70% confidence to flip
      minRMultiple: 1.5,  // Require at least 1.5R profit before flipping
      cooldownMinutes: 30,  // 30 minutes between flips
      maxFlipsPerHour: 3,  // Maximum 3 flips per hour to avoid overtrading
    },
    earlyExit: {
      adxBelow: 12,  // CRYPTO: Exit only if ADX < 12 (was 18) - ADX 12-18 is normal consolidation
      cmfNegative: false,  // CRYPTO: Don't exit on CMF negative (too noisy in crypto)
      tightenProfitR: 0.4,  // CRYPTO: Trail at 0.4R (was 0.1R) - don't trail too early
      cutLossR: 0.5,  // CRYPTO: Cut loss at -0.5R (was 0.2R) - let positions breathe
      minHoldMinutes: 12,  // CRYPTO: 12 minutes minimum (was 3) - wait for moves to develop
    },
    maxHoldingMin: undefined,  // CRYPTO: Disabled - let trailing stop decide exit, not hard time cap
    reentryCooldownMin: 25,
    enforceHardMinHold: false,
    exitOnBarClose: false,
    trailingPriceSource: 'last',
    slipTicks: 0,
    strategyOverrides: undefined,
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
    catastrophicTradeDrawdownPct: Number(
      raw.catastrophic_trade_drawdown_pct
        ?? raw.catastrophicTradeDrawdownPct
        ?? DEFAULT_CONFIG.risk.catastrophicTradeDrawdownPct
        ?? 0,
    ),
    catastrophicTradeConsecutiveLosses: Number(
      raw.catastrophic_trade_consecutive_losses
        ?? raw.catastrophicTradeConsecutiveLosses
        ?? DEFAULT_CONFIG.risk.catastrophicTradeConsecutiveLosses
        ?? 0,
    ),
    reduceSizeAfterLosses: Boolean(raw.reduce_size_after_losses ?? raw.reduceSizeAfterLosses ?? DEFAULT_CONFIG.risk.reduceSizeAfterLosses),
    sizeReductionAfterLosses: Number(raw.size_reduction_after_n_losses ?? raw.sizeReductionAfterLosses ?? DEFAULT_CONFIG.risk.sizeReductionAfterLosses),
    sizeReductionFactor: Number(raw.size_reduction_factor ?? raw.sizeReductionFactor ?? DEFAULT_CONFIG.risk.sizeReductionFactor),
    baseRiskPerTradePct: Number(raw.base_risk_per_trade_pct ?? raw.baseRiskPerTradePct ?? DEFAULT_CONFIG.risk.baseRiskPerTradePct),
    winStreakForIncrease: Number(raw.win_streak_for_increase ?? raw.winStreakForIncrease ?? DEFAULT_CONFIG.risk.winStreakForIncrease ?? 0),
    sizeIncreaseFactor: Number(raw.size_increase_factor ?? raw.sizeIncreaseFactor ?? DEFAULT_CONFIG.risk.sizeIncreaseFactor ?? 1),
    sizeIncreaseMaxMultiplier: Number(raw.size_increase_max_multiplier ?? raw.sizeIncreaseMaxMultiplier ?? DEFAULT_CONFIG.risk.sizeIncreaseMaxMultiplier ?? 1),
    dailyLossRiskReductionMultiplier: Number(raw.daily_loss_risk_reduction_multiplier ?? raw.dailyLossRiskReductionMultiplier ?? DEFAULT_CONFIG.risk.dailyLossRiskReductionMultiplier ?? 1),
    dailyLossCooldownMinutes: Number(raw.daily_loss_cooldown_minutes ?? raw.dailyLossCooldownMinutes ?? DEFAULT_CONFIG.risk.dailyLossCooldownMinutes ?? DEFAULT_CONFIG.risk.cooldownMinutes),
    dailyLossRecoveryWins: Number(raw.daily_loss_recovery_wins ?? raw.dailyLossRecoveryWins ?? DEFAULT_CONFIG.risk.dailyLossRecoveryWins ?? 0),
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

function cloneVolatilityProfileOverrides(
  overrides?: Record<string, QuantAIVolatilityProfileOverride>,
): Record<string, QuantAIVolatilityProfileOverride> | undefined {
  if (!overrides) return undefined;
  const cloned: Record<string, QuantAIVolatilityProfileOverride> = {};
  for (const [key, value] of Object.entries(overrides)) {
    cloned[key] = { ...value };
  }
  return Object.keys(cloned).length ? cloned : undefined;
}

function cloneSymbolOverrides(
  overrides?: Record<string, QuantAISymbolEntryFilterOverride>,
): Record<string, QuantAISymbolEntryFilterOverride> | undefined {
  if (!overrides) return undefined;
  const cloned: Record<string, QuantAISymbolEntryFilterOverride> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const symbolOverride: QuantAISymbolEntryFilterOverride = { ...value };
    if (value.volatilityProfileOverrides) {
      symbolOverride.volatilityProfileOverrides = cloneVolatilityProfileOverrides(
        value.volatilityProfileOverrides,
      );
    }
    cloned[key] = symbolOverride;
  }
  return Object.keys(cloned).length ? cloned : undefined;
}

function clonePlaybookOverrides(
  overrides?: Record<string, QuantAIPlaybookEntryFilterOverride>,
): Record<string, QuantAIPlaybookEntryFilterOverride> | undefined {
  if (!overrides) return undefined;
  const cloned: Record<string, QuantAIPlaybookEntryFilterOverride> = {};
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
  if (dynamic.directionalFilter) {
    cloned.directionalFilter = { ...dynamic.directionalFilter };
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
    volatilityProfileOverrides: cloneVolatilityProfileOverrides(defaults.volatilityProfileOverrides),
    symbolOverrides: cloneSymbolOverrides(defaults.symbolOverrides),
    playbookOverrides: clonePlaybookOverrides(defaults.playbookOverrides),
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

  const profileOverridesRaw = raw.volatility_profile_overrides ?? raw.volatilityProfileOverrides;
  if (profileOverridesRaw && typeof profileOverridesRaw === 'object') {
    cfg.volatilityProfileOverrides = cfg.volatilityProfileOverrides ? { ...cfg.volatilityProfileOverrides } : {};
    for (const [key, value] of Object.entries(profileOverridesRaw)) {
      if (!value || typeof value !== 'object') continue;
      const obj = value as Record<string, any>;
      const target: QuantAIVolatilityProfileOverride = { ...(cfg.volatilityProfileOverrides?.[key] ?? {}) };
      const minDollarVolume = normalizeOptionalNumber(obj['min_dollar_volume'] ?? obj['minDollarVolume']);
      if (minDollarVolume != null) target.minDollarVolume = minDollarVolume;
      const minAtrPct = normalizeOptionalNumber(obj['min_atr_pct'] ?? obj['minAtrPct']);
      if (minAtrPct != null) target.minAtrPct = minAtrPct;
      const maxAtrPct = normalizeOptionalNumber(obj['max_atr_pct'] ?? obj['maxAtrPct']);
      if (maxAtrPct != null) target.maxAtrPct = maxAtrPct;
      const minAdx = normalizeOptionalNumber(obj['min_adx'] ?? obj['minAdx']);
      if (minAdx != null) target.minAdx = minAdx;
      const spreadAtrRatioLimit = normalizeOptionalNumber(
        obj['spread_atr_ratio_limit'] ?? obj['spreadAtrRatioLimit'],
      );
      if (spreadAtrRatioLimit != null) target.spreadAtrRatioLimit = spreadAtrRatioLimit;
      if (Object.keys(target).length > 0) {
        cfg.volatilityProfileOverrides![key] = target;
      }
    }
  }
  if (cfg.volatilityProfileOverrides && Object.keys(cfg.volatilityProfileOverrides).length === 0) {
    cfg.volatilityProfileOverrides = undefined;
  }

  const symbolOverridesRaw = raw.symbol_overrides ?? raw.symbolOverrides;
  if (symbolOverridesRaw && typeof symbolOverridesRaw === 'object') {
    cfg.symbolOverrides = cfg.symbolOverrides ? { ...cfg.symbolOverrides } : {};
    for (const [key, value] of Object.entries(symbolOverridesRaw)) {
      if (!value || typeof value !== 'object') continue;
      const obj = value as Record<string, any>;
      const target: QuantAISymbolEntryFilterOverride = { ...(cfg.symbolOverrides?.[key] ?? {}) };
      const minAdx = normalizeOptionalNumber(obj['min_adx'] ?? obj['minAdx']);
      if (minAdx != null) target.minAdx = minAdx;
      const minDollarVolume = normalizeOptionalNumber(obj['min_dollar_volume'] ?? obj['minDollarVolume']);
      if (minDollarVolume != null) target.minDollarVolume = minDollarVolume;
      const minRr = normalizeOptionalNumber(obj['min_rr'] ?? obj['minRr']);
      if (minRr != null) target.minRr = minRr;
      const minAtrPct = normalizeOptionalNumber(obj['min_atr_pct'] ?? obj['minAtrPct']);
      if (minAtrPct != null) target.minAtrPct = minAtrPct;
      const maxSpreadBps = normalizeOptionalNumber(obj['max_spread_bps'] ?? obj['maxSpreadBps']);
      if (maxSpreadBps != null) target.maxSpreadBps = maxSpreadBps;
      const confidenceThreshold = normalizeOptionalNumber(
        obj['confidence_threshold'] ?? obj['confidenceThreshold'],
      );
      if (confidenceThreshold != null) target.confidenceThreshold = confidenceThreshold;
      if (obj['use_confidence_filter'] != null || obj['useConfidenceFilter'] != null) {
        target.useConfidenceFilter = Boolean(obj['use_confidence_filter'] ?? obj['useConfidenceFilter']);
      }
      const maxAtrPct = normalizeOptionalNumber(obj['max_atr_pct'] ?? obj['maxAtrPct']);
      if (maxAtrPct != null) target.maxAtrPct = maxAtrPct;
      const spreadAtrRatioLimit = normalizeOptionalNumber(
        obj['spread_atr_ratio_limit'] ?? obj['spreadAtrRatioLimit'],
      );
      if (spreadAtrRatioLimit != null) target.spreadAtrRatioLimit = spreadAtrRatioLimit;

      const symbolProfileOverrides = obj['volatility_profile_overrides'] ?? obj['volatilityProfileOverrides'];
      if (symbolProfileOverrides && typeof symbolProfileOverrides === 'object') {
        const dest = target.volatilityProfileOverrides ? { ...target.volatilityProfileOverrides } : {};
        for (const [profileKey, profileValue] of Object.entries(symbolProfileOverrides)) {
          if (!profileValue || typeof profileValue !== 'object') continue;
          const profileObj = profileValue as Record<string, any>;
          const profileTarget: QuantAIVolatilityProfileOverride = { ...(dest[profileKey] ?? {}) };
          const symMinDollar = normalizeOptionalNumber(
            profileObj['min_dollar_volume'] ?? profileObj['minDollarVolume'],
          );
          if (symMinDollar != null) profileTarget.minDollarVolume = symMinDollar;
          const symMinAtr = normalizeOptionalNumber(profileObj['min_atr_pct'] ?? profileObj['minAtrPct']);
          if (symMinAtr != null) profileTarget.minAtrPct = symMinAtr;
          const symMaxAtr = normalizeOptionalNumber(profileObj['max_atr_pct'] ?? profileObj['maxAtrPct']);
          if (symMaxAtr != null) profileTarget.maxAtrPct = symMaxAtr;
          const symMinAdx = normalizeOptionalNumber(profileObj['min_adx'] ?? profileObj['minAdx']);
          if (symMinAdx != null) profileTarget.minAdx = symMinAdx;
          const symSpreadLimit = normalizeOptionalNumber(
            profileObj['spread_atr_ratio_limit'] ?? profileObj['spreadAtrRatioLimit'],
          );
          if (symSpreadLimit != null) profileTarget.spreadAtrRatioLimit = symSpreadLimit;
          if (Object.keys(profileTarget).length > 0) {
            dest[profileKey] = profileTarget;
          }
        }
        target.volatilityProfileOverrides = Object.keys(dest).length ? dest : undefined;
      }

      if (Object.keys(target).length > 0) {
        cfg.symbolOverrides![key] = target;
      }
    }
  }
  if (cfg.symbolOverrides && Object.keys(cfg.symbolOverrides).length === 0) {
    cfg.symbolOverrides = undefined;
  }

  const playbookOverridesRaw = raw.playbook_overrides ?? raw.playbookOverrides;
  if (playbookOverridesRaw && typeof playbookOverridesRaw === 'object') {
    cfg.playbookOverrides = cfg.playbookOverrides ? { ...cfg.playbookOverrides } : {};
    for (const [key, value] of Object.entries(playbookOverridesRaw)) {
      if (!value || typeof value !== 'object') continue;
      const obj = value as Record<string, any>;
      const target: QuantAIPlaybookEntryFilterOverride = { ...(cfg.playbookOverrides?.[key] ?? {}) };
      const minAdx = normalizeOptionalNumber(obj['min_adx'] ?? obj['minAdx']);
      if (minAdx != null) target.minAdx = minAdx;
      const minDollarVolume = normalizeOptionalNumber(obj['min_dollar_volume'] ?? obj['minDollarVolume']);
      if (minDollarVolume != null) target.minDollarVolume = minDollarVolume;
      const minRr = normalizeOptionalNumber(obj['min_rr'] ?? obj['minRr']);
      if (minRr != null) target.minRr = minRr;
      const minAtrPct = normalizeOptionalNumber(obj['min_atr_pct'] ?? obj['minAtrPct']);
      if (minAtrPct != null) target.minAtrPct = minAtrPct;
      const maxSpreadBps = normalizeOptionalNumber(obj['max_spread_bps'] ?? obj['maxSpreadBps']);
      if (maxSpreadBps != null) target.maxSpreadBps = maxSpreadBps;
      const confidenceThreshold = normalizeOptionalNumber(obj['confidence_threshold'] ?? obj['confidenceThreshold']);
      if (confidenceThreshold != null) target.confidenceThreshold = confidenceThreshold;
      if (obj['use_confidence_filter'] != null || obj['useConfidenceFilter'] != null) {
        target.useConfidenceFilter = Boolean(obj['use_confidence_filter'] ?? obj['useConfidenceFilter']);
      }
      const maxAtrPctOverride = normalizeOptionalNumber(obj['max_atr_pct'] ?? obj['maxAtrPct']);
      if (maxAtrPctOverride != null) target.maxAtrPct = maxAtrPctOverride;
      const spreadLimit = normalizeOptionalNumber(obj['spread_atr_ratio_limit'] ?? obj['spreadAtrRatioLimit']);
      if (spreadLimit != null) target.spreadAtrRatioLimit = spreadLimit;
      if (Object.keys(target).length > 0) {
        cfg.playbookOverrides![key] = target;
      }
    }
  }
  if (cfg.playbookOverrides && Object.keys(cfg.playbookOverrides).length === 0) {
    cfg.playbookOverrides = undefined;
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
    const momentumRaw = (dynamicRaw as Record<string, any>)['momentum_fast_track']
      ?? (dynamicRaw as Record<string, any>)['momentumFastTrack'];
    if (momentumRaw && typeof momentumRaw === 'object') {
      const base = cfg.dynamic!.momentumFastTrack
        ?? defaults.dynamic?.momentumFastTrack
        ?? DEFAULT_DYNAMIC_FILTERS.momentumFastTrack
        ?? {};
      const next: NonNullable<QuantAIEntryFilterDynamicConfig['momentumFastTrack']> = { ...base };
      if (momentumRaw.enabled != null) next.enabled = Boolean(momentumRaw.enabled);
      const numericFields: Array<[keyof NonNullable<QuantAIEntryFilterDynamicConfig['momentumFastTrack']>, any]> = [
        ['minAdx', momentumRaw.min_adx ?? momentumRaw.minAdx],
        ['minVolumeRatio', momentumRaw.min_volume_ratio ?? momentumRaw.minVolumeRatio],
        ['minSlopePct', momentumRaw.min_slope_pct ?? momentumRaw.minSlopePct],
        ['minCmf', momentumRaw.min_cmf ?? momentumRaw.minCmf],
        ['minWeightedRr', momentumRaw.min_weighted_rr ?? momentumRaw.minWeightedRr],
        ['minRr', momentumRaw.min_rr ?? momentumRaw.minRr],
        ['rrFloor', momentumRaw.rr_floor ?? momentumRaw.rrFloor],
        ['minAtrPct', momentumRaw.min_atr_pct ?? momentumRaw.minAtrPct],
        ['nearThresholdFactor', momentumRaw.near_threshold_factor ?? momentumRaw.nearThresholdFactor],
      ];
      for (const [key, rawVal] of numericFields) {
        const num = normalizeOptionalNumber(rawVal);
        if (num != null) (next as any)[key] = num;
      }
      cfg.dynamic!.momentumFastTrack = next;
    }
    const directionalRaw = (dynamicRaw as Record<string, any>)['directional_filter']
      ?? (dynamicRaw as Record<string, any>)['directionalFilter'];
    if (directionalRaw && typeof directionalRaw === 'object') {
      const baseFilter = cfg.dynamic!.directionalFilter
        ?? defaults.dynamic?.directionalFilter
        ?? DEFAULT_DYNAMIC_FILTERS.directionalFilter;
      const next: QuantAIDirectionalFilterConfig = baseFilter ? { ...baseFilter } : {};
      if (directionalRaw.enabled != null) next.enabled = Boolean(directionalRaw.enabled);
      const numericFields: Array<[keyof QuantAIDirectionalFilterConfig, any]> = [
        ['trendAdx', directionalRaw.trend_adx ?? directionalRaw.trendAdx],
        ['rangeAdx', directionalRaw.range_adx ?? directionalRaw.rangeAdx],
        ['minDiTrend', directionalRaw.min_di_trend ?? directionalRaw.minDiTrend],
        ['minDiRange', directionalRaw.min_di_range ?? directionalRaw.minDiRange],
        ['minDiStrong', directionalRaw.min_di_strong ?? directionalRaw.minDiStrong],
        ['minRsiTrend', directionalRaw.min_rsi_trend ?? directionalRaw.minRsiTrend],
        ['maxRsiTrend', directionalRaw.max_rsi_trend ?? directionalRaw.maxRsiTrend],
        ['rangeNeutralBand', directionalRaw.range_neutral_band ?? directionalRaw.rangeNeutralBand],
      ];
      for (const [key, rawVal] of numericFields) {
        const num = normalizeOptionalNumber(rawVal);
        if (num != null) (next as any)[key] = num;
      }
      if (directionalRaw.require_di_signal != null || directionalRaw.requireDiSignal != null) {
        next.requireDiSignal = Boolean(directionalRaw.require_di_signal ?? directionalRaw.requireDiSignal);
      }
      cfg.dynamic!.directionalFilter = next;
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
  const minStopAtrMult = normalizeOptionalNumber(raw.min_stop_atr_mult ?? raw.minStopAtrMult)
    ?? DEFAULT_CONFIG.exits.minStopAtrMult
    ?? 0;
  const profitLockDefaults = DEFAULT_CONFIG.exits.profitLock ?? {
    minRMultiple: 1,
    allowPartialBeforeMinR: false,
    preLockTrailMultiplier: 0.8,
    preLockMinRMultiple: 0.35,
    minHoldBypassRMultiple: 0.5,
    breakevenOffsetR: 0,
  };
  const profitLockRaw = (raw.profit_lock ?? raw.profitLock) && typeof (raw.profit_lock ?? raw.profitLock) === 'object'
    ? (raw.profit_lock ?? raw.profitLock)
    : undefined;
  const profitLock = profitLockDefaults
    ? {
        minRMultiple: normalizeOptionalNumber(profitLockRaw?.min_r_multiple ?? profitLockRaw?.minRMultiple) ?? profitLockDefaults.minRMultiple,
        allowPartialBeforeMinR: profitLockRaw?.allow_partial_before_min_r != null
          ? Boolean(profitLockRaw.allow_partial_before_min_r)
          : profitLockRaw?.allowPartialBeforeMinR != null
            ? Boolean(profitLockRaw.allowPartialBeforeMinR)
            : profitLockDefaults.allowPartialBeforeMinR ?? false,
        preLockTrailMultiplier: normalizeOptionalNumber(
          profitLockRaw?.pre_lock_trail_multiplier ?? profitLockRaw?.preLockTrailMultiplier,
        ) ?? profitLockDefaults.preLockTrailMultiplier,
        preLockMinRMultiple: normalizeOptionalNumber(
          profitLockRaw?.pre_lock_min_r_multiple ?? profitLockRaw?.preLockMinRMultiple,
        ) ?? profitLockDefaults.preLockMinRMultiple,
        minHoldBypassRMultiple: normalizeOptionalNumber(
          profitLockRaw?.min_hold_bypass_r_multiple ?? profitLockRaw?.minHoldBypassRMultiple,
        ) ?? profitLockDefaults.minHoldBypassRMultiple,
        breakevenOffsetR: normalizeOptionalNumber(
          profitLockRaw?.breakeven_offset_r ?? profitLockRaw?.breakevenOffsetR,
        ) ?? profitLockDefaults.breakevenOffsetR,
      }
    : undefined;
  const volatilityDefaults = DEFAULT_CONFIG.exits.volatilityExit ?? { atrPctSpikeThreshold: 0.35, widenMultiplier: 1.25 };
  const volatilityRaw = (raw.volatility_exit ?? raw.volatilityExit) && typeof (raw.volatility_exit ?? raw.volatilityExit) === 'object'
    ? (raw.volatility_exit ?? raw.volatilityExit)
    : undefined;
  const volatilityExit = volatilityDefaults
    ? {
        atrPctSpikeThreshold: normalizeOptionalNumber(
          volatilityRaw?.atr_pct_spike_threshold ?? volatilityRaw?.atrPctSpikeThreshold,
        ) ?? volatilityDefaults.atrPctSpikeThreshold,
        widenMultiplier: normalizeOptionalNumber(
          volatilityRaw?.widen_multiplier ?? volatilityRaw?.widenMultiplier,
        ) ?? volatilityDefaults.widenMultiplier,
      }
    : undefined;
  const percentLockDefaults = DEFAULT_CONFIG.exits.percentGainLock ?? {
    enabled: false,
    activationGainPct: 0.01,
    lockFraction: 0.7,
    minGainStepPct: 0,
  };
  const percentLockRaw = (raw.percent_gain_lock ?? raw.percentGainLock) && typeof (raw.percent_gain_lock ?? raw.percentGainLock) === 'object'
    ? (raw.percent_gain_lock ?? raw.percentGainLock)
    : undefined;
  const normalizePercentDecimal = (value: any, fallback: number): number => {
    const parsed = normalizeOptionalNumber(value);
    if (parsed == null) return fallback;
    if (!Number.isFinite(parsed)) return fallback;
    const decimal = parsed > 1 ? parsed / 100 : parsed;
    if (!Number.isFinite(decimal) || decimal < 0) {
      return fallback;
    }
    return decimal;
  };
  const percentGainLock = percentLockDefaults
    ? {
        enabled: percentLockRaw?.enabled != null ? Boolean(percentLockRaw.enabled) : percentLockDefaults.enabled,
        activationGainPct: normalizePercentDecimal(
          percentLockRaw?.activation_gain_pct ?? percentLockRaw?.activationGainPct,
          percentLockDefaults.activationGainPct,
        ),
        lockFraction: (() => {
          const rawValue = normalizeOptionalNumber(
            percentLockRaw?.lock_fraction ?? percentLockRaw?.lockFraction,
          );
          if (rawValue == null) return percentLockDefaults.lockFraction;
          const decimal = rawValue > 1 ? rawValue / 100 : rawValue;
          if (!Number.isFinite(decimal)) return percentLockDefaults.lockFraction;
          return Math.min(Math.max(decimal, 0), 1);
        })(),
        minGainStepPct: (() => {
          const rawValue = percentLockRaw?.min_gain_step_pct ?? percentLockRaw?.minGainStepPct;
          if (rawValue == null) return percentLockDefaults.minGainStepPct;
          const decimal = normalizePercentDecimal(rawValue, percentLockDefaults.minGainStepPct ?? 0);
          return Math.max(0, decimal);
        })(),
      }
    : undefined;
  const peakDrawdownDefaults = DEFAULT_CONFIG.exits.peakDrawdown ?? { enabled: true, thresholds: { 1.0: 0.05, 2.0: 0.04, 3.0: 0.03, 5.0: 0.02 } };
  const peakDrawdownRaw = (raw.peak_drawdown ?? raw.peakDrawdown) && typeof (raw.peak_drawdown ?? raw.peakDrawdown) === 'object'
    ? (raw.peak_drawdown ?? raw.peakDrawdown)
    : undefined;
  const peakDrawdown: QuantAIPeakDrawdownConfig | undefined = peakDrawdownDefaults
    ? {
        enabled: peakDrawdownRaw?.enabled != null ? Boolean(peakDrawdownRaw.enabled) : peakDrawdownDefaults.enabled,
        thresholds: (() => {
          const thresholdsRaw = peakDrawdownRaw?.thresholds;
          if (thresholdsRaw && typeof thresholdsRaw === 'object') {
            const result: Record<number, number> = {};
            for (const [key, value] of Object.entries(thresholdsRaw)) {
              const rKey = Number(key);
              const threshold = normalizeOptionalNumber(value);
              if (Number.isFinite(rKey) && threshold != null && threshold > 0 && threshold < 1) {
                result[rKey] = threshold;
              }
            }
            return Object.keys(result).length > 0 ? result : peakDrawdownDefaults.thresholds;
          }
          return peakDrawdownDefaults.thresholds;
        })(),
      }
    : undefined;
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
  const minHoldMinutes = Number(
    earlyExitRaw.min_hold_minutes ??
    earlyExitRaw.minHoldMinutes ??
    DEFAULT_CONFIG.exits.earlyExit.minHoldMinutes ??
    0,
  );
  const maxHoldingRaw = raw.max_holding_min ?? raw.maxHoldingMin;
  const maxHolding = maxHoldingRaw != null
    ? Number(maxHoldingRaw)
    : DEFAULT_CONFIG.exits.maxHoldingMin;
  const reentryCooldownRaw = raw.reentry_cooldown_min ?? raw.reentryCooldownMin;
  const reentryCooldown = reentryCooldownRaw != null
    ? Number(reentryCooldownRaw)
    : (DEFAULT_CONFIG.exits.reentryCooldownMin ?? 0);
  const tpRaw: number[] = Array.isArray(raw.tp_r_multiples ?? raw.tpRMultiples)
    ? (raw.tp_r_multiples ?? raw.tpRMultiples).map((v: any) => Number(v)).filter((v: number) => Number.isFinite(v) && v > 0)
    : DEFAULT_CONFIG.exits.tpRMultiples;
  const tpMultiples: number[] = [];
  const uniqueTpValues = Array.from(new Set<number>(tpRaw));
  const minAllowedTp = Math.min(1.1, ...DEFAULT_CONFIG.exits.tpRMultiples);
  const maxAllowedTp = Math.max(4.2, ...DEFAULT_CONFIG.exits.tpRMultiples);
  for (const value of uniqueTpValues.sort((a, b) => a - b)) {
    if (tpMultiples.length >= 3) break;
    const clamped = Math.min(Math.max(value, minAllowedTp), maxAllowedTp);
    const last = tpMultiples[tpMultiples.length - 1];
    if (last == null || Math.abs(clamped - last) >= 0.2) {
      tpMultiples.push(clamped);
    }
  }

  const trailingAdaptiveRaw = raw.trailing_adaptive ?? raw.trailingAdaptive;
  let trailingAdaptive: QuantAITrailingAdaptiveConfig | undefined = DEFAULT_CONFIG.exits.trailingAdaptive
    ? { ...DEFAULT_CONFIG.exits.trailingAdaptive }
    : undefined;
  if (trailingAdaptiveRaw && typeof trailingAdaptiveRaw === 'object') {
    trailingAdaptive = trailingAdaptive ?? {};
    const modeRaw = (trailingAdaptiveRaw as Record<string, any>)['mode']
      ?? (trailingAdaptiveRaw as Record<string, any>)['trail_mode'];
    if (modeRaw != null) {
      const normalized = String(modeRaw).toLowerCase();
      trailingAdaptive.mode = normalized === 'percent' ? 'percent' : 'atr';
    }
    const percentRaw = (trailingAdaptiveRaw as Record<string, any>)['percent']
      ?? (trailingAdaptiveRaw as Record<string, any>)['percentTrail']
      ?? (trailingAdaptiveRaw as Record<string, any>)['percentage'];
    const percentVal = normalizeOptionalNumber(percentRaw);
    if (percentVal != null) trailingAdaptive.percent = percentVal;
    const clampRaw = (trailingAdaptiveRaw as Record<string, any>)['clamp_multiplier']
      ?? (trailingAdaptiveRaw as Record<string, any>)['clampMultiplier'];
    if (clampRaw && typeof clampRaw === 'object') {
      const baseClamp = trailingAdaptive.clampMultiplier ?? {};
      const minVal = normalizeOptionalNumber((clampRaw as Record<string, any>)['min']);
      const maxVal = normalizeOptionalNumber((clampRaw as Record<string, any>)['max']);
      trailingAdaptive.clampMultiplier = {
        ...(baseClamp ?? {}),
        ...(minVal != null ? { min: minVal } : {}),
        ...(maxVal != null ? { max: maxVal } : {}),
      };
    }
    const bandsRaw = (trailingAdaptiveRaw as Record<string, any>)['atr_bands']
      ?? (trailingAdaptiveRaw as Record<string, any>)['atrBands']
      ?? (trailingAdaptiveRaw as Record<string, any>)['bands'];
    if (bandsRaw && typeof bandsRaw === 'object') {
      const baseBands = trailingAdaptive.atrBands
        ?? DEFAULT_CONFIG.exits.trailingAdaptive?.atrBands
        ?? null;
      const nextBands: QuantAITrailingAtrBands = baseBands ? { ...baseBands } : {
        low: 1,
        high: 3,
        lowMultiplier: 1,
        highMultiplier: 1,
      };
      const lowVal = normalizeOptionalNumber((bandsRaw as Record<string, any>)['low']);
      if (lowVal != null) nextBands.low = lowVal;
      const highVal = normalizeOptionalNumber((bandsRaw as Record<string, any>)['high']);
      if (highVal != null) nextBands.high = highVal;
      const extremeVal = normalizeOptionalNumber((bandsRaw as Record<string, any>)['extreme']);
      if (extremeVal != null) nextBands.extreme = extremeVal;
      const lowMult = normalizeOptionalNumber((bandsRaw as Record<string, any>)['low_multiplier'] ?? (bandsRaw as Record<string, any>)['lowMultiplier']);
      if (lowMult != null) nextBands.lowMultiplier = lowMult;
      const midMult = normalizeOptionalNumber((bandsRaw as Record<string, any>)['mid_multiplier'] ?? (bandsRaw as Record<string, any>)['midMultiplier']);
      if (midMult != null) nextBands.midMultiplier = midMult;
      const highMult = normalizeOptionalNumber((bandsRaw as Record<string, any>)['high_multiplier'] ?? (bandsRaw as Record<string, any>)['highMultiplier']);
      if (highMult != null) nextBands.highMultiplier = highMult;
      const extremeMult = normalizeOptionalNumber((bandsRaw as Record<string, any>)['extreme_multiplier'] ?? (bandsRaw as Record<string, any>)['extremeMultiplier']);
      if (extremeMult != null) nextBands.extremeMultiplier = extremeMult;
      trailingAdaptive.atrBands = nextBands;
    }
  }

  const enforceHardMinHoldRaw = raw.enforce_hard_min_hold ?? raw.enforceHardMinHold;
  const enforceHardMinHold = enforceHardMinHoldRaw != null
    ? Boolean(enforceHardMinHoldRaw)
    : Boolean(DEFAULT_CONFIG.exits.enforceHardMinHold ?? false);
  const exitOnBarCloseRaw = raw.exit_on_bar_close ?? raw.exitOnBarClose;
  const exitOnBarClose = exitOnBarCloseRaw != null
    ? Boolean(exitOnBarCloseRaw)
    : Boolean(DEFAULT_CONFIG.exits.exitOnBarClose ?? false);
  const trailingPriceSourceRaw = raw.trailing_price_source ?? raw.trailingPriceSource ?? DEFAULT_CONFIG.exits.trailingPriceSource ?? 'last';
  const trailingPriceSourceNormalized = String(trailingPriceSourceRaw || '').toLowerCase();
  const trailingPriceSource: QuantAIExitConfig['trailingPriceSource'] =
    trailingPriceSourceNormalized === 'mid'
      ? 'mid'
      : trailingPriceSourceNormalized === 'bid'
        ? 'bid'
        : trailingPriceSourceNormalized === 'ask'
          ? 'ask'
          : 'last';
  const slipTicks = normalizeOptionalNumber(raw.slip_ticks ?? raw.slipTicks)
    ?? DEFAULT_CONFIG.exits.slipTicks
    ?? 0;

  const cfg: QuantAIExitConfig = {
    atrPeriod: Number(raw.atr_period ?? raw.atrPeriod ?? DEFAULT_CONFIG.exits.atrPeriod),
    slAtrMult: slBase,
    slAtrMultReversal: slReversal,
    slAtrMultImpulse: slImpulse,
    tpRMultiples: tpMultiples.length ? tpMultiples : DEFAULT_CONFIG.exits.tpRMultiples,
    trailAfterR: trailBase,
    trailAfterRReversal: trailReversal,
    trailAfterRImpulse: trailImpulse,
    trailAtrMult: Number(raw.trail_atr_mult ?? raw.trailAtrMult ?? DEFAULT_CONFIG.exits.trailAtrMult),
    trailingAdaptive,
    minStopAtrMult,
    profitLock,
    volatilityExit,
    percentGainLock,
    peakDrawdown,
    earlyExit: {
      adxBelow: Number(earlyExitRaw.adx_below ?? earlyExitRaw.adxBelow ?? DEFAULT_CONFIG.exits.earlyExit.adxBelow),
      cmfNegative: Boolean(earlyExitRaw.cmf_negative ?? earlyExitRaw.cmfNegative ?? DEFAULT_CONFIG.exits.earlyExit.cmfNegative),
      tightenProfitR,
      cutLossR,
      tightenOnlyIfProfitGtR: tightenProfitR,
      cutIfLossGtR: cutLossR,
      minHoldMinutes: Number.isFinite(minHoldMinutes)
        ? Math.max(0, minHoldMinutes)
        : DEFAULT_CONFIG.exits.earlyExit.minHoldMinutes,
    },
    maxHoldingMin: Number.isFinite(maxHolding) ? maxHolding : DEFAULT_CONFIG.exits.maxHoldingMin,
    reentryCooldownMin: Number.isFinite(reentryCooldown)
      ? Math.max(0, Number(reentryCooldown))
      : (DEFAULT_CONFIG.exits.reentryCooldownMin ?? 0),
    enforceHardMinHold,
    exitOnBarClose,
    trailingPriceSource,
    slipTicks,
    strategyOverrides: undefined,
  };

  const normalizeExitOverride = (value: any): QuantAIExitOverride | null => {
    if (!value || typeof value !== 'object') return null;
    const out: QuantAIExitOverride = {};
    const sl = normalizeOptionalNumber(value.sl_atr_mult ?? value.slAtrMult);
    if (sl != null) out.slAtrMult = sl;
    const slRev = normalizeOptionalNumber(value.sl_atr_mult_reversal ?? value.slAtrMultReversal);
    if (slRev != null) out.slAtrMultReversal = slRev;
    const slImp = normalizeOptionalNumber(value.sl_atr_mult_impulse ?? value.slAtrMultImpulse);
    if (slImp != null) out.slAtrMultImpulse = slImp;
    const trail = normalizeOptionalNumber(value.trail_after_r ?? value.trailAfterR);
    if (trail != null) out.trailAfterR = trail;
    const trailRev = normalizeOptionalNumber(value.trail_after_r_reversal ?? value.trailAfterRReversal);
    if (trailRev != null) out.trailAfterRReversal = trailRev;
    const trailImp = normalizeOptionalNumber(value.trail_after_r_impulse ?? value.trailAfterRImpulse);
    if (trailImp != null) out.trailAfterRImpulse = trailImp;
    const trailAtr = normalizeOptionalNumber(value.trail_atr_mult ?? value.trailAtrMult);
    if (trailAtr != null) out.trailAtrMult = trailAtr;
    const minStop = normalizeOptionalNumber(value.min_stop_atr_mult ?? value.minStopAtrMult);
    if (minStop != null) out.minStopAtrMult = minStop;
    if (value.enforce_hard_min_hold != null || value.enforceHardMinHold != null) {
      out.enforceHardMinHold = Boolean(value.enforce_hard_min_hold ?? value.enforceHardMinHold);
    }
    if (value.exit_on_bar_close != null || value.exitOnBarClose != null) {
      out.exitOnBarClose = Boolean(value.exit_on_bar_close ?? value.exitOnBarClose);
    }
    const overridePriceSourceRaw = value.trailing_price_source ?? value.trailingPriceSource;
    if (overridePriceSourceRaw != null) {
      const normalized = String(overridePriceSourceRaw).toLowerCase();
      if (normalized === 'mid' || normalized === 'bid' || normalized === 'ask' || normalized === 'last') {
        out.trailingPriceSource = normalized as QuantAIExitOverride['trailingPriceSource'];
      }
    }
    const overrideSlipTicks = normalizeOptionalNumber(value.slip_ticks ?? value.slipTicks);
    if (overrideSlipTicks != null) out.slipTicks = overrideSlipTicks;
    const profitLockOverride = value.profit_lock ?? value.profitLock;
    if (profitLockOverride && typeof profitLockOverride === 'object') {
      const pl: NonNullable<QuantAIExitOverride['profitLock']> = {};
      const minR = normalizeOptionalNumber(profitLockOverride.min_r_multiple ?? profitLockOverride.minRMultiple);
      if (minR != null) pl.minRMultiple = minR;
      if (profitLockOverride.allow_partial_before_min_r != null) {
        pl.allowPartialBeforeMinR = Boolean(profitLockOverride.allow_partial_before_min_r);
      } else if (profitLockOverride.allowPartialBeforeMinR != null) {
        pl.allowPartialBeforeMinR = Boolean(profitLockOverride.allowPartialBeforeMinR);
      }
      const preLockTrail = normalizeOptionalNumber(
        profitLockOverride.pre_lock_trail_multiplier ?? profitLockOverride.preLockTrailMultiplier,
      );
      if (preLockTrail != null) pl.preLockTrailMultiplier = preLockTrail;
      const preLockMinR = normalizeOptionalNumber(
        profitLockOverride.pre_lock_min_r_multiple ?? profitLockOverride.preLockMinRMultiple,
      );
      if (preLockMinR != null) pl.preLockMinRMultiple = preLockMinR;
      const bypassR = normalizeOptionalNumber(
        profitLockOverride.min_hold_bypass_r_multiple ?? profitLockOverride.minHoldBypassRMultiple,
      );
      if (bypassR != null) pl.minHoldBypassRMultiple = bypassR;
      const breakevenOffset = normalizeOptionalNumber(
        profitLockOverride.breakeven_offset_r ?? profitLockOverride.breakevenOffsetR,
      );
      if (breakevenOffset != null) pl.breakevenOffsetR = breakevenOffset;
      if (Object.keys(pl).length) out.profitLock = pl;
    }
    const volatilityOverride = value.volatility_exit ?? value.volatilityExit;
    if (volatilityOverride && typeof volatilityOverride === 'object') {
      const vol: NonNullable<QuantAIExitOverride['volatilityExit']> = {};
      const spike = normalizeOptionalNumber(
        volatilityOverride.atr_pct_spike_threshold ?? volatilityOverride.atrPctSpikeThreshold,
      );
      if (spike != null) vol.atrPctSpikeThreshold = spike;
      const widen = normalizeOptionalNumber(
        volatilityOverride.widen_multiplier ?? volatilityOverride.widenMultiplier,
      );
      if (widen != null) vol.widenMultiplier = widen;
      if (Object.keys(vol).length) out.volatilityExit = vol;
    }
    const percentLockOverride = value.percent_gain_lock ?? value.percentGainLock;
    if (percentLockOverride && typeof percentLockOverride === 'object') {
      const plock: NonNullable<QuantAIExitOverride['percentGainLock']> = {};
      if (percentLockOverride.enabled != null) {
        plock.enabled = Boolean(percentLockOverride.enabled);
      }
      const activation = normalizeOptionalNumber(
        percentLockOverride.activation_gain_pct ?? percentLockOverride.activationGainPct,
      );
      if (activation != null) {
        plock.activationGainPct = activation > 1 ? activation / 100 : activation;
      }
      const lockFraction = normalizeOptionalNumber(
        percentLockOverride.lock_fraction ?? percentLockOverride.lockFraction,
      );
      if (lockFraction != null) {
        const decimal = lockFraction > 1 ? lockFraction / 100 : lockFraction;
        plock.lockFraction = Math.min(Math.max(decimal, 0), 1);
      }
      const minStep = normalizeOptionalNumber(
        percentLockOverride.min_gain_step_pct ?? percentLockOverride.minGainStepPct,
      );
      if (minStep != null) {
        const decimal = minStep > 1 ? minStep / 100 : minStep;
        plock.minGainStepPct = Math.max(0, decimal);
      }
      if (Object.keys(plock).length) out.percentGainLock = plock;
    }
    const maxHold = normalizeOptionalNumber(value.max_holding_min ?? value.maxHoldingMin);
    if (maxHold != null) out.maxHoldingMin = maxHold;
    const reentry = normalizeOptionalNumber(value.reentry_cooldown_min ?? value.reentryCooldownMin);
    if (reentry != null) out.reentryCooldownMin = reentry;
    const tpOverrideRaw = value.tp_r_multiples ?? value.tpRMultiples;
    if (Array.isArray(tpOverrideRaw)) {
      const parsed = tpOverrideRaw
        .map((v: any) => Number(v))
        .filter((v: number) => Number.isFinite(v) && v > 0);
      if (parsed.length) out.tpRMultiples = parsed;
    }

    const earlyRaw = value.early_exit ?? value.earlyExit;
    if (earlyRaw && typeof earlyRaw === 'object') {
      const early: QuantAIExitOverride['earlyExit'] = {};
      const adx = normalizeOptionalNumber(earlyRaw.adx_below ?? earlyRaw.adxBelow);
      if (adx != null) early.adxBelow = adx;
      if (earlyRaw.cmf_negative != null || earlyRaw.cmfNegative != null) {
        const cmfVal = earlyRaw.cmf_negative ?? earlyRaw.cmfNegative;
        if (typeof cmfVal === 'boolean') early.cmfNegative = cmfVal;
        else if (typeof cmfVal === 'string') early.cmfNegative = cmfVal.trim().toLowerCase() !== 'false';
        else if (typeof cmfVal === 'number') early.cmfNegative = cmfVal !== 0;
      }
      const tighten = normalizeOptionalNumber(
        earlyRaw.tighten_profit_r ?? earlyRaw.tightenProfitR ?? earlyRaw.tighten_only_if_profit_gt_r ?? earlyRaw.tightenOnlyIfProfitGtR,
      );
      if (tighten != null) early.tightenProfitR = tighten;
      const cut = normalizeOptionalNumber(earlyRaw.cut_loss_r ?? earlyRaw.cutLossR ?? earlyRaw.cut_if_loss_gt_r ?? earlyRaw.cutIfLossGtR);
      if (cut != null) early.cutLossR = cut;
      const tightenOnly = normalizeOptionalNumber(earlyRaw.tighten_only_if_profit_gt_r ?? earlyRaw.tightenOnlyIfProfitGtR);
      if (tightenOnly != null) early.tightenOnlyIfProfitGtR = tightenOnly;
      const cutOnly = normalizeOptionalNumber(earlyRaw.cut_if_loss_gt_r ?? earlyRaw.cutIfLossGtR);
      if (cutOnly != null) early.cutIfLossGtR = cutOnly;
      const hold = normalizeOptionalNumber(earlyRaw.min_hold_minutes ?? earlyRaw.minHoldMinutes);
      if (hold != null) early.minHoldMinutes = hold;
      if (Object.keys(early).length) out.earlyExit = early;
    }

    const trailingRaw = value.trailing_adaptive ?? value.trailingAdaptive;
    if (trailingRaw && typeof trailingRaw === 'object') {
      const trailing: any = {};
      const modeVal = trailingRaw.mode ?? trailingRaw.trail_mode ?? trailingRaw.trailMode;
      if (modeVal != null) {
        const normalized = String(modeVal).toLowerCase();
        trailing.mode = normalized === 'percent' ? 'percent' : 'atr';
      }
      const percentVal = normalizeOptionalNumber(trailingRaw.percent ?? trailingRaw.percentTrail ?? trailingRaw.percentage);
      if (percentVal != null) trailing.percent = percentVal;
      const clampRaw = trailingRaw.clamp_multiplier ?? trailingRaw.clampMultiplier;
      if (clampRaw && typeof clampRaw === 'object') {
        const clamp: { min?: number; max?: number } = {};
        const minClamp = normalizeOptionalNumber(clampRaw.min);
        if (minClamp != null) clamp.min = minClamp;
        const maxClamp = normalizeOptionalNumber(clampRaw.max);
        if (maxClamp != null) clamp.max = maxClamp;
        if (Object.keys(clamp).length) trailing.clampMultiplier = clamp;
      }
      const bandsRaw = trailingRaw.atr_bands ?? trailingRaw.atrBands ?? trailingRaw.bands;
      if (bandsRaw && typeof bandsRaw === 'object') {
        const bands: Partial<QuantAITrailingAtrBands> = {};
        const low = normalizeOptionalNumber(bandsRaw.low);
        if (low != null) bands.low = low;
        const high = normalizeOptionalNumber(bandsRaw.high);
        if (high != null) bands.high = high;
        const extreme = normalizeOptionalNumber(bandsRaw.extreme);
        if (extreme != null) bands.extreme = extreme;
        const lowMult = normalizeOptionalNumber(bandsRaw.low_multiplier ?? bandsRaw.lowMultiplier);
        if (lowMult != null) bands.lowMultiplier = lowMult;
        const midMult = normalizeOptionalNumber(bandsRaw.mid_multiplier ?? bandsRaw.midMultiplier);
        if (midMult != null) bands.midMultiplier = midMult;
        const highMult = normalizeOptionalNumber(bandsRaw.high_multiplier ?? bandsRaw.highMultiplier);
        if (highMult != null) bands.highMultiplier = highMult;
        const extMult = normalizeOptionalNumber(bandsRaw.extreme_multiplier ?? bandsRaw.extremeMultiplier);
        if (extMult != null) bands.extremeMultiplier = extMult;
        if (Object.keys(bands).length) trailing.atrBands = bands;
      }
      if (Object.keys(trailing).length) out.trailingAdaptive = trailing;
    }

    return Object.keys(out).length ? out : null;
  };

  const strategyOverridesRaw = raw.strategy_overrides ?? raw.strategyOverrides;
  if (strategyOverridesRaw && typeof strategyOverridesRaw === 'object') {
    const overrides: Record<string, QuantAIExitOverride> = {};
    for (const [key, value] of Object.entries(strategyOverridesRaw)) {
      const normalized = normalizeExitOverride(value);
      if (normalized) overrides[key.toLowerCase()] = normalized;
    }
    if (Object.keys(overrides).length) {
      cfg.strategyOverrides = overrides;
    }
  }

  return cfg;
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
