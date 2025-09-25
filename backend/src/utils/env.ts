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
  DEFAULT_RISK_PCT: number;
  DEFAULT_MAX_LEVERAGE: number;
  DAILY_LOSS_LIMIT_PCT: number;
  // Agent risk tuning
  MIN_STOP_PCT: number;    // minimum stop distance in % of price
  MIN_TP_PCT: number;      // minimum TP distance in % of price (for first TP)
  MIN_FIRST_R: number;     // minimum R for first TP
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
  // Provider routing
  USE_GROK_FOR_ANALYSIS: boolean;
  USE_GROK_FOR_STRATEGY: boolean;
  USE_GROK_FOR_PLAN: boolean;
  GROK_ANALYSIS_DAILY_MAX: number;   // max grok analysis calls per symbol/day
  GROK_REVERSAL_PCT_THRESHOLD: number; // absolute % change to treat as major reversal
  // Monitoring
  STALE_TICK_SEC: number;             // alert if no tick per session beyond this threshold
  // Order reliability
  ORDER_FILL_TIMEOUT_SEC: number;     // max seconds to wait for a live order to fill
  ORDER_FILL_POLL_MS: number;         // polling interval for fetchOrder
  ORDER_RETRY_MAX: number;            // how many times to retry a market order if not filled
  // Plan LLM limits
  PLAN_LLM_COOLDOWN_MIN: number;
  PLAN_LLM_MAX_PER_HOUR: number;
  COOLDOWN_CONFIDENCE_MIN: number;
  COOLDOWN_MOMENTUM_THRESHOLD: number;
  ENTRY_MIN_ATR_PCT: number;
  ENTRY_MIN_SLOPE_ABS_PCT: number;
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
  CRITICAL_LOSS_PCT: number;        // Loss threshold for immediate exit (bypass min hold)
  // Trade quality filters
  MIN_TRADE_PROFIT_PCT: number;     // Minimum expected profit to enter a trade (1-2%)
  MIN_PRICE_MOVEMENT_PCT: number;   // Minimum price movement to consider significant
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
  TREND_FILTER_ENABLED: boolean;
  TREND_FILTER_NEUTRAL_BAND_BPS: number;
  TREND_FILTER_LOOKBACK_MIN: number;
};
export function getConfig(): Cfg {
  const e = process.env as Record<string, string>;
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
    DEFAULT_RISK_PCT: Number(e.DEFAULT_RISK_PCT || "1.0"),
    DEFAULT_MAX_LEVERAGE: Number(e.DEFAULT_MAX_LEVERAGE || "10"),
    DAILY_LOSS_LIMIT_PCT: Number(e.DAILY_LOSS_LIMIT_PCT || "5"),
    MIN_STOP_PCT: Number(e.MIN_STOP_PCT || "0.2"),
    MIN_TP_PCT: Number(e.MIN_TP_PCT || "0.4"),
    MIN_FIRST_R: Number(e.MIN_FIRST_R || "1.5"),
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
    LLM_DISABLE: (e.LLM_DISABLE || "false") === "true",
    LLM_MIN_INTERVAL_MS: Number(e.LLM_MIN_INTERVAL_MS || "1000"), // réduit à 1s pour plus de réactivité
    LLM_CACHE_TTL_MIN: Number(e.LLM_CACHE_TTL_MIN || "30"), // réduit de 60 à 30 min
    BREAKOUT_CONFIRM_TICKS: Number(e.BREAKOUT_CONFIRM_TICKS || "2"),
    BREAKOUT_HYSTERESIS_PCT: Number(e.BREAKOUT_HYSTERESIS_PCT || "0.15"),
    REVERSE_ON_BREAKOUT: (e.REVERSE_ON_BREAKOUT || "false") === "true",
    TRAIL_PCT: Number(e.TRAIL_PCT || "0"),
    ENTRY_SHORT_MIN_ADX: Number(e.ENTRY_SHORT_MIN_ADX || "18"),
    ENTRY_SHORT_MIN_RSI: Number(e.ENTRY_SHORT_MIN_RSI || "45"),
    ENTRY_LONG_MIN_ADX: Number(e.ENTRY_LONG_MIN_ADX || "14"),
    ENTRY_LONG_MAX_RSI: Number(e.ENTRY_LONG_MAX_RSI || "65"),
    USE_GROK_FOR_ANALYSIS: (e.USE_GROK_FOR_ANALYSIS || "true") === "true",
    USE_GROK_FOR_STRATEGY: (e.USE_GROK_FOR_STRATEGY || "false") === "true",
    USE_GROK_FOR_PLAN: (e.USE_GROK_FOR_PLAN || "false") === "true",
    GROK_ANALYSIS_DAILY_MAX: Number(e.GROK_ANALYSIS_DAILY_MAX || "10"), // augmenté pour plus d'analyses
    GROK_REVERSAL_PCT_THRESHOLD: Number(e.GROK_REVERSAL_PCT_THRESHOLD || "3.5"),
    STALE_TICK_SEC: Number(e.STALE_TICK_SEC || "300"),  // 5 min instead of 2 min for crypto
    ORDER_FILL_TIMEOUT_SEC: Number(e.ORDER_FILL_TIMEOUT_SEC || "10"),
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
    MIN_HOLD_TIME_MS: Number(e.MIN_HOLD_TIME_MS || "300000"), // 5 minutes minimum
    TRADE_COOLDOWN_MS: Number(e.TRADE_COOLDOWN_MS || "120000"), // 2 minutes cooldown
    CRITICAL_LOSS_PCT: Number(e.CRITICAL_LOSS_PCT || "2.0"), // 2% loss = immediate exit
    // Trade quality filters
    MIN_TRADE_PROFIT_PCT: Number(e.MIN_TRADE_PROFIT_PCT || "1.5"), // 1.5% minimum expected profit
    MIN_PRICE_MOVEMENT_PCT: Number(e.MIN_PRICE_MOVEMENT_PCT || "1.0"), // 1% minimum movement to be significant
    QUALITY_MIN_SCORE_CONSERVATIVE: Number(e.QUALITY_MIN_SCORE_CONSERVATIVE || "48"),
    QUALITY_MIN_SCORE_REACTIVE: Number(e.QUALITY_MIN_SCORE_REACTIVE || "38"),
    QUALITY_MIN_SCORE_AGGRESSIVE: Number(e.QUALITY_MIN_SCORE_AGGRESSIVE || "30"),
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
    TREND_FILTER_ENABLED: (e.TREND_FILTER_ENABLED || "false") === "true",
    TREND_FILTER_NEUTRAL_BAND_BPS: Number(e.TREND_FILTER_NEUTRAL_BAND_BPS || "15"),
    TREND_FILTER_LOOKBACK_MIN: Number(e.TREND_FILTER_LOOKBACK_MIN || "240"),
    ORDER_FILL_POLL_MS: Number(e.ORDER_FILL_POLL_MS || "300"),
    ORDER_RETRY_MAX: Number(e.ORDER_RETRY_MAX || "2"),
    PLAN_LLM_COOLDOWN_MIN: Number(e.PLAN_LLM_COOLDOWN_MIN || "5"), // réduit de 15 à 5 min
    PLAN_LLM_MAX_PER_HOUR: Number(e.PLAN_LLM_MAX_PER_HOUR || "10"), // augmenté de 3 à 10
    COOLDOWN_CONFIDENCE_MIN: Number(e.COOLDOWN_CONFIDENCE_MIN || "0.6"),
    COOLDOWN_MOMENTUM_THRESHOLD: Number(e.COOLDOWN_MOMENTUM_THRESHOLD || "0.3"),
    ENTRY_MIN_ATR_PCT: Number(e.ENTRY_MIN_ATR_PCT || "1.0"),  // Revert to higher minimum for crypto
    ENTRY_MIN_SLOPE_ABS_PCT: Number(e.ENTRY_MIN_SLOPE_ABS_PCT || "0.03"),
  };
}
