export const MEAN_REV_4H_CONFIG = {
  // Timeframe
  CANDLE_AGGREGATE: 16,          // 16 * 15m = 4h candles

  // Bollinger Bands
  BB_PERIOD: 20,                 // 20 * 4h = 80h = ~3.3 days
  BB_STD_ENTRY: 2.0,
  BB_STD_EXIT: 0.5,

  // RSI
  RSI_PERIOD: 14,
  RSI_OVERSOLD: 30,
  RSI_OVERBOUGHT: 70,

  // Volume
  VOLUME_MIN: 1.0,

  // ADX trend filter
  ADX_MAX: 30,                   // Skip if trending too hard

  // Risk
  STOP_LOSS_PCT: 3.0,
  TRAILING_ACTIVATION_PCT: 2.0,  // Wider activation for 4h
  TRAILING_DISTANCE_PCT: 1.5,
  MAX_HOLD_MINUTES: 5760,        // 4 days max

  // Progressive trailing
  PROGRESSIVE_ENABLED: true,
  TIER2_PROFIT_PCT: 4.0,
  TIER2_TRAIL_PCT: 2.5,
  TIER3_PROFIT_PCT: 8.0,
  TIER3_TRAIL_PCT: 4.0,
} as const;
