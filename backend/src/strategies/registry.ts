/**
 * Strategy registry — maps strategy names to implementations.
 * Used by backtest engine and live agent to load strategies dynamically.
 */
import type { IStrategy } from './types.js';

const strategies = new Map<string, IStrategy>();

export function registerStrategy(strategy: IStrategy): void {
  if (strategies.has(strategy.name)) {
    throw new Error(`Strategy "${strategy.name}" is already registered`);
  }
  strategies.set(strategy.name, strategy);
}

export function getStrategy(name: string): IStrategy {
  const strategy = strategies.get(name);
  if (!strategy) {
    const available = listStrategies().join(', ') || 'none';
    throw new Error(`Strategy "${name}" not found. Available: ${available}`);
  }
  return strategy;
}

export function listStrategies(): string[] {
  return Array.from(strategies.keys());
}

export function clearStrategies(): void {
  strategies.clear();
}

// ============================================================================
// Auto-register known strategies
// ============================================================================
import { PullbackTrendStrategy } from './pullbackTrend/strategy.js';
registerStrategy(new PullbackTrendStrategy());

import { MeanReversion4hStrategy } from './meanReversion4h/strategy.js';
registerStrategy(new MeanReversion4hStrategy());

import { FundingRateStrategy } from './fundingRate/strategy.js';
registerStrategy(new FundingRateStrategy());

import { FundingHunterStrategy } from './fundingHunter/strategy.js';
registerStrategy(new FundingHunterStrategy());
