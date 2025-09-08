import { Router } from 'express';
import { runQuickTest } from '../sim/quicktest.js';
import { PlanZ } from '../agent/planSchema.js';

export const router = Router();

router.post('/quicktest', async (req, res) => {
  try {
    const symbol = String(req.body?.symbol || 'BTCUSDT');
    const hours = Number(req.body?.hours || 72);
    const plan = req.body?.plan ? PlanZ.parse(req.body.plan) : undefined;
    const opts = req.body?.opts;
    const out = await runQuickTest(symbol, hours, plan as any, opts);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
