export type Cfg = {
  EXCHANGE_ID: string;
  SYMBOL: string;
  // REMOVED: API_KEY and API_SECRET - now using user-specific keys from database
  API_PASSWORD?: string;
  PORT: number;
  POLL_MS: number;
  CORS_ORIGIN: string;
  REQUIRE_API_KEY: boolean;
  APP_API_KEY: string;
  API_RATE_LIMIT_AGENT_WINDOW_MS: number;
  API_RATE_LIMIT_AGENT_PER_IP: number;
  API_RATE_LIMIT_AGENT_PER_KEY: number;
  API_RATE_LIMIT_MONITOR_WINDOW_MS: number;
  API_RATE_LIMIT_MONITOR_PER_IP: number;
  API_RATE_LIMIT_MONITOR_PER_KEY: number;
  DEFAULT_RISK_PCT: number;
  DEFAULT_MAX_LEVERAGE: number;
  DAILY_LOSS_LIMIT_PCT: number;
  // Agent risk tuning
  MIN_STOP_PCT: number;    // minimum stop distance in % of price
  MIN_TP_PCT: number;      // minimum TP distance in % of price (for first TP)
  MIN_FIRST_R: number;     // minimum R for first TP
  TARGET_TP1_PCT: number;
  TARGET_TP2_PCT: number;
  TARGET_TP3_PCT: number;
  TARGET_TP1_MIN_PNL_USD: number;
  USE_GROK: boolean;
  GROK_API_KEY?: string;
  GROK_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;      // e.g. gpt-5-mini-2025-08-07
  DATABASE_URL?: string;
  // LLM cost settings (per 1K tokens). Set to 0 to disable cost estimation.
  OPENAI_COST_IN_PER_1K: number;
  OPENAI_COST_OUT_PER_1K: number;
  GROK_COST_IN_PER_1K: number;
  GROK_COST_OUT_PER_1K: number;
  // Auth
  AUTH_USER: string;        // single user (for demo/testing)
  AUTH_PASS: string;        // password
  ACCESS_CODE?: string;     // optional single access code alternative
  JWT_SECRET: string;       // JWT secret for user authentication
  WS_JWT_SECRET: string;
  WS_JWT_TTL_SEC: number;
  // LLM governance
  LLM_DISABLE: boolean;         // disable LLM calls (use heuristic fallbacks)
  LLM_MIN_INTERVAL_MS: number;  // min spacing between LLM calls (global)
  LLM_CACHE_TTL_MIN: number;    // default cache TTL for identical prompts
  // Agent invalidation & trailing
  BREAKOUT_CONFIRM_TICKS: number; // number of consecutive ticks outside zone to confirm breakout
  BREAKOUT_HYSTERESIS_PCT: number; // percent beyond zone to consider breakout (e.g. 0.15)
  REVERSE_ON_BREAKOUT: boolean;    // immediately reverse after confirmed breakout
  TRAIL_PCT: number;               // optional trailing stop distance in percent (e.g., 0.4 for 0.4%)
  // Entry filters (optional)
  ENTRY_SHORT_MIN_ADX: number;
  ENTRY_SHORT_MIN_RSI: number;
  ENTRY_LONG_MIN_ADX: number;
  ENTRY_LONG_MAX_RSI: number;
  // Market data validation thresholds
  WS_MAX_TIMESTAMP_DRIFT_MS: number;   // reject WS frames if |ts_recv - ts_frame| exceeds this
  REST_MAX_TIMESTAMP_DRIFT_MS: number; // reject REST frames if |ts_recv - ts_frame| exceeds this
  MARKET_STALE_THRESHOLD_MS: number;   // mark data stale when older than this
  OHLCV_FAILFAST_THRESHOLD: number;
  OHLCV_BACKFILL_RETRY: number;
  // Provider routing
  USE_GROK_FOR_ANALYSIS: boolean;
  USE_GROK_FOR_STRATEGY: boolean;
  USE_GROK_FOR_PLAN: boolean;
  GROK_ANALYSIS_DAILY_MAX: number;   // max grok analysis calls per symbol/day
  GROK_REVERSAL_PCT_THRESHOLD: number; // absolute % change to treat as major reversal
  // Monitoring
  STALE_TICK_SEC: number;             // alert if no tick per session beyond this threshold
  MARGIN_UTIL_WARN_PCT: number;
  MARGIN_UTIL_CRITICAL_PCT: number;
  MARGIN_UTIL_TARGET_PCT: number;      // desired utilisation target when projecting new orders
  MARGIN_UTIL_BUFFER_PCT: number;      // safety buffer below the critical threshold
  MARGIN_PROJECTION_MIN_SCALE: number; // minimum acceptable scale factor when resizing orders
  MARGIN_LIQUIDATION_MIN_DIST_PCT: number;
  MARGIN_CONCENTRATION_WARN_PCT: number;
  MARGIN_MONITOR_INTERVAL_MS: number;
  MARGIN_HALT_TARGET_PCT: number;
  MARGIN_HALT_RESUME_PCT: number;
  MARGIN_HALT_RELEASE_COOLDOWN_MS: number;
  // Order reliability
  ORDER_FILL_TIMEOUT_SEC: number;     // max seconds to wait for a live order to fill
  ORDER_FILL_POLL_MS: number;         // polling interval for fetchOrder
  ORDER_RETRY_MAX: number;            // how many times to retry a market order if not filled
  ORDER_LIMIT_SPREAD_BPS: number;     // spread bps threshold to switch to limit orders
  ORDER_TWAP_SPREAD_BPS: number;      // spread bps threshold to prefer TWAP execution
  ORDER_MARKET_ATR_PCT: number;       // ATR% threshold to allow market execution even in wider spreads
  ORDER_LIMIT_TIMEOUT_MS: number;     // how long to wait before falling back from limit to market
  // Liquidity/impact controls
  ORDER_MAX_IMPACT_PCT: number;       // max acceptable market impact for sizing/gating
  MIN_ORDER_NOTIONAL_USD: number;     // minimum order notional to execute
  PAPER_LIQ_SIM_ENABLED: boolean;     // enable liquidity/slippage simulation in paper mode
  PAPER_MAX_IMPACT_PCT: number;       // max impact allowed for paper estimate
  LIQUIDITY_MIN_15M_USD: number;      // minimum 15m USD volume to allow trading
  LIQUIDITY_VOLUME_MULTIPLIER: number; // multiplier for volume24h vs position size (e.g., 50x)
  LEVERAGE_CAP_DEFAULT: number;
  LEVERAGE_CAP_MAJOR: number;
  LEVERAGE_CAP_ALT: number;
  LEVERAGE_CAP_MEME: number;
  
  // Anti-whale / manipulation filters
  ANTI_WHALE_ENABLED: boolean;        // enable anti-whale entry filters
  ANTI_WHALE_VOL_SPIKE_MULT: number;  // reject if latest volume > X * EMA20 volume
  ANTI_WHALE_ATR_PCT: number;         // apply stricter rules when ATR% above this
  ANTI_WHALE_MIN_ADX: number;         // require at least this ADX under spike conditions
  // Plan LLM limits
  PLAN_LLM_COOLDOWN_MIN: number;
  PLAN_LLM_MAX_PER_HOUR: number;
  COOLDOWN_CONFIDENCE_MIN: number;
  COOLDOWN_MOMENTUM_THRESHOLD: number;
  ENTRY_MIN_ATR_PCT: number;
  ENTRY_MIN_SLOPE_ABS_PCT: number;
  // Adaptive performance tuning (streak-based)
  STREAK_WINDOW: number;                 // trades to consider for win/loss streaks
  LOSS_STREAK_ATR_BOOST: number;         // +x per loss (e.g., 0.15 => +15%)
  WIN_STREAK_ATR_RELAX: number;          // -x per win (e.g., 0.12 => -12%)
  MOMENTUM_RELAX_FLOOR: number;          // floor multiplier for relax (e.g., 0.8)
  LOSS_STREAK_SCORE_BONUS: number;       // +score per loss
  WIN_STREAK_SCORE_BONUS: number;        // -score per win (applied as subtraction)
  LOSS_STREAK_SIZE_PENALTY: number;      // -size fraction per loss (e.g., 0.15)
  WIN_STREAK_SIZE_BONUS: number;         // +size fraction per win (e.g., 0.10)
  // Crypto-specific optimizations
  MIN_PROFIT_PCT: number;
  CRYPTO_VOLATILITY_MIN: number;
  // Crypto Moonshot Strategy
  CRYPTO_BREAKOUT_THRESHOLD: number;
  CRYPTO_MOONSHOT_THRESHOLD: number;
  CRYPTO_BREAKOUT_TRAILING: number;
  CRYPTO_MOONSHOT_TRAILING: number;
  CRYPTO_VOLUME_SURGE_MIN: number;
  // Trading timing controls
  MIN_HOLD_TIME_MS: number;         // Minimum hold time before any exit (except critical SL)
  TRADE_COOLDOWN_MS: number;        // Cooldown between trades to prevent over-trading
  TRADE_COOLDOWN_WIN_MS: number;
  TRADE_COOLDOWN_LOSS_MS: number;
  TRADE_COOLDOWN_STAGE_MS: number[];
  TRADE_FREQUENCY_STAGE_COUNTS: number[];
  TRADE_FREQUENCY_STAGE_WIN_THRESHOLDS: number[];
  TRADE_FREQUENCY_STAGE_MIN_TRADES: number[];
  TRADE_FREQUENCY_HYSTERESIS: number;
  CRITICAL_LOSS_PCT: number;        // Loss threshold for immediate exit (bypass min hold)
  // Trade quality filters
  MIN_TRADE_PROFIT_PCT: number;     // Minimum expected profit to enter a trade (1-2%)
  MIN_PRICE_MOVEMENT_PCT: number;   // Minimum price movement to consider significant
  QUALITY_VOLUME_RATIO_BASE: number;
  QUALITY_VOLUME_RATIO_FLOOR: number;
  QUALITY_VOLUME_RATIO_CEIL: number;
  QUALITY_VOLUME_RATIO_HIGH_USD: number;
  QUALITY_VOLUME_RATIO_MEDIUM_USD: number;
  QUALITY_VOLUME_RATIO_LOW_USD: number;
  // CMF-based volume modulation
  VOLUME_CMF_STRONG: number;           // e.g., 0.15 → strong flow
  VOLUME_CMF_RELAX: number;            // base relax to subtract when CMF aligns
  VOLUME_CMF_RELAX_MAX: number;        // cap of relax
  VOLUME_CMF_MIN_ADX: number;          // minimal ADX to trust CMF relaxation
  // Diagnostics warm-up controls
  DIAGNOSTICS_MIN_BARS_15M: number;
  DIAGNOSTICS_BACKFILL_DAYS: number;
  DIAGNOSTICS_ALLOW_PARTIAL_CANDLE: boolean;
  QUALITY_MIN_SCORE_CONSERVATIVE: number;
  QUALITY_MIN_SCORE_REACTIVE: number;
  QUALITY_MIN_SCORE_AGGRESSIVE: number;
  QUALITY_SCORE_RELIEF_ATR_BONUS: boolean;
  SENTIMENT_ENABLED: boolean;
  SENTIMENT_API_URL?: string;
  SENTIMENT_API_KEY?: string;
  SENTIMENT_CACHE_TTL_SEC: number;
  SENTIMENT_MIN_CONFIDENCE: number;
  ARBITRAGE_ENABLED: boolean;
  ARBITRAGE_EXCHANGES: string[];
  ARBITRAGE_SYMBOLS: string[];
  ARBITRAGE_MIN_SPREAD_BPS: number;
  ARBITRAGE_CACHE_TTL_SEC: number;
  ARBITRAGE_MAX_RESULTS: number;
  ARBITRAGE_POLL_INTERVAL_SEC: number;
  TREND_FILTER_ENABLED: boolean;
  TREND_FILTER_NEUTRAL_BAND_BPS: number;
  TREND_FILTER_LOOKBACK_MIN: number;
  // Intelligent selection
  AUTO_MIN_USD_VOLUME: number;
  AUTO_MIN_USD_VOLUME_CONSERVATIVE: number;
  AUTO_MIN_USD_VOLUME_REACTIVE: number;
  AUTO_MIN_USD_VOLUME_AGGRESSIVE: number;
  // Entry near-zone tuning (diagnostics and gating)
  ENTRY_NEAR_ATR_FACTOR: number;        // scales ATR% → near window
  ENTRY_NEAR_WIDTH_FACTOR: number;      // scales zone width% → near window
  ENTRY_NEAR_MIN_BPS: number;           // min bps of price for near window (e.g., 2 => 0.02%)
  ENTRY_NEAR_MAX_BPS: number;           // max bps of price for near window (e.g., 12 => 0.12%)
  ENTRY_NEAR_SPREAD_WEIGHT: number;     // multiply spread% by this and take max with computed window
  TECH_SNAPSHOT_SWING_TOLERANCE_PCT: number; // optional override for swing clustering tolerance
  // Mode-based adaptive parameters (Conservative/Reactive/Aggressive)
  CONSERVATIVE_RISK_PCT: number;
  CONSERVATIVE_MIN_ATR_PCT: number;
  CONSERVATIVE_MAX_TRADES_PER_DAY: number;
  CONSERVATIVE_MAX_CONSECUTIVE_STOPS: number;
  CONSERVATIVE_DAILY_LOSS_LIMIT_PCT: number;
  CONSERVATIVE_TRADE_COOLDOWN_MS: number;
  REACTIVE_RISK_PCT: number;
  REACTIVE_MIN_ATR_PCT: number;
  REACTIVE_MAX_TRADES_PER_DAY: number;
  REACTIVE_MAX_CONSECUTIVE_STOPS: number;
  REACTIVE_DAILY_LOSS_LIMIT_PCT: number;
  REACTIVE_TRADE_COOLDOWN_MS: number;
  AGGRESSIVE_RISK_PCT: number;
  AGGRESSIVE_MIN_ATR_PCT: number;
  AGGRESSIVE_MAX_TRADES_PER_DAY: number;
  AGGRESSIVE_MAX_CONSECUTIVE_STOPS: number;
  AGGRESSIVE_DAILY_LOSS_LIMIT_PCT: number;
  AGGRESSIVE_TRADE_COOLDOWN_MS: number;
  TRADE_COOLDOWN_WIN_MULTIPLIER: number;
  TRADE_COOLDOWN_LOSS_MULTIPLIER: number;
  // Default sizing mode for agents: 'risk' | 'budget'
  SIZING_DEFAULT_MODE: string;
  PORTFOLIO_MIN_BUDGET_FRACTION: number;
  PORTFOLIO_MAX_BUDGET_FRACTION: number;
  PORTFOLIO_BUDGET_FRACTION_MULTIPLIER: number;
  PORTFOLIO_BUDGET_FRACTION_OFFSET: number;

  // Intelligent strategy refresh (indicator-driven, debounced)
  STRAT_REFRESH_ENABLED: boolean;
  STRAT_REFRESH_DEBOUNCE_SEC: number;        // min seconds between forced refresh per symbol
  STRAT_REFRESH_BIAS_DIVERGENCE_ENABLED: boolean;
  STRAT_REFRESH_BIAS_DIVERGENCE_TICKS: number; // consecutive ticks with strong divergence before refresh
  STRAT_REFRESH_SR_REJECTION_ENABLED: boolean;
  STRAT_REFRESH_RSI_CROSS_ENABLED: boolean;
  STRAT_REFRESH_RSI_OVERBOUGHT: number;      // e.g., 70
  STRAT_REFRESH_RSI_OVERSOLD: number;        // e.g., 30
  STRAT_REFRESH_ADAPTIVE_ENABLED: boolean;   // adapt thresholds per symbol volatility/liquidity
  // Indicator change thresholds to avoid redundant LLM calls
  STRAT_REFRESH_MIN_PRICE_BPS: number;       // min price change (bps) to consider significant
  STRAT_REFRESH_MIN_EMA_SPREAD_BPS: number;  // min EMA20/50 spread delta (bps)
  STRAT_REFRESH_MIN_RSI_DELTA: number;       // min RSI delta (points)
  STRAT_REFRESH_MIN_ADX_DELTA: number;       // min ADX delta (points)
};
export type AgentAggressiveness = 'conservative' | 'reactive' | 'aggressive';

export interface ModeParams {
  riskPct: number;
  minAtrPct: number;
  maxTradesPerDay: number;
  maxConsecutiveStops: number;
  dailyLossLimitPct: number;
  tradeCooldownMs: number;
}

export function getModeParams(mode: AgentAggressiveness = 'reactive'): ModeParams {
  const cfg = getConfig();
  
  switch (mode) {
    case 'conservative':
      return {
        riskPct: cfg.CONSERVATIVE_RISK_PCT,
        minAtrPct: cfg.CONSERVATIVE_MIN_ATR_PCT,
        maxTradesPerDay: cfg.CONSERVATIVE_MAX_TRADES_PER_DAY,
        maxConsecutiveStops: cfg.CONSERVATIVE_MAX_CONSECUTIVE_STOPS,
        dailyLossLimitPct: cfg.CONSERVATIVE_DAILY_LOSS_LIMIT_PCT,
        tradeCooldownMs: cfg.CONSERVATIVE_TRADE_COOLDOWN_MS,
      };
    case 'aggressive':
      return {
        riskPct: cfg.AGGRESSIVE_RISK_PCT,
        minAtrPct: cfg.AGGRESSIVE_MIN_ATR_PCT,
        maxTradesPerDay: cfg.AGGRESSIVE_MAX_TRADES_PER_DAY,
        maxConsecutiveStops: cfg.AGGRESSIVE_MAX_CONSECUTIVE_STOPS,
        dailyLossLimitPct: cfg.AGGRESSIVE_DAILY_LOSS_LIMIT_PCT,
        tradeCooldownMs: cfg.AGGRESSIVE_TRADE_COOLDOWN_MS,
      };
    case 'reactive':
    default:
      return {
        riskPct: cfg.REACTIVE_RISK_PCT,
        minAtrPct: cfg.REACTIVE_MIN_ATR_PCT,
        maxTradesPerDay: cfg.REACTIVE_MAX_TRADES_PER_DAY,
        maxConsecutiveStops: cfg.REACTIVE_MAX_CONSECUTIVE_STOPS,
        dailyLossLimitPct: cfg.REACTIVE_DAILY_LOSS_LIMIT_PCT,
        tradeCooldownMs: cfg.REACTIVE_TRADE_COOLDOWN_MS,
      };
  }
}

export function getConfig(): Cfg {
  const e = process.env as Record<string, string>;

  const parseNumberList = (raw: string | undefined, fallback: number[]): number[] => {
    if (!raw) return [...fallback];
    const parts = raw
      .split(/[,;\s]+/)
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value));
    return parts.length ? parts.map((value) => Number(value)) : [...fallback];
  };

  const alignList = (values: number[], length: number, fallback: number): number[] => {
    if (length <= 0) return [];
    const copy = values.slice(0, length);
    while (copy.length < length) {
      copy.push(copy.length ? copy[copy.length - 1] : fallback);
    }
    return copy;
  };

  const defaultStageCounts = [6, 10, 14];
  const stageCountsRaw = parseNumberList(e.TRADE_FREQUENCY_STAGE_COUNTS, defaultStageCounts)
    .map((value) => Math.max(1, Math.round(value)));
  const stageCounts = stageCountsRaw.length ? stageCountsRaw : defaultStageCounts;
  const defaultStageCooldowns = [20_000, 12_000, 8_000];
  const stageCooldownsRaw = parseNumberList(e.TRADE_COOLDOWN_STAGE_MS, defaultStageCooldowns)
    .map((value) => Math.max(1_000, Math.round(value)));
  const stageCooldownFallback = stageCooldownsRaw.length
    ? stageCooldownsRaw[stageCooldownsRaw.length - 1]
    : defaultStageCooldowns[defaultStageCooldowns.length - 1];
  const stageCooldowns = alignList(
    stageCooldownsRaw.length ? stageCooldownsRaw : defaultStageCooldowns,
    stageCounts.length,
    stageCooldownFallback,
  );
  const stageWinThresholdsRaw = parseNumberList(e.TRADE_FREQUENCY_STAGE_WIN_THRESHOLDS, [0, 0.36, 0.44])
    .map((value) => Math.max(0, Math.min(1, value)));
  const stageWinThresholdFallback = stageWinThresholdsRaw.length
    ? stageWinThresholdsRaw[stageWinThresholdsRaw.length - 1]
    : 0;
  const stageWinThresholds = alignList(
    stageWinThresholdsRaw.length ? stageWinThresholdsRaw : [0, 0.36, 0.44],
    stageCounts.length,
    stageWinThresholdFallback,
  );
  const stageMinTradesRaw = parseNumberList(e.TRADE_FREQUENCY_STAGE_MIN_TRADES, [0, 6, 10])
    .map((value) => Math.max(0, Math.round(value)));
  const stageMinTradesFallback = stageMinTradesRaw.length
    ? stageMinTradesRaw[stageMinTradesRaw.length - 1]
    : 0;
  const stageMinTrades = alignList(
    stageMinTradesRaw.length ? stageMinTradesRaw : [0, 6, 10],
    stageCounts.length,
    stageMinTradesFallback,
  );
  const tradeFrequencyHysteresis = Math.max(0, Math.min(0.3, Number(e.TRADE_FREQUENCY_HYSTERESIS || '0.05')));

  return {
    EXCHANGE_ID: e.EXCHANGE_ID || "cryptocom",
    SYMBOL: e.SYMBOL || "BTCUSDT",
    // REMOVED: API_KEY and API_SECRET - now using user-specific keys from database
    API_PASSWORD: e.API_PASSWORD || "",
    PORT: Number(e.PORT || "4000"),
    // Polling every 2s by default for better real-time response (reduced from 5s)
    POLL_MS: Number(e.POLL_MS || "2000"),
    CORS_ORIGIN: e.CORS_ORIGIN || "http://localhost:5173",
    // Respect env flag; default off for dev
    REQUIRE_API_KEY: (e.REQUIRE_API_KEY || "false") === "true",
    APP_API_KEY: e.APP_API_KEY || "change-me",
    API_RATE_LIMIT_AGENT_WINDOW_MS: Number(e.API_RATE_LIMIT_AGENT_WINDOW_MS || "60000"),
    API_RATE_LIMIT_AGENT_PER_IP: Number(e.API_RATE_LIMIT_AGENT_PER_IP || "60"),
    API_RATE_LIMIT_AGENT_PER_KEY: Number(e.API_RATE_LIMIT_AGENT_PER_KEY || "120"),
    API_RATE_LIMIT_MONITOR_WINDOW_MS: Number(e.API_RATE_LIMIT_MONITOR_WINDOW_MS || "60000"),
    API_RATE_LIMIT_MONITOR_PER_IP: Number(e.API_RATE_LIMIT_MONITOR_PER_IP || "120"),
    API_RATE_LIMIT_MONITOR_PER_KEY: Number(e.API_RATE_LIMIT_MONITOR_PER_KEY || "240"),
    DEFAULT_RISK_PCT: Number(e.DEFAULT_RISK_PCT || "2.0"),
    DEFAULT_MAX_LEVERAGE: Number(e.DEFAULT_MAX_LEVERAGE || "10"),
    DAILY_LOSS_LIMIT_PCT: Number(e.DAILY_LOSS_LIMIT_PCT || "5"),
    MIN_STOP_PCT: Number(e.MIN_STOP_PCT || "0.2"),
    MIN_TP_PCT: Number(e.MIN_TP_PCT || "0.4"),
    MIN_FIRST_R: Number(e.MIN_FIRST_R || "1.8"),
    TARGET_TP1_PCT: Number(e.TARGET_TP1_PCT || "2.0"),
    TARGET_TP2_PCT: Number(e.TARGET_TP2_PCT || "3"),
    TARGET_TP3_PCT: Number(e.TARGET_TP3_PCT || "5"),
    TARGET_TP1_MIN_PNL_USD: Number(e.TARGET_TP1_MIN_PNL_USD || "30"),
    USE_GROK: (e.USE_GROK || "true") === "true",
    GROK_API_KEY: e.GROK_API_KEY || "",
    GROK_BASE_URL: e.GROK_BASE_URL || "https://api.x.ai/v1/chat/completions",
    OPENAI_API_KEY: e.OPENAI_API_KEY || "",
    // Use a valid default OpenAI model
    OPENAI_MODEL: e.OPENAI_MODEL || "gpt-5-mini-2025-08-07",
    DATABASE_URL: e.DATABASE_URL || "",
    OPENAI_COST_IN_PER_1K: Number(e.OPENAI_COST_IN_PER_1K || "0"),
    OPENAI_COST_OUT_PER_1K: Number(e.OPENAI_COST_OUT_PER_1K || "0"),
    GROK_COST_IN_PER_1K: Number(e.GROK_COST_IN_PER_1K || "0"),
    GROK_COST_OUT_PER_1K: Number(e.GROK_COST_OUT_PER_1K || "0"),
    AUTH_USER: e.AUTH_USER || "",
    AUTH_PASS: e.AUTH_PASS || "",
    ACCESS_CODE: e.ACCESS_CODE || "",
    JWT_SECRET: e.JWT_SECRET || e.APP_API_KEY || "change-me-jwt-secret",
    WS_JWT_SECRET: e.WS_JWT_SECRET || e.JWT_SECRET || e.APP_API_KEY || "change-me-ws-secret",
    WS_JWT_TTL_SEC: Number(e.WS_JWT_TTL_SEC || "60"),
    LLM_DISABLE: (e.LLM_DISABLE || "false") === "true",
    LLM_MIN_INTERVAL_MS: Number(e.LLM_MIN_INTERVAL_MS || "1000"), // réduit à 1s pour plus de réactivité
    LLM_CACHE_TTL_MIN: Number(e.LLM_CACHE_TTL_MIN || "30"), // réduit de 60 à 30 min
    BREAKOUT_CONFIRM_TICKS: Number(e.BREAKOUT_CONFIRM_TICKS || "2"),
    BREAKOUT_HYSTERESIS_PCT: Number(e.BREAKOUT_HYSTERESIS_PCT || "0.15"),
    REVERSE_ON_BREAKOUT: (e.REVERSE_ON_BREAKOUT || "false") === "true",
    TRAIL_PCT: Number(e.TRAIL_PCT || "0"),
    // Slightly more permissive by default to avoid idle agents on moderate-trend days
    ENTRY_SHORT_MIN_ADX: Number(e.ENTRY_SHORT_MIN_ADX || "6"),
    ENTRY_SHORT_MIN_RSI: Number(e.ENTRY_SHORT_MIN_RSI || "45"),
    ENTRY_LONG_MIN_ADX: Number(e.ENTRY_LONG_MIN_ADX || "4"),
    ENTRY_LONG_MAX_RSI: Number(e.ENTRY_LONG_MAX_RSI || "65"),
    WS_MAX_TIMESTAMP_DRIFT_MS: Number(e.WS_MAX_TIMESTAMP_DRIFT_MS || "5000"),
    REST_MAX_TIMESTAMP_DRIFT_MS: Number(
      e.REST_MAX_TIMESTAMP_DRIFT_MS ||
      e.MARKET_STALE_THRESHOLD_MS ||
      "12000"
    ),
    MARKET_STALE_THRESHOLD_MS: Number(e.MARKET_STALE_THRESHOLD_MS || "12000"),
    OHLCV_FAILFAST_THRESHOLD: Number(e.OHLCV_FAILFAST_THRESHOLD || '0.2'),
    OHLCV_BACKFILL_RETRY: Number(e.OHLCV_BACKFILL_RETRY || '1'),
    USE_GROK_FOR_ANALYSIS: (e.USE_GROK_FOR_ANALYSIS || "true") === "true",
    USE_GROK_FOR_STRATEGY: (e.USE_GROK_FOR_STRATEGY || "false") === "true",
    USE_GROK_FOR_PLAN: (e.USE_GROK_FOR_PLAN || "false") === "true",
    GROK_ANALYSIS_DAILY_MAX: Number(e.GROK_ANALYSIS_DAILY_MAX || "10"), // augmenté pour plus d'analyses
    GROK_REVERSAL_PCT_THRESHOLD: Number(e.GROK_REVERSAL_PCT_THRESHOLD || "3.5"),
    STALE_TICK_SEC: Number(e.STALE_TICK_SEC || "300"),  // 5 min instead of 2 min for crypto
    MARGIN_UTIL_WARN_PCT: Number(e.MARGIN_UTIL_WARN_PCT || "65"),
    MARGIN_UTIL_CRITICAL_PCT: Number(e.MARGIN_UTIL_CRITICAL_PCT || "90"),
    MARGIN_UTIL_TARGET_PCT: Number(e.MARGIN_UTIL_TARGET_PCT || e.MARGIN_HALT_TARGET_PCT || "80"),
    MARGIN_UTIL_BUFFER_PCT: Number(e.MARGIN_UTIL_BUFFER_PCT || "2"),
    MARGIN_PROJECTION_MIN_SCALE: Number(e.MARGIN_PROJECTION_MIN_SCALE || "0.15"),
    MARGIN_LIQUIDATION_MIN_DIST_PCT: Number(e.MARGIN_LIQUIDATION_MIN_DIST_PCT || "12"),
    MARGIN_CONCENTRATION_WARN_PCT: Number(e.MARGIN_CONCENTRATION_WARN_PCT || "35"),
    MARGIN_MONITOR_INTERVAL_MS: Number(e.MARGIN_MONITOR_INTERVAL_MS || "30000"),
    MARGIN_HALT_TARGET_PCT: Number(e.MARGIN_HALT_TARGET_PCT || "80"),
    MARGIN_HALT_RESUME_PCT: Number(e.MARGIN_HALT_RESUME_PCT || "78"),
    MARGIN_HALT_RELEASE_COOLDOWN_MS: Number(e.MARGIN_HALT_RELEASE_COOLDOWN_MS || "10000"),
    ORDER_FILL_TIMEOUT_SEC: Number(e.ORDER_FILL_TIMEOUT_SEC || "10"),
    ORDER_FILL_POLL_MS: Number(e.ORDER_FILL_POLL_MS || "300"),
    ORDER_RETRY_MAX: Number(e.ORDER_RETRY_MAX || "2"),
    ORDER_LIMIT_SPREAD_BPS: Number(e.ORDER_LIMIT_SPREAD_BPS || "12"),
    ORDER_TWAP_SPREAD_BPS: Number(e.ORDER_TWAP_SPREAD_BPS || "20"),
    ORDER_MARKET_ATR_PCT: Number(e.ORDER_MARKET_ATR_PCT || "4"),
    ORDER_LIMIT_TIMEOUT_MS: Number(e.ORDER_LIMIT_TIMEOUT_MS || "4000"),
    // Crypto-specific optimizations
    MIN_PROFIT_PCT: Number(e.MIN_PROFIT_PCT || "0.3"),
    CRYPTO_VOLATILITY_MIN: Number(e.CRYPTO_VOLATILITY_MIN || "0.5"),
    // Crypto Moonshot Strategy
    CRYPTO_BREAKOUT_THRESHOLD: Number(e.CRYPTO_BREAKOUT_THRESHOLD || "5.0"),
    CRYPTO_MOONSHOT_THRESHOLD: Number(e.CRYPTO_MOONSHOT_THRESHOLD || "15.0"),
    CRYPTO_BREAKOUT_TRAILING: Number(e.CRYPTO_BREAKOUT_TRAILING || "2.0"),
    CRYPTO_MOONSHOT_TRAILING: Number(e.CRYPTO_MOONSHOT_TRAILING || "3.0"),
    CRYPTO_VOLUME_SURGE_MIN: Number(e.CRYPTO_VOLUME_SURGE_MIN || "2.0"),
    // Trading timing controls to prevent over-trading
    MIN_HOLD_TIME_MS: Number(e.MIN_HOLD_TIME_MS || "600000"), // 10 minutes minimum for crypto scalping
    TRADE_COOLDOWN_MS: Number(e.TRADE_COOLDOWN_MS || "600000"), // 10 minutes cooldown for crypto
    TRADE_COOLDOWN_WIN_MS: Number(e.TRADE_COOLDOWN_WIN_MS || "60000"),
    TRADE_COOLDOWN_LOSS_MS: Number(e.TRADE_COOLDOWN_LOSS_MS || "180000"),
    TRADE_COOLDOWN_STAGE_MS: stageCooldowns,
    TRADE_FREQUENCY_STAGE_COUNTS: stageCounts,
    TRADE_FREQUENCY_STAGE_WIN_THRESHOLDS: stageWinThresholds,
    TRADE_FREQUENCY_STAGE_MIN_TRADES: stageMinTrades,
    TRADE_FREQUENCY_HYSTERESIS: tradeFrequencyHysteresis,
    CRITICAL_LOSS_PCT: Number(e.CRITICAL_LOSS_PCT || "3.0"), // 3% loss = immediate exit (increased for crypto)
    // Trade quality filters
    // Lowered to trigger more realistic crypto trades while keeping quality
    MIN_TRADE_PROFIT_PCT: Number(e.MIN_TRADE_PROFIT_PCT || "0.35"), // 0.35% baseline profit target for calm crypto markets
    MIN_PRICE_MOVEMENT_PCT: Number(e.MIN_PRICE_MOVEMENT_PCT || "0.6"), // 0.6% movement significant
    // Slightly reduced base quality thresholds (dynamic adjustments still apply)
    QUALITY_MIN_SCORE_CONSERVATIVE: Number(e.QUALITY_MIN_SCORE_CONSERVATIVE || "60"),
    QUALITY_MIN_SCORE_REACTIVE: Number(e.QUALITY_MIN_SCORE_REACTIVE || "50"),
    QUALITY_MIN_SCORE_AGGRESSIVE: Number(e.QUALITY_MIN_SCORE_AGGRESSIVE || "40"),
    QUALITY_SCORE_RELIEF_ATR_BONUS: (e.QUALITY_SCORE_RELIEF_ATR_BONUS || "false") === "true",
    SENTIMENT_ENABLED: (e.SENTIMENT_ENABLED || "false") === "true",
    SENTIMENT_API_URL: e.SENTIMENT_API_URL || undefined,
    SENTIMENT_API_KEY: e.SENTIMENT_API_KEY || undefined,
    SENTIMENT_CACHE_TTL_SEC: Number(e.SENTIMENT_CACHE_TTL_SEC || "180"),
    SENTIMENT_MIN_CONFIDENCE: Number(e.SENTIMENT_MIN_CONFIDENCE || "0.2"),
    ARBITRAGE_ENABLED: (e.ARBITRAGE_ENABLED || "false") === "true",
    ARBITRAGE_EXCHANGES: (e.ARBITRAGE_EXCHANGES || "binance,bybit,okx").split(',').map(s => s.trim()).filter(Boolean),
    ARBITRAGE_SYMBOLS: (e.ARBITRAGE_SYMBOLS || "BTC/USDT,ETH/USDT,SOL/USDT,XRP/USDT,BNB/USDT").split(',').map(s => s.trim()).filter(Boolean),
    ARBITRAGE_MIN_SPREAD_BPS: Number(e.ARBITRAGE_MIN_SPREAD_BPS || "20"),
    ARBITRAGE_CACHE_TTL_SEC: Number(e.ARBITRAGE_CACHE_TTL_SEC || "120"),
    ARBITRAGE_MAX_RESULTS: Number(e.ARBITRAGE_MAX_RESULTS || "10"),
    ARBITRAGE_POLL_INTERVAL_SEC: Number(e.ARBITRAGE_POLL_INTERVAL_SEC || "600"), // 10 minutes instead of 3
    TREND_FILTER_ENABLED: (e.TREND_FILTER_ENABLED || "false") === "true",
    TREND_FILTER_NEUTRAL_BAND_BPS: Number(e.TREND_FILTER_NEUTRAL_BAND_BPS || "15"),
    TREND_FILTER_LOOKBACK_MIN: Number(e.TREND_FILTER_LOOKBACK_MIN || "240"),
    // Liquidity/impact controls
    ORDER_MAX_IMPACT_PCT: Number(e.ORDER_MAX_IMPACT_PCT || "0.35"),
    MIN_ORDER_NOTIONAL_USD: Number(e.MIN_ORDER_NOTIONAL_USD || "40"),
    PAPER_LIQ_SIM_ENABLED: (e.PAPER_LIQ_SIM_ENABLED || "true") === "true",
    PAPER_MAX_IMPACT_PCT: Number(e.PAPER_MAX_IMPACT_PCT || e.ORDER_MAX_IMPACT_PCT || "0.35"),
    LIQUIDITY_MIN_15M_USD: Number(e.LIQUIDITY_MIN_15M_USD || "100000"),
    LIQUIDITY_VOLUME_MULTIPLIER: Number(e.LIQUIDITY_VOLUME_MULTIPLIER || "30"),
    LEVERAGE_CAP_DEFAULT: Number(e.LEVERAGE_CAP_DEFAULT || e.DEFAULT_MAX_LEVERAGE || "5"),
    LEVERAGE_CAP_MAJOR: Number(e.LEVERAGE_CAP_MAJOR || e.LEVERAGE_CAP_DEFAULT || e.DEFAULT_MAX_LEVERAGE || "6"),
    LEVERAGE_CAP_ALT: Number(e.LEVERAGE_CAP_ALT || e.LEVERAGE_CAP_DEFAULT || e.DEFAULT_MAX_LEVERAGE || "4"),
    LEVERAGE_CAP_MEME: Number(
      e.LEVERAGE_CAP_MEME
        || e.LEVERAGE_CAP_DEFAULT
        || Math.min(Number(e.DEFAULT_MAX_LEVERAGE || "3"), 3)
    ),
    // Anti-whale / manipulation filters
    ANTI_WHALE_ENABLED: (e.ANTI_WHALE_ENABLED || "true") === "true",
    ANTI_WHALE_VOL_SPIKE_MULT: Number(e.ANTI_WHALE_VOL_SPIKE_MULT || "2.2"),
    ANTI_WHALE_ATR_PCT: Number(e.ANTI_WHALE_ATR_PCT || "2.0"),
    ANTI_WHALE_MIN_ADX: Number(e.ANTI_WHALE_MIN_ADX || "18"),
    PLAN_LLM_COOLDOWN_MIN: Number(e.PLAN_LLM_COOLDOWN_MIN || "5"), // réduit de 15 à 5 min
    PLAN_LLM_MAX_PER_HOUR: Number(e.PLAN_LLM_MAX_PER_HOUR || "10"), // augmenté de 3 à 10
    COOLDOWN_CONFIDENCE_MIN: Number(e.COOLDOWN_CONFIDENCE_MIN || "0.6"),
    COOLDOWN_MOMENTUM_THRESHOLD: Number(e.COOLDOWN_MOMENTUM_THRESHOLD || "0.3"),
    // ATR % threshold relaxed to 0.3 by default; adaptive logic still enforces safety per symbol
    ENTRY_MIN_ATR_PCT: Number(e.ENTRY_MIN_ATR_PCT || "0.3"),
    ENTRY_MIN_SLOPE_ABS_PCT: Number(e.ENTRY_MIN_SLOPE_ABS_PCT || "0.08"),
    // Adaptive performance tuning (streak-based)
    STREAK_WINDOW: Number(e.STREAK_WINDOW || "3"),
    LOSS_STREAK_ATR_BOOST: Number(e.LOSS_STREAK_ATR_BOOST || "0.15"),
    WIN_STREAK_ATR_RELAX: Number(e.WIN_STREAK_ATR_RELAX || "0.12"),
    MOMENTUM_RELAX_FLOOR: Number(e.MOMENTUM_RELAX_FLOOR || "0.8"),
    LOSS_STREAK_SCORE_BONUS: Number(e.LOSS_STREAK_SCORE_BONUS || "4"),
    WIN_STREAK_SCORE_BONUS: Number(e.WIN_STREAK_SCORE_BONUS || "3"),
    LOSS_STREAK_SIZE_PENALTY: Number(e.LOSS_STREAK_SIZE_PENALTY || "0.15"),
    WIN_STREAK_SIZE_BONUS: Number(e.WIN_STREAK_SIZE_BONUS || "0.10"),
    // Intelligent selection
    AUTO_MIN_USD_VOLUME: Number(e.AUTO_MIN_USD_VOLUME || "50000000"),
    AUTO_MIN_USD_VOLUME_CONSERVATIVE: Number(e.AUTO_MIN_USD_VOLUME_CONSERVATIVE || e.AUTO_MIN_USD_VOLUME || "75000000"),
    AUTO_MIN_USD_VOLUME_REACTIVE: Number(e.AUTO_MIN_USD_VOLUME_REACTIVE || e.AUTO_MIN_USD_VOLUME || "50000000"),
    AUTO_MIN_USD_VOLUME_AGGRESSIVE: Number(
      e.AUTO_MIN_USD_VOLUME_AGGRESSIVE
        || e.AUTO_MIN_USD_VOLUME_REACTIVE
        || e.AUTO_MIN_USD_VOLUME
        || "35000000"
    ),
    QUALITY_VOLUME_RATIO_BASE: Number(e.QUALITY_VOLUME_RATIO_BASE || "0.25"),
    QUALITY_VOLUME_RATIO_FLOOR: Number(e.QUALITY_VOLUME_RATIO_FLOOR || "0.15"),
    QUALITY_VOLUME_RATIO_CEIL: Number(e.QUALITY_VOLUME_RATIO_CEIL || "0.78"),
    QUALITY_VOLUME_RATIO_HIGH_USD: Number(e.QUALITY_VOLUME_RATIO_HIGH_USD || "20000000"),
    QUALITY_VOLUME_RATIO_MEDIUM_USD: Number(e.QUALITY_VOLUME_RATIO_MEDIUM_USD || "8000000"),
    QUALITY_VOLUME_RATIO_LOW_USD: Number(e.QUALITY_VOLUME_RATIO_LOW_USD || "1500000"),
    // CMF-based volume modulation (defaults tuned for crypto 15m)
    VOLUME_CMF_STRONG: Number(e.VOLUME_CMF_STRONG || "0.15"),
    VOLUME_CMF_RELAX: Number(e.VOLUME_CMF_RELAX || "0.15"),
    VOLUME_CMF_RELAX_MAX: Number(e.VOLUME_CMF_RELAX_MAX || "0.20"),
    VOLUME_CMF_MIN_ADX: Number(e.VOLUME_CMF_MIN_ADX || "15"),
    DIAGNOSTICS_MIN_BARS_15M: Number(e.DIAGNOSTICS_MIN_BARS_15M || "120"),
    DIAGNOSTICS_BACKFILL_DAYS: Number(e.DIAGNOSTICS_BACKFILL_DAYS || "3"),
    DIAGNOSTICS_ALLOW_PARTIAL_CANDLE: (e.DIAGNOSTICS_ALLOW_PARTIAL_CANDLE || "false") === "true",
    // Entry near-zone tuning
    ENTRY_NEAR_ATR_FACTOR: Number(e.ENTRY_NEAR_ATR_FACTOR || "0.2"),
    ENTRY_NEAR_WIDTH_FACTOR: Number(e.ENTRY_NEAR_WIDTH_FACTOR || "0.15"),
    ENTRY_NEAR_MIN_BPS: Number(e.ENTRY_NEAR_MIN_BPS || "2"),
    ENTRY_NEAR_MAX_BPS: Number(e.ENTRY_NEAR_MAX_BPS || "12"),
    ENTRY_NEAR_SPREAD_WEIGHT: Number(e.ENTRY_NEAR_SPREAD_WEIGHT || "0.5"),
    TECH_SNAPSHOT_SWING_TOLERANCE_PCT: Number(e.TECH_SNAPSHOT_SWING_TOLERANCE_PCT || "0"),
    // Mode-based adaptive parameters
    CONSERVATIVE_RISK_PCT: Number(e.CONSERVATIVE_RISK_PCT || "1.0"),
    CONSERVATIVE_MIN_ATR_PCT: Number(e.CONSERVATIVE_MIN_ATR_PCT || "0.30"),
    CONSERVATIVE_MAX_TRADES_PER_DAY: Number(e.CONSERVATIVE_MAX_TRADES_PER_DAY || "10"),
    CONSERVATIVE_MAX_CONSECUTIVE_STOPS: Number(e.CONSERVATIVE_MAX_CONSECUTIVE_STOPS || "2"),
    CONSERVATIVE_DAILY_LOSS_LIMIT_PCT: Number(e.CONSERVATIVE_DAILY_LOSS_LIMIT_PCT || "4.0"),
    CONSERVATIVE_TRADE_COOLDOWN_MS: Number(e.CONSERVATIVE_TRADE_COOLDOWN_MS || "30000"),
    REACTIVE_RISK_PCT: Number(e.REACTIVE_RISK_PCT || "1.5"),
    REACTIVE_MIN_ATR_PCT: Number(e.REACTIVE_MIN_ATR_PCT || "0.18"),
    REACTIVE_MAX_TRADES_PER_DAY: Number(e.REACTIVE_MAX_TRADES_PER_DAY || "12"),
    REACTIVE_MAX_CONSECUTIVE_STOPS: Number(e.REACTIVE_MAX_CONSECUTIVE_STOPS || "3"),
    REACTIVE_DAILY_LOSS_LIMIT_PCT: Number(e.REACTIVE_DAILY_LOSS_LIMIT_PCT || "5.5"),
    REACTIVE_TRADE_COOLDOWN_MS: Number(e.REACTIVE_TRADE_COOLDOWN_MS || "20000"),
    AGGRESSIVE_RISK_PCT: Number(e.AGGRESSIVE_RISK_PCT || "2.5"),
    AGGRESSIVE_MIN_ATR_PCT: Number(e.AGGRESSIVE_MIN_ATR_PCT || "0.12"),
    AGGRESSIVE_MAX_TRADES_PER_DAY: Number(e.AGGRESSIVE_MAX_TRADES_PER_DAY || "15"),
    AGGRESSIVE_MAX_CONSECUTIVE_STOPS: Number(e.AGGRESSIVE_MAX_CONSECUTIVE_STOPS || "4"),
    AGGRESSIVE_DAILY_LOSS_LIMIT_PCT: Number(e.AGGRESSIVE_DAILY_LOSS_LIMIT_PCT || "7.0"),
    AGGRESSIVE_TRADE_COOLDOWN_MS: Number(e.AGGRESSIVE_TRADE_COOLDOWN_MS || "10000"),
    TRADE_COOLDOWN_WIN_MULTIPLIER: Number(e.TRADE_COOLDOWN_WIN_MULTIPLIER || "0.5"),
    TRADE_COOLDOWN_LOSS_MULTIPLIER: Number(e.TRADE_COOLDOWN_LOSS_MULTIPLIER || "1.5"),
    SIZING_DEFAULT_MODE: (e.SIZING_DEFAULT_MODE || "budget").toLowerCase() === 'risk' ? 'risk' : 'budget',
    PORTFOLIO_MIN_BUDGET_FRACTION: Number(e.PORTFOLIO_MIN_BUDGET_FRACTION || "0.25"),
    PORTFOLIO_MAX_BUDGET_FRACTION: Number(e.PORTFOLIO_MAX_BUDGET_FRACTION || "1"),
    PORTFOLIO_BUDGET_FRACTION_MULTIPLIER: Number(e.PORTFOLIO_BUDGET_FRACTION_MULTIPLIER || "3"),
    PORTFOLIO_BUDGET_FRACTION_OFFSET: Number(e.PORTFOLIO_BUDGET_FRACTION_OFFSET || "0"),

    // Intelligent strategy refresh (indicator-driven, debounced)
    STRAT_REFRESH_ENABLED: (e.STRAT_REFRESH_ENABLED || "true") === "true",
    STRAT_REFRESH_DEBOUNCE_SEC: Number(e.STRAT_REFRESH_DEBOUNCE_SEC || "60"),
    STRAT_REFRESH_BIAS_DIVERGENCE_ENABLED: (e.STRAT_REFRESH_BIAS_DIVERGENCE_ENABLED || "true") === "true",
    STRAT_REFRESH_BIAS_DIVERGENCE_TICKS: Number(e.STRAT_REFRESH_BIAS_DIVERGENCE_TICKS || "3"),
    STRAT_REFRESH_SR_REJECTION_ENABLED: (e.STRAT_REFRESH_SR_REJECTION_ENABLED || "true") === "true",
    STRAT_REFRESH_RSI_CROSS_ENABLED: (e.STRAT_REFRESH_RSI_CROSS_ENABLED || "true") === "true",
    STRAT_REFRESH_RSI_OVERBOUGHT: Number(e.STRAT_REFRESH_RSI_OVERBOUGHT || "70"),
    STRAT_REFRESH_RSI_OVERSOLD: Number(e.STRAT_REFRESH_RSI_OVERSOLD || "30"),
    STRAT_REFRESH_ADAPTIVE_ENABLED: (e.STRAT_REFRESH_ADAPTIVE_ENABLED || "true") === "true",
    STRAT_REFRESH_MIN_PRICE_BPS: Number(e.STRAT_REFRESH_MIN_PRICE_BPS || "10"),
    STRAT_REFRESH_MIN_EMA_SPREAD_BPS: Number(e.STRAT_REFRESH_MIN_EMA_SPREAD_BPS || "8"),
    STRAT_REFRESH_MIN_RSI_DELTA: Number(e.STRAT_REFRESH_MIN_RSI_DELTA || "2"),
    STRAT_REFRESH_MIN_ADX_DELTA: Number(e.STRAT_REFRESH_MIN_ADX_DELTA || "2"),
  };
}
