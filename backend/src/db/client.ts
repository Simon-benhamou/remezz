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

// Create instance and cast to generated type to preserve all model information
const prismaInstance = (USE_IN_MEMORY 
  ? createInMemoryPrismaClient()
  : new PrismaClient()) as unknown as GeneratedPrismaClient;

// Export with generated types to preserve all models and methods
export const prisma = prismaInstance;
export const prismaIsInMemory = USE_IN_MEMORY;

if (USE_IN_MEMORY && typeof (prismaInstance as any).$reset !== 'function') {
  (prismaInstance as any).$reset = async () => {};
}
