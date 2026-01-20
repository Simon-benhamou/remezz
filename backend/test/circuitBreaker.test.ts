/**
 * 🧪 UNIT TESTS - Global REST Circuit Breaker
 *
 * Tests for the circuit breaker that protects against IP bans.
 *
 * Coverage:
 * - State transitions (CLOSED -> OPEN -> CLOSED)
 * - Critical exit allowance (V5.71)
 * - Failure threshold tracking
 * - Cooldown period behavior
 * - Rate-limited critical requests
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ============================================================================
// Mock Circuit Breaker for testing
// ============================================================================

interface RestFailureRecord {
  timestamp: number;
  agentId: string;
  symbol: string;
  error: string;
}

interface CircuitBreakerState {
  isOpen: boolean;
  failureCount: number;
  lastFailure: number | null;
  openedAt: number | null;
  closesAt: number | null;
}

class MockCircuitBreaker {
  private failureCount = 0;
  private lastFailure = 0;
  private isOpen = false;
  private openedAt: number | null = null;
  private closesAt: number | null = null;
  private recentFailures: RestFailureRecord[] = [];
  private lastCriticalRequest = 0;

  private readonly FAILURE_THRESHOLD = 5;
  private readonly DEFAULT_COOLDOWN_MS = 60_000; // 1 minute
  private readonly FAILURE_WINDOW_MS = 30_000; // 30 seconds
  private readonly CRITICAL_COOLDOWN_MS = 5000; // 5 seconds between critical requests

  /**
   * Check if regular REST requests are allowed
   */
  canMakeRequest(): boolean {
    const now = Date.now();

    if (this.isOpen) {
      const closeTime = this.closesAt ?? (this.openedAt! + this.DEFAULT_COOLDOWN_MS);
      if (now >= closeTime) {
        this.closeCircuit();
        return true;
      }
      return false;
    }

    return true;
  }

  /**
   * V5.71: Check if CRITICAL requests are allowed (position closure)
   * Critical orders are allowed even when circuit is open, with a limited rate
   */
  canMakeCriticalRequest(): boolean {
    // If circuit is closed, always allow
    if (!this.isOpen) {
      return true;
    }

    // Circuit is open - check if enough time has passed since last critical request
    const now = Date.now();
    if (now - this.lastCriticalRequest >= this.CRITICAL_COOLDOWN_MS) {
      this.lastCriticalRequest = now;
      return true;
    }

    return false;
  }

  /**
   * Check if circuit is currently open
   */
  isCircuitOpen(): boolean {
    return this.isOpen;
  }

  /**
   * Record a REST failure
   */
  recordFailure(agentId: string, symbol: string, error: string): void {
    const now = Date.now();

    this.recentFailures.push({
      timestamp: now,
      agentId,
      symbol,
      error,
    });

    // Clean up failures outside window
    this.recentFailures = this.recentFailures.filter(
      f => (now - f.timestamp) < this.FAILURE_WINDOW_MS
    );

    this.failureCount = this.recentFailures.length;
    this.lastFailure = now;

    // Open circuit if threshold exceeded
    if (this.failureCount >= this.FAILURE_THRESHOLD && !this.isOpen) {
      this.openCircuit();
    }
  }

  /**
   * Record a successful REST call
   */
  recordSuccess(): void {
    if (this.failureCount > 0) {
      this.failureCount = Math.max(0, this.failureCount - 1);
    }
  }

  /**
   * Open the circuit - block all REST calls
   */
  private openCircuit(untilTimestamp?: number): void {
    this.isOpen = true;
    this.openedAt = Date.now();
    this.closesAt = untilTimestamp ?? (this.openedAt + this.DEFAULT_COOLDOWN_MS);
  }

  /**
   * Close the circuit - allow REST calls again
   */
  private closeCircuit(): void {
    this.isOpen = false;
    this.openedAt = null;
    this.closesAt = null;
    this.failureCount = 0;
    this.recentFailures = [];
  }

  /**
   * Force open the circuit (for testing)
   */
  forceOpen(cooldownMs?: number): void {
    const now = Date.now();
    this.isOpen = true;
    this.openedAt = now;
    this.closesAt = now + (cooldownMs ?? this.DEFAULT_COOLDOWN_MS);
  }

  /**
   * Get current state
   */
  getState(): CircuitBreakerState {
    return {
      isOpen: this.isOpen,
      failureCount: this.failureCount,
      lastFailure: this.lastFailure || null,
      openedAt: this.openedAt,
      closesAt: this.closesAt,
    };
  }

  /**
   * Reset for testing
   */
  reset(): void {
    this.failureCount = 0;
    this.lastFailure = 0;
    this.isOpen = false;
    this.openedAt = null;
    this.closesAt = null;
    this.recentFailures = [];
    this.lastCriticalRequest = 0;
  }
}

// ============================================================================
// TESTS: Basic State
// ============================================================================

describe('CircuitBreaker - Basic State', () => {
  let breaker: MockCircuitBreaker;

  beforeEach(() => {
    breaker = new MockCircuitBreaker();
  });

  afterEach(() => {
    breaker.reset();
  });

  it('should start in closed state', () => {
    expect(breaker.isCircuitOpen()).toBe(false);
    expect(breaker.canMakeRequest()).toBe(true);
  });

  it('should allow requests when closed', () => {
    expect(breaker.canMakeRequest()).toBe(true);
    expect(breaker.canMakeCriticalRequest()).toBe(true);
  });
});

// ============================================================================
// TESTS: Failure Tracking
// ============================================================================

describe('CircuitBreaker - Failure Tracking', () => {
  let breaker: MockCircuitBreaker;

  beforeEach(() => {
    breaker = new MockCircuitBreaker();
  });

  afterEach(() => {
    breaker.reset();
  });

  it('should track failures and open after threshold', () => {
    // Record 4 failures (below threshold of 5)
    for (let i = 0; i < 4; i++) {
      breaker.recordFailure('agent-1', 'BTC/USDT:USDT', 'Test error');
    }
    expect(breaker.isCircuitOpen()).toBe(false);

    // Record 5th failure (reaches threshold)
    breaker.recordFailure('agent-1', 'BTC/USDT:USDT', 'Test error');
    expect(breaker.isCircuitOpen()).toBe(true);
    expect(breaker.canMakeRequest()).toBe(false);
  });

  it('should heal with successful requests', () => {
    // Record some failures (not enough to open)
    for (let i = 0; i < 3; i++) {
      breaker.recordFailure('agent-1', 'BTC/USDT:USDT', 'Test error');
    }

    const stateBefore = breaker.getState();
    expect(stateBefore.failureCount).toBe(3);

    // Record success - should reduce failure count
    breaker.recordSuccess();
    const stateAfter = breaker.getState();
    expect(stateAfter.failureCount).toBe(2);
  });
});

// ============================================================================
// TESTS: Critical Request Allowance (V5.71)
// ============================================================================

describe('CircuitBreaker - Critical Request Allowance', () => {
  let breaker: MockCircuitBreaker;

  beforeEach(() => {
    breaker = new MockCircuitBreaker();
  });

  afterEach(() => {
    breaker.reset();
  });

  it('should allow critical requests when circuit is closed', () => {
    expect(breaker.canMakeCriticalRequest()).toBe(true);
  });

  it('should allow first critical request when circuit is open', () => {
    breaker.forceOpen();
    expect(breaker.isCircuitOpen()).toBe(true);

    // First critical request should be allowed
    expect(breaker.canMakeCriticalRequest()).toBe(true);
  });

  it('should rate-limit critical requests when circuit is open', () => {
    breaker.forceOpen();

    // First critical request allowed
    expect(breaker.canMakeCriticalRequest()).toBe(true);

    // Immediate second critical request blocked (5s cooldown)
    expect(breaker.canMakeCriticalRequest()).toBe(false);
  });

  it('should block regular requests when circuit is open', () => {
    breaker.forceOpen();
    expect(breaker.canMakeRequest()).toBe(false);
  });

  it('should allow critical request after cooldown', async () => {
    breaker.forceOpen();

    // First request
    expect(breaker.canMakeCriticalRequest()).toBe(true);

    // Wait for critical cooldown (5s)
    await new Promise(resolve => setTimeout(resolve, 5100));

    // Second request should now be allowed
    expect(breaker.canMakeCriticalRequest()).toBe(true);
  }, 10000); // Extended timeout for 5s wait
});

// ============================================================================
// TESTS: State Transitions
// ============================================================================

describe('CircuitBreaker - State Transitions', () => {
  let breaker: MockCircuitBreaker;

  beforeEach(() => {
    breaker = new MockCircuitBreaker();
  });

  afterEach(() => {
    breaker.reset();
  });

  it('should close circuit after cooldown period', async () => {
    // Open with short cooldown (100ms)
    breaker.forceOpen(100);
    expect(breaker.isCircuitOpen()).toBe(true);
    expect(breaker.canMakeRequest()).toBe(false);

    // Wait for cooldown
    await new Promise(resolve => setTimeout(resolve, 150));

    // canMakeRequest should close the circuit and return true
    expect(breaker.canMakeRequest()).toBe(true);
    expect(breaker.isCircuitOpen()).toBe(false);
  });

  it('should track closesAt timestamp', () => {
    const beforeOpen = Date.now();
    breaker.forceOpen(60000);

    const state = breaker.getState();
    expect(state.closesAt).not.toBeNull();
    expect(state.closesAt! - state.openedAt!).toBe(60000);
  });
});

// ============================================================================
// TESTS: Position Exit Scenario
// ============================================================================

describe('CircuitBreaker - Position Exit Scenario', () => {
  let breaker: MockCircuitBreaker;

  beforeEach(() => {
    breaker = new MockCircuitBreaker();
  });

  afterEach(() => {
    breaker.reset();
  });

  it('should allow position exit when circuit is open (V5.71 fix)', () => {
    // Simulate IP ban scenario
    for (let i = 0; i < 10; i++) {
      breaker.recordFailure('agent-1', 'BTC/USDT:USDT', 'HTTP 418');
    }
    expect(breaker.isCircuitOpen()).toBe(true);

    // Regular requests blocked
    expect(breaker.canMakeRequest()).toBe(false);

    // But critical exit should be allowed
    expect(breaker.canMakeCriticalRequest()).toBe(true);
  });

  it('should not leave positions stuck', () => {
    // This test documents the V5.71 fix behavior
    // Before V5.71: canMakeRequest() blocks ALL requests including exits
    // After V5.71: canMakeCriticalRequest() allows exits with rate limit

    breaker.forceOpen();

    // Simulate multiple agents trying to exit
    const exitAttempts: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      exitAttempts.push(breaker.canMakeCriticalRequest());
    }

    // First attempt should succeed, rest are rate-limited
    expect(exitAttempts[0]).toBe(true);
    expect(exitAttempts.slice(1).every(r => r === false)).toBe(true);

    // This ensures at least ONE exit can happen every 5 seconds
    // preventing positions from being stuck indefinitely
  });
});
