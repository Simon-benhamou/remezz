import { Router } from "express";
import { prisma } from "../db/client.js";
export const router = Router();
router.get("/", async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  res.json(await prisma.sessionKpi.findUnique({ where: { sessionId } }));
});
