import { prisma } from "../db/client.js";
import { getUserExchange } from "../exchange/ccxtClient.js";
import { getUserCredentials } from '../services/userCredentials.js';
import { levels } from "../risk/brackets.js";
export type PlaceArgs = {
  sessionId: string;
  strategyId?: string;
  symbol: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  price?: number;
  qty: number;
  leverage?: number;
  stop?: { type: "percent" | "price"; value: number };
  target?: { type: "percent" | "price"; value: number };
  userId: string; // Required for authenticated exchange access
};
export async function placeBracketOrder(a: PlaceArgs) {
  const userCredentials = await getUserCredentials(a.userId);
  if (!userCredentials) {
    throw new Error('User API credentials not found');
  }
  const ex = await getUserExchange(a.userId, userCredentials);
  const clientOrderId = `${a.sessionId}.${a.symbol}.${Date.now()}`;
  const rec = await prisma.order.create({
    data: {
      clientOrderId,
      sessionId: a.sessionId,
      strategyId: a.strategyId,
      symbol: a.symbol,
      side: a.side,
      type: a.type,
      qty: a.qty,
      price: a.price,
      leverage: a.leverage,
      status: "created",
      source: "agent",
    },
  });
  try {
    const order = await ex.createOrder(
      a.symbol,
      a.type,
      a.side,
      a.qty,
      a.price,
      { clientOrderId }
    );
    await prisma.order.update({
      where: { id: rec.id },
      data: { exchangeOrderId: order.id, status: "open" },
    });
    if (a.stop && a.target && a.price) {
      const { stopPrice, takeProfitPrice } = levels(
        a.price,
        a.side,
        a.stop,
        a.target
      );
      const opp = a.side === "buy" ? "sell" : "buy";
      try {
        await ex.createOrder(
          a.symbol,
          "limit",
          opp,
          a.qty / 2,
          takeProfitPrice,
          { reduceOnly: true }
        );
      } catch {}
      try {
        await ex.createOrder(a.symbol, "stop", opp, a.qty, stopPrice, {
          reduceOnly: true,
        });
      } catch {}
    }
  } catch (e: any) {
    await prisma.order.update({
      where: { id: rec.id },
      data: { status: "error", error: String(e?.message || e) },
    });
    throw e;
  }
  return rec;
}
