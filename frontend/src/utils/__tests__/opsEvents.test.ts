import { describe, expect, it } from 'vitest';
import {
  collectOpsEventReasons,
  formatOpsEventDetailValue,
  formatOpsEventMessage,
  normalizeOpsEventDetails,
} from '../opsEvents';

describe('opsEvents utilities', () => {
  it('formats event messages by expanding underscores', () => {
    expect(formatOpsEventMessage('quantai_entry_rejected')).toBe('Quantai Entry Rejected');
    expect(formatOpsEventMessage(undefined)).toBe('Agent Update');
  });

  it('normalizes string and array details to objects', () => {
    expect(normalizeOpsEventDetails('{"reason":"low_volume"}')).toEqual({ reason: 'low_volume' });
    expect(normalizeOpsEventDetails(['one', 'two'])).toEqual({ reasons: ['one', 'two'] });
  });

  it('formats nested detail values consistently', () => {
    const formatted = formatOpsEventDetailValue('ratio', 0.2567);
    expect(formatted).toBe('25.7%');
    const nested = formatOpsEventDetailValue('context', { note: 'strong_flow', score: 0.8231 });
    expect(nested).toContain('Note: Strong Flow');
    expect(nested).toContain('Score: 0.82');
  });

  it('collects human readable reasons from nested structures', () => {
    const reasons = collectOpsEventReasons({
      reasons: ['failed_momentum', 'low_volume'],
      summary: ['rr below floor', 'wait for funding reset'],
      nested: { explanation: ['atr too weak'] },
    });
    expect(reasons).toContain('Failed Momentum');
    expect(reasons).toContain('Low Volume');
    expect(reasons).toContain('Rr Below Floor');
    expect(reasons).toContain('Wait For Funding Reset');
    expect(reasons).toContain('Atr Too Weak');
  });

  it('handles JSON encoded string reasons', () => {
    const reasons = collectOpsEventReasons('{"reason":"risk_guard_block","notes":["momentum neutral"]}');
    expect(reasons).toEqual(['Risk Guard Block', 'Momentum Neutral']);
  });
});
