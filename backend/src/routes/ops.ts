import { Router } from 'express';
import { authenticateUser, requireRole, type AuthenticatedRequest } from '../middleware/auth.js';
import { prisma } from '../db/client.js';
import { listSchedulerJobs, replaySchedulerJob } from '../services/schedulerJobService.js';
import { computeAgentHealth, computeOpsMetrics, recentOpsEvents } from '../monitor/ops.js';
import { getOpsJobsSnapshot } from '../monitor/opsJobs.js';
import { getRegenerationStats } from '../engine/events.js';
import { getSelectorSnapshot, refreshSelectorSnapshot } from '../services/selectorAgent.js';
import { getSubagentLearningSnapshot, refreshSubagentLearning } from '../services/subagentLearning.js';

export const router = Router();

router.use(authenticateUser);

const hasGlobalScope = (user?: AuthenticatedRequest['user']) => Boolean(user?.isLegacy || user?.role === 'admin');

router.get('/metrics', async (req: AuthenticatedRequest, res) => {
  try {
    const includeAll = hasGlobalScope(req.user);
    if (!includeAll && !req.user?.id) {
      return res.status(401).json({ error: 'auth_required' });
    }
    const snapshot = await computeOpsMetrics({
      includeAll,
      userId: includeAll ? undefined : req.user?.id,
    });
    res.json(snapshot);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

router.get('/agent-health', async (req: AuthenticatedRequest, res) => {
  try {
    const includeAll = hasGlobalScope(req.user);
    if (!includeAll && !req.user?.id) {
      return res.status(401).json({ error: 'auth_required' });
    }
    const snapshot = await computeAgentHealth(undefined, {
      userId: includeAll ? undefined : req.user?.id,
      includeAll,
    });
    res.json(snapshot);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

router.get('/events', async (req: AuthenticatedRequest, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId.trim().length
      ? req.query.sessionId
      : undefined;
    const includeAll = hasGlobalScope(req.user);
    let allowedSessionIds: Set<string> | undefined;

    if (!includeAll) {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'auth_required' });
      }
      const ownedSessions = await prisma.agentSession.findMany({
        where: { userId: req.user.id },
        select: { id: true },
      });
      allowedSessionIds = new Set(ownedSessions.map((row) => row.id));
      if (sessionId && !allowedSessionIds.has(sessionId)) {
        return res.status(403).json({ error: 'session_forbidden' });
      }
    }

    const rows = recentOpsEvents(Number.isFinite(limit) ? limit : 50, {
      sessionId,
      allowedSessionIds,
    });
    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

router.get('/jobs', async (_req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await getOpsJobsSnapshot({ force: true });
    res.json(snapshot);
  } catch (error: any) {
    res.status(500).json({ error: 'ops_jobs_failed', message: String(error?.message || error) });
  }
});

router.get('/selector', async (req: AuthenticatedRequest, res) => {
  try {
    const force = req.query.force === 'true';
    const refreshReason = force ? 'rest_force' : 'rest';
    const current = getSelectorSnapshot();
    const snapshot = !current || force
      ? await refreshSelectorSnapshot(refreshReason)
      : current;
    res.json({
      ok: true,
      snapshot,
      refreshedAt: Date.now(),
      reason: (!current || force) ? refreshReason : 'cached',
    });
  } catch (error: any) {
    res.status(500).json({
      ok: false,
      code: 'selector_snapshot_failed',
      message: String(error?.message || error),
    });
  }
});

router.get('/subagent-learning', async (req: AuthenticatedRequest, res) => {
  try {
    const force = req.query.force === 'true';
    const cached = getSubagentLearningSnapshot();
    const snapshot = !force && cached
      ? cached
      : await refreshSubagentLearning(force ? 'ops_force' : 'ops_rest');
    res.json({
      ok: true,
      snapshot,
      fromCache: !force && Boolean(cached),
    });
  } catch (error: any) {
    res.status(500).json({
      ok: false,
      code: 'subagent_learning_failed',
      message: String(error?.message || error),
    });
  }
});

router.post('/subagent-learning/refresh', requireRole(['admin']), async (req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await refreshSubagentLearning('ops_manual');
    res.json({ ok: true, snapshot, reason: 'manual' });
  } catch (error: any) {
    res.status(500).json({
      ok: false,
      code: 'subagent_learning_refresh_failed',
      message: String(error?.message || error),
    });
  }
});

// Phase 2: Get regeneration learning stats
router.get('/regeneration-stats', (req, res) => {
  try {
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
    const stats = getRegenerationStats(symbol);
    
    if (symbol && !stats) {
      return res.json({ symbol, stats: null, message: 'No history for this symbol' });
    }
    
    if (symbol) {
      res.json({ symbol, stats });
    } else {
      // Convert Map to object for JSON serialization
      const statsObj: Record<string, any> = {};
      (stats as Map<string, any>).forEach((value, key) => {
        statsObj[key] = value;
      });
      res.json({ symbols: Object.keys(statsObj), stats: statsObj });
    }
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

router.get('/scheduler/jobs', requireRole(['admin']), async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ ok: false, code: 'auth_required', message: 'Authentication required' });
    }
    if (req.user.role !== 'admin') {
      return res.status(403).json({ ok: false, code: 'forbidden', message: 'Admin role required' });
    }
    const limit = Number(req.query.limit ?? 50);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const jobs = await listSchedulerJobs({
      limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
      status,
      type,
    });
    res.json({ ok: true, jobs });
  } catch (error) {
    res.status(500).json({ ok: false, code: 'scheduler_jobs_error', message: String(error) });
  }
});

router.post('/scheduler/jobs/:id/replay', requireRole(['admin']), async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ ok: false, code: 'auth_required', message: 'Authentication required' });
    }
    if (req.user.role !== 'admin') {
      return res.status(403).json({ ok: false, code: 'forbidden', message: 'Admin role required' });
    }
    const jobId = req.params.id;
    if (!jobId) {
      return res.status(400).json({ ok: false, code: 'job_id_required', message: 'Job id is required' });
    }
    const job = await replaySchedulerJob(jobId, { runAt: new Date() });
    res.json({ ok: true, job });
  } catch (error) {
    res.status(500).json({ ok: false, code: 'scheduler_replay_error', message: String(error) });
  }
});
