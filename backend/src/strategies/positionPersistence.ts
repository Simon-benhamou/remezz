/**
 * PositionPersistence - Extracted from SimpleAgent.
 * Handles all Prisma DB operations for positions, orders, fills, and session KPIs.
 */

import { PrismaClient } from '@prisma/client';
import { MomentumConfig, type Position } from './momentumSimple.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('persistence');

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PositionPersistence {
  constructor(private prisma: PrismaClient) {}

  /**
   * Load an existing position from DB (for agent restart recovery).
   */
  async loadExistingPosition(
    sessionId: string,
    symbol: string,
  ): Promise<Position | null> {
    try {
      const dbPosition = await (this.prisma as any).position.findFirst({
        where: { sessionId, symbol },
      });

      if (dbPosition && dbPosition.entryPrice && dbPosition.qty) {
        const notional = dbPosition.qty * dbPosition.entryPrice;
        const leverage = dbPosition.leverage || MomentumConfig.LEVERAGE[symbol as keyof typeof MomentumConfig.LEVERAGE] || 4.5;
        const marginUsd = notional / leverage;

        const position: Position = {
          symbol: dbPosition.symbol,
          side: (dbPosition.side as 'long' | 'short') || 'long',
          entryPrice: dbPosition.entryPrice,
          qty: dbPosition.qty,
          entryTime: dbPosition.openedAt?.getTime() || Date.now(),
          realEntryTime: dbPosition.openedAt?.getTime() || Date.now(),
          stopLoss: dbPosition.stopPrice || undefined,
          orderId: dbPosition.slOrderId || undefined,
          leverage,
          marginUsd,
          highWaterMark: (dbPosition.highWaterMark as number | null) ?? (dbPosition.side === 'long' ? dbPosition.entryPrice : undefined),
          lowWaterMark: (dbPosition.lowWaterMark as number | null) ?? (dbPosition.side === 'short' ? dbPosition.entryPrice : undefined),
          maxPnlPct: (dbPosition.maxPnlPct as number | null) ?? undefined,
          trailingActive: (dbPosition.trailingActive as boolean) ?? false,
          trailingBreachCandles: (dbPosition.trailingBreachCandles as number | null) ?? 0,
          stagnantState: (() => {
            try {
              if (!dbPosition.stagnantState) return undefined;
              if (typeof dbPosition.stagnantState === 'string') {
                return JSON.parse(dbPosition.stagnantState);
              }
              return dbPosition.stagnantState as { triggered: boolean; triggeredAtMinutes?: number; confirmed: boolean; cancelled: boolean; obsPeakPct: number };
            } catch (e) {
              logger.warn(`⚠️ [${symbol}] Failed to parse stagnantState from DB, resetting: ${e}`);
              return undefined;
            }
          })(),
        };

        logger.info(
          `📥 [${symbol}] Loaded existing position: ${position.side} @ $${position.entryPrice}` +
          ` | margin=$${marginUsd.toFixed(2)} | trailingActive=${position.trailingActive}` +
          ` | breachCandles=${position.trailingBreachCandles ?? 0}` +
          ` | maxPnl=${position.maxPnlPct?.toFixed(2) ?? 'N/A'}%` +
          ` | hwm=$${position.highWaterMark?.toFixed(4) ?? 'N/A'}`,
        );

        return position;
      }

      return null;
    } catch (error) {
      logger.error(`❌ [${symbol}] Failed to load position:`, error);
      return null;
    }
  }

  /**
   * Save a new position to DB (entry order + fill + position record).
   */
  async savePositionToDb(
    sessionId: string,
    symbol: string,
    mode: 'paper' | 'live',
    position: Position,
    entryFeeUsd?: number,
  ): Promise<void> {
    try {
      const isLive = mode === 'live';
      const clientOrderId = position.orderId || `${isLive ? 'live' : 'paper'}_entry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const entrySide = position.side === 'long' ? 'buy' : 'sell';
      const entryNotionalUsd = position.qty * position.entryPrice;
      const calculatedFee = entryFeeUsd ?? (entryNotionalUsd * 0.0004);

      const order = await (this.prisma as any).order.create({
        data: {
          clientOrderId,
          sessionId,
          symbol: position.symbol,
          side: entrySide,
          type: 'market',
          qty: position.qty,
          price: position.entryPrice,
          status: 'filled',
          source: 'simple_agent',
          strategyUsed: 'momentum_simple',
          leverage: position.leverage ?? MomentumConfig.LEVERAGE[position.symbol as keyof typeof MomentumConfig.LEVERAGE] ?? 4,
        },
      });

      await (this.prisma as any).fill.create({
        data: {
          orderId: order.id,
          sessionId,
          symbol: position.symbol,
          price: position.entryPrice,
          qty: position.qty,
          side: entrySide,
          realizedPnl: 0,
          fee: calculatedFee,
          strategyUsed: 'momentum_simple',
          strategyFamily: 'momentum',
          ts: new Date(position.entryTime),
        },
      });

      logger.info(`💾 [${symbol}] Entry order logged: ${entrySide.toUpperCase()} @ $${position.entryPrice.toFixed(4)}, fee: $${calculatedFee.toFixed(2)}`);

      await (this.prisma as any).position.create({
        data: {
          sessionId,
          symbol: position.symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          qty: position.qty,
          leverage: MomentumConfig.LEVERAGE[position.symbol as keyof typeof MomentumConfig.LEVERAGE] || 3,
          stopPrice: position.stopLoss,
          openedAt: new Date(position.entryTime),
          highWaterMark: position.side === 'long' ? position.entryPrice : null,
          lowWaterMark: position.side === 'short' ? position.entryPrice : null,
          maxPnlPct: 0,
          trailingActive: false,
          stagnantState: null,
        },
      });
    } catch (error) {
      logger.error(`❌ [${symbol}] Failed to save position to DB:`, error);
      throw error;
    }
  }

  /**
   * Update position tracking state in DB (HWM, trailing, stagnant).
   */
  async updatePositionStateInDb(
    sessionId: string,
    symbol: string,
    position: Position,
  ): Promise<void> {
    try {
      await (this.prisma as any).position.update({
        where: {
          sessionId_symbol: { sessionId, symbol },
        },
        data: {
          highWaterMark: position.highWaterMark ?? null,
          lowWaterMark: position.lowWaterMark ?? null,
          maxPnlPct: position.maxPnlPct ?? null,
          trailingActive: position.trailingActive ?? false,
          trailingBreachCandles: position.trailingBreachCandles ?? 0,
          stagnantState: position.stagnantState ?? null,
        },
      });
    } catch (error: unknown) {
      if (!errMsg(error).includes('Record to update not found')) {
        logger.debug(`⚠️ [${symbol}] Failed to update position state: ${errMsg(error)}`);
      }
    }
  }

  /**
   * Save an exit to DB (atomic transaction: order + trade + fill + delete position).
   * Returns true on success, false on failure.
   */
  async saveExitToDb(
    sessionId: string,
    symbol: string,
    mode: 'paper' | 'live',
    position: Position,
    exitPrice: number,
    reason: string,
    pnlPct: number,
    pnlUsd: number,
    currentPosition: Position | null,
    lastPrice: number,
    exchangeOrderId?: string,
    feeUsd?: number,
  ): Promise<boolean> {
    try {
      const exitSide = position.side === 'long' ? 'sell' : 'buy';
      const isLive = mode === 'live';

      let clientOrderId = exchangeOrderId || `${isLive ? 'live' : 'paper'}_exit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      if (exchangeOrderId) {
        const existing = await (this.prisma as any).order.findFirst({ where: { clientOrderId: exchangeOrderId } });
        if (existing) {
          logger.warn(`⚠️ [${symbol}] Exit order ${exchangeOrderId} already exists in DB, skipping save`);
          return true;
        }
      }

      const notionalUsd = position.qty * exitPrice;
      const calculatedFee = feeUsd ?? (notionalUsd * 0.0004);

      const exitTs = new Date();
      const entryTimeMs = position.realEntryTime ?? position.entryTime ?? Date.now();
      const entryTs = new Date(entryTimeMs);
      if (!position.realEntryTime && !position.entryTime) {
        logger.warn(`⚠️ [${symbol}] position.entryTime was undefined, using fallback: ${entryTs.toISOString()}`);
      }
      const durationMs = exitTs.getTime() - entryTs.getTime();
      const durationMinutes = Math.max(0, Math.round(durationMs / 60000));
      const entryNotional = position.entryPrice * position.qty;
      const priceChange = position.side === 'long'
        ? exitPrice - position.entryPrice
        : position.entryPrice - exitPrice;
      const pctChange = (priceChange / position.entryPrice) * 100;
      const roiPct = entryNotional > 0 ? (pnlUsd / entryNotional) * 100 : 0;
      const leverage = position.leverage ?? MomentumConfig.LEVERAGE[position.symbol as keyof typeof MomentumConfig.LEVERAGE] ?? 4;
      const roePct = roiPct * leverage;

      await (this.prisma as any).$transaction(async (tx: any) => {
        const order = await tx.order.create({
          data: {
            clientOrderId,
            sessionId,
            symbol: position.symbol,
            side: exitSide,
            type: 'market',
            qty: position.qty,
            price: exitPrice,
            status: 'filled',
            source: 'simple_agent',
            strategyUsed: 'momentum_simple',
            leverage,
            pctChange: pnlPct / 100,
          },
        });

        const trade = await tx.trade.create({
          data: {
            id: order.id,
            sessionId,
            symbol: position.symbol,
            positionSide: position.side,
            qty: position.qty,
            entryPrice: position.entryPrice,
            exitPrice,
            entryNotional,
            realizedPnlUsd: pnlUsd,
            feesUsd: calculatedFee * 2,
            pctChange,
            roiPct,
            leverage,
            roePct,
            orderCount: 2,
            exitReason: reason.toUpperCase(),
            durationMinutes,
            maxPnlPct: position.maxPnlPct ?? null,
            entryTs,
            exitTs,
          },
        });

        await tx.fill.create({
          data: {
            orderId: order.id,
            sessionId,
            symbol: position.symbol,
            price: exitPrice,
            qty: position.qty,
            side: exitSide,
            realizedPnl: pnlUsd,
            fee: calculatedFee,
            strategyUsed: 'momentum_simple',
            strategyFamily: 'momentum',
            ts: exitTs,
            exitReason: reason.toUpperCase(),
            entryTs,
            maxPnlPct: position.maxPnlPct ?? null,
            tradeId: trade.id,
          },
        });

        await tx.position.deleteMany({
          where: { sessionId, symbol: position.symbol },
        });

        return { order };
      }, {
        maxWait: 5000,
        timeout: 10000,
      });

      logger.info(`✅ [${symbol}] Trade created (atomic): ${position.side.toUpperCase()} ${position.qty} PnL=$${pnlUsd.toFixed(2)}`);

      // Trigger parity verification (async, non-blocking)
      if (process.env.AUTO_VERIFY_PARITY === 'true') {
        import('../services/parityVerificationServiceV2.js').then(({ triggerVerificationV2 }) => {
          triggerVerificationV2(clientOrderId);
        }).catch(() => {});
      }

      // Update session KPI
      await this.updateSessionKpi(sessionId, symbol, currentPosition, lastPrice, pnlUsd, pnlPct);

      logger.info(`💾 [${symbol}] Exit logged: ${reason}, PnL: $${pnlUsd.toFixed(2)} (${pnlPct.toFixed(2)}%), Fee: $${calculatedFee.toFixed(2)}`);
      return true;
    } catch (error) {
      logger.error(`❌ [${symbol}] Failed to save exit to DB:`, error);
      return false;
    }
  }

  /**
   * Update session KPI aggregate metrics after a trade.
   */
  async updateSessionKpi(
    sessionId: string,
    symbol: string,
    currentPosition: Position | null,
    lastPrice: number,
    _tradePnlUsd: number,
    _tradePnlPct: number,
  ): Promise<void> {
    try {
      const fills = await (this.prisma as any).fill.findMany({
        where: { sessionId, realizedPnl: { not: null } },
        orderBy: { ts: 'asc' },
      });

      const exitFills = fills.filter((f: any) => f.realizedPnl !== null && f.realizedPnl !== 0);
      const tradeCount = exitFills.length;
      const wins = exitFills.filter((f: any) => (f.realizedPnl || 0) > 0).length;
      const losses = exitFills.filter((f: any) => (f.realizedPnl || 0) < 0).length;

      const totalRealizedPnl = exitFills.reduce((sum: number, f: any) => sum + (f.realizedPnl || 0), 0);
      const totalFees = fills.reduce((sum: number, f: any) => sum + (f.fee || 0), 0);
      const netRealizedPnl = totalRealizedPnl - totalFees;

      const winRate = tradeCount > 0 ? (wins / tradeCount) * 100 : 0;
      const expectancy = tradeCount > 0 ? netRealizedPnl / tradeCount : 0;

      // Max drawdown
      let peak = 0;
      let cumulative = 0;
      let maxDrawdown = 0;
      for (const fill of exitFills) {
        cumulative += (fill.realizedPnl || 0);
        if (cumulative > peak) peak = cumulative;
        const drawdown = peak > 0 ? (cumulative - peak) / peak * 100 : 0;
        if (drawdown < maxDrawdown) maxDrawdown = drawdown;
      }

      const session = await (this.prisma as any).agentSession.findUnique({
        where: { id: sessionId },
        select: { startBalanceUsd: true },
      });
      const startBalance = session?.startBalanceUsd || 1000;
      const roiPct = startBalance > 0 ? (netRealizedPnl / startBalance) * 100 : 0;

      // Unrealized PnL
      let unrealizedPnlUsd = 0;
      if (currentPosition && lastPrice) {
        if (currentPosition.side === 'long') {
          unrealizedPnlUsd = currentPosition.qty * (lastPrice - currentPosition.entryPrice);
        } else {
          unrealizedPnlUsd = currentPosition.qty * (currentPosition.entryPrice - lastPrice);
        }
      }

      const stats = {
        trades: tradeCount,
        wins,
        losses,
        totalFees,
        netRealizedPnl,
        lastTradeAt: new Date().toISOString(),
        avgWinUsd: wins > 0 ? exitFills.filter((f: any) => (f.realizedPnl || 0) > 0).reduce((s: number, f: any) => s + (f.realizedPnl || 0), 0) / wins : 0,
        avgLossUsd: losses > 0 ? exitFills.filter((f: any) => (f.realizedPnl || 0) < 0).reduce((s: number, f: any) => s + (f.realizedPnl || 0), 0) / losses : 0,
      };

      await (this.prisma as any).sessionKpi.upsert({
        where: { sessionId },
        update: {
          realizedPnlUsd: netRealizedPnl,
          unrealizedPnlUsd,
          roiPct,
          winRate,
          expectancy,
          maxDrawdownPct: Math.abs(maxDrawdown),
          stats,
          lastUpdated: new Date(),
        },
        create: {
          sessionId,
          realizedPnlUsd: netRealizedPnl,
          unrealizedPnlUsd,
          roiPct,
          winRate,
          expectancy,
          maxDrawdownPct: Math.abs(maxDrawdown),
          stats,
        },
      });

      logger.info(`📊 [${symbol}] KPI updated: ${tradeCount} trades, ${winRate.toFixed(1)}% WR, $${netRealizedPnl.toFixed(2)} PnL, ${roiPct.toFixed(2)}% ROI`);
    } catch (error) {
      logger.error(`❌ [${symbol}] Failed to update SessionKpi:`, error);
    }
  }
}
