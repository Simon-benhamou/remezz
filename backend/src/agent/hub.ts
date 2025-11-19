import type { ActivationProfile } from './state.js';
import { prisma } from '../db/client.js';
import { PaperBroker } from '../broker/paper.js';
import { LiveBroker } from '../broker/live.js';
import { CapitalPoolBroker } from '../broker/capitalPoolBroker.js';
import { capitalConfig } from '../config/capital.js';
import { getCapitalManager } from '../services/capitalPool.js';
import type { Broker } from '../broker/types.js';
import type { StrategyGuardrail } from '../services/strategyHealth.js';
import { agentServiceRegistry } from './subagents/serviceRegistry.js';
import { agentEventBus } from './bus/index.js';
import type {
  ExecutionPlan,
  MarketQualityScore,
  PredictorInsight,
  RiskLimits,
  SentimentSignal,
} from './subagents/types.js';
import type { AgentActionIntent, AgentActionType } from './actions/types.js';
import { buildSupportDiagnostics } from './diagnostics/supportDiagnostics.js';
import { activateEntryLock } from '../services/sessionLocks.js';

// AgentHub not used in meta-adaptive - kept for backward compatibility
type ReboundRejectionAgent = any;

export type StopAllSessionResult = {
  sessionId: string;
  symbol: string;
  mode: string;
  closeAttempted: boolean;
  closeOk: boolean;
  cancelCount: number;
  cancelFailed: number;
  positionsClosed: number;
  haltOk: boolean;
  brokerSource: 'agent'|'paper'|'live'|'none';
  errors: string[];
};

export type StopAllResult = {
  sessions: StopAllSessionResult[];
};

type SupportSnapshot<T> = {
  data: T;
  updatedAt: number;
};

type AgentSupportAlert = {
  reason: string;
  limits: RiskLimits;
  symbol: string;
  timestamp: number;
};

type AgentActionSnapshot = {
  intentId: string;
  type: AgentActionType;
  status: 'completed' | 'failed' | 'skipped';
  failureReason?: string | null;
  details?: Record<string, unknown> | null;
};

export type AgentSupportState = {
  marketQuality?: SupportSnapshot<MarketQualityScore>;
  sentiment?: SupportSnapshot<SentimentSignal>;
  riskLimits?: SupportSnapshot<RiskLimits>;
  executionPlan?: SupportSnapshot<ExecutionPlan>;
  predictor?: SupportSnapshot<PredictorInsight>;
  decisions?: SupportSnapshot<{ intents: AgentActionIntent[] }>;
  actions?: SupportSnapshot<AgentActionSnapshot>;
  alerts: AgentSupportAlert[];
};

const HALT_ENTRY_LOCK_TTLS: Record<'entries_only' | 'full', number> = {
  entries_only: 3 * 60_000,  // BUG FIX: Reduced from 10min to 3min to avoid long blocks
  full: 30 * 60_000,
};

async function applyHaltEntryLock(sessionId: string, mode: 'entries_only' | 'full'): Promise<void> {
  const reason = mode === 'entries_only' ? 'agent_halt_entries_only' : 'agent_halt_full';
  const ttl = HALT_ENTRY_LOCK_TTLS[mode] ?? HALT_ENTRY_LOCK_TTLS.entries_only;
  try {
    const acquired = await activateEntryLock(sessionId, reason, ttl, {
      requestedMode: mode,
      source: 'AgentHub.halt',
    });
    if (!acquired) {
      console.info(`[AgentHub] Entry lock already active for ${sessionId} (mode=${mode})`);
    }
  } catch (error) {
    console.warn(`[AgentHub] Failed to activate entry lock for ${sessionId} (mode=${mode})`, error);
    throw error;
  }
}

const MAX_ALERTS = 5;

const createSupportState = (): AgentSupportState => ({ alerts: [] });

export class AgentsHub {
  private agents = new Map<string, any>(); // sessionId -> agent (not used in meta-adaptive)
  private symbolToSessions = new Map<string, Set<string>>();

  constructor() {
    this.registerEventSubscriptions();
  }

  get(sessionId: string) { return this.agents.get(sessionId) || null; }

  getSupportState(sessionId: string): AgentSupportState | null {
    const agent = this.agents.get(sessionId);
    return (agent?.supportState as AgentSupportState | undefined) ?? null;
  }

  async activate(sessionId: string, profile: ActivationProfile) {
    // Meta-adaptive doesn't use agent instances - create minimal stub with runtime state
    const supportState = createSupportState();
    const a: any = { 
      sessionId, 
      profile,
      state: 'ACTIVE', // Meta-adaptive agents are stateless - show as ACTIVE when running
      bias: 'none',
      pos: null, // Initialize to prevent ghost position bugs
      supportState,
      // Stub onTick for compatibility with tests
      onTick: async () => {
        // Meta-adaptive processing happens via tick routing, not agent.onTick
        // This is just a no-op stub for backward compatibility
      },
      // Provide getDiagnostics method for meta-adaptive stub agents
      getDiagnostics: async () => buildSupportDiagnostics({
        sessionId,
        symbol: profile?.symbol ?? null,
        profile,
        state: 'ACTIVE',
        bias: 'none',
        supportState,
      })
    };
    this.agents.set(sessionId, a);
    this.trackSymbolSession(profile?.symbol ?? null, sessionId);
    return a;
  }

  /**
   * BUG FIX: Cleanup inactive agent stubs to prevent memory leaks
   */
  async cleanupInactiveSessions(): Promise<number> {
    try {
      const activeSessions = await prisma.agentSession.findMany({
        select: { id: true },
      });
      const activeIds = new Set(activeSessions.map(s => s.id));
      
      let cleaned = 0;
      for (const [sessionId, agent] of this.agents.entries()) {
        if (!activeIds.has(sessionId)) {
          this.agents.delete(sessionId);
          cleaned++;
        }
      }
      
      return cleaned;
    } catch (error) {
      console.warn('[AgentHub] Failed to cleanup inactive sessions:', error);
      return 0;
    }
  }

  async halt(sessionId: string, mode: 'entries_only' | 'full' = 'full') {
    const agent = this.agents.get(sessionId);
    if (!agent) return;

    const supportsNativeHalt = typeof (agent as any).halt === 'function';
    if (supportsNativeHalt) {
      try {
        await (agent as any).halt(mode);
        return;
      } catch (error) {
        console.warn(`[AgentHub] Agent halt failed for ${sessionId} (mode=${mode})`, error);
      }
    }

    await applyHaltEntryLock(sessionId, mode);
  }

  async closeNow(sessionId: string, reason = 'external_close_now') {
    const a = this.agents.get(sessionId);
    if (a && (a as any).closeNow) await (a as any).closeNow(reason);
  }

  applyAllocation(
    sessionId: string,
    update: {
      capitalUsd?: number;
      budgetFraction?: number;
      maxLeverage?: number;
      leverageCap?: { resolved: number; requested?: number; dynamicMax?: number };
      weight?: number;
      score?: number;
      reason?: string;
    },
  ) {
    const agent = this.agents.get(sessionId);
    if (agent && typeof (agent as any).applyPortfolioAllocation === 'function') {
      (agent as any).applyPortfolioAllocation(update);
    }
  }

  applyStrategyHealth(sessionId: string, guardrail: StrategyGuardrail | null) {
    if (!guardrail) return;
    const agent = this.agents.get(sessionId);
    if (agent && typeof (agent as any).applyStrategyHealth === 'function') {
      (agent as any).applyStrategyHealth(guardrail);
    }
  }

  private async resolveBroker(
    session: { id: string; mode: string; startBalanceUsd: number | null; userId: string | null },
    agent: ReboundRejectionAgent | undefined | null,
    needsBroker: boolean,
  ): Promise<{ broker: Broker | null; source: StopAllSessionResult['brokerSource'] }> {
    const existing = (agent as any)?.broker as Broker | null | undefined;
    if (existing) {
      return { broker: existing, source: 'agent' };
    }
    if (!needsBroker) {
      return { broker: null, source: 'none' };
    }
    if (session.mode === 'paper') {
      const base = new PaperBroker(session.startBalanceUsd ?? undefined);
      const capital = getCapitalManager('paper');
      const broker = new CapitalPoolBroker({
        agentId: session.id,
        mode: 'paper',
        capital,
        broker: base,
        minOrderUsd: capitalConfig.minOrderUSD,
      });
      return { broker, source: 'paper' };
    }
    if (session.mode === 'live' && session.userId) {
      const base = new LiveBroker(session.userId);
      const capital = getCapitalManager('live');
      const broker = new CapitalPoolBroker({
        agentId: session.id,
        mode: 'live',
        capital,
        broker: base,
        minOrderUsd: capitalConfig.minOrderUSD,
      });
      return { broker, source: 'live' };
    }
    return { broker: null, source: 'none' };
  }

  async stopAll(): Promise<StopAllResult> {
    const activeSessions = await prisma.agentSession.findMany({
      where: { stoppedAt: null },
      select: { id: true, symbol: true, mode: true, startBalanceUsd: true, userId: true },
    });

    const results: StopAllSessionResult[] = [];

    for (const session of activeSessions) {
      const agent = this.agents.get(session.id) || null;
      const result: StopAllSessionResult = {
        sessionId: session.id,
        symbol: session.symbol,
        mode: session.mode,
        closeAttempted: false,
        closeOk: false,
        cancelCount: 0,
        cancelFailed: 0,
        positionsClosed: 0,
        haltOk: false,
        brokerSource: 'none',
        errors: [],
      };

      if (agent && typeof (agent as any).closeNow === 'function') {
        result.closeAttempted = true;
        try {
          await (agent as any).closeNow();
          result.closeOk = true;
        } catch (error) {
          result.errors.push(`closeNow_failed:${(error as any)?.message || error}`);
        }
      }

      const openOrders = await prisma.order.findMany({
        where: {
          sessionId: session.id,
          status: { in: ['open', 'created', 'new', 'partially_filled'] },
        },
        select: { id: true, exchangeOrderId: true, clientOrderId: true },
      });
      const needsBroker = openOrders.length > 0;
      const { broker, source } = await this.resolveBroker(
        {
          id: session.id,
          mode: session.mode,
          startBalanceUsd: session.startBalanceUsd ?? null,
          userId: session.userId ?? null,
        },
        agent,
        needsBroker,
      );
      result.brokerSource = source;

      if (broker && openOrders.length) {
        for (const order of openOrders) {
          try {
            const brokerOrderId = order.exchangeOrderId || order.clientOrderId;
            if (brokerOrderId) {
              await broker.cancel(brokerOrderId);
            }
            await prisma.order.update({
              where: { id: order.id },
              data: { status: 'canceled', updatedAt: new Date(), error: null },
            });
            result.cancelCount += 1;
          } catch (error) {
            result.cancelFailed += 1;
            result.errors.push(`cancel_failed:${order.id}:${(error as any)?.message || error}`);
          }
        }
      } else if (openOrders.length) {
        result.cancelFailed += openOrders.length;
        result.errors.push('no_broker_for_open_orders');
      }

      try {
        // Delete positions instead of setting qty to 0 to prevent ghost positions
        const positions = await prisma.position.findMany({
          where: { sessionId: session.id, qty: { gt: 0 } },
          select: { id: true },
        });
        if (positions.length > 0) {
          await prisma.position.deleteMany({
            where: { id: { in: positions.map(p => p.id) } },
          });
          result.positionsClosed = positions.length;
        }
      } catch (error) {
        result.errors.push(`positions_close_failed:${(error as any)?.message || error}`);
      }

      if (agent) {
        try {
          agent.halt('full');
          result.haltOk = true;
        } catch (error) {
          result.errors.push(`halt_failed:${(error as any)?.message || error}`);
        }
      }

      results.push(result);

      this.deactivate(session.id);
    }

    return { sessions: results };
  }

  async onTick(sessionId: string) {
    const a = this.agents.get(sessionId);
    if (a) await a.onTick();
  }

  listActiveIds() { return Array.from(this.agents.keys()); }

  deactivate(sessionId: string): void {
    const agent = this.agents.get(sessionId);
    if (!agent) return;
    const symbol = agent?.profile?.symbol ?? null;
    this.agents.delete(sessionId);
    this.untrackSymbolSession(symbol, sessionId);
  }

  getServices() { return agentServiceRegistry; }

  snapshot() {
    return Array.from(this.agents.entries()).map(([sessionId, agent]) => ({
      sessionId,
      state: agent.state,
      mode: agent.profile?.mode,
      symbol: agent.profile?.symbol,
      hasPosition: !!agent.pos,
      aggressiveness: agent.profile?.aggressiveness ?? null,
      support: agent.supportState
        ? {
            marketQualityScore: agent.supportState.marketQuality?.data.score ?? null,
            sentimentBias: agent.supportState.sentiment?.data.bias ?? null,
            sentimentConfidence: agent.supportState.sentiment?.data.confidence ?? null,
            riskMaxPositionUsd: agent.supportState.riskLimits?.data.maxPositionUsd ?? null,
            predictorConfidence: agent.supportState.predictor?.data.confidence ?? null,
            executionStrategy: agent.supportState.executionPlan?.data.strategy ?? null,
            decisionIntentCount: agent.supportState.decisions?.data.intents.length ?? 0,
            lastActionStatus: agent.supportState.actions?.data ?? null,
            lastAlert: agent.supportState.alerts.at(-1) ?? null,
          }
        : null,
    }));
  }

  private registerEventSubscriptions(): void {
    agentEventBus.subscribe('marketQuality.updated', ({ sessionIds, snapshot }) => {
      sessionIds.forEach((sessionId) => {
        this.updateSupportState(sessionId, (state) => {
          state.marketQuality = { data: snapshot, updatedAt: Date.now() };
        });
      });
    });

    agentEventBus.subscribe('sentiment.updated', ({ symbol, snapshot }) => {
      this.updateSupportStateForSymbol(symbol, (state) => {
        state.sentiment = { data: snapshot, updatedAt: Date.now() };
      });
    });

    agentEventBus.subscribe('riskGovernor.updated', ({ sessionId, limits }) => {
      this.updateSupportState(sessionId, (state) => {
        state.riskLimits = { data: limits, updatedAt: Date.now() };
      });
    });

    agentEventBus.subscribe('riskGovernor.alert', ({ sessionId, symbol, reason, limits }) => {
      this.updateSupportState(sessionId, (state) => {
        state.alerts = [...state.alerts.slice(-(MAX_ALERTS - 1)), {
          reason,
          limits,
          symbol,
          timestamp: Date.now(),
        }];
      });
    });

    agentEventBus.subscribe('execution.plan.ready', ({ sessionId, plan }) => {
      this.updateSupportState(sessionId, (state) => {
        state.executionPlan = { data: plan, updatedAt: Date.now() };
      });
    });

    agentEventBus.subscribe('predictor.insight', ({ symbol, insight }) => {
      this.updateSupportStateForSymbol(symbol, (state) => {
        state.predictor = { data: insight, updatedAt: Date.now() };
      });
    });

    agentEventBus.subscribe('decisions.intent', ({ sessionId, intents }) => {
      this.updateSupportState(sessionId, (state) => {
        state.decisions = {
          data: { intents },
          updatedAt: Date.now(),
        };
      });
    });

    agentEventBus.subscribe('actions.executed', ({ sessionId, intentId, type, status, details, failureReason }) => {
      this.updateSupportState(sessionId, (state) => {
        state.actions = {
          data: {
            intentId,
            type,
            status,
            failureReason: failureReason ?? null,
            details: details ?? null,
          },
          updatedAt: Date.now(),
        };
      });
    });
  }

  private trackSymbolSession(symbol: string | null | undefined, sessionId: string): void {
    if (!symbol) return;
    const existing = this.symbolToSessions.get(symbol) ?? new Set<string>();
    existing.add(sessionId);
    this.symbolToSessions.set(symbol, existing);
  }

  private untrackSymbolSession(symbol: string | null | undefined, sessionId: string): void {
    if (!symbol) return;
    const existing = this.symbolToSessions.get(symbol);
    if (!existing) return;
    existing.delete(sessionId);
    if (existing.size === 0) {
      this.symbolToSessions.delete(symbol);
    }
  }

  private updateSupportState(sessionId: string, updater: (state: AgentSupportState) => void): void {
    const agent = this.agents.get(sessionId);
    if (!agent) return;
    if (!agent.supportState) {
      agent.supportState = createSupportState();
    }
    updater(agent.supportState as AgentSupportState);
  }

  private updateSupportStateForSymbol(
    symbol: string,
    updater: (state: AgentSupportState, sessionId: string) => void,
  ): void {
    const sessionIds = this.symbolToSessions.get(symbol);
    if (!sessionIds) return;
    sessionIds.forEach((sessionId) => {
      this.updateSupportState(sessionId, (state) => updater(state, sessionId));
    });
  }
}

export const AgentHub = new AgentsHub();
