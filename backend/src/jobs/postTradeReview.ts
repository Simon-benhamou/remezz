import { prisma } from '../db/client.js';
import { recordOpsEvent } from '../monitor/ops.js';
import { bumpTriggerSampleRate } from '../engine/diagnosticRegistry.js';
import { updateExecutionTelemetry, reportExecutionAnomaly } from '../services/executionTelemetry.js';

type ReviewInput = {
  sessionId: string;
  symbol: string;
  exitOrderId: string;
  planStopDistance?: number | null;
  expectedSlippageBps?: number | null;
};

type ReviewResult = {
  slippageBps: number;
  drawdownPct: number | null;
  fallbackTriggered: boolean;
};

export async function postTradeReview(input: ReviewInput): Promise<ReviewResult | null> {
  const order = await prisma.order.findUnique({
    where: { id: input.exitOrderId },
    include: { Fill: true },
  });
  if (!order) return null;

  const fill = order.fills?.[0] ?? null;
  const slippageBps = Number(order.slippageBps ?? 0);
  const drawdownPct = order.error?.includes('drawdown:')
    ? Number(order.error.split('drawdown:')[1])
    : null;
  const fallbackTriggered = Boolean(order.attempts && order.attempts > 1);

  const expected = input.expectedSlippageBps ?? 12;
  if (Math.abs(slippageBps) > expected * 1.6) {
    reportExecutionAnomaly(input.symbol, {
      reason: 'slippage_exceeded_plan',
      slippageBps,
      fillRatio: Number(order.fillRatio ?? 1),
      passiveOffsetBps: 0,
    });
    bumpTriggerSampleRate(input.symbol, 0.15, 2 * 60 * 60 * 1000);
  }

  if (drawdownPct != null && Math.abs(drawdownPct) > 4) {
    recordOpsEvent({
      level: 'warn',
      source: 'post_trade_review',
      message: 'drawdown_exceeded',
      sessionId: input.sessionId,
      symbol: input.symbol,
      details: { drawdownPct, slippageBps },
    });
  }

  const execMode = (['market', 'limit', 'twap'] as const).includes((order.type || '').toLowerCase() as any)
    ? (order.type as 'market' | 'limit' | 'twap')
    : 'market';

  updateExecutionTelemetry(input.symbol, {
    symbol: input.symbol,
    mode: execMode,
    slippageBps,
    fillRatio: Number(order.fillRatio ?? 1),
    fallbackTriggered,
    spreadBps: 0,
    notionalUsd: Number(order.price ?? 0) * Number(order.qty ?? 0),
  });

  return { slippageBps, drawdownPct, fallbackTriggered };
}

