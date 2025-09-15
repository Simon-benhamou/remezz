import { Router } from 'express';
import { llmJSON } from '../ai/llm.js';

export const router = Router();

router.get('/test', async (req, res) => {
  const provider = String(req.query.provider || 'openai') as any;
  try {
    const out = await llmJSON('{"health":"check"}', { provider, bypassRate: true, noCache: true });
    res.json({ ok: true, provider, sample: out });
  } catch (e: any) {
    res.status(500).json({ ok: false, provider, error: String(e?.message || e) });
  }
});

