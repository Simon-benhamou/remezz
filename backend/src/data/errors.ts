export type InsufficientDataMeta = {
  symbol: string;
  timeframe: string;
  availableBars: number;
  minBarsNeeded: number;
  firstBarAt?: number | null;
  lastBarAt?: number | null;
  warmupState?: {
    attempts: number;
    lastAttempt?: number;
    pending: boolean;
    lastError?: string;
    fulfilled?: boolean;
    nextRetryTs?: number;
  };
  /** Optional machine-readable reason for why the data is insufficient */
  reason?: string;
  /** Extra diagnostic details related to the data anomaly */
  details?: Record<string, unknown>;
};

export class InsufficientDataError extends Error {
  readonly meta: InsufficientDataMeta;

  constructor(message: string, meta: InsufficientDataMeta) {
    super(message);
    this.name = 'InsufficientDataError';
    this.meta = meta;
  }
}

export function isInsufficientDataError(error: unknown): error is InsufficientDataError {
  return error instanceof InsufficientDataError;
}

export type UnusableMarketDataMeta = {
  symbol: string;
  timeframe: string;
  invalidRatio: number;
  windowSize: number;
  zeroCount: number;
  nullCount: number;
  attempts?: number;
};

export class UnusableMarketDataError extends Error {
  readonly meta: UnusableMarketDataMeta;

  constructor(message: string, meta: UnusableMarketDataMeta) {
    super(message);
    this.name = 'UnusableMarketDataError';
    this.meta = meta;
  }
}

export function isUnusableMarketDataError(error: unknown): error is UnusableMarketDataError {
  return error instanceof UnusableMarketDataError;
}
