import { prisma } from '../db/client.js';

type LockKind = 'entryLock' | 'rotationLock';

type LockConfig = {
  ttlMs: number;
};

const DEFAULT_LOCK_CONFIG: Record<LockKind, LockConfig> = {
  entryLock: { ttlMs: 120_000 }, // 2 minutes
  rotationLock: { ttlMs: 300_000 }, // 5 minutes
};

export type SessionLockSnapshot = {
  active: boolean;
  reason?: string | null;
  since: string;
  expiresAt?: string | null;
  releasedAt?: string | null;
  meta?: Record<string, any> | null;
};

type MutableProfile = Record<string, any>;

function nowIso(): string {
  return new Date().toISOString();
}

function lockKey(kind: LockKind): LockKind {
  return kind;
}

function cloneProfile(profile: MutableProfile | null | undefined): MutableProfile {
  if (!profile || typeof profile !== 'object') {
    return {};
  }
  return { ...profile };
}

function isLockActiveSnapshot(lock: SessionLockSnapshot | null | undefined, now = Date.now()): boolean {
  if (!lock || lock.active !== true) {
    return false;
  }
  if (lock.expiresAt) {
    const expiry = Date.parse(lock.expiresAt);
    if (Number.isFinite(expiry) && expiry <= now) {
      return false;
    }
  }
  return true;
}

async function fetchProfile(sessionId: string): Promise<MutableProfile> {
  const row = await prisma.agentSession.findUnique({
    where: { id: sessionId },
    select: { profileJson: true },
  });
  return cloneProfile((row?.profileJson as any) ?? {});
}

async function saveProfile(sessionId: string, profile: MutableProfile): Promise<void> {
  await prisma.agentSession.update({
    where: { id: sessionId },
    data: { profileJson: profile as any },
  });
}

async function activateLock(sessionId: string, kind: LockKind, reason: string, ttlMs?: number, meta?: Record<string, any>): Promise<boolean> {
  const key = lockKey(kind);
  const profile = await fetchProfile(sessionId);
  const current = profile[key] as SessionLockSnapshot | undefined;
  const nowTs = Date.now();
  if (isLockActiveSnapshot(current, nowTs)) {
    return false;
  }
  const ttl = Number.isFinite(ttlMs) && ttlMs ? Math.max(1_000, ttlMs) : DEFAULT_LOCK_CONFIG[kind].ttlMs;
  const expiresAt = new Date(nowTs + ttl).toISOString();
  profile[key] = {
    active: true,
    reason,
    since: nowIso(),
    expiresAt,
    meta: meta ?? null,
  } satisfies SessionLockSnapshot;
  await saveProfile(sessionId, profile);
  return true;
}

async function releaseLock(sessionId: string, kind: LockKind, reason?: string | null): Promise<void> {
  const key = lockKey(kind);
  const profile = await fetchProfile(sessionId);
  const current = profile[key] as SessionLockSnapshot | undefined;
  const since = typeof current?.since === 'string' ? current?.since : nowIso();
  profile[key] = {
    active: false,
    since,
    reason: reason ?? current?.reason ?? null,
    releasedAt: nowIso(),
    expiresAt: null,
    meta: current?.meta ?? null,
  } satisfies SessionLockSnapshot;
  await saveProfile(sessionId, profile);
}

async function getLockSnapshot(sessionId: string, kind: LockKind): Promise<SessionLockSnapshot | null> {
  const profile = await fetchProfile(sessionId);
  const snapshot = profile[lockKey(kind)] as SessionLockSnapshot | undefined;
  if (!snapshot) {
    return null;
  }
  return snapshot;
}

export async function activateEntryLock(sessionId: string, reason: string, ttlMs?: number, meta?: Record<string, any>): Promise<boolean> {
  try {
    return await activateLock(sessionId, 'entryLock', reason, ttlMs, meta);
  } catch (error) {
    console.warn(`[sessionLocks] Failed to activate entry lock for ${sessionId}:`, error);
    return false;
  }
}

export async function releaseEntryLock(sessionId: string, reason?: string | null): Promise<void> {
  try {
    await releaseLock(sessionId, 'entryLock', reason);
  } catch (error) {
    console.warn(`[sessionLocks] Failed to release entry lock for ${sessionId}:`, error);
  }
}

export async function activateRotationLock(sessionId: string, reason: string, ttlMs?: number, meta?: Record<string, any>): Promise<boolean> {
  try {
    return await activateLock(sessionId, 'rotationLock', reason, ttlMs, meta);
  } catch (error) {
    console.warn(`[sessionLocks] Failed to activate rotation lock for ${sessionId}:`, error);
    return false;
  }
}

export async function releaseRotationLock(sessionId: string, reason?: string | null): Promise<void> {
  try {
    await releaseLock(sessionId, 'rotationLock', reason);
  } catch (error) {
    console.warn(`[sessionLocks] Failed to release rotation lock for ${sessionId}:`, error);
  }
}

export function isEntryLockActive(profileJson: any, now = Date.now()): boolean {
  const snapshot = profileJson?.entryLock as SessionLockSnapshot | undefined;
  return isLockActiveSnapshot(snapshot, now);
}

export function isRotationLockActive(profileJson: any, now = Date.now()): boolean {
  const snapshot = profileJson?.rotationLock as SessionLockSnapshot | undefined;
  return isLockActiveSnapshot(snapshot, now);
}

export async function getEntryLockSnapshot(sessionId: string): Promise<SessionLockSnapshot | null> {
  try {
    return await getLockSnapshot(sessionId, 'entryLock');
  } catch (error) {
    console.warn(`[sessionLocks] Failed to fetch entry lock snapshot for ${sessionId}:`, error);
    return null;
  }
}

export async function getRotationLockSnapshot(sessionId: string): Promise<SessionLockSnapshot | null> {
  try {
    return await getLockSnapshot(sessionId, 'rotationLock');
  } catch (error) {
    console.warn(`[sessionLocks] Failed to fetch rotation lock snapshot for ${sessionId}:`, error);
    return null;
  }
}

export function describeLock(snapshot: SessionLockSnapshot | null | undefined): string {
  if (!snapshot) {
    return 'inactive';
  }
  if (!snapshot.active) {
    return `inactive(releasedAt=${snapshot.releasedAt ?? 'n/a'})`;
  }
  return `active(reason=${snapshot.reason ?? 'n/a'}, since=${snapshot.since}, expiresAt=${snapshot.expiresAt ?? 'n/a'})`;
}
