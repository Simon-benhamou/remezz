import { prisma } from '../db/client.js';
import { createLogger } from '../utils/logger.js';

const ledgerLogger = createLogger('performance-ledger');
const DEFAULT_WINDOWS = [60, 360, 1440]; // minutes => 1h, 6h, 24h
const DEFAULT_REFRESH_MS = Math.max(30_000, Number(process.env.AGENT_LEDGER_REFRESH_MS || '60000'));

type JsonRecord = Record<string, unknown>;

type SessionRow = {
  id: string;
  symbol: string;
  currentSymbol: string | null;
  mode: string;
  isSmartAgent: boolean;
  smartConfig: unknown;
  smartHistory: unknown;
  profileJson: unknown;
  planJson: unknown;
  startBalanceUsd: number | null;
  lastSymbolSwitchAt: Date | null;
};

type SessionKpiRow = {
  sessionId: string;
  maxDrawdownPct: number | null;
  stats: unknown;
};

type OrderRow = {
  id: string;
  sessionId: string | null;
  symbol: string;
  createdAt: Date;
  latencyMs: number | null;
  slippageBps: number | null;
};

type FillRow = {
  orderId: string;
  sessionId: string | null;
  realizedPnl: number | null;
  fee: number | null;
  ts: Date;
};

type BucketDescriptor = {
  minutes: number;
  bucketStart: Date;
};

type MetricsResult = {
  hasSamples: boolean;
  tradeCount: number;
  winRate: number;
  realizedPnlUsd: number;
  netPnlUsd: number;
  feesUsd: number;
  avgLatencyMs: number | null;
  avgSlippageBps: number | null;
  volatilityPct: number | null;
  score: number | null;
  stats: JsonRecord;
};

type SessionContext = {
  sessionId: string;
  agentName: string;
  agentFamily: string;
  regime: string | null;
  focusSymbol: string;
  mode: string;
  drawdownPct: number;
  startBalanceUsd: number;
  isSmartAgent: boolean;
  lastSymbolSwitchAt: Date | null;
};

type RefreshOptions = {
  windows?: number[];
  now?: Date;
};

type RefreshSummary = {
  windows: number[];
  combosEvaluated: number;
  rowsUpserted: number;
};

let ledgerTimer: NodeJS.Timeout | null = null;

function alignBucketStart(now: Date, windowMinutes: number): Date {
  const windowMs = Math.max(1, windowMinutes) * 60_000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

function buildSessionSymbolKey(sessionId: string, symbol: string): string {
  return `${sessionId}__${symbol}`;
}

function splitSessionSymbolKey(key: string): { sessionId: string; symbol: string } {
  const idx = key.indexOf('__');
  if (idx === -1) return { sessionId: key, symbol: '' };
  return { sessionId: key.slice(0, idx), symbol: key.slice(idx + 2) };
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function stdDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = average(values);
  if (mean == null) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function computeScore(deltaPct: number, hitRatePct: number, drawdownPct: number, volatilityPct: number): number {
  const wP = 0.6;
  const wH = 0.3;
  const wD = 0.07;
  const wV = 0.03;
  const score = wP * deltaPct + wH * hitRatePct - wD * drawdownPct - wV * volatilityPct;
  return Number(score.toFixed(2));
}

function normalizeProfile(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object') return {};
  if (Array.isArray(value)) return {};
  return value as JsonRecord;
}

function deriveSessionContext(session: SessionRow, kpi?: SessionKpiRow | null): SessionContext {
  const profile = normalizeProfile(session.profileJson);
  const agentName = String(
    profile.agentLabel || profile.name || profile.strategyName || profile.strategy || (session.isSmartAgent ? 'Smart Meta Agent' : 'Meta Adaptive Agent')
  );
  const agentFamily = String(profile.agentFamily || profile.family || (session.isSmartAgent ? 'smart_meta' : 'meta_adaptive'));
  const regime = typeof profile.regimeTag === 'string'
    ? profile.regimeTag
    : typeof profile.regime === 'string'
    ? profile.regime
    : typeof profile.strategyRegime === 'string'
    ? profile.strategyRegime
    : null;
  const focusSymbol = String(session.currentSymbol || profile.currentSymbol || session.symbol || 'UNKNOWN');
  const drawdownPct = Number(kpi?.maxDrawdownPct ?? 0);
  const startBalanceUsd = Number(session.startBalanceUsd ?? 0);

  return {
    sessionId: session.id,
    agentName,
    agentFamily,
    regime,
    focusSymbol,
    mode: session.mode,
    drawdownPct: Number.isFinite(drawdownPct) ? drawdownPct : 0,
    startBalanceUsd: Number.isFinite(startBalanceUsd) ? startBalanceUsd : 0,
    isSmartAgent: Boolean(session.isSmartAgent),
    lastSymbolSwitchAt: session.lastSymbolSwitchAt,
  };
}

function buildMetrics(
  orders: OrderRow[],
  fills: FillRow[],
  context: SessionContext,
): MetricsResult {
  const latencyValues = orders
    .map((order) => (order.latencyMs != null ? Number(order.latencyMs) : null))
    .filter((value): value is number => value != null && Number.isFinite(value));
  const slippageValues = orders
    .map((order) => (order.slippageBps != null ? Math.abs(Number(order.slippageBps)) : null))
    .filter((value): value is number => value != null && Number.isFinite(value));

  const fillGroups = new Map<string, { net: number; gross: number; fee: number }>();
  for (const fill of fills) {
    const orderId = fill.orderId;
    if (!orderId) continue;
    const net = Number(fill.realizedPnl ?? 0);
    const fee = Number(fill.fee ?? 0);
    const gross = net + fee;
    const bucket = fillGroups.get(orderId) ?? { net: 0, gross: 0, fee: 0 };
    bucket.net += net;
    bucket.gross += gross;
    bucket.fee += fee;
    fillGroups.set(orderId, bucket);
  }

  const trades = Array.from(fillGroups.values());
  const tradeCount = trades.length;
  const wins = trades.filter((trade) => trade.gross > 0).length;
  const losses = trades.filter((trade) => trade.gross < 0).length;
  const realizedPnlUsd = trades.reduce((sum, trade) => sum + trade.gross, 0);
  const feesUsd = trades.reduce((sum, trade) => sum + trade.fee, 0);
  const netPnlUsd = realizedPnlUsd - feesUsd;
  const winRate = tradeCount > 0 ? wins / tradeCount : 0;
  const volatilityUsd = stdDeviation(trades.map((trade) => trade.net)) ?? 0;
  const capital = Math.max(context.startBalanceUsd, 1);
  const deltaPct = (netPnlUsd / capital) * 100;
  const volatilityPct = (volatilityUsd / capital) * 100;
  const hitRatePct = winRate * 100;
  const score = tradeCount >= 2
    ? computeScore(deltaPct, hitRatePct, context.drawdownPct, volatilityPct)
    : null;

  return {
    hasSamples: tradeCount > 0 || latencyValues.length > 0,
    tradeCount,
    winRate,
    realizedPnlUsd,
    netPnlUsd,
    feesUsd,
    avgLatencyMs: average(latencyValues),
    avgSlippageBps: average(slippageValues),
    volatilityPct,
    score,
    stats: {
      tradeCount,
      wins,
      losses,
      breakeven: tradeCount - wins - losses,
      realizedGrossUsd: Number(realizedPnlUsd.toFixed(2)),
      feesUsd: Number(feesUsd.toFixed(2)),
      netPnlUsd: Number(netPnlUsd.toFixed(2)),
      volatilityUsd: Number(volatilityUsd.toFixed(4)),
      latencySamples: latencyValues.length,
      slippageSamples: slippageValues.length,
      startBalanceUsd: context.startBalanceUsd,
      lastSymbolSwitchAt: context.lastSymbolSwitchAt?.toISOString() ?? null,
      isSmartAgent: context.isSmartAgent,
    },
  };
}

export async function refreshAgentPerformanceLedger(options: RefreshOptions = {}): Promise<RefreshSummary> {
  const windows = (options.windows && options.windows.length
    ? options.windows
    : DEFAULT_WINDOWS
  )
    .map((value) => Math.max(1, Math.floor(Number(value))))
    .filter((value, index, arr) => Number.isFinite(value) && arr.indexOf(value) === index)
    .sort((a, b) => a - b);

  if (!windows.length) {
    return { windows: [], combosEvaluated: 0, rowsUpserted: 0 };
  }

  const now = options.now ?? new Date();
  const bucketDescriptors: BucketDescriptor[] = windows.map((minutes) => ({
    minutes,
    bucketStart: alignBucketStart(now, minutes),
  }));
  const earliestStart = new Date(Math.min(...bucketDescriptors.map((bucket) => bucket.bucketStart.getTime())));

  const orders = await prisma.order.findMany({
    where: {
      status: 'filled',
      createdAt: { gte: earliestStart },
      sessionId: { not: null },
    },
    select: {
      id: true,
      sessionId: true,
      symbol: true,
      createdAt: true,
      latencyMs: true,
      slippageBps: true,
    },
  });

  if (!orders.length) {
    ledgerLogger.debug('No filled orders since %s; skipping ledger refresh', earliestStart.toISOString());
    return { windows, combosEvaluated: 0, rowsUpserted: 0 };
  }

  const orderMap = new Map<string, OrderRow>();
  const ordersByKey = new Map<string, OrderRow[]>();
  for (const order of orders) {
    orderMap.set(order.id, order);
    if (!order.sessionId) continue;
    const key = buildSessionSymbolKey(order.sessionId, order.symbol);
    const bucket = ordersByKey.get(key);
    if (bucket) bucket.push(order);
    else ordersByKey.set(key, [order]);
  }

  const orderIds = orders.map((order) => order.id);
  const fills = orderIds.length
    ? await prisma.fill.findMany({
        where: {
          orderId: { in: orderIds },
          ts: { gte: earliestStart },
        },
        select: {
          orderId: true,
          sessionId: true,
          realizedPnl: true,
          fee: true,
          ts: true,
        },
      })
    : [];

  const fillsByKey = new Map<string, FillRow[]>();
  for (const fill of fills) {
    const meta = orderMap.get(fill.orderId);
    if (!meta || !meta.sessionId) continue;
    const key = buildSessionSymbolKey(meta.sessionId, meta.symbol);
    const bucket = fillsByKey.get(key);
    if (bucket) bucket.push(fill);
    else fillsByKey.set(key, [fill]);
  }

  const sessionIds = Array.from(new Set(
    Array.from(orderMap.values())
      .map((order) => order.sessionId)
      .filter((value): value is string => typeof value === 'string')
  ));

  const [sessions, kpis] = await Promise.all([
    prisma.agentSession.findMany({
      where: { id: { in: sessionIds } },
      select: {
        id: true,
        symbol: true,
        currentSymbol: true,
        mode: true,
        isSmartAgent: true,
        smartConfig: true,
        smartHistory: true,
        profileJson: true,
        planJson: true,
        startBalanceUsd: true,
        lastSymbolSwitchAt: true,
      },
    }),
    prisma.sessionKpi.findMany({
      where: { sessionId: { in: sessionIds } },
      select: { sessionId: true, maxDrawdownPct: true, stats: true },
    }),
  ]);

  const kpiBySession = new Map(kpis.map((row) => [row.sessionId, row]));
  const sessionContext = new Map(
    sessions.map((session) => [session.id, deriveSessionContext(session, kpiBySession.get(session.id))])
  );

  const comboKeys = new Set<string>([...ordersByKey.keys(), ...fillsByKey.keys()]);
  let rowsUpserted = 0;
  let combosEvaluated = 0;

  for (const key of comboKeys) {
    const { sessionId, symbol } = splitSessionSymbolKey(key);
    const context = sessionContext.get(sessionId);
    if (!context) continue;
    const regimeKey = context.regime ?? 'global';
    const orderSamples = ordersByKey.get(key) ?? [];
    const fillSamples = fillsByKey.get(key) ?? [];

    for (const bucket of bucketDescriptors) {
      const windowOrders = orderSamples.filter((order) => order.createdAt >= bucket.bucketStart);
      const windowFills = fillSamples.filter((fill) => fill.ts >= bucket.bucketStart);
      if (!windowOrders.length && !windowFills.length) {
        continue;
      }
      const metrics = buildMetrics(windowOrders, windowFills, context);
      if (!metrics.hasSamples) {
        continue;
      }
      combosEvaluated += 1;

      await prisma.agentPerformanceLedger.upsert({
        where: {
          agent_performance_window_unique: {
            sessionId,
            symbol,
            mode: context.mode,
            regime: regimeKey,
            windowMinutes: bucket.minutes,
            bucketStart: bucket.bucketStart,
          },
        },
        update: {
          tradeCount: metrics.tradeCount,
          winRate: metrics.winRate,
          realizedPnlUsd: metrics.realizedPnlUsd,
          netPnlUsd: metrics.netPnlUsd,
          feesUsd: metrics.feesUsd,
          avgLatencyMs: metrics.avgLatencyMs,
          avgSlippageBps: metrics.avgSlippageBps,
          score: metrics.score,
          volatilityPct: metrics.volatilityPct,
          drawdownPct: context.drawdownPct,
          stats: metrics.stats as any,
          blockedCount: 0,
          complianceHits: 0,
          agentFamily: context.agentFamily,
          agentName: context.agentName,
        },
        create: {
          sessionId,
          agentName: context.agentName,
          agentFamily: context.agentFamily,
          symbol,
          mode: context.mode,
          regime: regimeKey,
          windowMinutes: bucket.minutes,
          bucketStart: bucket.bucketStart,
          tradeCount: metrics.tradeCount,
          winRate: metrics.winRate,
          realizedPnlUsd: metrics.realizedPnlUsd,
          netPnlUsd: metrics.netPnlUsd,
          feesUsd: metrics.feesUsd,
          avgLatencyMs: metrics.avgLatencyMs,
          avgSlippageBps: metrics.avgSlippageBps,
          avgHoldMinutes: null,
          blockedCount: 0,
          complianceHits: 0,
          score: metrics.score,
          volatilityPct: metrics.volatilityPct,
          drawdownPct: context.drawdownPct,
          stats: metrics.stats as any,
        },
      });
      rowsUpserted += 1;
    }
  }

  return { windows, combosEvaluated, rowsUpserted };
}

export function startAgentPerformanceLedgerLoop(intervalMs = DEFAULT_REFRESH_MS) {
  if (process.env.AGENT_LEDGER_DISABLED === 'true') {
    ledgerLogger.info('Agent performance ledger loop disabled via env flag');
    return null;
  }
  if (ledgerTimer) {
    return ledgerTimer;
  }
  const effectiveInterval = Math.max(30_000, intervalMs);

  const run = (label: string) => {
    refreshAgentPerformanceLedger()
      .then((summary) => {
        ledgerLogger.debug(
          'Ledger refresh (%s) upserted=%d combos=%d windows=%s',
          label,
          summary.rowsUpserted,
          summary.combosEvaluated,
          summary.windows.join(',')
        );
      })
      .catch((error) => {
        ledgerLogger.warn('Agent performance ledger refresh failed (%s): %s', label, (error as Error).message);
      });
  };

  run('startup');
  ledgerTimer = setInterval(() => run('interval'), effectiveInterval);
  ledgerLogger.info('Agent performance ledger loop started (interval=%dms)', effectiveInterval);
  return ledgerTimer;
}

export function stopAgentPerformanceLedgerLoop() {
  if (ledgerTimer) {
    clearInterval(ledgerTimer);
    ledgerTimer = null;
  }
}
