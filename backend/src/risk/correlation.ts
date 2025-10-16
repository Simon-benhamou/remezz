import { prisma } from '../db/client.js';

type CorrelationAssessment = {
  riskMultiplier: number;
  correlation: number;
  baseExposureUsd: number;
};

function baseSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();
  if (upper.includes('/')) return upper.split('/')[0];
  if (upper.endsWith('USDT')) return upper.slice(0, -4);
  if (upper.endsWith('USD')) return upper.slice(0, -3);
  return upper;
}

export async function assessCorrelationLoad(sessionId: string | null | undefined, symbol: string): Promise<CorrelationAssessment | null> {
  const positions = await prisma.position.findMany({
    where: { qty: { gt: 0 } },
    select: { sessionId: true, symbol: true, qty: true, entryPrice: true },
  });
  if (!positions.length) return null;

  const baseMap = new Map<string, number>();
  for (const pos of positions) {
    const base = baseSymbol(pos.symbol);
    const notional = Number(pos.qty || 0) * Number(pos.entryPrice || 0);
    if (!Number.isFinite(notional) || notional <= 0) continue;
    baseMap.set(base, (baseMap.get(base) || 0) + notional);
  }

  const currentBase = baseSymbol(symbol);
  const exposure = baseMap.get(currentBase) || 0;
  if (exposure <= 0) return null;

  const total = Array.from(baseMap.values()).reduce((acc, val) => acc + val, 0);
  const share = total > 0 ? exposure / total : 0;
  if (share < 0.25) return { riskMultiplier: 1, correlation: share, baseExposureUsd: exposure };

  const multiplier = Math.max(0.4, 1 - share);
  return { riskMultiplier: multiplier, correlation: share, baseExposureUsd: exposure };
}

