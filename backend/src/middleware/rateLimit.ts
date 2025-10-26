import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getConfig } from '../utils/env.js';
import { recordOpsEvent } from '../monitor/ops.js';

type LimiterKind = 'agent.ip' | 'agent.key' | 'monitor.ip' | 'monitor.key';

type Bucket = {
  hits: number;
  resetAt: number;
};

type LimiterOptions = {
  id: LimiterKind;
  windowMs: number;
  limit: number;
  keyFn: (req: Request) => string;
  message: string;
};

const stores: Record<LimiterKind, Map<string, Bucket>> = {
  'agent.ip': new Map(),
  'agent.key': new Map(),
  'monitor.ip': new Map(),
  'monitor.key': new Map(),
};

function getRetryAfterMs(bucket: Bucket, now: number) {
  return Math.max(0, bucket.resetAt - now);
}

function buildLimiter(opts: LimiterOptions): RequestHandler {
  const store = stores[opts.id];
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = opts.keyFn(req) || 'anonymous';
    let bucket = store.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { hits: 0, resetAt: now + opts.windowMs };
      store.set(key, bucket);
    }
    bucket.hits += 1;
    if (bucket.hits <= opts.limit) {
      return next();
    }

    const retryMs = getRetryAfterMs(bucket, now);
    const retryAfterSec = Math.max(1, Math.ceil(retryMs / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));

    const [scope, dimension] = opts.id.split('.') as [string, string];
    const code = `rate_limit.${scope}.${dimension}`;

    recordOpsEvent({
      level: 'warn',
      source: 'api_rate_limit',
      message: 'limit_exceeded',
      details: {
        code,
        identifier: key,
        path: req.originalUrl,
        ip: req.ip,
        retryAfterSec,
      },
    });

    res.status(429).json({
      error: 'rate_limit_exceeded',
      code,
      message: opts.message,
      retryAfterSec,
    });
  };
}

type WindowConfig = {
  windowMs: number;
  perIp: number;
  perKey: number;
};

function getWindowConfig(kind: 'agent' | 'monitor'): WindowConfig {
  const cfg = getConfig();
  const baseWindowMs = 60_000;
  if (kind === 'agent') {
    return {
      windowMs: Number(cfg.API_RATE_LIMIT_AGENT_WINDOW_MS ?? baseWindowMs),
      perIp: Number(cfg.API_RATE_LIMIT_AGENT_PER_IP ?? 60),
      perKey: Number(cfg.API_RATE_LIMIT_AGENT_PER_KEY ?? 120),
    };
  }
  return {
    windowMs: Number(cfg.API_RATE_LIMIT_MONITOR_WINDOW_MS ?? baseWindowMs),
    perIp: Number(cfg.API_RATE_LIMIT_MONITOR_PER_IP ?? 120),
    perKey: Number(cfg.API_RATE_LIMIT_MONITOR_PER_KEY ?? 240),
  };
}

function firstHeader(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim()) {
        return entry;
      }
    }
  }
  return '';
}

function stripBearer(raw: string): string {
  return raw.replace(/^Bearer\s+/i, '').trim();
}

function getKey(req: Request) {
  const header = firstHeader(req.headers['x-api-key']).trim();
  if (header) return header;
  const authRaw = firstHeader(req.headers['authorization']);
  return authRaw ? stripBearer(authRaw) : '';
}

export function createAgentRateLimiters(overrides?: Partial<WindowConfig>): RequestHandler[] {
  const cfg = getWindowConfig('agent');
  const windowMs = overrides?.windowMs ?? cfg.windowMs;
  const perIp = overrides?.perIp ?? cfg.perIp;
  const perKey = overrides?.perKey ?? cfg.perKey;
  return [
    buildLimiter({
      id: 'agent.ip',
      windowMs,
      limit: perIp,
      keyFn: (req) => req.ip || req.socket.remoteAddress || 'unknown',
      message: 'Agent API rate limit exceeded for your IP address.',
    }),
    buildLimiter({
      id: 'agent.key',
      windowMs,
      limit: perKey,
      keyFn: getKey,
      message: 'Agent API rate limit exceeded for your credentials.',
    }),
  ];
}

export function createMonitorRateLimiters(overrides?: Partial<WindowConfig>): RequestHandler[] {
  const cfg = getWindowConfig('monitor');
  const windowMs = overrides?.windowMs ?? cfg.windowMs;
  const perIp = overrides?.perIp ?? cfg.perIp;
  const perKey = overrides?.perKey ?? cfg.perKey;
  return [
    buildLimiter({
      id: 'monitor.ip',
      windowMs,
      limit: perIp,
      keyFn: (req) => req.ip || req.socket.remoteAddress || 'unknown',
      message: 'Monitor API rate limit exceeded for your IP address.',
    }),
    buildLimiter({
      id: 'monitor.key',
      windowMs,
      limit: perKey,
      keyFn: getKey,
      message: 'Monitor API rate limit exceeded for your credentials.',
    }),
  ];
}
