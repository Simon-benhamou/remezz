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
    expect(normalizeStrategyEngine('intraday-dual')).toBe('intraday_dual');
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
      profile: { strategyEngine: 'intraday_dual' },
    };
    expect(inferSessionStrategyEngine(session)).toBe('intraday_dual');
    expect(resolveSessionStrategyLabel(session)).toBe(STRATEGY_META.intraday_dual.label);

    const fallbackSession = {
      strategy: 'Custom Blend',
      strategyFamily: null,
      strategyEngine: null,
      profile: null,
    };
    expect(inferSessionStrategyEngine(fallbackSession)).toBeNull();
    expect(resolveSessionStrategyLabel(fallbackSession)).toBe('Custom Blend');
  });
});
