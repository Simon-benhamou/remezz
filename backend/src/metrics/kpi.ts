import { prisma } from '../db/client.js';
import { getTicker } from '../data/market.js';

export async function recomputeKpi(sessionId: string) {
  const s = await prisma.agentSession.findUnique({ where: { id: sessionId } });
  if (!s) return;
  const sum = await prisma.fill.aggregate({
    where: { sessionId, realizedPnl: { not: null } },
    _sum: { realizedPnl: true },
  });
  const realized = Number(sum._sum.realizedPnl || 0);

  // Unrealized from latest open position (if any)
  let unrealized = 0;
  const pos = await prisma.position.findFirst({ where: { sessionId, qty: { gt: 0 } }, orderBy: { openedAt: 'desc' } });
  if (pos && pos.qty && pos.entryPrice) {
    try {
      const t = await getTicker(pos.symbol);
      const last = Number(t?.last || 0);
      if (last > 0) {
        const dir = pos.side === 'buy' ? 1 : -1;
        unrealized = dir * (last - pos.entryPrice) * pos.qty;
      }
    } catch {}
  }

  const startBal = Number(s.startBalanceUsd || 0);
  const roiPct = startBal > 0 ? ((realized + unrealized) / startBal) * 100 : 0;

  await prisma.sessionKpi.upsert({
    where: { sessionId },
    update: { realizedPnlUsd: realized, unrealizedPnlUsd: unrealized, roiPct, lastUpdated: new Date() },
    create: { sessionId, realizedPnlUsd: realized, unrealizedPnlUsd: unrealized, roiPct },
  });
}

