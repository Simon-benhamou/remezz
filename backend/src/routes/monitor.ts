import { Router } from 'express';
import { recentAlerts, clearAlertsMemory } from '../monitor/policy.js';
import { prisma } from '../db/client.js';
import { llmJSON } from '../ai/llm.js';

export const router = Router();

// Recent policy alerts (in-memory)
// source param controls where alerts are fetched: 'db' | 'mem' | 'auto'
router.get('/alerts', async (req,res)=>{
  const sessionId = String(req.query.sessionId || '');
  const source = String(req.query.source || 'auto');
  if (source === 'mem') return res.json(recentAlerts(sessionId || undefined));
  if (source === 'db') {
    try {
      const where: any = sessionId ? { sessionId } : {};
      const rows = await prisma.alert.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
      return res.json(rows.map(r => ({ id: r.id, sessionId: r.sessionId, symbol: r.symbol, kind: r.kind, severity: r.severity, details: r.details, ts: new Date(r.createdAt).getTime() })));
    } catch (e:any) { return res.status(500).json({ error: String(e?.message || e) }); }
  }
  // auto: prefer DB, fallback to memory only if DB errors out
  try {
    const where: any = sessionId ? { sessionId } : {};
    const rows = await prisma.alert.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    return res.json(rows.map(r => ({ id: r.id, sessionId: r.sessionId, symbol: r.symbol, kind: r.kind, severity: r.severity, details: r.details, ts: new Date(r.createdAt).getTime() })));
  } catch {}
  res.json(recentAlerts(sessionId || undefined));
});

// Administrative: purge in-memory alerts buffer (does not touch DB)
router.post('/alerts/purge', async (_req,res)=>{
  try { clearAlertsMemory(); res.json({ ok: true }); } catch (e:any) { res.status(500).json({ error: String(e?.message||e) }); }
});

// Daily report with LLM analysis (no persistence for now)
router.get('/reports/daily', async (req,res)=>{
  const sessionId = String(req.query.sessionId || '');
  const date = String(req.query.date || new Date().toISOString().slice(0,10)); // YYYY-MM-DD
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const dayStart = new Date(date + 'T00:00:00.000Z');
  const dayEnd = new Date(dayStart.getTime() + 24*3600*1000);
  const refresh = String(req.query.refresh || 'false') === 'true';

  try {
    if (!refresh) {
      const existing = await prisma.dailyReport.findUnique({ where: { sessionId_day: { sessionId, day: date } } as any });
      if (existing) return res.json({ date, sessionId, symbol: (await prisma.agentSession.findUnique({ where: { id: sessionId } }))?.symbol, stats: existing.stats, llm: existing.llm, persisted: true });
    }
    const [sess, orders, fills, alerts] = await Promise.all([
      prisma.agentSession.findUnique({ where: { id: sessionId } }),
      prisma.order.findMany({ where: { sessionId, createdAt: { gte: dayStart, lt: dayEnd }, clientOrderId: { endsWith: '.exit' } }, orderBy: { createdAt: 'asc' } }),
      prisma.fill.findMany({ where: { sessionId, ts: { gte: dayStart, lt: dayEnd } }, orderBy: { ts: 'asc' } }),
      Promise.resolve(recentAlerts(sessionId).filter(a=> a.ts >= dayStart.getTime() && a.ts < dayEnd.getTime())),
    ]);

    // Basic stats
    const exits = orders;
    const P = (exits || []).map(o=> Number(o.pctChange || 0));
    const wins = P.filter(v=> v>0).length;
    const losses = P.filter(v=> v<0).length;
    const avgWin = P.filter(v=> v>0).reduce((a,b)=>a+b,0)/(wins||1);
    const avgLoss = P.filter(v=> v<0).reduce((a,b)=>a+b,0)/(losses||1);
    const winRate = P.length ? wins/P.length : 0;
    const expectancy = (winRate * avgWin) + ((1-winRate) * (avgLoss||0));
    const pnlUsd = (fills||[]).reduce((s,f)=> s + Number(f.realizedPnl||0), 0);
    const alertCounts = alerts.reduce((m:any,a)=> (m[a.kind]=(m[a.kind]||0)+1, m), {} as Record<string,number>);

    // LLM audit prompt
    let llm: any = null;
    try {
      const prompt = `You are a trading auditor AI. Given the daily stats and alerts, produce a concise JSON audit with keys: {summary, what_went_well:[...], issues:[...], suggestions:[...]}. Keep it actionable.\nStats: ${JSON.stringify({ symbol: sess?.symbol, date, trades: P.length, winRate, avgWin, avgLoss, expectancy, pnlUsd, alertCounts })}`;
      const raw = await llmJSON(prompt, { cacheKey: `audit:${sessionId}:${date}`, ttlMin: 120 });
      llm = JSON.parse(raw);
    } catch {}

    const payload = {
      date, sessionId, symbol: sess?.symbol,
      stats: { trades: P.length, winRate, avgWin, avgLoss, expectancy, pnlUsd },
      alerts: { counts: alertCounts, recent: alerts.slice(0,20) },
      llm: llm || {
        summary: 'Daily audit generated without LLM.',
        what_went_well: [winRate>0.5? 'Win rate above 50%':''],
        issues: [expectancy<0? 'Negative expectancy':''].filter(Boolean),
        suggestions: ['Consider tuning trailing and first TP if expectancy is negative.']
      }
    };
    res.json(payload);
  } catch (e:any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Persist a daily report
router.post('/reports/daily', async (req,res)=>{
  try {
    const { sessionId, date, stats, llm } = req.body || {};
    if (!sessionId || !date) return res.status(400).json({ error: 'sessionId_and_date_required' });
    const saved = await prisma.dailyReport.upsert({
      where: { sessionId_day: { sessionId, day: date } as any },
      update: { stats, llm },
      create: { sessionId, day: date, stats, llm },
    });
    res.json(saved);
  } catch (e:any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
