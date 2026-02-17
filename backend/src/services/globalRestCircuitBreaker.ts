/**
 * Global REST Circuit Breaker
 * 
 * Coordinates REST API usage across ALL agents to prevent:
 * - Binance IP bans (418 errors)
 * - Quota exhaustion cascades
 * - Agent-level race conditions
 * 
 * When ANY agent triggers too many REST failures, ALL agents are blocked
 * from REST fallback for a cooldown period (default 60s).
 */

import { notifySystemAlert } from '../utils/notifications.js';

export interface RestFailureRecord {
  timestamp: number;
  agentId: string;
  symbol: string;
  error: string;
}

export interface CircuitBreakerState {
  isOpen: boolean;
  failureCount: number;
  lastFailure: number | null;
  openedAt: number | null;
  closesAt: number | null;
  recentFailures: RestFailureRecord[];
}

class GlobalRestCircuitBreaker {
  private failureCount = 0;
  private lastFailure = 0;
  private isOpen = false;
  private openedAt: number | null = null;
  private closesAt: number | null = null;      // NEW: Track when circuit should close (for IP bans)
  private recentFailures: RestFailureRecord[] = [];
  
  // Configuration
  private readonly FAILURE_THRESHOLD = 5;        // Open circuit after N failures
  private readonly DEFAULT_COOLDOWN_MS = 60_000; // 1 minute default cooldown
  private readonly FAILURE_WINDOW_MS = 30_000;   // Track failures in 30s window
  private readonly MAX_FAILURE_HISTORY = 20;     // Keep last 20 failures
  
  constructor() {
    // Log initialization
    console.log('[GlobalRestCircuitBreaker] Initialized with thresholds:', {
      failureThreshold: this.FAILURE_THRESHOLD,
      cooldownMs: this.DEFAULT_COOLDOWN_MS,
      failureWindowMs: this.FAILURE_WINDOW_MS,
    });
  }
  
  /**
   * Check if REST requests are allowed
   * Returns false if circuit is open (all REST blocked)
   */
  canMakeRequest(): boolean {
    const now = Date.now();

    // If circuit is open, check if we can close it
    if (this.isOpen) {
      // Use explicit closesAt if set (from IP ban), otherwise use default cooldown
      const closeTime = this.closesAt ?? (this.openedAt! + this.DEFAULT_COOLDOWN_MS);

      if (now >= closeTime) {
        // Cooldown period elapsed - CLOSE circuit
        this.closeCircuit();
        return true;
      } else {
        // Still in cooldown - BLOCK all REST
        return false;
      }
    }

    return true; // Circuit closed = allow requests
  }

  /**
   * V5.65: Check if CRITICAL requests are allowed (position closure)
   * Critical orders are allowed even when circuit is open, with a limited rate
   *
   * This prevents positions from being stuck open during IP bans or rate limits.
   * Critical orders get 1 attempt every 5 seconds even when circuit is open.
   */
  private lastCriticalRequest = 0;
  private readonly CRITICAL_COOLDOWN_MS = 5000; // 5 seconds between critical requests when circuit open

  canMakeCriticalRequest(): boolean {
    // If circuit is closed, always allow
    if (!this.isOpen) {
      return true;
    }

    // Circuit is open - check if enough time has passed since last critical request
    const now = Date.now();
    if (now - this.lastCriticalRequest >= this.CRITICAL_COOLDOWN_MS) {
      this.lastCriticalRequest = now;
      console.log(`⚠️ [CircuitBreaker] Allowing CRITICAL request despite open circuit (rate limited: 1 per ${this.CRITICAL_COOLDOWN_MS / 1000}s)`);
      return true;
    }

    console.log(`⚠️ [CircuitBreaker] CRITICAL request blocked - rate limit (${this.CRITICAL_COOLDOWN_MS / 1000}s cooldown)`);
    return false;
  }

  /**
   * V5.65: Check if the circuit is currently open
   */
  isCircuitOpen(): boolean {
    return this.isOpen;
  }
  
  /**
   * Record a REST failure
   * Opens circuit if threshold exceeded
   */
  recordFailure(agentId: string, symbol: string, error: string): void {
    const now = Date.now();
    
    // Add to failure history
    this.recentFailures.push({
      timestamp: now,
      agentId,
      symbol,
      error,
    });
    
    // Trim old history
    if (this.recentFailures.length > this.MAX_FAILURE_HISTORY) {
      this.recentFailures = this.recentFailures.slice(-this.MAX_FAILURE_HISTORY);
    }
    
    // Clean up failures outside window
    this.recentFailures = this.recentFailures.filter(
      f => (now - f.timestamp) < this.FAILURE_WINDOW_MS
    );
    
    // Update counters
    this.failureCount = this.recentFailures.length;
    this.lastFailure = now;
    
    // Check if we should open circuit
    if (this.failureCount >= this.FAILURE_THRESHOLD && !this.isOpen) {
      this.openCircuit();
    }
  }
  
  /**
   * Record a successful REST call
   * Gradually reduces failure count (healing)
   */
  recordSuccess(): void {
    if (this.failureCount > 0) {
      this.failureCount = Math.max(0, this.failureCount - 1);
    }
  }
  
  /**
   * Open the circuit - BLOCK all REST calls
   * @param untilTimestamp Optional: specific timestamp when circuit should close (for IP bans)
   */
  private openCircuit(untilTimestamp?: number): void {
    this.isOpen = true;
    this.openedAt = Date.now();
    this.closesAt = untilTimestamp ?? (this.openedAt + this.DEFAULT_COOLDOWN_MS);
    
    const agentIds = [...new Set(this.recentFailures.map(f => f.agentId))];
    const symbols = [...new Set(this.recentFailures.map(f => f.symbol))];
    const cooldownSeconds = Math.round((this.closesAt - this.openedAt) / 1000);
    
    console.error('🚫 [GlobalRestCircuitBreaker] CIRCUIT OPENED - All REST calls blocked', {
      failureCount: this.failureCount,
      affectedAgents: agentIds.length,
      affectedSymbols: symbols,
      cooldownSeconds,
      closesAt: new Date(this.closesAt).toISOString(),
      recentErrors: this.recentFailures.slice(-5).map(f => ({
        agent: f.agentId,
        symbol: f.symbol,
        error: f.error,
        ago: `${Math.round((Date.now() - f.timestamp) / 1000)}s`,
      })),
    });

    notifySystemAlert({
      level: 'error',
      title: 'Circuit Breaker OPENED',
      message: `REST blocked for ${cooldownSeconds}s.\nFailures: ${this.failureCount}\nSymbols: ${symbols.join(', ')}`,
    }).catch(() => {});
  }
  
  /**
   * Close the circuit - Allow REST calls again
   */
  private closeCircuit(): void {
    console.log('✅ [GlobalRestCircuitBreaker] CIRCUIT CLOSED - REST calls allowed again', {
      wasOpenFor: this.openedAt ? `${Math.round((Date.now() - this.openedAt) / 1000)}s` : 'unknown',
      totalFailuresDuringOpen: this.recentFailures.length,
    });
    
    this.isOpen = false;
    this.openedAt = null;
    this.closesAt = null;
    this.failureCount = 0;
    this.recentFailures = [];
  }
  
  /**
   * Force close the circuit (admin override)
   */
  forceClose(): void {
    console.warn('[GlobalRestCircuitBreaker] Force closing circuit (admin override)');
    this.closeCircuit();
  }
  
  /**
   * Force open the circuit (emergency mode, e.g., IP ban)
   * @param reason Description of why circuit is opened
   * @param untilTimestamp Optional: specific timestamp when circuit should close
   */
  forceOpen(reason: string, untilTimestamp?: number): void {
    const now = Date.now();
    // Default to 5 minutes if no timestamp provided
    const closeTime = untilTimestamp ?? (now + 5 * 60 * 1000);
    const durationSeconds = Math.round((closeTime - now) / 1000);
    
    console.error(`[GlobalRestCircuitBreaker] Force opening circuit (emergency mode): ${reason}`);
    console.error(`[GlobalRestCircuitBreaker] Circuit will close at ${new Date(closeTime).toISOString()} (in ${durationSeconds}s)`);
    
    this.isOpen = true;
    this.openedAt = now;
    this.closesAt = closeTime;
  }
  
  /**
   * Get current circuit state (for monitoring)
   */
  getState(): CircuitBreakerState {
    return {
      isOpen: this.isOpen,
      failureCount: this.failureCount,
      lastFailure: this.lastFailure || null,
      openedAt: this.openedAt,
      closesAt: this.closesAt,
      recentFailures: this.recentFailures.slice(-10), // Last 10
    };
  }
  
  /**
   * Check if we're close to opening (warning state)
   */
  isWarningState(): boolean {
    return this.failureCount >= (this.FAILURE_THRESHOLD * 0.7) && !this.isOpen;
  }
  
  /**
   * Get time remaining until circuit closes (if open)
   */
  getRemainingCooldown(): number {
    if (!this.isOpen || !this.closesAt) return 0;
    
    const remaining = Math.max(0, this.closesAt - Date.now());
    return remaining;
  }
}

// Export singleton instance
export const globalRestCircuitBreaker = new GlobalRestCircuitBreaker();

/**
 * Convenience function: Check if REST allowed (wrapper)
 */
export function canMakeRestCall(): boolean {
  return globalRestCircuitBreaker.canMakeRequest();
}

/**
 * Convenience function: Record REST failure (wrapper)
 */
export function recordRestFailure(agentId: string, symbol: string, error: string): void {
  globalRestCircuitBreaker.recordFailure(agentId, symbol, error);
}

/**
 * Convenience function: Record REST success (wrapper)
 */
export function recordRestSuccess(): void {
  globalRestCircuitBreaker.recordSuccess();
}

/**
 * Convenience function: Get circuit state (wrapper)
 */
export function getCircuitBreakerState(): CircuitBreakerState {
  return globalRestCircuitBreaker.getState();
}
