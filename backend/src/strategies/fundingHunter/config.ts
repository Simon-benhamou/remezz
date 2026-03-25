export const FUNDING_HUNTER_CONFIG = {
  // Entry thresholds (fundingRate as %)
  HIGH_FUNDING_ENTRY: 0.01,      // Enter SHORT when funding > 0.01% (longs pay shorts)
  LOW_FUNDING_ENTRY: -0.01,      // Enter LONG when funding < -0.01% (shorts pay longs)

  // Extreme levels for higher confidence
  EXTREME_FUNDING: 0.03,         // Funding > 0.03% = very crowded

  // Position management
  HOLD_CANDLES: 32,              // Hold 32 * 15m = 8h (one funding period)
  MAX_HOLD_CANDLES: 96,          // Max hold 96 * 15m = 24h (3 funding periods)

  // Risk
  STOP_LOSS_PCT: 3.0,            // Hard stop
  TRAILING_ACTIVATION_PCT: 1.0,  // Start trailing after 1%
  TRAILING_DISTANCE_PCT: 0.8,    // Trail at 0.8%

  // Leverage
  LEVERAGE: 5,

  // Progressive sizing based on funding magnitude
  BASE_POSITION_PCT: 0.03,      // 3% of capital base
  EXTREME_POSITION_PCT: 0.06,   // 6% when funding is extreme

  // Direction filter
  SHORT_ONLY: false,            // Only SHORT on positive funding

  // Trailing enabled
  TRAILING_ENABLED: true,
} as const;
