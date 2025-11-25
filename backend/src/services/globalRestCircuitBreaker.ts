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
  private recentFailures: RestFailureRecord[] = [];
  
  // Configuration
  private readonly FAILURE_THRESHOLD = 5;        // Open circuit after N failures
  private readonly COOLDOWN_MS = 60_000;         // 1 minute cooldown
  private readonly FAILURE_WINDOW_MS = 30_000;   // Track failures in 30s window
  private readonly MAX_FAILURE_HISTORY = 20;     // Keep last 20 failures
  
  constructor() {
    // Log initialization
    console.log('[GlobalRestCircuitBreaker] Initialized with thresholds:', {
      failureThreshold: this.FAILURE_THRESHOLD,
      cooldownMs: this.COOLDOWN_MS,
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
      const timeSinceOpen = now - (this.openedAt ?? 0);
      
      if (timeSinceOpen >= this.COOLDOWN_MS) {
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
   */
  private openCircuit(): void {
    this.isOpen = true;
    this.openedAt = Date.now();
    
    const agentIds = [...new Set(this.recentFailures.map(f => f.agentId))];
    const symbols = [...new Set(this.recentFailures.map(f => f.symbol))];
    
    console.error('🚫 [GlobalRestCircuitBreaker] CIRCUIT OPENED - All REST calls blocked', {
      failureCount: this.failureCount,
      affectedAgents: agentIds.length,
      affectedSymbols: symbols,
      cooldownSeconds: this.COOLDOWN_MS / 1000,
      recentErrors: this.recentFailures.slice(-5).map(f => ({
        agent: f.agentId,
        symbol: f.symbol,
        error: f.error,
        ago: `${Math.round((Date.now() - f.timestamp) / 1000)}s`,
      })),
    });
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
   * Force open the circuit (emergency mode)
   */
  forceOpen(reason: string): void {
    console.error('[GlobalRestCircuitBreaker] Force opening circuit (emergency mode):', reason);
    this.isOpen = true;
    this.openedAt = Date.now();
  }
  
  /**
   * Get current circuit state (for monitoring)
   */
  getState(): CircuitBreakerState {
    const now = Date.now();
    return {
      isOpen: this.isOpen,
      failureCount: this.failureCount,
      lastFailure: this.lastFailure || null,
      openedAt: this.openedAt,
      closesAt: this.isOpen && this.openedAt 
        ? this.openedAt + this.COOLDOWN_MS 
        : null,
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
    if (!this.isOpen || !this.openedAt) return 0;
    
    const elapsed = Date.now() - this.openedAt;
    const remaining = Math.max(0, this.COOLDOWN_MS - elapsed);
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
