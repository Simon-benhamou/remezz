export const PULLBACK_CONFIG = {
  // Trend detection
  TREND_SMA_PERIOD: 50,           // SMA period for trend detection
  TREND_REQUIRE_BTC_ALIGN: true,  // Require BTC trend alignment

  // Pullback detection (Bollinger Bands)
  BB_PERIOD: 20,
  BB_STD: 2.0,

  // Entry filters
  RSI_PERIOD: 14,
  RSI_OVERSOLD: 35,              // For long pullback entries
  RSI_OVERBOUGHT: 65,            // For short pullback entries
  VOLUME_MIN: 1.0,               // Minimum volume ratio (1.0 = average)
  ADX_MIN: 15,                   // Minimum ADX to confirm trend exists

  // Exit - trailing to let trend run
  STOP_LOSS_PCT: 2.0,            // Tight SL if pullback fails
  TRAILING_ACTIVATION_PCT: 1.0,  // Start trailing after 1% profit
  TRAILING_DISTANCE_PCT: 1.5,    // Wide trailing to let trend continue
  MAX_HOLD_MINUTES: 2880,        // 48h max

  // Progressive trailing (wider trail on bigger moves)
  PROGRESSIVE_TRAIL_ENABLED: true,
  TIER2_PROFIT_PCT: 3.0,         // At 3% profit, widen trail
  TIER2_TRAIL_PCT: 2.5,          // To 2.5%
  TIER3_PROFIT_PCT: 6.0,         // At 6% profit, widen more
  TIER3_TRAIL_PCT: 4.0,          // To 4.0%
} as const;
