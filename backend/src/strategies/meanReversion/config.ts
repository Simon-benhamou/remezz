export const MEAN_REV_CONFIG = {
  // Bollinger Bands
  BB_PERIOD: 50,
  BB_STD_ENTRY: 2.5,
  BB_STD_EXIT: 0.5,

  // Volume confirmation
  VOLUME_SPIKE_MIN: 1.5,

  // Risk management
  STOP_LOSS_PCT: 3.0,
  MAX_HOLD_MINUTES: 1440,       // 24h
  TRAILING_AFTER_PCT: 1.5,
  TRAILING_DISTANCE_PCT: 0.8,

  // Filters
  MIN_DEVIATION_PCT: 1.5,
  ADX_MAX: 30,
  RSI_OVERSOLD: 25,
  RSI_OVERBOUGHT: 75,
} as const;
