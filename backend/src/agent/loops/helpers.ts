import { prisma } from '../../db/client.js';

export type ActiveSession = {
  id: string;
  symbol: string;
  mode: 'paper' | 'live';
};

export async function getActiveSessions(): Promise<ActiveSession[]> {
  const sessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null },
    select: { id: true, symbol: true, mode: true },
  });
  return sessions.map((session) => ({
    id: session.id,
    symbol: session.symbol,
    mode: session.mode as 'paper' | 'live',
  }));
}
