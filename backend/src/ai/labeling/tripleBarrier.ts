import type { ContextFeatures } from '../features/featureBuilder.js';

export type TripleBarrierParams = { k_tp: number; k_sl: number; horizonBars: number };

export interface TripleBarrierInput {
  context: ContextFeatures;
  ohlcv15m: number[][];
  side: 'long' | 'short';
  params: TripleBarrierParams;
  notional: number;
}

export type TripleBarrierLabel = 0 | 1 | null;

export interface LabeledRow {
  x: ContextFeatures;
  y: TripleBarrierLabel;
  meta: {
    symbol: string;
    ts: number;
    side: 'long' | 'short';
  };
}

export function generateTripleBarrierLabel(input: TripleBarrierInput): { label: TripleBarrierLabel; tpUsd: number; slUsd: number } {
  const { ohlcv15m, side, params, notional } = input;
  if (ohlcv15m.length < 2) {
    return { label: null, tpUsd: 0, slUsd: 0 };
  }
  const entry = ohlcv15m[ohlcv15m.length - 1];
  const entryPrice = Number(entry[4]);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error('Invalid entry price for triple barrier');
  }
  const atrPct = computeAtrPercent(ohlcv15m, 14);
  const tpDistance = atrPct * params.k_tp * entryPrice;
  const slDistance = atrPct * params.k_sl * entryPrice;
  const tpUsd = notional * params.k_tp * atrPct;
  const slUsd = notional * params.k_sl * atrPct;
  const horizon = params.horizonBars;
  const startIndex = ohlcv15m.length - 1;
  const endIndex = Math.min(ohlcv15m.length - 1 + horizon, ohlcv15m.length + horizon - 1);
  for (let i = startIndex + 1; i <= endIndex; i++) {
    const row = ohlcv15m[i];
    if (!row) break;
    const high = Number(row[2]);
    const low = Number(row[3]);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
    if (side === 'long') {
      if (high >= entryPrice + tpDistance) {
        return { label: 1, tpUsd, slUsd };
      }
      if (low <= entryPrice - slDistance) {
        return { label: 0, tpUsd, slUsd };
      }
    } else {
      if (low <= entryPrice - tpDistance) {
        return { label: 1, tpUsd, slUsd };
      }
      if (high >= entryPrice + slDistance) {
        return { label: 0, tpUsd, slUsd };
      }
    }
  }
  return { label: null, tpUsd, slUsd };
}

function computeAtrPercent(ohlcv: number[][], period: number): number {
  if (ohlcv.length <= period) {
    return 0.01;
  }
  let total = 0;
  for (let i = ohlcv.length - period; i < ohlcv.length; i++) {
    const row = ohlcv[i];
    const prev = ohlcv[i - 1];
    if (!row || !prev) continue;
    const high = Number(row[2]);
    const low = Number(row[3]);
    const prevClose = Number(prev[4]);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    total += tr;
  }
  const atr = total / period;
  const lastClose = Number(ohlcv[ohlcv.length - 1]?.[4] ?? 0);
  if (!Number.isFinite(lastClose) || lastClose === 0) return 0.01;
  return atr / Math.abs(lastClose);
}
