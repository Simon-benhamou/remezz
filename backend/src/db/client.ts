// Import types from .prisma/client to get full generated types
// Runtime imports use @prisma/client for production compatibility
import type { PrismaClient as GeneratedPrismaClient, Prisma as GeneratedPrisma } from '.prisma/client';
import { PrismaClient } from '@prisma/client';
import { createInMemoryPrismaClient } from './inMemoryClient.js';

// @prisma/client re-exports Prisma namespace but TypeScript may not see it
// Import it as any and cast to correct type
import * as PrismaClientModule from '@prisma/client';
export const Prisma = (PrismaClientModule as any).Prisma as typeof GeneratedPrisma;

const UNIT_TEST_MODE = (process.env.UNIT_TEST_MODE || 'false') === 'true';
const USE_IN_MEMORY = UNIT_TEST_MODE || (process.env.USE_IN_MEMORY_DB || '').toLowerCase() === 'true';

/**
 * Build DATABASE_URL with connection pool parameters.
 * Neon's pgbouncer handles server-side pooling, but Prisma's internal pool
 * also needs limits to avoid opening too many connections from the app side.
 *   - connection_limit=20: max Prisma connections (default is num_cpus * 2 + 1)
 *   - pool_timeout=30: seconds to wait for a connection from the pool
 * These are appended only if not already present in the URL.
 */
function buildPooledUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;

  const params: Record<string, string> = {
    connection_limit: '20',
    pool_timeout: '30',
  };

  let result = url;
  for (const [key, value] of Object.entries(params)) {
    if (!result.includes(key + '=')) {
      result += (result.includes('?') ? '&' : '?') + `${key}=${value}`;
    }
  }
  return result;
}

// Create instance and cast to generated type to preserve all model information
const pooledUrl = USE_IN_MEMORY ? undefined : buildPooledUrl();
const prismaInstance = (USE_IN_MEMORY
  ? createInMemoryPrismaClient()
  : new (PrismaClient as any)({
      datasources: pooledUrl ? { db: { url: pooledUrl } } : undefined,
    })) as unknown as GeneratedPrismaClient;

// Export with generated types to preserve all models and methods
export const prisma = prismaInstance;
export const prismaIsInMemory = USE_IN_MEMORY;

if (USE_IN_MEMORY && typeof (prismaInstance as any).$reset !== 'function') {
  (prismaInstance as any).$reset = async () => {};
}
