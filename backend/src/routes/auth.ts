import { Router } from 'express';
import { getConfig } from '../utils/env.js';

export const router = Router();

// Simple login for demo/testing: single user
// username: simon, password: shira1704
router.post('/login', async (req, res) => {
  const { username, password, code } = req.body || {};
  const cfg = getConfig();
  const okByUser = (typeof username === 'string' && typeof password === 'string' && username === cfg.AUTH_USER && password === cfg.AUTH_PASS);
  const okByCode = (typeof code === 'string' && code && (code === (cfg.ACCESS_CODE || cfg.AUTH_PASS)));
  if (okByUser || okByCode) return res.json({ token: cfg.APP_API_KEY, user: { ok: true } });
  return res.status(401).json({ error: 'invalid_credentials' });
});
