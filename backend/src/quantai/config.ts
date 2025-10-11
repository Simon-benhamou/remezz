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

export type QuantAIEntryFilterConfig = {
  minAdx: number;
  minDollarVolume: number;
  minRr: number;
  minAtrPct: number;
  maxSpreadBps: number;
  confidenceThreshold: number;
  useConfidenceFilter: boolean;
};

export type QuantAIExitConfig = {
  atrPeriod: number;
  slAtrMult: number;
  tpRMultiples: number[];
  trailAfterR: number;
  trailAtrMult: number;
  earlyExit: {
    adxBelow: number;
    cmfNegative: boolean;
    tightenOnlyIfProfitGtR: number;
    cutIfLossGtR: number;
  };
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
    dailyTradeLimit: 7,
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
    minAdx: 18,
    minDollarVolume: 500_000,
    minRr: 1.3,
    minAtrPct: 0.2,
    maxSpreadBps: 8,
    confidenceThreshold: 0.58,
    useConfidenceFilter: true,
  },
  exits: {
    atrPeriod: 14,
    slAtrMult: 1.5,
    tpRMultiples: [0.5, 1.0, 2.0],
    trailAfterR: 1.0,
    trailAtrMult: 1.0,
    earlyExit: {
      adxBelow: 18,
      cmfNegative: true,
      tightenOnlyIfProfitGtR: 0.2,
      cutIfLossGtR: 0.5,
    },
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

function normalizeFilters(raw: any): QuantAIEntryFilterConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_CONFIG.filters;
  return {
    minAdx: Number(raw.min_adx ?? raw.minAdx ?? DEFAULT_CONFIG.filters.minAdx),
    minDollarVolume: Number(raw.min_dollar_volume ?? raw.minDollarVolume ?? DEFAULT_CONFIG.filters.minDollarVolume),
    minRr: Number(raw.min_rr ?? raw.minRr ?? DEFAULT_CONFIG.filters.minRr),
    minAtrPct: Number(raw.min_atr_pct ?? raw.minAtrPct ?? DEFAULT_CONFIG.filters.minAtrPct),
    maxSpreadBps: Number(raw.max_spread_bps ?? raw.maxSpreadBps ?? DEFAULT_CONFIG.filters.maxSpreadBps),
    confidenceThreshold: Number(raw.confidence_threshold ?? raw.confidenceThreshold ?? DEFAULT_CONFIG.filters.confidenceThreshold),
    useConfidenceFilter: Boolean(raw.use_confidence_filter ?? raw.useConfidenceFilter ?? DEFAULT_CONFIG.filters.useConfidenceFilter),
  };
}

function normalizeExits(raw: any): QuantAIExitConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_CONFIG.exits;
  const earlyExitRaw = raw.early_exit ?? raw.earlyExit ?? {};
  return {
    atrPeriod: Number(raw.atr_period ?? raw.atrPeriod ?? DEFAULT_CONFIG.exits.atrPeriod),
    slAtrMult: Number(raw.sl_atr_mult ?? raw.slAtrMult ?? DEFAULT_CONFIG.exits.slAtrMult),
    tpRMultiples: Array.isArray(raw.tp_r_multiples ?? raw.tpRMultiples)
      ? (raw.tp_r_multiples ?? raw.tpRMultiples).map((v: any) => Number(v)).filter((v: number) => Number.isFinite(v) && v > 0)
      : DEFAULT_CONFIG.exits.tpRMultiples,
    trailAfterR: Number(raw.trail_after_r ?? raw.trailAfterR ?? DEFAULT_CONFIG.exits.trailAfterR),
    trailAtrMult: Number(raw.trail_atr_mult ?? raw.trailAtrMult ?? DEFAULT_CONFIG.exits.trailAtrMult),
    earlyExit: {
      adxBelow: Number(earlyExitRaw.adx_below ?? earlyExitRaw.adxBelow ?? DEFAULT_CONFIG.exits.earlyExit.adxBelow),
      cmfNegative: Boolean(earlyExitRaw.cmf_negative ?? earlyExitRaw.cmfNegative ?? DEFAULT_CONFIG.exits.earlyExit.cmfNegative),
      tightenOnlyIfProfitGtR: Number(earlyExitRaw.tighten_only_if_profit_gt_r ?? earlyExitRaw.tightenOnlyIfProfitGtR ?? DEFAULT_CONFIG.exits.earlyExit.tightenOnlyIfProfitGtR),
      cutIfLossGtR: Number(earlyExitRaw.cut_if_loss_gt_r ?? earlyExitRaw.cutIfLossGtR ?? DEFAULT_CONFIG.exits.earlyExit.cutIfLossGtR),
    },
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
