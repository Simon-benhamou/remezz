import { getConfig } from '../utils/env.js';
import { getCapacityPressure } from '../broker/live.js';
import { getExecutionTuning } from '../services/executionTelemetry.js';

export type ExecutionMode = 'market' | 'limit' | 'twap';

export type MinimalTicker = {
  bid?: number;
  ask?: number;
  last?: number;
  baseVolume?: number;
  quoteVolume?: number;
  info?: any;
};

export type ExecutionContext = {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  notionalUsd: number;
  entryPrice: number;
  ticker?: MinimalTicker | null;
  atrPct?: number | null;
  spreadBps?: number | null;
  volatilityProfile?: string | null;
  playbook?: string | null;
  recentRejections?: number;
  volumeRatio?: number | null;
  confirmationUrgent?: boolean;
  bookDepthUsd?: { bid?: number | null; ask?: number | null } | null;
};

export type ExecutionStep = {
  mode: ExecutionMode;
  reason: string;
  limitPrice?: number;
  passiveOffsetBps?: number;
  postOnly?: boolean;
  twapSlices?: number;
  twapIntervalMs?: number;
  delayMs?: number;
};

export type ExecutionPlan = ExecutionStep & {
  telemetry: Record<string, number | string | boolean | null | undefined>;
  fallbacks: ExecutionStep[];
};

const DEFAULT_LIMIT_SPREAD_THRESHOLD = 12; // 12 bps = 0.12%
const DEFAULT_TWAP_SPREAD_THRESHOLD = 16; // 16 bps = 0.16%
const LARGE_NOTIONAL_THRESHOLD = 15_000;
const EXTREME_NOTIONAL_THRESHOLD = 35_000;

function deriveSpreadBps(context: ExecutionContext): number | null {
  if (typeof context.spreadBps === 'number') return context.spreadBps;
  const { ticker } = context;
  if (!ticker?.bid || !ticker?.ask || ticker.bid <= 0 || ticker.ask <= 0) return null;
  const mid = (ticker.ask + ticker.bid) / 2;
  if (!Number.isFinite(mid) || mid <= 0) return null;
  return ((ticker.ask - ticker.bid) / mid) * 10_000;
}

function derivePassivePrice(
  side: 'buy' | 'sell',
  reference: number,
  ticker: MinimalTicker | null | undefined,
  passiveOffsetBps = 5,
): number {
  if (!ticker) return reference;
  const slip = passiveOffsetBps / 10_000;
  if (side === 'buy') {
    const bid = ticker.bid ?? reference;
    return Math.max(0, Math.min(reference, bid * (1 - slip)));
  }
  const ask = ticker.ask ?? reference;
  return Math.max(reference, ask * (1 + slip));
}

function normalizeVolProfile(volProfile?: string | null): string | null {
  if (!volProfile) return null;
  return String(volProfile).toUpperCase();
}

function estimateLiquidityScore(ticker?: MinimalTicker | null): number {
  if (!ticker) return 0;
  const vol = Number(ticker.quoteVolume ?? ticker.baseVolume ?? ticker.info?.quoteVolume ?? ticker.info?.volume);
  if (!Number.isFinite(vol) || vol <= 0) return 0;
  return Math.max(0, Math.log10(vol + 1));
}

export function chooseExecutionPlan(context: ExecutionContext): ExecutionPlan {
  const cfg = getConfig();
  const spreadBps = deriveSpreadBps(context);
  const spreadPct = spreadBps != null ? spreadBps / 100 : null;
  const atrPct = typeof context.atrPct === 'number' ? Math.max(0, context.atrPct) : null;
  const capacityPressure = getCapacityPressure(context.symbol);
  const volProfile = normalizeVolProfile(context.volatilityProfile);
  const liquidityScore = estimateLiquidityScore(context.ticker);
  const tuning = getExecutionTuning(context.symbol);
  const notional = Math.max(0, context.notionalUsd);
  const trendPlaybook = (context.playbook || '').toLowerCase();
  const depth = context.bookDepthUsd ?? null;
  const bidDepthUsd = depth?.bid != null && Number.isFinite(depth.bid) ? Math.max(0, depth.bid as number) : null;
  const askDepthUsd = depth?.ask != null && Number.isFinite(depth.ask) ? Math.max(0, depth.ask as number) : null;
  const depthComparable = bidDepthUsd != null && askDepthUsd != null
    ? Math.min(bidDepthUsd, askDepthUsd)
    : bidDepthUsd ?? askDepthUsd ?? null;
  const bookImbalance = bidDepthUsd != null && askDepthUsd != null && bidDepthUsd + askDepthUsd > 0
    ? (bidDepthUsd - askDepthUsd) / (bidDepthUsd + askDepthUsd)
    : null;

  let mode: ExecutionMode = 'market';
  const fallbacks: ExecutionStep[] = [];
  const telemetry: Record<string, number | string | boolean | null | undefined> = {
    spreadBps,
    spreadPct,
    atrPct,
    notional,
    capacityPressure,
    liquidityScore,
    volatilityProfile: volProfile,
    playbook: context.playbook || null,
    bookBidDepthUsd: bidDepthUsd,
    bookAskDepthUsd: askDepthUsd,
  };
  telemetry.orderBookImbalance = bookImbalance;

  // Primary heuristics
  const highSpread = spreadBps != null && spreadBps >= (cfg.ORDER_LIMIT_SPREAD_BPS ?? DEFAULT_LIMIT_SPREAD_THRESHOLD);
  const extremeSpread = spreadBps != null && spreadBps >= (cfg.ORDER_TWAP_SPREAD_BPS ?? DEFAULT_TWAP_SPREAD_THRESHOLD);
  const bigNotional = notional >= LARGE_NOTIONAL_THRESHOLD;
  const hugeNotional = notional >= EXTREME_NOTIONAL_THRESHOLD;
  const highPressure = capacityPressure >= 3;
  const trending = trendPlaybook.includes('momentum') || trendPlaybook.includes('breakout');
  const highVol = atrPct != null && atrPct >= (cfg.ORDER_MARKET_ATR_PCT ?? 4);
  const fragileBook = liquidityScore < 2.5; // roughly < ~300 quote volume
  const recentIssues = (context.recentRejections ?? 0) > 0;

  telemetry.highSpread = highSpread;
  telemetry.extremeSpread = extremeSpread;
  telemetry.bigNotional = bigNotional;
  telemetry.hugeNotional = hugeNotional;
  telemetry.trending = trending;
  telemetry.highVol = highVol;
  telemetry.fragileBook = fragileBook;
  telemetry.recentIssues = recentIssues;

  if (hugeNotional || (bigNotional && (extremeSpread || highPressure || fragileBook))) {
    mode = 'twap';
  } else if (extremeSpread || (highSpread && !trending)) {
    mode = 'limit';
  } else if (fragileBook && !highVol) {
    mode = 'limit';
  } else {
    mode = 'market';
  }

  // Trend-friendly override: allow market even on high spread when speed is key
  if (mode !== 'market' && trending && highVol && !recentIssues) {
    mode = 'market';
    telemetry.modeOverride = 'trend_speed_priority';
  }

  if (tuning.modeOverride && tuning.modeOverride !== mode) {
    mode = tuning.modeOverride;
    telemetry.modeOverride = `telemetry_${tuning.modeOverride}`;
  }

  let passiveOffsetBps = mode === 'limit' ? (fragileBook ? 8 : 5) : undefined;
  let limitPrice: number | undefined;
  if (mode === 'limit') {
    if (passiveOffsetBps != null) {
      if (bookImbalance != null) {
        if (context.side === 'buy' && bookImbalance > 0.2) passiveOffsetBps = Math.max(2, passiveOffsetBps - 2);
        if (context.side === 'sell' && bookImbalance < -0.2) passiveOffsetBps = Math.max(2, passiveOffsetBps - 2);
      }
      if (atrPct != null && atrPct > 4) passiveOffsetBps = Math.max(2, passiveOffsetBps - 1);
      if (atrPct != null && atrPct < 1.2) passiveOffsetBps += 1;
      if (tuning.passiveOffsetBps != null) passiveOffsetBps = tuning.passiveOffsetBps;
    }
    limitPrice = derivePassivePrice(context.side, context.entryPrice, context.ticker, passiveOffsetBps);
    let fallbackDelay = Math.max(1800, cfg.ORDER_LIMIT_TIMEOUT_MS ?? 2500);
    if (tuning.limitFallbackMs != null) fallbackDelay = Math.max(1500, tuning.limitFallbackMs);
    if (context.confirmationUrgent) fallbackDelay = Math.max(1200, Math.round(fallbackDelay * 0.75));
    if (depthComparable != null && depthComparable > 0) {
      const depthRatio = notional / depthComparable;
      if (depthRatio > 1.2) fallbackDelay = Math.max(1500, Math.round(fallbackDelay * 0.85));
      else if (depthRatio < 0.6) fallbackDelay = Math.min(Math.round(fallbackDelay * 1.25), fallbackDelay + 1200);
    }
    fallbacks.push({ mode: 'market', reason: 'limit_timeout', delayMs: Math.round(fallbackDelay) });
  }

  if (mode === 'twap') {
    let slices = Math.min(6, Math.max(3, Math.round(notional / 7000)));
    let intervalMs = Math.max(150, Math.min(600, Math.round((spreadPct ?? 0.12) * 1500)));
    if (depthComparable != null && depthComparable > 0) {
      const depthRatio = Math.max(1, Math.ceil(notional / depthComparable));
      slices = Math.max(slices, Math.min(12, depthRatio));
    }
    if (tuning.twapSliceCount != null) slices = Math.max(2, tuning.twapSliceCount);
    if (tuning.twapIntervalMs != null) intervalMs = Math.max(120, tuning.twapIntervalMs);
    fallbacks.push({ mode: 'market', reason: 'twap_slippage_guard', delayMs: Math.max(4000, intervalMs * slices) });
    telemetry.twapSlices = slices;
    telemetry.twapIntervalMs = intervalMs;
  }

  const reasonParts: string[] = [];
  if (mode === 'market') {
    reasonParts.push('market:fast_fill');
    if (highVol) reasonParts.push('high_vol');
    if (trending) reasonParts.push('trend');
  } else if (mode === 'limit') {
    reasonParts.push('limit:protect_spread');
    if (highSpread) reasonParts.push('spread');
    if (fragileBook) reasonParts.push('fragile_book');
  } else {
    reasonParts.push('twap:distribute');
    if (bigNotional) reasonParts.push('size');
    if (highPressure) reasonParts.push('capacity');
  }

  const plan: ExecutionPlan = {
    mode,
    reason: reasonParts.join('|'),
    limitPrice,
    passiveOffsetBps,
    twapSlices: telemetry.twapSlices as number | undefined,
    twapIntervalMs: telemetry.twapIntervalMs as number | undefined,
    fallbacks,
    telemetry,
  };

  return plan;
}
