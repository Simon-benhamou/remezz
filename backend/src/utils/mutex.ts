/**
 * Async Mutex Lock
 *
 * Prevents race conditions in async operations
 * Used for capital pool reservations, API call deduplication, cache updates
 *
 * Example:
 *   const lock = new Mutex();
 *   await lock.runExclusive(async () => {
 *     // Critical section - only one execution at a time
 *   });
 */

export class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  /**
   * Acquire the lock
   * Returns a release function
   */
  async acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const tryAcquire = () => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => this.release());
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  /**
   * Release the lock
   */
  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  /**
   * Run a function exclusively (auto acquire/release)
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Check if lock is currently held
   */
  isLocked(): boolean {
    return this.locked;
  }

  /**
   * Get queue length (for monitoring)
   */
  getQueueLength(): number {
    return this.queue.length;
  }
}

/**
 * Keyed Mutex - Multiple locks identified by string keys
 *
 * Example:
 *   const locks = new KeyedMutex();
 *   await locks.runExclusive('user_123', async () => {
 *     // Critical section for user_123
 *   });
 */
export class KeyedMutex {
  private locks = new Map<string, Mutex>();

  /**
   * Get or create a mutex for a key
   */
  private getMutex(key: string): Mutex {
    let mutex = this.locks.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.locks.set(key, mutex);
    }
    return mutex;
  }

  /**
   * Run exclusively for a specific key
   */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const mutex = this.getMutex(key);
    return mutex.runExclusive(fn);
  }

  /**
   * Clean up unused locks (call periodically)
   */
  cleanup(): void {
    for (const [key, mutex] of this.locks) {
      if (!mutex.isLocked() && mutex.getQueueLength() === 0) {
        this.locks.delete(key);
      }
    }
  }

  /**
   * Get stats (for monitoring)
   */
  getStats() {
    return {
      totalLocks: this.locks.size,
      lockedCount: Array.from(this.locks.values()).filter(m => m.isLocked()).length,
    };
  }
}
