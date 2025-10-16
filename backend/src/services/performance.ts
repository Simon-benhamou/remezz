import { prisma } from "../db/client.js";

export type SessionPerformanceMetrics = {
  sessionId: string;
  startingBalanceUsd: number;
  realizedPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  roiPct: number;
  tradeCount: number;
};

/**
 * Aggregate realized PnL/fees/ROI for one or multiple sessions using order/fill joins.
 * Some fills emitted by older agents never captured sessionId, so we fallback to the
 * parent order's session linkage to ensure metrics stay accurate.
 */
export async function getSessionPerformanceMetrics(
  sessionIds: string[]
): Promise<SessionPerformanceMetrics[]> {
  const ids = Array.from(new Set(sessionIds.filter((id) => typeof id === "string" && id.trim().length > 0)))
    .map((id) => id.trim());
  if (!ids.length) return [];

  const [sessions, orders] = await Promise.all([
    prisma.agentSession.findMany({
      where: { id: { in: ids } },
      select: { id: true, startBalanceUsd: true },
    }),
    prisma.order.findMany({
      where: {
        sessionId: { in: ids },
        status: "filled",
      },
      select: {
        id: true,
        sessionId: true,
      },
    }),
  ]);

  const orderIds = orders.map((order) => order.id);
  const fills = orderIds.length
    ? await prisma.fill.findMany({
        where: {
          orderId: { in: orderIds },
          realizedPnl: { not: null },
        },
        select: { orderId: true, realizedPnl: true, fee: true },
      })
    : [];

  const startBalanceBySession = new Map<string, number>();
  for (const session of sessions) {
    startBalanceBySession.set(session.id, Number(session.startBalanceUsd ?? 0));
  }

  const metricsBySession = new Map<string, SessionPerformanceMetrics>();
  for (const id of ids) {
    metricsBySession.set(id, {
      sessionId: id,
      startingBalanceUsd: Number(startBalanceBySession.get(id) ?? 0),
      realizedPnlUsd: 0,
      feesUsd: 0,
      netPnlUsd: 0,
      roiPct: 0,
      tradeCount: 0,
    });
  }

  const orderToSession = new Map<string, string>();
  for (const order of orders) {
    if (order.sessionId) {
      orderToSession.set(order.id, order.sessionId);
    }
  }

  const countedOrders = new Set<string>();
  for (const fill of fills) {
    const sessionId = orderToSession.get(fill.orderId);
    if (!sessionId) continue;
    const metrics = metricsBySession.get(sessionId);
    if (!metrics) continue;
    const net = Number(fill?.realizedPnl ?? 0);
    const fee = Number(fill?.fee ?? 0);
    metrics.realizedPnlUsd += net + fee;
    metrics.feesUsd += fee;
    const orderKey = `${sessionId}:${fill.orderId}`;
    if (!countedOrders.has(orderKey)) {
      countedOrders.add(orderKey);
      metrics.tradeCount += 1;
    }
  }

  for (const metrics of metricsBySession.values()) {
    metrics.netPnlUsd = metrics.realizedPnlUsd - metrics.feesUsd;
    const startingBalance = metrics.startingBalanceUsd;
    metrics.roiPct = startingBalance > 0 ? (metrics.netPnlUsd / startingBalance) * 100 : 0;
  }

  return Array.from(metricsBySession.values());
}
