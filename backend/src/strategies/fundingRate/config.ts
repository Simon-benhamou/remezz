export const FUNDING_CONFIG = {
  // Funding thresholds
  HIGH_FUNDING_PCT: 0.05,        // Enter when funding > 0.05% per 8h (~23%/year)
  LOW_FUNDING_PCT: -0.05,        // Enter when funding < -0.05%

  // Position management
  HOLD_HOURS: 8,                 // Hold for one funding period
  MAX_HOLD_HOURS: 24,            // Max hold 3 funding periods
  STOP_LOSS_PCT: 2.0,            // Protection against adverse move

  // We simulate funding by checking price trend
  // When price goes up fast -> longs pay shorts (positive funding)
  // We SHORT when funding is positive (collect payment)
  // Proxy: use recent momentum as funding proxy
  MOMENTUM_LOOKBACK: 32,         // 32 * 15m = 8h (one funding period)
  MOMENTUM_THRESHOLD_PCT: 2.0,   // 2% move in 8h suggests high funding

  // Direction filter
  SHORT_ONLY: false,             // Only SHORT when momentum positive
} as const;
