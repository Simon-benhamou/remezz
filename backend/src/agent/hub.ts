import { ReboundRejectionAgent, ActivationProfile } from './state.js';
import { prisma } from '../db/client.js';
import { PaperBroker } from '../broker/paper.js';
import { LiveBroker } from '../broker/live.js';
import type { Broker } from '../broker/types.js';

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

export class AgentsHub {
  private agents = new Map<string, ReboundRejectionAgent>(); // sessionId -> agent

  get(sessionId: string) { return this.agents.get(sessionId) || null; }

  async activate(sessionId: string, profile: ActivationProfile) {
    let a = this.agents.get(sessionId);
    if (!a) { a = new ReboundRejectionAgent(); this.agents.set(sessionId, a); }
    (a as any).sessionId = sessionId;
    await a.activate(profile);
    return a;
  }

  async halt(sessionId: string, mode: 'entries_only' | 'full' = 'full') {
    const a = this.agents.get(sessionId);
    if (a) a.halt(mode);
  }

  async closeNow(sessionId: string) {
    const a = this.agents.get(sessionId);
    if (a && (a as any).closeNow) await (a as any).closeNow();
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
      return { broker: new PaperBroker(session.startBalanceUsd ?? undefined), source: 'paper' };
    }
    if (session.mode === 'live' && session.userId) {
      return { broker: new LiveBroker(session.userId), source: 'live' };
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
        const updated = await prisma.position.updateMany({
          where: { sessionId: session.id, qty: { gt: 0 } },
          data: { qty: 0, updatedAt: new Date(), protectiveStatus: 'halted_stop_all' },
        });
        const closed = updated?.count ?? 0;
        if (closed > 0) {
          result.positionsClosed = closed;
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
    }

    return { sessions: results };
  }

  async onTick(sessionId: string) {
    const a = this.agents.get(sessionId);
    if (a) await a.onTick();
  }

  listActiveIds() { return Array.from(this.agents.keys()); }

  snapshot() {
    return Array.from(this.agents.entries()).map(([sessionId, agent]) => ({
      sessionId,
      state: agent.state,
      mode: agent.profile?.mode,
      symbol: agent.profile?.symbol,
      hasPosition: !!agent.pos,
    }));
  }
}

export const AgentHub = new AgentsHub();
