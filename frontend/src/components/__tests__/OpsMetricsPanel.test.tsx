import { render } from '@testing-library/react';
import { beforeAll, describe, it, expect, vi } from 'vitest';
import OpsMetricsPanel from '../OpsMetricsPanel';

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }
});

describe('OpsMetricsPanel', () => {
  it('renders margin overview with actions', () => {
    const metrics = {
      uptimeSec: 3600,
      loadAvg: 1.23,
      memory: { rss: 1024 * 1024 * 512, heapUsed: 1024 * 1024 * 256 },
      sessions: { active: 3, managing: 2, halted: 1 },
      positions: { open: 4, protectiveIssues: 1 },
      alerts: { lastHour: { total: 2 }, last24h: { total: 5 } },
      agents: { total: 3 },
      margin: {
        tracked: 2,
        warn: 1,
        critical: 1,
        averageUtilisationPct: 72.4,
        worstSessions: [
          {
            sessionId: 'sess1',
            symbol: 'BTC/USDT',
            status: 'critical',
            utilisationPct: 88.2,
            worstLiquidationDistancePct: 4.2,
            actions: [
              { label: 'Reduce BTC leverage', severity: 'critical', rationale: 'Utilisation exceeds safe threshold.' },
            ],
          },
          {
            sessionId: 'sess2',
            symbol: 'ETH/USDT',
            status: 'warn',
            utilisationPct: 64.8,
            worstLiquidationDistancePct: 11.1,
            actions: [],
          },
        ],
      },
    };

    const { container } = render(<OpsMetricsPanel metrics={metrics} loading={false} />);
    expect(container).toMatchSnapshot();
  });
});
