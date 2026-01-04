/**
 * LRU Cache with TTL support
 *
 * Used for:
 * - WebSocket klines cache (prevent unbounded growth)
 * - API response deduplication
 * - Symbol resolution cache
 *
 * Features:
 * - Maximum size limit with LRU eviction
 * - Per-entry TTL (time-to-live)
 * - Memory-efficient doubly-linked list
 */

interface CacheEntry<T> {
  key: string;
  value: T;
  expiresAt: number;
  prev: CacheEntry<T> | null;
  next: CacheEntry<T> | null;
}

export class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private head: CacheEntry<T> | null = null;
  private tail: CacheEntry<T> | null = null;
  private readonly maxSize: number;
  private readonly defaultTTL: number;

  // Stats
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(maxSize: number, defaultTTL: number = 300_000) {
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL;
  }

  /**
   * Get value from cache
   * Returns undefined if not found or expired
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      this.misses++;
      return undefined;
    }

    // Move to head (most recently used)
    this.moveToHead(entry);
    this.hits++;
    return entry.value;
  }

  /**
   * Set value in cache
   */
  set(key: string, value: T, ttl?: number): void {
    const existing = this.cache.get(key);

    if (existing) {
      // Update existing entry
      existing.value = value;
      existing.expiresAt = Date.now() + (ttl ?? this.defaultTTL);
      this.moveToHead(existing);
      return;
    }

    // Create new entry
    const entry: CacheEntry<T> = {
      key,
      value,
      expiresAt: Date.now() + (ttl ?? this.defaultTTL),
      prev: null,
      next: null,
    };

    this.cache.set(key, entry);
    this.addToHead(entry);

    // Evict if over capacity
    if (this.cache.size > this.maxSize) {
      this.evictLRU();
    }
  }

  /**
   * Delete entry from cache
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    this.removeFromList(entry);
    this.cache.delete(key);
    return true;
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
    this.head = null;
    this.tail = null;
  }

  /**
   * Get or compute value
   * If not in cache, calls factory function and stores result
   */
  async getOrCompute(
    key: string,
    factory: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await factory();
    this.set(key, value, ttl);
    return value;
  }

  /**
   * Clean up expired entries
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Get cache stats
   */
  getStats() {
    const hitRate = this.hits + this.misses > 0
      ? this.hits / (this.hits + this.misses)
      : 0;

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: Math.round(hitRate * 100),
    };
  }

  /**
   * Reset stats
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  // ========================================================================
  // Internal methods - Doubly linked list operations
  // ========================================================================

  private moveToHead(entry: CacheEntry<T>): void {
    if (entry === this.head) return;

    this.removeFromList(entry);
    this.addToHead(entry);
  }

  private addToHead(entry: CacheEntry<T>): void {
    entry.next = this.head;
    entry.prev = null;

    if (this.head) {
      this.head.prev = entry;
    }

    this.head = entry;

    if (!this.tail) {
      this.tail = entry;
    }
  }

  private removeFromList(entry: CacheEntry<T>): void {
    if (entry.prev) {
      entry.prev.next = entry.next;
    } else {
      this.head = entry.next;
    }

    if (entry.next) {
      entry.next.prev = entry.prev;
    } else {
      this.tail = entry.prev;
    }
  }

  private evictLRU(): void {
    if (!this.tail) return;

    const key = this.tail.key;
    this.removeFromList(this.tail);
    this.cache.delete(key);
    this.evictions++;
  }
}
