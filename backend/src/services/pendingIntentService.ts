/**
 * Pending Intent Service
 * 
 * Manages pending entry intents with database persistence to survive restarts.
 * Replaces in-memory agentMemoryStore for critical entry timing decisions.
 * 
 * Critical for:
 * - Persisting "wait_pullback" and "wait_confirmation" decisions
 * - Ensuring no lost trades on server restart
 * - Providing audit trail of entry timing decisions
 */

import { prisma } from '../db/client.js';
import type { RecognizedStrategySignal } from '../quantai/strategies/metaAdaptive/recognizedStrategies.js';

export type PendingIntentAction = 'wait_pullback' | 'wait_confirmation';

export type PendingIntentStatus = 'active' | 'executed' | 'expired' | 'cancelled';

export interface PendingIntentData {
  id: string;
  sessionId: string;
  symbol: string;
  action: PendingIntentAction;
  targetOffset?: number;
  originalPrice: number;
  originalSignal: RecognizedStrategySignal;
  expiresAt: Date;
  confirmationTicks: number;
  status: PendingIntentStatus;
  createdAt: Date;
  updatedAt: Date;
  executedAt?: Date;
}

export interface CreatePendingIntentParams {
  sessionId: string;
  symbol: string;
  action: PendingIntentAction;
  targetOffset?: number;
  originalPrice: number;
  originalSignal: RecognizedStrategySignal;
  expiresAt: Date;
}

class PendingIntentService {
  /**
   * Create a new pending intent (cancels any existing active intent for the session)
   */
  async create(params: CreatePendingIntentParams): Promise<PendingIntentData> {
    // Cancel any existing active intent for this session
    await this.cancelActiveIntent(params.sessionId);

    const intent = await prisma.pendingIntent.create({
      data: {
        sessionId: params.sessionId,
        symbol: params.symbol,
        action: params.action,
        targetOffset: params.targetOffset,
        originalPrice: params.originalPrice,
        originalSignal: params.originalSignal as any,
        expiresAt: params.expiresAt,
        status: 'active',
        confirmationTicks: 0,
      },
    });

    return intent as PendingIntentData;
  }

  /**
   * Get active pending intent for a session
   */
  async getActive(sessionId: string): Promise<PendingIntentData | null> {
    const intent = await prisma.pendingIntent.findFirst({
      where: {
        sessionId,
        status: 'active',
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return intent as PendingIntentData | null;
  }

  /**
   * Update confirmation ticks for wait_confirmation intent
   */
  async incrementConfirmationTicks(intentId: string): Promise<PendingIntentData> {
    const intent = await prisma.pendingIntent.update({
      where: { id: intentId },
      data: {
        confirmationTicks: {
          increment: 1,
        },
        updatedAt: new Date(),
      },
    });

    return intent as PendingIntentData;
  }

  /**
   * Mark intent as executed
   */
  async markExecuted(intentId: string): Promise<void> {
    await prisma.pendingIntent.update({
      where: { id: intentId },
      data: {
        status: 'executed',
        executedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Mark intent as expired
   */
  async markExpired(intentId: string): Promise<void> {
    await prisma.pendingIntent.update({
      where: { id: intentId },
      data: {
        status: 'expired',
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Cancel active intent for a session
   */
  async cancelActiveIntent(sessionId: string): Promise<void> {
    await prisma.pendingIntent.updateMany({
      where: {
        sessionId,
        status: 'active',
      },
      data: {
        status: 'cancelled',
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Cleanup expired intents (should be run periodically)
   */
  async cleanupExpired(): Promise<number> {
    const now = new Date();
    
    const result = await prisma.pendingIntent.updateMany({
      where: {
        status: 'active',
        expiresAt: {
          lt: now,
        },
      },
      data: {
        status: 'expired',
        updatedAt: now,
      },
    });

    return result.count;
  }

  /**
   * Get all pending intents for debugging/monitoring
   */
  async getAll(filter?: {
    sessionId?: string;
    status?: PendingIntentStatus;
    symbol?: string;
  }): Promise<PendingIntentData[]> {
    const intents = await prisma.pendingIntent.findMany({
      where: filter,
      orderBy: {
        createdAt: 'desc',
      },
      take: 100,
    });

    return intents as PendingIntentData[];
  }

  /**
   * Get statistics about pending intents
   */
  async getStats(): Promise<{
    activeCount: number;
    executedCount: number;
    expiredCount: number;
    cancelledCount: number;
  }> {
    const [active, executed, expired, cancelled] = await Promise.all([
      prisma.pendingIntent.count({ where: { status: 'active' } }),
      prisma.pendingIntent.count({ where: { status: 'executed' } }),
      prisma.pendingIntent.count({ where: { status: 'expired' } }),
      prisma.pendingIntent.count({ where: { status: 'cancelled' } }),
    ]);

    return {
      activeCount: active,
      executedCount: executed,
      expiredCount: expired,
      cancelledCount: cancelled,
    };
  }
}

// Singleton instance
export const pendingIntentService = new PendingIntentService();

// Background cleanup task (run every 5 minutes)
setInterval(async () => {
  try {
    const cleaned = await pendingIntentService.cleanupExpired();
    if (cleaned > 0) {
      console.log(`[PendingIntentService] Cleaned up ${cleaned} expired intents`);
    }
  } catch (error) {
    console.error('[PendingIntentService] Error cleaning up expired intents:', error);
  }
}, 5 * 60 * 1000);
