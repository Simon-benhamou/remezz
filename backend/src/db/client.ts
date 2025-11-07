import { PrismaClient } from '@prisma/client';

type InMemoryFactory = typeof import('./inMemoryClient.js');

async function loadInMemoryFactory(): Promise<InMemoryFactory['createInMemoryPrismaClient']> {
  const candidates = ['./inMemoryClient.js', './inMemoryClient.ts'];

  for (const candidate of candidates) {
    try {
      const mod = (await import(candidate)) as Partial<InMemoryFactory>;
      if (typeof mod.createInMemoryPrismaClient === 'function') {
        return mod.createInMemoryPrismaClient;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ERR_MODULE_NOT_FOUND') {
        throw error;
      }
    }
  }

  throw new Error('Unable to locate in-memory Prisma client factory.');
}

const createInMemoryPrismaClient = await loadInMemoryFactory();

const UNIT_TEST_MODE = (process.env.UNIT_TEST_MODE || 'false') === 'true';
const USE_IN_MEMORY = UNIT_TEST_MODE || (process.env.USE_IN_MEMORY_DB || '').toLowerCase() === 'true';

const prismaInstance: any = USE_IN_MEMORY ? createInMemoryPrismaClient() : new PrismaClient();

// Export with proper type that includes $queryRaw methods
export const prisma = prismaInstance as PrismaClient & {
  $queryRaw<T = unknown>(query: TemplateStringsArray | string, ...values: any[]): Promise<T>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
};
export const prismaIsInMemory = USE_IN_MEMORY;

if (USE_IN_MEMORY && typeof prismaInstance.$reset !== 'function') {
  prismaInstance.$reset = async () => {};
}
