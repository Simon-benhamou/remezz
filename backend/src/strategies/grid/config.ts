export const GRID_CONFIG = {
  // Range detection
  RANGE_LOOKBACK_CANDLES: 96,    // 96 * 15m = 24h lookback
  RANGE_PERCENTILE_LOW: 0.25,
  RANGE_PERCENTILE_HIGH: 0.75,

  // Grid levels
  GRID_LEVELS: 5,
  GRID_SPACING_PCT: 0.5,

  // Entry
  ENTRY_THRESHOLD_PCT: 0.3,

  // Exit
  TAKE_PROFIT_GRIDS: 1,
  STOP_LOSS_PCT: 3.0,
  MAX_HOLD_MINUTES: 2880,       // 48h

  // Risk
  TREND_FILTER_ADX_MAX: 25,
  MIN_RANGE_PCT: 2.0,
  MAX_RANGE_PCT: 15.0,
} as const;
