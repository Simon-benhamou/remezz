import { buildTechSnapshot } from '../ai/tech.js';
import { AgentHub } from '../agent/hub.js';
import type { ActivationProfile } from '../agent/state/types.js';
import { serializeActivationProfile } from '../agent/profilePersistence.js';
import { PaperBroker } from '../broker/paper.js';
import { prisma } from '../db/client.js';
import { isInsufficientDataError } from '../data/errors.js';
import { processMetaAdaptiveTick } from '../services/metaAdaptiveOrchestrator.js';
import { metaAdaptiveStrategyAgent } from '../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { stopSession, startSession } from '../session/session.js';
import { HistoricalFeed, type Candle } from './historicalFeed.js';

export type ReplayTrade = {
  exitReason: string | null;
  realizedPnlUsd: number | null;
  capturedAt: string;
};

export type HistoricalReplaySummary = {
  sessionId: string;
  symbol: string;
  startedAt: string;
  stoppedAt?: string | null;
  candlesProcessed: number;
  trades: ReplayTrade[];
  stats: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRatePct: number;
    realizedPnlUsd: number;
    expectancyR: number;
    avgHoldingMin: number;
  };
  kpi?: {
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    roiPct: number;
    expectancy: number;
    winRate: number;
    maxDrawdownPct: number;
    lastUpdated: string;
  } | null;
};

export type HistoricalReplayConfig = {
  symbol: string;
  candles: Candle[];
  baseTimeframe?: string;
  startBalanceUsd?: number;
  warmupBars?: number;
  maxBars?: number;
  cleanup?: boolean;
  logEvery?: number;
};

function buildActivationProfile(symbol: string, startBalanceUsd?: number): ActivationProfile {
  return {
    symbol,
    mode: 'paper',
    maxLeverage: 5,
    requestedMaxLeverage: 5,
    leverageCap: undefined,
    riskPerTradePct: 1,
    dailyLossLimitPct: 3.5,
    timestamp: new Date().toISOString(),
    startBalanceUsd,
    budgetFraction: 1,
    aggressiveness: 'reactive',
    strategyEngine: 'meta_adaptive',
    rrFloor: 1,
    rrCeil: 2.5,
    rrBaseMin: 1.2,
  } as ActivationProfile;
}

async function summarizeReplay(sessionId: string, candlesProcessed: number): Promise<HistoricalReplaySummary> {
  const [session, kpi, exits] = await Promise.all([
    prisma.agentSession.findUnique({ where: { id: sessionId } }),
    prisma.sessionKpi.findUnique({ where: { sessionId } }),
    prisma.triggerLog.findMany({
      where: { sessionId, kind: 'exit_diagnostic' },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  if (!session) {
    throw new Error(`Session ${sessionId} no longer exists`);
  }

  const trades: ReplayTrade[] = exits.map((log) => {
    const payload = (log.payload ?? {}) as Record<string, unknown>;
    const realized = typeof payload.realizedPnl === 'number' ? payload.realizedPnl : null;
    const reason = typeof payload.reason === 'string' ? payload.reason : null;
    const capturedAt = typeof payload.capturedAt === 'string'
      ? payload.capturedAt
      : log.createdAt.toISOString();
    return {
      exitReason: reason,
      realizedPnlUsd: realized,
      capturedAt,
    };
  });

  const wins = trades.filter((trade) => (trade.realizedPnlUsd ?? 0) > 0).length;
  const losses = trades.filter((trade) => (trade.realizedPnlUsd ?? 0) < 0).length;
  const realizedPnlUsd = trades.reduce((sum, trade) => sum + (trade.realizedPnlUsd ?? 0), 0);
  const totalTrades = trades.length;
  const winRatePct = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

  return {
    sessionId,
    symbol: session.symbol,
    startedAt: session.startedAt.toISOString(),
    stoppedAt: session.stoppedAt?.toISOString() ?? null,
    candlesProcessed,
    trades,
    stats: {
      totalTrades,
      wins,
      losses,
      winRatePct,
      realizedPnlUsd,
      expectancyR: kpi?.expectancy ?? 0,
      avgHoldingMin: kpi?.avgHoldingMin ?? 0,
    },
    kpi: kpi
      ? {
          realizedPnlUsd: kpi.realizedPnlUsd,
          unrealizedPnlUsd: kpi.unrealizedPnlUsd,
          roiPct: kpi.roiPct,
          expectancy: kpi.expectancy,
          winRate: kpi.winRate,
          maxDrawdownPct: kpi.maxDrawdownPct,
          lastUpdated: kpi.lastUpdated.toISOString(),
        }
      : null,
  };
}

async function cleanupSessionArtifacts(sessionId: string): Promise<void> {
  await prisma.fill.deleteMany({ where: { sessionId } });
  await prisma.order.deleteMany({ where: { sessionId } });
  await prisma.position.deleteMany({ where: { sessionId } });
  await prisma.triggerLog.deleteMany({ where: { sessionId } });
  await prisma.sessionKpi.deleteMany({ where: { sessionId } });
  await prisma.agentSession.delete({ where: { id: sessionId } });
}

export async function runHistoricalReplay(config: HistoricalReplayConfig): Promise<HistoricalReplaySummary> {
  if (!config.symbol) {
    throw new Error('Historical replay requires a symbol');
  }
  if (!config.candles?.length) {
    throw new Error('Historical replay requires at least one candle');
  }

  const feed = new HistoricalFeed({
    symbol: config.symbol,
    baseTimeframe: config.baseTimeframe,
    candles: config.candles,
    warmupBars: config.warmupBars,
  });
  feed.install();

  const profile = buildActivationProfile(config.symbol, config.startBalanceUsd);
  const serialized = serializeActivationProfile(profile, { budgetPct: 100 });
  const session = await startSession(config.symbol, 'paper', config.startBalanceUsd, serialized);
  const agent = await AgentHub.activate(session.id, profile);
  const broker = new PaperBroker(config.startBalanceUsd ?? 10_000);
  agent.broker = broker;

  const maxSteps = config.maxBars ?? feed.totalBars;
  let processed = 0;

  metaAdaptiveStrategyAgent.enableGuardBypass(session.id);
  try {
    while (feed.hasNext() && processed < maxSteps) {
      feed.advance();
      try {
        const tech = await buildTechSnapshot(config.symbol, undefined, { bypassCache: true });
        await processMetaAdaptiveTick(session.id, config.symbol, tech);
      } catch (error) {
        if (isInsufficientDataError(error)) {
          continue;
        }
        feed.dispose();
        throw error;
      }
      processed += 1;
      if (config.logEvery && processed % config.logEvery === 0) {
        console.log(`⏱️  Replay ${config.symbol}: processed ${processed} bars (cursor=${new Date(feed.currentTimestamp).toISOString()})`);
      }
    }
  } finally {
    metaAdaptiveStrategyAgent.disableGuardBypass(session.id);
  }

  await stopSession(session.id);
  const summary = await summarizeReplay(session.id, feed.processedBars);

  feed.dispose();

  if (config.cleanup) {
    await cleanupSessionArtifacts(session.id);
  }

  return summary;
}
