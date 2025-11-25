/**
 * STUB FILE - Python performance tracker has been removed
 * This file provides stub implementations to maintain build compatibility
 */

export class PythonPerformanceTracker {
  private readonly defaultWeight: number;

  constructor(defaultWeight: number = 0) {
    this.defaultWeight = defaultWeight;
  }

  reset(): void {
    // No-op
  }

  recordOutcome(_isWin: boolean, _symbol?: string): void {
    // No-op
  }

  recordExpectation(_symbol: string, _expected: 'long' | 'short' | 'none'): void {
    // No-op
  }

  getBiasWeight(_baseWeight?: number): number {
    return this.defaultWeight;
  }

  getStats() {
    return {
      wins: 0,
      losses: 0,
      total: 0,
      winRate: 0,
      adjustedWeight: this.defaultWeight,
    };
  }

  getMetrics() {
    return {
      wins: 0,
      losses: 0,
      total: 0,
      winRate: 0,
      adjustedWeight: this.defaultWeight,
      samples: 0,
      hitRate: 0,
      realizedEdge: 0,
    };
  }
}
