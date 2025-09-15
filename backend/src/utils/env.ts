export type Cfg = {
  EXCHANGE_ID: string;
  SYMBOL: string;
  API_KEY: string;
  API_SECRET: string;
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
  OPENAI_MODEL?: string;      // e.g. gpt-4o-mini
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
};
export function getConfig(): Cfg {
  const e = process.env as Record<string, string>;
  return {
    EXCHANGE_ID: e.EXCHANGE_ID || "cryptocom",
    SYMBOL: e.SYMBOL || "BTCUSDT",
    API_KEY: e.API_KEY || "",
    API_SECRET: e.API_SECRET || "",
    API_PASSWORD: e.API_PASSWORD || "",
    PORT: Number(e.PORT || "4000"),
    // Polling every 5s by default to reduce CCXT rate-limit pressure
    POLL_MS: Number(e.POLL_MS || "5000"),
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
    OPENAI_MODEL: e.OPENAI_MODEL || "gpt-4o-mini",
    DATABASE_URL: e.DATABASE_URL || "",
    OPENAI_COST_IN_PER_1K: Number(e.OPENAI_COST_IN_PER_1K || "0"),
    OPENAI_COST_OUT_PER_1K: Number(e.OPENAI_COST_OUT_PER_1K || "0"),
    GROK_COST_IN_PER_1K: Number(e.GROK_COST_IN_PER_1K || "0"),
    GROK_COST_OUT_PER_1K: Number(e.GROK_COST_OUT_PER_1K || "0"),
    AUTH_USER: e.AUTH_USER || "",
    AUTH_PASS: e.AUTH_PASS || "",
    ACCESS_CODE: e.ACCESS_CODE || "",
    LLM_DISABLE: (e.LLM_DISABLE || "false") === "true",
    LLM_MIN_INTERVAL_MS: Number(e.LLM_MIN_INTERVAL_MS || "5000"),
    LLM_CACHE_TTL_MIN: Number(e.LLM_CACHE_TTL_MIN || "60"),
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
    GROK_ANALYSIS_DAILY_MAX: Number(e.GROK_ANALYSIS_DAILY_MAX || "1"),
    GROK_REVERSAL_PCT_THRESHOLD: Number(e.GROK_REVERSAL_PCT_THRESHOLD || "3.5"),
  };
}
