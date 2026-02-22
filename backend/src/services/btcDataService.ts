/**
 * btcDataService.ts — Single Source of Truth for BTC Data & Regime
 *
 * Eliminates 6 duplicated BTC regime computations across the codebase.
 * Provides both live (WS-driven) and backtest (cursor-based) implementations.
 *
 * Key design decisions:
 *   - filterClosed() and computeRegime() are pure functions (testable, shared)
 *   - LiveBtcDataService reads directly from WS cache (no TTL-based staleness)
 *   - BacktestBtcDataProvider uses monotonic cursor (O(1) per step)
 *   - Singleton access via getBtcDataService() for live
 */

import { getKlinesWithMeta } from './binanceWebSocket.js';
import { MomentumConfig, type Candle, type MarketConditions, calcSMA, getMarketConditions as getMC } from '../strategies/momentumSimple.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('btc-data-service');

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface BtcRegime {
  trend: 'bullish' | 'bearish';
  btcNow: number;
  btcSma200: number;
  inDeadZone: boolean;
}

export interface BtcDataProvider {
  /** Closed BTC 15m candles only (isFinal !== false filtered) */
  getBtcCandles15m(): Candle[];
  /** Candles used for regime SMA200: 15m or 1h depending on config */
  getBtcCandlesForRegime(): Candle[];
  /** Centralized regime computation */
  getRegime(): BtcRegime | null;
  /** Full market conditions (wraps getMarketConditions from momentumSignal) */
  getMarketConditions(): MarketConditions | null;
  /** Whether the service has enough data to be useful */
  isReady(): boolean;
}

// ══════════════════════════════════════════════════════════════════════════════
// Pure functions — single implementations of previously-duplicated logic
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Filter candles to only closed ones.
 * Single implementation replacing 6 inline variants:
 *   - orchestrator.ts checkEntry (isFinal === false check on last)
 *   - orchestrator.ts checkExit (same)
 *   - orchestrator.ts getMarketConditions (.filter(c => c.isFinal !== false))
 *   - symbolEngine.ts (isFinal === false on last)
 *   - positionOpener.ts (.filter(c => c.isFinal !== false))
 *   - server.ts (no filtering at all — bug)
 */
export function filterClosed(candles: Candle[]): Candle[] {
  if (candles.length === 0) return candles;
  // Only the LAST candle can be in-progress in the WS kline cache.
  // Checking only the last is sufficient and matches symbolEngine/orchestrator logic.
  const last = candles[candles.length - 1];
  if (last.isFinal === false) {
    return candles.slice(0, -1);
  }
  return candles;
}

/**
 * Compute BTC regime from regime candles (15m or 1h depending on config).
 * Single implementation replacing logic duplicated in:
 *   - momentumSignal.ts:388-421 (checkMomentumSignal)
 *   - momentumSignal.ts:56-85 (getMarketConditions)
 *   - positionOpener.ts:104-153 (inline .reduce() SMA200)
 *   - server.ts:582-613 (inline SMA200 on OHLCV arrays)
 *
 * Logic matches momentumSignal.ts:388-421 (tolerance band + slope fallback).
 * Minor simplification: exact btcNow===btcSma200 returns 'bearish' (original had
 * both bull/bear false — unreachable with floating-point BTC prices).
 */
export function computeRegime(regimeCandles: Candle[]): BtcRegime | null {
  const smaPeriod = MomentumConfig.ENTRY.BTC_SMA_PERIOD;
  if (regimeCandles.length < smaPeriod) return null;

  const closes = regimeCandles.map(c => c.close);
  const btcSma200 = calcSMA(closes, smaPeriod);
  const btcNow = closes[closes.length - 1];

  // V5.113: Tolerance band around SMA200
  const tolerancePct = (MomentumConfig.ENTRY as any).BTC_REGIME_TOLERANCE_PCT ?? 0;
  const tolerance = btcSma200 > 0 ? btcSma200 * (tolerancePct / 100) : 0;

  let inDeadZone = false;
  let trend: 'bullish' | 'bearish';

  if (tolerance > 0 && Math.abs(btcNow - btcSma200) <= tolerance) {
    // In dead zone: use SMA200 slope to determine regime
    inDeadZone = true;
    if (closes.length >= smaPeriod + 1) {
      const sma200Prev = calcSMA(closes.slice(-(smaPeriod + 1), -1), smaPeriod);
      trend = btcSma200 >= sma200Prev ? 'bullish' : 'bearish';
    } else {
      trend = btcNow > btcSma200 ? 'bullish' : 'bearish';
    }
  } else {
    trend = btcNow > btcSma200 ? 'bullish' : 'bearish';
  }

  return { trend, btcNow, btcSma200, inDeadZone };
}

// ══════════════════════════════════════════════════════════════════════════════
// LiveBtcDataService — reads WS cache directly, event-driven refresh
// ══════════════════════════════════════════════════════════════════════════════

const MIN_CANDLES_15M = 201; // 200 for SMA200 + 1
const REFRESH_INTERVAL_MS = 5_000; // 5s polling

export class LiveBtcDataService implements BtcDataProvider {
  private btcCandles15m: Candle[] = [];
  private btcCandlesRegime: Candle[] = [];
  private cachedRegime: BtcRegime | null = null;
  private cachedConditions: MarketConditions | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastClosedCandleTs = 0;

  start(): void {
    if (this.refreshTimer) return;
    this.refresh(); // initial
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    logger.info('[BtcDataService] Started (5s refresh)');
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    logger.info('[BtcDataService] Stopped');
  }

  /**
   * Read WS cache, filter closed, recompute regime on candle close.
   */
  refresh(): void {
    // 1. Read BTC 15m from WS cache
    const raw15m = getKlinesWithMeta('BTCUSDT', '15m');
    if (!raw15m || raw15m.length < MIN_CANDLES_15M) return;

    const all15m: Candle[] = raw15m as Candle[];
    this.btcCandles15m = filterClosed(all15m);

    // 2. Determine regime candles based on config
    if (MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME === '15m') {
      this.btcCandlesRegime = this.btcCandles15m;
    } else {
      // Fetch 1h from WS cache
      const raw1h = getKlinesWithMeta('BTCUSDT', '1h');
      if (raw1h && raw1h.length >= MIN_CANDLES_15M) {
        this.btcCandlesRegime = filterClosed(raw1h as Candle[]);
      } else {
        // Fallback to 15m if 1h not ready
        this.btcCandlesRegime = this.btcCandles15m;
      }
    }

    // 3. Detect candle close → recompute regime + conditions
    const newLastTs = this.btcCandles15m.length > 0
      ? this.btcCandles15m[this.btcCandles15m.length - 1].timestamp
      : 0;

    if (newLastTs !== this.lastClosedCandleTs) {
      this.lastClosedCandleTs = newLastTs;
      this.cachedRegime = computeRegime(this.btcCandlesRegime);
      this.cachedConditions = this.buildMarketConditions();
    }
  }

  getBtcCandles15m(): Candle[] {
    return this.btcCandles15m;
  }

  getBtcCandlesForRegime(): Candle[] {
    return this.btcCandlesRegime;
  }

  getRegime(): BtcRegime | null {
    return this.cachedRegime;
  }

  getMarketConditions(): MarketConditions | null {
    return this.cachedConditions;
  }

  isReady(): boolean {
    return this.btcCandles15m.length >= MIN_CANDLES_15M;
  }

  /**
   * Build MarketConditions from cached data.
   * Replaces the inline logic in server.ts and getMarketConditions() calls.
   * Delegates to the existing getMarketConditions function from momentumSignal.
   */
  private buildMarketConditions(): MarketConditions | null {
    if (this.btcCandles15m.length < 200) return null;

    return getMC(this.btcCandles15m, this.btcCandlesRegime);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// BacktestBtcDataProvider — cursor-based for O(1) per-step
// ══════════════════════════════════════════════════════════════════════════════

export class BacktestBtcDataProvider implements BtcDataProvider {
  private btcCandles15m: Candle[];
  private btcCandlesRegimeAll: Candle[];
  private regimeIntervalMs: number;

  // Cursor state (monotonically advancing)
  private btcIdx = 0;
  private regimeCursor = 0;
  private cachedRegimeWindow: Candle[] = [];
  private lastRegimeCursor = -1;
  private cachedRegime: BtcRegime | null = null;

  constructor(
    btcCandles15m: Candle[],
    btcCandlesRegime: Candle[],
    regimeIntervalMs: number,
  ) {
    this.btcCandles15m = btcCandles15m;
    this.btcCandlesRegimeAll = btcCandlesRegime;
    this.regimeIntervalMs = regimeIntervalMs;
  }

  /**
   * Advance cursors to the given BTC candle timestamp.
   * Must be called with monotonically increasing timestamps.
   */
  setCursor(btcCandleTimestamp: number): void {
    // Find btcIdx for this timestamp (advance monotonically)
    while (
      this.btcIdx < this.btcCandles15m.length - 1 &&
      this.btcCandles15m[this.btcIdx + 1].timestamp <= btcCandleTimestamp
    ) {
      this.btcIdx++;
    }

    // Advance regime cursor: include candles whose close time <= btcCandleTimestamp
    while (
      this.regimeCursor < this.btcCandlesRegimeAll.length &&
      this.btcCandlesRegimeAll[this.regimeCursor].timestamp + this.regimeIntervalMs <= btcCandleTimestamp
    ) {
      this.regimeCursor++;
    }

    // Cache regime window only when cursor advances
    if (this.regimeCursor !== this.lastRegimeCursor) {
      this.cachedRegimeWindow = this.btcCandlesRegimeAll.slice(0, this.regimeCursor);
      this.lastRegimeCursor = this.regimeCursor;
      this.cachedRegime = computeRegime(this.cachedRegimeWindow);
    }
  }

  getBtcCandles15m(): Candle[] {
    // Return window up to current btcIdx (exclusive of forming candle)
    const start = Math.max(0, this.btcIdx - 200);
    return this.btcCandles15m.slice(start, this.btcIdx);
  }

  getBtcCandlesForRegime(): Candle[] {
    return this.cachedRegimeWindow;
  }

  getRegime(): BtcRegime | null {
    return this.cachedRegime;
  }

  getMarketConditions(): MarketConditions | null {
    const candles15m = this.getBtcCandles15m();
    if (candles15m.length < 200) return null;
    return getMC(candles15m, this.cachedRegimeWindow);
  }

  isReady(): boolean {
    return this.btcIdx >= 200;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Singleton for live usage
// ══════════════════════════════════════════════════════════════════════════════

let liveBtcDataService: LiveBtcDataService | null = null;

export function getBtcDataService(): LiveBtcDataService {
  if (!liveBtcDataService) {
    liveBtcDataService = new LiveBtcDataService();
  }
  return liveBtcDataService;
}

/** Reset singleton (for tests) */
export function resetBtcDataService(): void {
  if (liveBtcDataService) {
    liveBtcDataService.stop();
    liveBtcDataService = null;
  }
}
