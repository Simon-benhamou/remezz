/**
 * CacheManager - Mutex-protected global caches for BTC candles and leverage.
 *
 * Wraps the 3 global caches (BTC 15m, BTC 1h, leverage) with Promise-based
 * mutex to prevent race conditions when multiple agents read/write concurrently.
 * Also deduplicates in-flight fetch promises so only one REST call is made.
 */

import { CACHE_TTLS } from '../config/constants.js';
import type { Candle } from './momentumSimple.js';

interface CandleCacheEntry {
  candles: Candle[];
  fetchedAt: number;
}

export class CacheManager {
  // BTC 15m candle cache
  private btc15mCache: CandleCacheEntry | null = null;
  private btc15mLock: Promise<void> = Promise.resolve();
  private btc15mLockResolve: (() => void) | null = null;
  private btc15mFetchingPromise: Promise<Candle[]> | null = null;

  // BTC 1h candle cache
  private btc1hCache: CandleCacheEntry | null = null;
  private btc1hLock: Promise<void> = Promise.resolve();
  private btc1hLockResolve: (() => void) | null = null;
  private btc1hFetchingPromise: Promise<Candle[]> | null = null;

  // Leverage cache: key = `${userId}:${symbol}:${leverage}`, value = timestamp
  private leverageMap: Map<string, number> = new Map();
  private leverageLock: Promise<void> = Promise.resolve();
  private leverageLockResolve: (() => void) | null = null;

  // BTC WS subscription tracking
  private btc15mWsSubscribed = false;

  // ── BTC 15m Cache ──────────────────────────────────────────────────────

  getBtc15mCache(): CandleCacheEntry | null {
    return this.btc15mCache;
  }

  setBtc15mCache(candles: Candle[]): void {
    this.btc15mCache = { candles, fetchedAt: Date.now() };
  }

  isBtc15mCacheValid(): boolean {
    return this.btc15mCache !== null &&
      Date.now() - this.btc15mCache.fetchedAt < CACHE_TTLS.BTC_15M_MS;
  }

  getBtc15mWsSubscribed(): boolean {
    return this.btc15mWsSubscribed;
  }

  setBtc15mWsSubscribed(value: boolean): void {
    this.btc15mWsSubscribed = value;
  }

  /**
   * Deduplicate concurrent BTC 15m fetches.
   * If a fetch is already in-flight, returns the existing promise.
   */
  getBtc15mFetchingPromise(): Promise<Candle[]> | null {
    return this.btc15mFetchingPromise;
  }

  setBtc15mFetchingPromise(promise: Promise<Candle[]> | null): void {
    this.btc15mFetchingPromise = promise;
  }

  // ── BTC 1h Cache ───────────────────────────────────────────────────────

  getBtc1hCache(): CandleCacheEntry | null {
    return this.btc1hCache;
  }

  setBtc1hCache(candles: Candle[]): void {
    this.btc1hCache = { candles, fetchedAt: Date.now() };
  }

  isBtc1hCacheValid(minFinalCandles?: number): boolean {
    if (!this.btc1hCache || Date.now() - this.btc1hCache.fetchedAt >= CACHE_TTLS.BTC_1H_MS) {
      return false;
    }
    if (minFinalCandles !== undefined) {
      const finalCount = this.btc1hCache.candles.filter(c => c.isFinal !== false).length;
      return finalCount >= minFinalCandles;
    }
    return true;
  }

  getBtc1hFetchingPromise(): Promise<Candle[]> | null {
    return this.btc1hFetchingPromise;
  }

  setBtc1hFetchingPromise(promise: Promise<Candle[]> | null): void {
    this.btc1hFetchingPromise = promise;
  }

  // ── Leverage Cache ─────────────────────────────────────────────────────

  private getLeverageKey(userId: string, symbol: string, leverage: number): string {
    return `${userId}:${symbol}:${leverage}`;
  }

  isLeverageCached(userId: string, symbol: string, leverage: number): boolean {
    const key = this.getLeverageKey(userId, symbol, leverage);
    const cachedAt = this.leverageMap.get(key);
    if (!cachedAt) return false;
    if (Date.now() - cachedAt > CACHE_TTLS.LEVERAGE_MS) {
      this.leverageMap.delete(key);
      return false;
    }
    return true;
  }

  cacheLeverage(userId: string, symbol: string, leverage: number): void {
    const key = this.getLeverageKey(userId, symbol, leverage);
    this.leverageMap.set(key, Date.now());
    // Cleanup old entries when map grows large
    if (this.leverageMap.size > 100) {
      const now = Date.now();
      for (const [k, v] of this.leverageMap.entries()) {
        if (now - v > CACHE_TTLS.LEVERAGE_MS) {
          this.leverageMap.delete(k);
        }
      }
    }
  }

  // ── Mutex helpers (Promise-based) ──────────────────────────────────────

  async acquireBtc15mLock(): Promise<void> {
    await this.btc15mLock;
    this.btc15mLock = new Promise<void>(resolve => { this.btc15mLockResolve = resolve; });
  }

  releaseBtc15mLock(): void {
    if (this.btc15mLockResolve) {
      this.btc15mLockResolve();
      this.btc15mLockResolve = null;
    }
  }

  async acquireBtc1hLock(): Promise<void> {
    await this.btc1hLock;
    this.btc1hLock = new Promise<void>(resolve => { this.btc1hLockResolve = resolve; });
  }

  releaseBtc1hLock(): void {
    if (this.btc1hLockResolve) {
      this.btc1hLockResolve();
      this.btc1hLockResolve = null;
    }
  }

  async acquireLeverageLock(): Promise<void> {
    await this.leverageLock;
    this.leverageLock = new Promise<void>(resolve => { this.leverageLockResolve = resolve; });
  }

  releaseLeverageLock(): void {
    if (this.leverageLockResolve) {
      this.leverageLockResolve();
      this.leverageLockResolve = null;
    }
  }
}

/** Global singleton shared by all agents */
export const globalCacheManager = new CacheManager();
