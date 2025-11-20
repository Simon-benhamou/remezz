import { prisma } from "../db/client.js";
import { getPersonalityProfile, savePersonalityProfile, DEFAULT_PARAMS } from '../learning/personalityProfile.js';
export async function startSession(
  symbol: string,
  mode: "paper" | "live",
  startBalanceUsd?: number,
  profile?: any,
  userId?: string,
  rrConfig?: { rrFloor?: number; rrCeil?: number; rrBaseMin?: number; rrExpectancy?: any }
) {
  const s = await prisma.agentSession.create({
    data: {
      symbol,
      mode,
      startBalanceUsd,
      profileJson: profile || undefined,
      userId,
      rrFloor: rrConfig?.rrFloor ?? undefined,
      rrCeil: rrConfig?.rrCeil ?? undefined,
      rrBaseMin: rrConfig?.rrBaseMin ?? undefined,
      rrExpectancy: rrConfig?.rrExpectancy ?? undefined,
    },
  });
  await prisma.sessionKpi.create({ data: { sessionId: s.id } });
  // Ensure a personality profile exists for this symbol
  try {
    const existing = await getPersonalityProfile(symbol);
    if (!existing) {
      await savePersonalityProfile(symbol, DEFAULT_PARAMS);
    }
  } catch (error) {
    console.warn(`⚠️ Failed to ensure personality profile for ${symbol}:`, error);
  }
  return s;
}
export async function stopSession(sessionId: string) {
  return prisma.agentSession.update({
    where: { id: sessionId },
    data: { stoppedAt: new Date(), haltedAt: null, haltReason: null },
  });
}
export async function activeSession() {
  return prisma.agentSession.findFirst({
    where: { stoppedAt: null },
    orderBy: { startedAt: "desc" },
  });
}
