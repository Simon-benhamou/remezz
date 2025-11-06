import { describe, expect, it } from 'vitest';
import {
  STRATEGY_META,
  normalizeStrategyEngine,
  resolveStrategyLabel,
  resolveSessionStrategyLabel,
  inferSessionStrategyEngine,
} from '../strategies';

describe('strategies utils', () => {
  it('normalizes strategy engine aliases', () => {
    expect(normalizeStrategyEngine('Meta Adaptive')).toBe('meta_adaptive');
    expect(normalizeStrategyEngine('intraday-dual')).toBe('meta_adaptive'); // Intraday removed
    expect(normalizeStrategyEngine('unknown')).toBeNull();
  });

  it('resolves labels with sensible fallbacks', () => {
    expect(resolveStrategyLabel('meta_adaptive')).toBe(STRATEGY_META.meta_adaptive.label);
    expect(resolveStrategyLabel(undefined)).toBe('Unspecified');
    expect(resolveStrategyLabel('custom_alpha')).toBe('Custom Alpha');
  });

  it('derives session strategy information from profile data', () => {
    const session = {
      strategy: null,
      strategyFamily: null,
      strategyEngine: null,
      profile: { strategyEngine: 'meta_adaptive' },
    };
    expect(inferSessionStrategyEngine(session)).toBe('meta_adaptive');
    expect(resolveSessionStrategyLabel(session)).toBe(STRATEGY_META.meta_adaptive.label);
  });
});
