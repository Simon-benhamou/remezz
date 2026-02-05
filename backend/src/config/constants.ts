/**
 * Centralized constants for magic numbers used across the trading system.
 * Eliminates scattered hardcoded literals in simpleAgent.ts and orderQueue.ts.
 */

// Global BTC cache TTLs (shared between all agents to reduce API calls)
export const CACHE_TTLS = {
  BTC_15M_MS: 300_000,        // 5 minutes (WS is primary, REST fallback)
  BTC_1H_MS: 900_000,         // 15 minutes (1h candles change less frequently)
  LEVERAGE_MS: 3_600_000,     // 1 hour (leverage rarely changes)
  SYMBOL_CANDLE_MS: 120_000,  // 2 minutes per-symbol candle cache
} as const;

// Sync intervals for live trading operations
export const SYNC_INTERVALS = {
  BALANCE_MS: 30_000,         // 30s max between balance syncs
  POSITION_MS: 600_000,       // 10 minutes - avoid REST spam / IP bans
  MISSING_TRADES_MS: 300_000, // 5 minutes between missing trade checks
} as const;

// Order queue configuration (tuned for Binance Futures limits)
export const ORDER_QUEUE = {
  MAX_CONCURRENT: 3,              // Safe for Binance (allows 40/sec)
  DELAY_MS: 350,                  // ~8 orders/sec (well under 40/sec limit)
  MAX_RETRIES: 2,                 // Max retry attempts
  DEFAULT_TIMEOUT_MS: 30_000,     // Max wait time per order
  EXECUTION_TIMEOUT_MS: 10_000,   // Max time for exchange API call
  MAX_QUEUE_SIZE: 5000,           // Support 1000 agents × 5 orders
  RESULT_CACHE_TTL_MS: 300_000,   // 5 minutes result cache
  HEALTH_CHECK_INTERVAL_MS: 60_000, // 1 minute health check
} as const;

// WebSocket throttling
export const WS_THROTTLE = {
  UNHEALTHY_WARN_MS: 30_000,  // Max once per 30s per agent
} as const;
