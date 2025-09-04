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
  USE_GROK: boolean;
  GROK_API_KEY?: string;
  OPENAI_API_KEY?: string;
  DATABASE_URL?: string;
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
    USE_GROK: (e.USE_GROK || "true") === "true",
    GROK_API_KEY: e.GROK_API_KEY || "",
    OPENAI_API_KEY: e.OPENAI_API_KEY || "",
    DATABASE_URL: e.DATABASE_URL || "",
  };
}
