import { Router } from "express";
import { getConfig } from "../utils/env.js";
import { activeSession } from "../session/session.js";
import { fullAnalysis } from "../ai/analysis.js";

export const router = Router();

router.get("/", async (req, res) => {
  const qsym = (req.query?.symbol as string) || undefined;
  const s = await activeSession().catch(() => null);
  const cfg = getConfig();
  const symbol = qsym || s?.symbol || cfg.SYMBOL;
  try {
    const out = await fullAnalysis(symbol);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
