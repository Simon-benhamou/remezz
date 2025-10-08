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
