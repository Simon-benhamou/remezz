import { prisma } from '../../db/client.js';

export type ActiveSession = {
  id: string;
  symbol: string;
  mode: 'paper' | 'live';
};

export async function getActiveSessions(): Promise<ActiveSession[]> {
  const sessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null },
    select: { id: true, symbol: true, currentSymbol: true, mode: true },
  });
  return sessions.map((session) => {
    // ✅ FIXED: Use currentSymbol (active trading symbol) instead of symbol (initial symbol)
    const tradingSymbol = session.currentSymbol || session.symbol;
    if (!tradingSymbol) {
      throw new Error(`Session ${session.id} has no currentSymbol or symbol set`);
    }
    return {
      id: session.id,
      symbol: tradingSymbol,
      mode: session.mode as 'paper' | 'live',
    };
  });
}
