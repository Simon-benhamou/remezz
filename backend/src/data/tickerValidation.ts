import { createHash } from 'node:crypto';
import { getConfig } from '../utils/env.js';

export type FrameSource = 'WS' | 'REST';

export type ValidationRuleId =
  | 'non_positive_last'
  | 'non_positive_bid'
  | 'non_positive_ask'
  | 'bid_gt_ask'
  | 'high_lt_low'
  | 'last_out_of_bounds'
  | 'negative_base_volume'
  | 'negative_quote_volume'
  | 'nan_base_volume'
  | 'nan_quote_volume'
  | 'timestamp_drift'
  | 'symbol_mismatch'
  | 'stale_frame';

export interface NormalizedTickerFrame {
  symbol?: string;
  last?: number;
  bid?: number;
  ask?: number;
  high?: number;
  low?: number;
  baseVolume?: number;
  quoteVolume?: number;
  timestamp?: number;
}

export interface TickerValidationResult {
  status: 'accepted' | 'stale' | 'rejected';
  ruleId?: ValidationRuleId;
  dataAgeMs: number;
  timestamp: number;
  frameSymbolId: string;
  expectedSymbolId?: string;
}

export interface EvaluateTickerFrameParams {
  symbol: string;
  frame: NormalizedTickerFrame;
  source: FrameSource;
  receivedAt: number;
  expectedSymbolId?: string;
}

function toNumber(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeSymbolId(value?: string | null): string {
  if (!value) return '';
  const str = String(value);
  const base = str.includes(':') ? str.split(':')[0] : str;
  return base.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as any)[key])}`);
  return `{${entries.join(',')}}`;
}

export function computeInputHash(frame: unknown): string {
  try {
    const serialized = stableStringify(frame);
    return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
  } catch {
    return '0000000000000000';
  }
}

export function evaluateTickerFrame(params: EvaluateTickerFrameParams): TickerValidationResult {
  const cfg = getConfig();
  const { frame, symbol, receivedAt, expectedSymbolId } = params;
  const frameSymbolId = normalizeSymbolId(frame.symbol || symbol);
  const expectedId = expectedSymbolId ? normalizeSymbolId(expectedSymbolId) : frameSymbolId;

  if (expectedId && frameSymbolId && expectedId !== frameSymbolId) {
    return {
      status: 'rejected',
      ruleId: 'symbol_mismatch',
      dataAgeMs: 0,
      timestamp: receivedAt,
      frameSymbolId,
      expectedSymbolId: expectedId,
    };
  }

  const last = toNumber(frame.last);
  if (!Number.isFinite(last) || (last as number) <= 0) {
    return {
      status: 'rejected',
      ruleId: 'non_positive_last',
      dataAgeMs: 0,
      timestamp: receivedAt,
      frameSymbolId,
      expectedSymbolId: expectedId,
    };
  }

  const bid = toNumber(frame.bid);
  if (!Number.isFinite(bid) || (bid as number) <= 0) {
    return {
      status: 'rejected',
      ruleId: 'non_positive_bid',
      dataAgeMs: 0,
      timestamp: receivedAt,
      frameSymbolId,
      expectedSymbolId: expectedId,
    };
  }

  const ask = toNumber(frame.ask);
  if (!Number.isFinite(ask) || (ask as number) <= 0) {
    return {
      status: 'rejected',
      ruleId: 'non_positive_ask',
      dataAgeMs: 0,
      timestamp: receivedAt,
      frameSymbolId,
      expectedSymbolId: expectedId,
    };
  }

  if ((bid as number) > (ask as number)) {
    return {
      status: 'rejected',
      ruleId: 'bid_gt_ask',
      dataAgeMs: 0,
      timestamp: receivedAt,
      frameSymbolId,
      expectedSymbolId: expectedId,
    };
  }

  const high = toNumber(frame.high);
  const low = toNumber(frame.low);
  if (Number.isFinite(high) && Number.isFinite(low) && (high as number) < (low as number)) {
    return {
      status: 'rejected',
      ruleId: 'high_lt_low',
      dataAgeMs: 0,
      timestamp: receivedAt,
      frameSymbolId,
      expectedSymbolId: expectedId,
    };
  }

  if (
    Number.isFinite(high) &&
    Number.isFinite(low) &&
    ((last as number) < (low as number) || (last as number) > (high as number))
  ) {
    return {
      status: 'rejected',
      ruleId: 'last_out_of_bounds',
      dataAgeMs: 0,
      timestamp: receivedAt,
      frameSymbolId,
      expectedSymbolId: expectedId,
    };
  }

  const baseVolume = toNumber(frame.baseVolume);
  if (baseVolume === undefined) {
    if (frame.baseVolume !== undefined && frame.baseVolume !== null) {
      return {
        status: 'rejected',
        ruleId: 'nan_base_volume',
        dataAgeMs: 0,
        timestamp: receivedAt,
        frameSymbolId,
        expectedSymbolId: expectedId,
      };
    }
  } else if (baseVolume < 0) {
    return {
      status: 'rejected',
      ruleId: 'negative_base_volume',
      dataAgeMs: 0,
      timestamp: receivedAt,
      frameSymbolId,
      expectedSymbolId: expectedId,
    };
  }

  const quoteVolume = toNumber(frame.quoteVolume);
  if (quoteVolume === undefined) {
    if (frame.quoteVolume !== undefined && frame.quoteVolume !== null) {
      return {
        status: 'rejected',
        ruleId: 'nan_quote_volume',
        dataAgeMs: 0,
        timestamp: receivedAt,
        frameSymbolId,
        expectedSymbolId: expectedId,
      };
    }
  } else if (quoteVolume < 0) {
    return {
      status: 'rejected',
      ruleId: 'negative_quote_volume',
      dataAgeMs: 0,
      timestamp: receivedAt,
      frameSymbolId,
      expectedSymbolId: expectedId,
    };
  }

  const frameTimestamp = toNumber(frame.timestamp) ?? receivedAt;
  const maxDriftMs = params.source === 'WS'
    ? cfg.WS_MAX_TIMESTAMP_DRIFT_MS
    : cfg.REST_MAX_TIMESTAMP_DRIFT_MS;
  const aheadByMs = Math.max(0, frameTimestamp - receivedAt);
  const dataAgeMs = Math.max(0, receivedAt - frameTimestamp);

  if (aheadByMs > maxDriftMs) {
    return {
      status: 'rejected',
      ruleId: 'timestamp_drift',
      dataAgeMs: aheadByMs,
      timestamp: frameTimestamp,
      frameSymbolId,
      expectedSymbolId: expectedId,
    };
  }

  if (params.source === 'WS' && dataAgeMs > maxDriftMs) {
    return {
      status: 'stale',
      ruleId: 'timestamp_drift',
      dataAgeMs,
      timestamp: frameTimestamp,
      frameSymbolId,
      expectedSymbolId: expectedId,
    };
  }

  if (dataAgeMs > cfg.MARKET_STALE_THRESHOLD_MS) {
    return {
      status: 'stale',
      ruleId: 'stale_frame',
      dataAgeMs,
      timestamp: frameTimestamp,
      frameSymbolId,
      expectedSymbolId: expectedId,
    };
  }

  return {
    status: 'accepted',
    dataAgeMs,
    timestamp: frameTimestamp,
    frameSymbolId,
    expectedSymbolId: expectedId,
  };
}
