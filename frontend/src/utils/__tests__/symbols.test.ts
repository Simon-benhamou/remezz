import { describe, expect, it } from 'vitest';
import { formatDisplaySymbol } from '../symbols';

describe('formatDisplaySymbol', () => {
  it('returns Unknown when symbol is missing', () => {
    expect(formatDisplaySymbol(null)).toBe('Unknown');
    expect(formatDisplaySymbol(undefined)).toBe('Unknown');
  });

  it('extracts the base asset from slash separated symbols', () => {
    expect(formatDisplaySymbol('btc/usdt:usdt')).toBe('BTC');
    expect(formatDisplaySymbol('eth/usdt')).toBe('ETH');
  });

  it('handles colon separated symbols', () => {
    expect(formatDisplaySymbol('adausdt:usdt')).toBe('ADAUSDT');
    expect(formatDisplaySymbol('adausdt:usdt'.toLowerCase())).toBe('ADAUSDT');
  });

  it('returns uppercase symbol when no separators', () => {
    expect(formatDisplaySymbol('solusdt')).toBe('SOLUSDT');
  });
});
