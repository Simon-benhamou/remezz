import { PrismaClient } from '@prisma/client';
import { createInMemoryPrismaClient } from './inMemoryClient.js';

const UNIT_TEST_MODE = (process.env.UNIT_TEST_MODE || 'false') === 'true';
const USE_IN_MEMORY = UNIT_TEST_MODE || (process.env.USE_IN_MEMORY_DB || '').toLowerCase() === 'true';

const prismaInstance: any = USE_IN_MEMORY ? createInMemoryPrismaClient() : new PrismaClient();

export const prisma: PrismaClient = prismaInstance as PrismaClient;
export const prismaIsInMemory = USE_IN_MEMORY;

if (USE_IN_MEMORY && typeof prismaInstance.$reset !== 'function') {
  prismaInstance.$reset = async () => {};
}
