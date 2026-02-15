import { toBinanceSymbolId, BINANCE_REST_BASE_URL } from './binanceWebSocket.js';
import { binanceRestQueue, BINANCE_WEIGHTS } from './binanceRestQueue.js';
import { isIpBanned, getIpBanExpiry, resetCcxtIpBan } from '../exchange/ccxtClient.js';

const REST_ZERO_LOG_INTERVAL_MS = 60_000;
const restZeroLogTs = new Map<string, number>();

const MAX_KLINE_LIMIT = 1500;

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

/**
 * Fetch OHLCV candles from Binance REST API.
 *
 * All calls are routed through binanceRestQueue (single gateway)
 * which handles: weight tracking, IP ban detection, priority ordering,
 * rate limiting, and retry logic.
 */
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

  // Route through binanceRestQueue — single gateway for ALL Binance REST calls.
  // Queue handles: canMakeCall(), record(), IP ban detection, retry, priority ordering.
  const payload = await binanceRestQueue.enqueue(
    async () => {
      const response = await fetchImpl(url, { signal: options?.signal });

      if (response.status === 429) {
        throw new Error('binance_rest_rate_limited');
      }

      if (response.status === 418 || !response.ok) {
        const body = await response.text().catch(() => '');
        const error = new Error(`binance_rest_http_${response.status}: ${body}`);
        // Include ban info in error message so queue's handleIpBan can parse it
        if (body.includes('"code":-1003') && body.includes('banned until')) {
          (error as any).message = `IP banned - ${body}`;
        }
        throw error;
      }

      const json = await response.json();
      if (!Array.isArray(json)) {
        throw new Error('binance_rest_invalid_payload');
      }
      return json;
    },
    {
      weight: BINANCE_WEIGHTS.FETCH_OHLCV,
      priority: 'low',
      tag: `ohlcv:${symbolId}:${timeframe}`,
    },
  );

  const normalized: number[][] = [];
  let zeroVolumeCount = 0;
  let zeroOhlcCount = 0;
  let nonFiniteRowCount = 0;
  for (const row of payload) {
    const parsed = normalizeRow(row);
    if (parsed) {
      normalized.push(parsed);
      const [, open, high, low, close, volume] = parsed;
      const ohlcValues = [open, high, low, close];
      let rowHasNonFinite = false;
      if (ohlcValues.some((value) => !Number.isFinite(value))) {
        rowHasNonFinite = true;
      }
      if (ohlcValues.every((value) => Number.isFinite(value) && value === 0)) {
        zeroOhlcCount += 1;
      }
      if (!Number.isFinite(volume)) {
        rowHasNonFinite = true;
      } else if (volume === 0) {
        zeroVolumeCount += 1;
      }
      if (rowHasNonFinite) {
        nonFiniteRowCount += 1;
      }
    } else {
      nonFiniteRowCount += 1;
    }
  }

  if (zeroVolumeCount || zeroOhlcCount || nonFiniteRowCount) {
    const key = `${symbol}:${timeframe}`;
    const now = Date.now();
    const lastLog = restZeroLogTs.get(key) || 0;
    if (now - lastLog >= REST_ZERO_LOG_INTERVAL_MS) {
      restZeroLogTs.set(key, now);
      console.warn('[REST][OHLCV_ANOMALY]', {
        symbol,
        timeframe,
        limit: boundedLimit,
        rows: payload.length,
        normalizedRows: normalized.length,
        zeroVolumeCount,
        zeroOhlcCount,
        nonFiniteRowCount,
        sample: normalized.slice(-3),
      });
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

/** Check if Binance REST is currently IP banned (delegates to ccxtClient) */
export function isBinanceRestIpBanned(): boolean {
  return isIpBanned();
}

/** Get IP ban expiry timestamp (delegates to ccxtClient) */
export function getBinanceIpBanExpiry(): number {
  return getIpBanExpiry();
}

/** Emergency reset of IP ban state (delegates to ccxtClient) */
export function resetBinanceIpBan(): { wasSet: boolean; previousExpiry: number } {
  return resetCcxtIpBan();
}
