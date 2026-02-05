import { CacheManager } from '../src/strategies/cacheManager.js';
import type { Candle } from '../src/strategies/momentumSimple.js';

function makeCandles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: Date.now() - (n - i) * 60_000,
    open: 100, high: 101, low: 99, close: 100.5, volume: 1000,
    isFinal: i < n - 1,
  }));
}

describe('CacheManager', () => {
  let cache: CacheManager;

  beforeEach(() => {
    cache = new CacheManager();
  });

  describe('BTC 15m cache', () => {
    it('should store and retrieve candles', () => {
      const candles = makeCandles(200);
      cache.setBtc15mCache(candles);
      expect(cache.getBtc15mCache()?.candles).toHaveLength(200);
    });

    it('should report cache as valid within TTL', () => {
      cache.setBtc15mCache(makeCandles(10));
      expect(cache.isBtc15mCacheValid()).toBe(true);
    });

    it('should return null when no cache set', () => {
      expect(cache.getBtc15mCache()).toBeNull();
      expect(cache.isBtc15mCacheValid()).toBe(false);
    });
  });

  describe('BTC 1h cache', () => {
    it('should check minimum final candles', () => {
      const candles = makeCandles(5);
      cache.setBtc1hCache(candles);
      expect(cache.isBtc1hCacheValid(11)).toBe(false);
      expect(cache.isBtc1hCacheValid(3)).toBe(true);
    });
  });

  describe('Leverage cache', () => {
    it('should cache and validate leverage entries', () => {
      cache.cacheLeverage('user1', 'BTC/USDT', 5);
      expect(cache.isLeverageCached('user1', 'BTC/USDT', 5)).toBe(true);
      expect(cache.isLeverageCached('user1', 'BTC/USDT', 10)).toBe(false);
      expect(cache.isLeverageCached('user2', 'BTC/USDT', 5)).toBe(false);
    });
  });

  describe('Mutex (Promise-based)', () => {
    it('should serialize concurrent BTC 15m lock acquisitions', async () => {
      const order: number[] = [];

      const task1 = (async () => {
        await cache.acquireBtc15mLock();
        order.push(1);
        await new Promise(r => setTimeout(r, 50));
        order.push(2);
        cache.releaseBtc15mLock();
      })();

      const task2 = (async () => {
        // Small delay to ensure task1 acquires first
        await new Promise(r => setTimeout(r, 5));
        await cache.acquireBtc15mLock();
        order.push(3);
        cache.releaseBtc15mLock();
      })();

      await Promise.all([task1, task2]);
      // task2 should only start after task1 releases
      expect(order).toEqual([1, 2, 3]);
    });

    it('should serialize concurrent BTC 1h lock acquisitions', async () => {
      const order: number[] = [];

      const task1 = (async () => {
        await cache.acquireBtc1hLock();
        order.push(1);
        await new Promise(r => setTimeout(r, 50));
        order.push(2);
        cache.releaseBtc1hLock();
      })();

      const task2 = (async () => {
        await new Promise(r => setTimeout(r, 5));
        await cache.acquireBtc1hLock();
        order.push(3);
        cache.releaseBtc1hLock();
      })();

      await Promise.all([task1, task2]);
      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe('Fetch promise dedup', () => {
    it('should deduplicate BTC 1h fetch promises', () => {
      expect(cache.getBtc1hFetchingPromise()).toBeNull();
      const promise = Promise.resolve(makeCandles(10));
      cache.setBtc1hFetchingPromise(promise);
      expect(cache.getBtc1hFetchingPromise()).toBe(promise);
      cache.setBtc1hFetchingPromise(null);
      expect(cache.getBtc1hFetchingPromise()).toBeNull();
    });
  });
});
