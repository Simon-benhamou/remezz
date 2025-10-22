import { Router } from 'express';
import { authenticateUser, requireRole, type AuthenticatedRequest } from '../middleware/auth.js';
import { listSchedulerJobs, replaySchedulerJob } from '../services/schedulerJobService.js';
import { computeAgentHealth, computeOpsMetrics, recentOpsEvents } from '../monitor/ops.js';

export const router = Router();

router.get('/metrics', async (_req, res) => {
  try {
    const snapshot = await computeOpsMetrics();
    res.json(snapshot);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

router.get('/agent-health', async (_req, res) => {
  try {
    const snapshot = await computeAgentHealth();
    res.json(snapshot);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

router.get('/events', (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId.trim().length
    ? req.query.sessionId
    : undefined;
  const rows = recentOpsEvents(Number.isFinite(limit) ? limit : 50, { sessionId });
  res.json(rows);
});

router.get('/scheduler/jobs', authenticateUser, requireRole(['admin']), async (req: AuthenticatedRequest, res) => {
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

router.post('/scheduler/jobs/:id/replay', authenticateUser, requireRole(['admin']), async (req: AuthenticatedRequest, res) => {
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
