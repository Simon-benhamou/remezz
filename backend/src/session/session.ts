import { prisma } from "../db/client.js";
export async function startSession(
  symbol: string,
  mode: "paper" | "live",
  startBalanceUsd?: number
) {
  const s = await prisma.agentSession.create({
    data: { symbol, mode, startBalanceUsd },
  });
  await prisma.sessionKpi.create({ data: { sessionId: s.id } });
  return s;
}
export async function stopSession(sessionId: string) {
  return prisma.agentSession.update({
    where: { id: sessionId },
    data: { stoppedAt: new Date() },
  });
}
export async function activeSession() {
  return prisma.agentSession.findFirst({
    where: { stoppedAt: null },
    orderBy: { startedAt: "desc" },
  });
}
