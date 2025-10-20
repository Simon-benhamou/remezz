import { createBinanceRestLimiter, toBinanceSymbolId, BINANCE_REST_BASE_URL, BINANCE_REST_429_BACKOFF_MS } from './binanceWebSocket.js';

const MAX_KLINE_LIMIT = 1500;

const ohlcvLimiter = createBinanceRestLimiter();

type FetchImpl = (input: string | URL, init?: any) => Promise<any>;

interface FetchBinanceOhlcvOptions {
  fetchImpl?: FetchImpl;
  signal?: any;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 1;
  const integer = Math.floor(limit);
  return Math.min(MAX_KLINE_LIMIT, Math.max(1, integer));
}

function ensureFetchAvailable(fetchImpl: FetchImpl | undefined): asserts fetchImpl {
  if (typeof fetchImpl !== 'function') {
    throw new Error('binance_rest_fetch_unavailable');
  }
}

function normalizeRow(row: any): number[] | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const [openTime, open, high, low, close, volume] = row;
  const parsed = [openTime, open, high, low, close, volume].map(value => {
    const num = Number(value);
    return Number.isFinite(num) ? num : NaN;
  });
  if (parsed.some(value => Number.isNaN(value))) {
    return null;
  }
  return parsed;
}

export async function fetchBinanceOhlcv(
  symbol: string,
  timeframe: string,
  limit: number,
  options?: FetchBinanceOhlcvOptions,
): Promise<number[][]> {
  const boundedLimit = clampLimit(limit);
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  ensureFetchAvailable(fetchImpl);

  const symbolId = toBinanceSymbolId(symbol);
  if (!symbolId) {
    throw new Error('binance_rest_invalid_symbol');
  }

  const params = new URLSearchParams({
    symbol: symbolId,
    interval: timeframe,
    limit: String(boundedLimit),
  });
  const url = `${BINANCE_REST_BASE_URL}/fapi/v1/klines?${params.toString()}`;

  const response = await ohlcvLimiter.run(() => fetchImpl(url, { signal: options?.signal }));
  if (response.status === 429) {
    ohlcvLimiter.backoff(BINANCE_REST_429_BACKOFF_MS);
    throw new Error('binance_rest_rate_limited');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(`binance_rest_http_${response.status}`);
    (error as any).body = body;
    throw error;
  }

  let payload: any;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('binance_rest_invalid_json');
  }

  if (!Array.isArray(payload)) {
    throw new Error('binance_rest_invalid_payload');
  }

  const normalized: number[][] = [];
  for (const row of payload) {
    const parsed = normalizeRow(row);
    if (parsed) {
      normalized.push(parsed);
    }
  }

  if (!normalized.length) {
    throw new Error('binance_rest_empty');
  }

  if (normalized.length > boundedLimit) {
    return normalized.slice(-boundedLimit);
  }

  return normalized;
}
