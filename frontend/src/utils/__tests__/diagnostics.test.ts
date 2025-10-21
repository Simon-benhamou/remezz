import { describe, expect, it } from 'vitest';
import { formatDiagnosticReason } from '../../utils/diagnostics';

describe('formatDiagnosticReason', () => {
  it('formats complex diagnostic reasons into readable paragraphs', () => {
    const reason = 'Key: EntryConfirmation • Code: Entry.waiting confirmation • Message: Waiting for 2.0min confirmation (0.4min elapsed, ADX 39.3) • Reason: Waiting for 2.0min confirmation (0.4min elapsed, ADX 39.3)Primary\nKey: QualityFilters.momentum • Code: Quality.momentum.failed • Reason: ADX (39.3) must stay ≤ 22 to confirm a true range; higher ADX flips to trend mode.';

    const formatted = formatDiagnosticReason(reason);

    expect(formatted).toContain('Key: EntryConfirmation');
    expect(formatted).toContain('\n• Code: Entry.waiting confirmation');
    expect(formatted).toContain('\nKey: QualityFilters.momentum');
    expect(formatted.split('\n').length).toBeGreaterThan(4);
  });

  it('returns empty string for missing reason', () => {
    expect(formatDiagnosticReason(undefined)).toBe('');
    expect(formatDiagnosticReason('')).toBe('');
  });
});
