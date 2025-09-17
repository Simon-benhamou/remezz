import { prisma } from '../db/client.js';

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

export type ImprovementPayload = {
  title: string;
  description: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  tags?: string[];
  reporter?: string;
  context?: any;
};

export async function logImprovementAuto(payload: ImprovementPayload) {
  const title = (payload.title || '').trim();
  const description = (payload.description || '').trim();
  if (!title || !description) return;
  const severity = SEVERITIES.has(payload.severity || '') ? payload.severity! : 'medium';
  const tags = Array.isArray(payload.tags) ? payload.tags.filter((tag) => !!tag) : [];
  const reporter = (payload.reporter || '').trim() || undefined;
  try {
    const existing = await prisma.improvementItem.findFirst({
      where: { title, status: { not: 'resolved' } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      await prisma.improvementItem.update({
        where: { id: existing.id },
        data: {
          description,
          severity,
          tags: tags.length ? tags : existing.tags,
          context: payload.context ?? existing.context,
          reporter: reporter ?? existing.reporter,
          status: existing.status,
        },
      });
    } else {
      await prisma.improvementItem.create({
        data: {
          title,
          description,
          severity,
          tags,
          reporter,
          context: payload.context,
        },
      });
    }
  } catch {
    // Swallow errors to avoid cascading failures in critical paths
  }
}
