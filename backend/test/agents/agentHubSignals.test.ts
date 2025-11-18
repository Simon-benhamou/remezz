import { describe, expect, it } from '@jest/globals';
import { AgentHub } from '../../src/agent/hub.js';
import { agentEventBus } from '../../src/agent/bus/index.js';
import type { ActivationProfile } from '../../src/agent/state.js';
import type { RiskLimits } from '../../src/agent/subagents/types.js';

describe('AgentHub support state wiring', () => {
  const createProfile = (sessionId: string, symbol: string): ActivationProfile => ({
    id: sessionId,
    symbol,
    mode: 'paper',
    maxLeverage: 3,
    riskPerTradePct: 0.5,
    dailyLossLimitPct: 3,
    timestamp: new Date().toISOString(),
  } as ActivationProfile);

  it('tracks sentiment snapshots emitted on the agent bus', async () => {
    const sessionId = 'support-state-sentiment';
    const symbol = 'BTC/USDT';
    await AgentHub.activate(sessionId, createProfile(sessionId, symbol));

    agentEventBus.emitEvent('sentiment.updated', {
      symbol,
      snapshot: {
        symbol,
        whaleActivity: 0.4,
        newsHeat: 0.1,
        bias: 'bullish' as const,
        confidence: 0.72,
        timestamp: Date.now(),
      },
    });

    const support = AgentHub.getSupportState(sessionId);
    expect(support?.sentiment?.data.bias).toBe('bullish');
    expect(support?.sentiment?.data.confidence).toBeCloseTo(0.72, 2);

    AgentHub.deactivate(sessionId);
  });

  it('records risk governor alerts with bounded history', async () => {
    const sessionId = 'support-state-risk';
    const symbol = 'ETH/USDT';
    await AgentHub.activate(sessionId, createProfile(sessionId, symbol));

    const limits: RiskLimits = {
      sessionId,
      maxLeverage: 5,
      maxPositionUsd: 1500,
      clusterExposureUsd: 500,
      hedgingRequired: true,
      reason: 'drawdown_guard',
      timestamp: Date.now(),
    };

    agentEventBus.emitEvent('riskGovernor.alert', {
      sessionId,
      symbol,
      reason: 'hedging_required',
      limits,
    });

    const support = AgentHub.getSupportState(sessionId);
    expect(support?.alerts).toHaveLength(1);
    expect(support?.alerts[0]?.reason).toBe('hedging_required');

    AgentHub.deactivate(sessionId);
  });
});
