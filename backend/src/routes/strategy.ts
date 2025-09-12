import { Router } from "express";
import { prisma } from "../db/client.js";
import { selectBestPerp } from "../ai/orchestrator.js";
import { proposePlan } from "../ai/planOrchestrator.js";
import { PlanZ } from "../agent/planSchema.js";
import { activeSession } from "../session/session.js";
import { requestStrategy } from "../ai/strategyManager.js";
import { levels as calcLevels } from "../risk/brackets.js";
export const router = Router();
router.post("/generate", async (req, res) => {
  const symbol = String(req.body?.symbol || "BTCUSDT");
  const trigger = String(req.body?.trigger || "manual");
  const { strategy, levels } = await requestStrategy({ symbol, trigger });
  res.json({ ...(strategy as any), levels });
});
router.get("/today", async (req, res) => {
  const symbol = String(req.query?.symbol || "BTCUSDT");
  const today = new Date().toISOString().slice(0, 10);
  const s = await prisma.strategy.findFirst({
    where: { symbol, id: { startsWith: `${today}:` } },
    orderBy: { createdAt: "desc" },
  });
  if (!s) return res.json(null);
  try {
    const entry: any = (s as any).entryJson || null;
    const risk: any = (s as any).riskJson || null;
    const bias: any = (s as any).bias || 'none';
    const side = bias === 'long' ? 'buy' : 'sell';
    const entryMid = entry?.price ?? (
      typeof entry?.zone?.min === 'number' && typeof entry?.zone?.max === 'number'
        ? (entry.zone.min + entry.zone.max) / 2
        : undefined
    );
    let levels: any = undefined;
    if (typeof entryMid === 'number' && Number.isFinite(entryMid) && entryMid > 0 && risk?.stop && risk?.target) {
      levels = calcLevels(entryMid, side as any, risk.stop, risk.target);
    }
    res.json({
      id: s.id,
      symbol: s.symbol,
      bias: s.bias,
      confidence: s.confidence,
      entry,
      risk,
      validity: { from: s.validityFrom, to: s.validityTo },
      rationale: s.rationale,
      trigger: s.trigger,
      levels,
    });
  } catch {
    res.json(s);
  }
});
// New: Ask LLM for rebound/rejection plan JSON (PlanZ)
router.post('/propose-plan', async (req, res) => {
  const symbol = String(req.body?.symbol || 'BTCUSDT');
  try {
    const plan = await proposePlan(symbol);
    // Respond with validated plan (schema enforced)
    res.json(PlanZ.parse(plan));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
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
