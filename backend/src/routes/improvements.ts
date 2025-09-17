import { Router } from 'express';
import { prisma } from '../db/client.js';

const router = Router();

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const STATUSES = new Set(['open', 'in_progress', 'resolved']);

function normalizeString(val: any, fallback = ''): string {
  if (typeof val === 'string' && val.trim()) return val.trim();
  return fallback;
}

router.get('/', async (req, res) => {
  const { status } = req.query as { status?: string };
  const where: any = {};
  if (status && STATUSES.has(status)) where.status = status;
  const items = await prisma.improvementItem.findMany({
    where,
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });
  res.json(items);
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  const title = normalizeString(body.title);
  const description = normalizeString(body.description);
  if (!title || !description) {
    return res.status(400).json({ error: 'title_and_description_required' });
  }
  const severityRaw = normalizeString(body.severity || 'medium').toLowerCase();
  const severity = SEVERITIES.has(severityRaw) ? severityRaw : 'medium';
  const statusRaw = normalizeString(body.status || 'open').toLowerCase();
  const status = STATUSES.has(statusRaw) ? statusRaw : 'open';
  const tags = Array.isArray(body.tags)
    ? body.tags.map((t: any) => String(t).trim()).filter((t: string) => t.length > 0)
    : [];
  const context = body.context && typeof body.context === 'object' ? body.context : undefined;
  const reporter = normalizeString(body.reporter || '');

  const item = await prisma.improvementItem.create({
    data: {
      title,
      description,
      severity,
      status,
      tags,
      context,
      reporter: reporter || undefined,
    },
  });
  res.json(item);
});

router.put('/:id', async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body || {};
  try {
    const updateData: any = {};
    if (body.title !== undefined) {
      const title = normalizeString(body.title);
      if (!title) return res.status(400).json({ error: 'invalid_title' });
      updateData.title = title;
    }
    if (body.description !== undefined) {
      const description = normalizeString(body.description);
      if (!description) return res.status(400).json({ error: 'invalid_description' });
      updateData.description = description;
    }
    if (body.severity !== undefined) {
      const severity = normalizeString(body.severity).toLowerCase();
      if (!SEVERITIES.has(severity)) return res.status(400).json({ error: 'invalid_severity' });
      updateData.severity = severity;
    }
    if (body.status !== undefined) {
      const status = normalizeString(body.status).toLowerCase();
      if (!STATUSES.has(status)) return res.status(400).json({ error: 'invalid_status' });
      updateData.status = status;
    }
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags)) return res.status(400).json({ error: 'invalid_tags' });
      updateData.tags = body.tags.map((t: any) => String(t).trim()).filter((t: string) => t.length > 0);
    }
    if (body.context !== undefined) {
      if (body.context && typeof body.context !== 'object') return res.status(400).json({ error: 'invalid_context' });
      updateData.context = body.context ?? null;
    }
    if (body.reporter !== undefined) {
      const reporter = normalizeString(body.reporter);
      updateData.reporter = reporter || null;
    }

    const item = await prisma.improvementItem.update({ where: { id }, data: updateData });
    res.json(item);
  } catch (e: any) {
    if (String(e?.code) === 'P2025') return res.status(404).json({ error: 'not_found' });
    throw e;
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params as { id: string };
  try {
    await prisma.improvementItem.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e: any) {
    if (String(e?.code) === 'P2025') return res.status(404).json({ error: 'not_found' });
    throw e;
  }
});

export { router };
