/**
 * 💾 Trade Persistence Service
 * 
 * Ce service persiste les Trades directement en DB lors de chaque exit.
 * Avant: Trades calculés dynamiquement depuis les Fills (fragile)
 * Après: Trades créés atomiquement en transaction avec Order + Fill (robuste)
 */

import { prisma } from '../db/client.js';

/**
 * Créer un Trade en DB lors d'un exit
 * 
 * Cette fonction doit être appelée depuis recordExit() en transaction atomique
 */
export async function createTrade(params: {
  sessionId: string;
  symbol: string;
  positionSide: 'long' | 'short';
  qty: number;
  entryPrice: number;
  exitPrice: number;
  realizedPnlUsd: number;
  feesUsd: number;
  leverage?: number | null;
  exitReason?: string | null;
  entryTs: Date;
  exitTs?: Date;
  maxPnlPct?: number | null;
  entryOrderIds: string[];
  exitOrderIds: string[];
}) {
  const exitTs = params.exitTs ?? new Date();
  const entryNotional = params.entryPrice * params.qty;
  
  // Calculer les métriques
  const priceChange = params.positionSide === 'long'
    ? params.exitPrice - params.entryPrice
    : params.entryPrice - params.exitPrice;
  
  const pctChange = (priceChange / params.entryPrice) * 100;
  const roiPct = entryNotional > 0 ? (params.realizedPnlUsd / entryNotional) * 100 : 0;
  const leverage = params.leverage ?? null;
  const roePct = leverage ? roiPct * leverage : roiPct;
  
  // Durée du trade en minutes
  const durationMs = exitTs.getTime() - params.entryTs.getTime();
  const durationMinutes = durationMs > 0 ? Math.round(durationMs / 60000) : null;
  
  // Order count = nombre d'orders uniques
  const allOrderIds = [...params.entryOrderIds, ...params.exitOrderIds];
  const uniqueOrderIds = new Set(allOrderIds);
  const orderCount = uniqueOrderIds.size;
  
  // ID du trade = dernier exitOrderId
  const tradeId = params.exitOrderIds[params.exitOrderIds.length - 1] || 
                  params.entryOrderIds[params.entryOrderIds.length - 1] ||
                  `${params.sessionId}-${exitTs.getTime()}-${params.positionSide}`;

  // Créer le Trade
  const trade = await prisma.trade.create({
    data: {
      id: tradeId,
      sessionId: params.sessionId,
      symbol: params.symbol,
      positionSide: params.positionSide,
      qty: params.qty,
      entryPrice: params.entryPrice,
      exitPrice: params.exitPrice,
      entryNotional,
      realizedPnlUsd: params.realizedPnlUsd,
      feesUsd: params.feesUsd,
      pctChange,
      roiPct,
      leverage,
      roePct,
      orderCount,
      exitReason: params.exitReason ?? null,
      durationMinutes,
      maxPnlPct: params.maxPnlPct ?? null,
      entryTs: params.entryTs,
      exitTs,
    },
  });

  // Mettre à jour les Fills avec le tradeId
  await prisma.fill.updateMany({
    where: {
      orderId: { in: allOrderIds },
    },
    data: {
      tradeId: trade.id,
    },
  });

  return trade;
}

/**
 * Reconstruire les informations d'un trade depuis les Fills
 * 
 * Cette fonction agrège les Fills d'entrée et de sortie pour calculer:
 * - Prix moyen d'entrée/sortie
 * - Quantité totale
 * - Fees cumulés
 * - PnL réalisé
 * - entryTs (timestamp de la première entrée)
 */
export async function aggregateTradeFromFills(params: {
  entryOrderIds: string[];
  exitOrderIds: string[];
}): Promise<{
  entryPrice: number;
  exitPrice: number;
  qty: number;
  feesUsd: number;
  realizedPnlUsd: number;
  entryTs: Date;
  maxPnlPct: number | null;
  exitReason: string | null;
} | null> {
  const allOrderIds = [...params.entryOrderIds, ...params.exitOrderIds];
  
  if (allOrderIds.length === 0) {
    return null;
  }

  // Charger tous les Fills
  const fills = await prisma.fill.findMany({
    where: {
      orderId: { in: allOrderIds },
    },
    orderBy: { ts: 'asc' },
  });

  if (fills.length === 0) {
    return null;
  }

  // Séparer entry et exit
  const entryFills = fills.filter((f) => params.entryOrderIds.includes(f.orderId));
  const exitFills = fills.filter((f) => params.exitOrderIds.includes(f.orderId));

  if (entryFills.length === 0 || exitFills.length === 0) {
    return null;
  }

  // Calculer prix moyen d'entrée (weighted average)
  const entryTotalValue = entryFills.reduce((sum, f) => sum + (f.price * f.qty), 0);
  const entryTotalQty = entryFills.reduce((sum, f) => sum + f.qty, 0);
  const entryPrice = entryTotalValue / entryTotalQty;

  // Calculer prix moyen de sortie (weighted average)
  const exitTotalValue = exitFills.reduce((sum, f) => sum + (f.price * f.qty), 0);
  const exitTotalQty = exitFills.reduce((sum, f) => sum + f.qty, 0);
  const exitPrice = exitTotalValue / exitTotalQty;

  // Fees cumulés
  const feesUsd = fills.reduce((sum, f) => sum + (f.fee ?? 0), 0);

  // PnL réalisé (somme des realizedPnl des exit fills)
  const realizedPnlUsd = exitFills.reduce((sum, f) => sum + (f.realizedPnl ?? 0), 0);

  // entryTs = timestamp du premier fill d'entrée
  const entryTs = entryFills[0].ts;

  // maxPnlPct = max des maxPnlPct des exit fills
  const maxPnlPct = exitFills.reduce(
    (max, f) => (f.maxPnlPct != null && f.maxPnlPct > (max ?? -Infinity) ? f.maxPnlPct : max),
    null as number | null
  );

  // exitReason = premier exitReason trouvé dans les exit fills
  const exitReason = exitFills.find((f) => f.exitReason)?.exitReason ?? null;

  return {
    entryPrice,
    exitPrice,
    qty: entryTotalQty,
    feesUsd,
    realizedPnlUsd,
    entryTs,
    maxPnlPct,
    exitReason,
  };
}
