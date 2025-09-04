import { Router } from "express";
import { prisma } from "../db/client.js";
import { generateStrategy, selectBestPerp } from "../ai/orchestrator.js";
import { activeSession } from "../session/session.js";
export const router = Router();
router.post("/generate", async (req, res) => {
  const symbol = String(req.body?.symbol || "BTCUSDT");
  const trigger = String(req.body?.trigger || "manual");
  const s = await generateStrategy(symbol, trigger);
  try {
    const saved = await prisma.strategy.create({
      data: {
        id: s.strategyId,
        symbol: s.symbol,
        bias: s.bias,
        confidence: s.confidence,
        entryJson: s.entry,
        riskJson: s.risk,
        validityFrom: s.validity?.from ? new Date(s.validity.from) : undefined,
        validityTo: s.validity?.to ? new Date(s.validity.to) : undefined,
        rationale: s.rationale,
        trigger,
      },
    });
    res.json(saved);
  } catch (e: any) {
    if (e?.code === 'P2002') {
      const existing = await prisma.strategy.findUnique({ where: { id: s.strategyId } });
      if (existing) return res.json(existing);
    }
    throw e;
  }
});
router.get("/today", async (req, res) => {
  const symbol = String(req.query?.symbol || "BTCUSDT");
  const today = new Date().toISOString().slice(0, 10);
  const s = await prisma.strategy.findFirst({
    where: { symbol, id: { startsWith: `${today}:` } },
    orderBy: { createdAt: "desc" },
  });
  res.json(s);
});
router.post('/rank', async (req,res)=>{
  const s = await activeSession();
  if (!s) return res.status(400).json({ error:'no active session' });
  const has = await prisma.order.count({ where:{ sessionId:s.id, status: { in: ['open','new','partially_filled']} }});
  const pos = await prisma.position.count({ where:{ sessionId:s.id }});
  if (has>0 || pos>0) return res.status(409).json({ error:'ranking_disabled_with_open_exposure' });

  const perps = (req.body?.perps as string[]) ?? ['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','AVAX/USDT'];
  const ranked = await selectBestPerp(perps);
  res.json(ranked);
});
