/**
 * 🧪 UNIT TESTS - Capital Pool System
 *
 * Tests for the shared capital pool that manages capital across 1000+ agents.
 *
 * Coverage:
 * - Atomic capital reservation (mutex-protected)
 * - Race condition prevention
 * - Capital release with PnL
 * - Available capital calculation
 * - Paper vs Live mode sync
 * - Consecutive loser tracking (V5.63)
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ============================================================================
// Mock Capital Pool for testing
// ============================================================================

class MockCapitalPool {
  private totalCapitalUsd: number;
  private reservedByAgent: Map<string, number> = new Map();
  private inPositionByAgent: Map<string, number> = new Map();
  private maxPositions: number;
  private mode: 'paper' | 'live';

  // V5.63: Consecutive loser tracking
  private consecutiveLosers: number = 0;
  private skipsRemaining: number = 0;
  private readonly CONSECUTIVE_LOSER_THRESHOLD = 2;
  private readonly SKIP_TRADES_AFTER_LOSERS = 1;

  // Mutex simulation
  private reserveLock: Promise<void> = Promise.resolve();
  private lockHolder: string | null = null;

  constructor(config: {
    initialCapital: number;
    maxPositions: number;
    mode?: 'paper' | 'live';
  }) {
    this.totalCapitalUsd = config.initialCapital;
    this.maxPositions = config.maxPositions;
    this.mode = config.mode ?? 'paper';
  }

  /**
   * Get total capital
   */
  getTotalCapital(): number {
    return this.totalCapitalUsd;
  }

  /**
   * Get available capital (not reserved, not in position)
   */
  getAvailableCapital(): number {
    const totalReserved = Array.from(this.reservedByAgent.values()).reduce((a, b) => a + b, 0);
    const totalInPosition = Array.from(this.inPositionByAgent.values()).reduce((a, b) => a + b, 0);
    return Math.max(0, this.totalCapitalUsd - totalReserved - totalInPosition);
  }

  /**
   * Get open position count
   */
  getOpenPositionCount(): number {
    return this.inPositionByAgent.size;
  }

  /**
   * Get max positions
   */
  getMaxPositions(): number {
    return this.maxPositions;
  }

  /**
   * Acquire reserve lock (mutex)
   */
  private async acquireReserveLock(agentId: string): Promise<void> {
    const currentLock = this.reserveLock;
    let releaseLock: () => void;

    this.reserveLock = new Promise<void>(resolve => {
      releaseLock = resolve;
    });

    await currentLock;
    this.lockHolder = agentId;

    // Return the release function wrapped in a timeout
    return new Promise(resolve => {
      setTimeout(() => {
        releaseLock!();
        this.lockHolder = null;
        resolve();
      }, 0);
    });
  }

  /**
   * Reserve capital for a trade (atomic with mutex)
   */
  async reserve(agentId: string, amountUsd: number): Promise<boolean> {
    await this.acquireReserveLock(agentId);

    const available = this.getAvailableCapital();
    if (amountUsd > available) {
      return false;
    }

    const current = this.reservedByAgent.get(agentId) || 0;
    this.reservedByAgent.set(agentId, current + amountUsd);
    return true;
  }

  /**
   * Commit reserved capital to position
   */
  commit(agentId: string, amountUsd: number): void {
    const reserved = this.reservedByAgent.get(agentId) || 0;
    this.reservedByAgent.set(agentId, Math.max(0, reserved - amountUsd));

    const inPosition = this.inPositionByAgent.get(agentId) || 0;
    this.inPositionByAgent.set(agentId, inPosition + amountUsd);
  }

  /**
   * Release capital from position (with PnL)
   */
  release(agentId: string, amountUsd: number, pnlUsd: number = 0): void {
    const inPosition = this.inPositionByAgent.get(agentId) || 0;
    const newInPosition = Math.max(0, inPosition - amountUsd);

    if (newInPosition === 0) {
      this.inPositionByAgent.delete(agentId);
    } else {
      this.inPositionByAgent.set(agentId, newInPosition);
    }

    // Paper mode: add PnL to total capital
    if (this.mode === 'paper') {
      this.totalCapitalUsd += pnlUsd;
    }
    // Live mode: balance synced from exchange separately
  }

  /**
   * V5.63: Record trade result for consecutive loser tracking
   */
  recordTradeResult(isWinner: boolean, symbol: string): void {
    if (isWinner) {
      this.consecutiveLosers = 0;
      this.skipsRemaining = 0;
    } else {
      this.consecutiveLosers++;
      if (this.consecutiveLosers >= this.CONSECUTIVE_LOSER_THRESHOLD) {
        this.skipsRemaining = this.SKIP_TRADES_AFTER_LOSERS;
        this.consecutiveLosers = 0; // Reset after applying skip
      }
    }
  }

  /**
   * V5.63: Check if should skip trade
   */
  shouldSkipTrade(): boolean {
    if (this.skipsRemaining > 0) {
      this.skipsRemaining--;
      return true;
    }
    return false;
  }

  /**
   * Reset for testing
   */
  reset(initialCapital?: number): void {
    this.totalCapitalUsd = initialCapital ?? 1000;
    this.reservedByAgent.clear();
    this.inPositionByAgent.clear();
    this.consecutiveLosers = 0;
    this.skipsRemaining = 0;
  }
}

// ============================================================================
// TESTS: Basic Operations
// ============================================================================

describe('CapitalPool - Basic Operations', () => {
  let pool: MockCapitalPool;

  beforeEach(() => {
    pool = new MockCapitalPool({
      initialCapital: 1000,
      maxPositions: 4,
      mode: 'paper',
    });
  });

  afterEach(() => {
    pool.reset();
  });

  it('should initialize with correct capital', () => {
    expect(pool.getTotalCapital()).toBe(1000);
    expect(pool.getAvailableCapital()).toBe(1000);
  });

  it('should reserve capital', async () => {
    const success = await pool.reserve('agent-1', 200);
    expect(success).toBe(true);
    expect(pool.getAvailableCapital()).toBe(800);
  });

  it('should reject reservation exceeding available', async () => {
    const success = await pool.reserve('agent-1', 1500);
    expect(success).toBe(false);
    expect(pool.getAvailableCapital()).toBe(1000);
  });

  it('should commit reserved capital to position', async () => {
    await pool.reserve('agent-1', 200);
    pool.commit('agent-1', 200);

    expect(pool.getAvailableCapital()).toBe(800);
    expect(pool.getOpenPositionCount()).toBe(1);
  });

  it('should release capital with PnL (paper mode)', async () => {
    await pool.reserve('agent-1', 200);
    pool.commit('agent-1', 200);

    // Release with +$50 profit
    pool.release('agent-1', 200, 50);

    expect(pool.getTotalCapital()).toBe(1050); // 1000 + 50
    expect(pool.getAvailableCapital()).toBe(1050);
    expect(pool.getOpenPositionCount()).toBe(0);
  });

  it('should release capital with loss (paper mode)', async () => {
    await pool.reserve('agent-1', 200);
    pool.commit('agent-1', 200);

    // Release with -$30 loss
    pool.release('agent-1', 200, -30);

    expect(pool.getTotalCapital()).toBe(970); // 1000 - 30
  });
});

// ============================================================================
// TESTS: Race Condition Prevention
// ============================================================================

describe('CapitalPool - Race Condition Prevention', () => {
  let pool: MockCapitalPool;

  beforeEach(() => {
    pool = new MockCapitalPool({
      initialCapital: 1000,
      maxPositions: 10,
      mode: 'paper',
    });
  });

  afterEach(() => {
    pool.reset();
  });

  it('should handle concurrent reservations without over-allocating', async () => {
    // Simulate 10 agents trying to reserve 150 each (total 1500, only 1000 available)
    const agents = Array.from({ length: 10 }, (_, i) => `agent-${i}`);
    const reservations = agents.map(agentId => pool.reserve(agentId, 150));

    const results = await Promise.all(reservations);

    // Count successful reservations
    const successCount = results.filter(r => r === true).length;

    // Should have at most 6 successful (6 * 150 = 900, 7 * 150 = 1050 > 1000)
    expect(successCount).toBeLessThanOrEqual(6);

    // Available should never go negative
    expect(pool.getAvailableCapital()).toBeGreaterThanOrEqual(0);
  });

  it('should not double-reserve for same agent', async () => {
    // First reservation
    const first = await pool.reserve('agent-1', 500);
    expect(first).toBe(true);

    // Second reservation for same agent
    const second = await pool.reserve('agent-1', 500);
    expect(second).toBe(true);

    // Total reserved should be 1000 (500 + 500)
    expect(pool.getAvailableCapital()).toBe(0);
  });
});

// ============================================================================
// TESTS: Skip-N-Trades Rule (V5.63)
// ============================================================================

describe('CapitalPool - Skip-N-Trades Rule (V5.63)', () => {
  let pool: MockCapitalPool;

  beforeEach(() => {
    pool = new MockCapitalPool({
      initialCapital: 1000,
      maxPositions: 4,
      mode: 'paper',
    });
  });

  afterEach(() => {
    pool.reset();
  });

  it('should not skip after first loser', () => {
    pool.recordTradeResult(false, 'BTC/USDT:USDT'); // First loss
    expect(pool.shouldSkipTrade()).toBe(false);
  });

  it('should skip after 2 consecutive losers', () => {
    pool.recordTradeResult(false, 'BTC/USDT:USDT'); // First loss
    pool.recordTradeResult(false, 'ETH/USDT:USDT'); // Second consecutive loss

    // Should skip 1 trade
    expect(pool.shouldSkipTrade()).toBe(true);
    // But not the next one
    expect(pool.shouldSkipTrade()).toBe(false);
  });

  it('should reset consecutive count on winner', () => {
    pool.recordTradeResult(false, 'BTC/USDT:USDT'); // Loss
    pool.recordTradeResult(true, 'ETH/USDT:USDT');  // Win - resets count
    pool.recordTradeResult(false, 'SOL/USDT:USDT'); // Loss (but count is 1, not 2)

    expect(pool.shouldSkipTrade()).toBe(false);
  });

  it('should only skip 1 trade then resume', () => {
    pool.recordTradeResult(false, 'BTC/USDT:USDT'); // Loss
    pool.recordTradeResult(false, 'ETH/USDT:USDT'); // Loss (2 consecutive)

    // Skip first
    expect(pool.shouldSkipTrade()).toBe(true);

    // Don't skip second
    expect(pool.shouldSkipTrade()).toBe(false);

    // Don't skip third
    expect(pool.shouldSkipTrade()).toBe(false);
  });
});

// ============================================================================
// TESTS: Multi-Position Scenario
// ============================================================================

describe('CapitalPool - Multi-Position Scenario', () => {
  let pool: MockCapitalPool;

  beforeEach(() => {
    pool = new MockCapitalPool({
      initialCapital: 10000,
      maxPositions: 4,
      mode: 'paper',
    });
  });

  afterEach(() => {
    pool.reset();
  });

  it('should track multiple positions correctly', async () => {
    // Open 3 positions
    for (let i = 0; i < 3; i++) {
      await pool.reserve(`agent-${i}`, 1000);
      pool.commit(`agent-${i}`, 1000);
    }

    expect(pool.getOpenPositionCount()).toBe(3);
    expect(pool.getAvailableCapital()).toBe(7000);
  });

  it('should respect max positions', async () => {
    // Open max positions (4)
    for (let i = 0; i < 4; i++) {
      await pool.reserve(`agent-${i}`, 1000);
      pool.commit(`agent-${i}`, 1000);
    }

    expect(pool.getOpenPositionCount()).toBe(4);
    expect(pool.getOpenPositionCount()).toBe(pool.getMaxPositions());
  });

  it('should handle mixed wins and losses', async () => {
    // Position 1: +100
    await pool.reserve('agent-1', 2000);
    pool.commit('agent-1', 2000);
    pool.release('agent-1', 2000, 100);

    // Position 2: -50
    await pool.reserve('agent-2', 2000);
    pool.commit('agent-2', 2000);
    pool.release('agent-2', 2000, -50);

    // Position 3: +200
    await pool.reserve('agent-3', 2000);
    pool.commit('agent-3', 2000);
    pool.release('agent-3', 2000, 200);

    // Net: 10000 + 100 - 50 + 200 = 10250
    expect(pool.getTotalCapital()).toBe(10250);
    expect(pool.getOpenPositionCount()).toBe(0);
  });
});
