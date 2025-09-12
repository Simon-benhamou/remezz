import { Router } from "express";
import { prisma } from "../db/client.js";
export const router = Router();
router.get("/", async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  let where: any = {};
  if (sessionId) where.sessionId = sessionId;
  else {
    const s = await prisma.agentSession.findFirst({ where: { stoppedAt: null }, orderBy: { startedAt: 'desc' } });
    if (s?.id) where.sessionId = s.id;
  }
  const rows = await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json(rows);
});
