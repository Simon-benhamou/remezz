import { Router } from 'express';
import { recentAlerts, clearAlertsMemory } from '../monitor/policy.js';
import { prisma } from '../db/client.js';
import { getLastTickAgeSec } from '../engine/events.js';
import { getConfig } from '../utils/env.js';
import { getAIMetrics } from '../metrics/aiCalls.js';
import { computeMonitorAnalytics } from '../monitor/analytics.js';
import { getMarketMetrics } from '../monitor/marketMetrics.js';
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

// Health snapshot across active sessions (staleness, AI, basic status)
router.get('/health', async (req,res)=>{
  try {
    const sessionId = String(req.query.sessionId || '');
    const cfg = getConfig();
    const list = await prisma.agentSession.findMany({ where: { stoppedAt: null }, orderBy: { startedAt: 'asc' } });
    const sessions = (await Promise.all(list.map(async s => {
      const age = getLastTickAgeSec(s.id);
      const stale = typeof age === 'number' && age > cfg.STALE_TICK_SEC;
      const ai = await getAIMetrics(s.id).catch(()=>null);
      return {
        id: s.id,
        symbol: s.symbol,
        mode: s.mode,
        lastTickSec: age,
        stale,
        ai: ai ? { total: ai.total, callsPerHour: ai.callsPerHour, costUsd: ai.costUsd } : null,
        startedAt: s.startedAt,
      };
    }))).filter(x => !sessionId || x.id === sessionId);
    const anyStale = sessions.some(s => s.stale);
    res.json({
      ok: true,
      anyStale,
      staleCount: sessions.filter(s=>s.stale).length,
      sessions,
      marketMetrics: getMarketMetrics(),
      ts: new Date().toISOString()
    });
  } catch (e:any) {
    res.status(500).json({ error: 'health_failed', details: String(e?.message || e) });
  }
});

// Aggregated analytics for monitor mini-panels & health banner
router.get('/analytics', async (req,res)=>{
  const sessionId = String(req.query.sessionId || '');
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  try {
    const data = await computeMonitorAnalytics(sessionId);
    res.json(data);
  } catch (e:any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

router.get('/adaptive-weights', async (req, res) => {
  try {
    const family = req.query.family ? String(req.query.family) : undefined;
    const limitRaw = Number(req.query.limit ?? 50);
    const decisionLimitRaw = Number(req.query.decisionsLimit ?? 25);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50;
    const decisionsLimit = Number.isFinite(decisionLimitRaw) ? Math.max(1, Math.min(200, decisionLimitRaw)) : 25;

    const weights = await prisma.adaptiveThreshold.findMany({
      where: family ? { family } : undefined,
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    const recentDecisions = await prisma.decisionMemory.findMany({
      where: family ? { family } : undefined,
      orderBy: { createdAt: 'desc' },
      take: decisionsLimit,
      select: {
        id: true,
        sessionId: true,
        symbol: true,
        family: true,
        score: true,
        confidence: true,
        biasConfidence: true,
        outcome: true,
        realizedPnl: true,
        createdAt: true,
        features: true,
      },
    });

    const familyStats = await prisma.decisionMemory.groupBy({
      by: ['family'],
      _count: { _all: true },
      _avg: {
        score: true,
        confidence: true,
        realizedPnl: true,
      },
    }).catch(() => []);

    res.json({
      weights: weights.map((w) => ({
        family: w.family,
        momentumWeight: w.momentumWeight,
        volumeWeight: w.volumeWeight,
        volatilityWeight: w.volatilityWeight,
        confidence: w.confidence,
        sampleSize: w.sampleSize,
        lastWinRate: w.lastWinRate,
        updatedAt: w.updatedAt,
        createdAt: w.createdAt,
      })),
      recentDecisions: recentDecisions.map((d) => ({
        id: d.id,
        sessionId: d.sessionId,
        symbol: d.symbol,
        family: d.family,
        score: d.score,
        confidence: d.confidence,
        biasConfidence: d.biasConfidence,
        outcome: d.outcome,
        realizedPnl: d.realizedPnl,
        createdAt: d.createdAt,
        features: d.features,
      })),
      familyStats,
    });
  } catch (error: any) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

router.get('/reports/daily/list', async (req,res)=>{
  const sessionId = String(req.query.sessionId || '');
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const limitRaw = Number(req.query.limit ?? 30);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(120, limitRaw)) : 30;
  try {
    const rows = await prisma.dailyReport.findMany({
      where: { sessionId },
      orderBy: { day: 'desc' },
      take: limit,
    });
    const out = rows.map((r) => ({
      day: r.day,
      sessionId: r.sessionId,
      stats: r.stats,
      llm: r.llm,
      createdAt: r.createdAt,
      persisted: true,
    }));
    res.json(out);
  } catch (e:any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
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
    const baseEquity = Number(sess?.startBalanceUsd || 0);
    const roiPct = baseEquity > 0 ? (pnlUsd / baseEquity) * 100 : undefined;
    const alertCounts = alerts.reduce((m:any,a)=> (m[a.kind]=(m[a.kind]||0)+1, m), {} as Record<string,number>);

    // LLM audit prompt
    let llm: any = null;
    try {
      const prompt = `You are a trading auditor AI. Given the daily stats and alerts, produce a concise JSON audit with keys: {summary, what_went_well:[...], issues:[...], suggestions:[...]}. Keep it actionable.\nStats: ${JSON.stringify({ symbol: sess?.symbol, date, trades: P.length, winRate, avgWin, avgLoss, expectancy, pnlUsd, alertCounts })}`;
      const raw = await llmJSON(prompt, {
        cacheKey: `audit:${sessionId}:${date}`,
        ttlMin: 120,
        context: { sessionId, symbol: sess?.symbol ?? undefined, kind: 'daily_audit' },
      });
      llm = JSON.parse(raw);
    } catch {}

    const payload = {
      date, sessionId, symbol: sess?.symbol,
      stats: { trades: P.length, winRate, avgWin, avgLoss, expectancy, pnlUsd, roiPct },
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
