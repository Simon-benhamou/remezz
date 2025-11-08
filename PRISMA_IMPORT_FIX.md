# Fix Prisma Import Path for Production

## Problem

When deploying to production, the application crashed with:
```
TypeError [ERR_INVALID_MODULE_SPECIFIER]: Invalid module ".prisma/client" is not a valid package name
```

This occurred because `.prisma/client` is a local development path that doesn't work in production environments or when using the compiled `dist/` folder.

## Root Cause

The codebase was importing from `.prisma/client` directly:
```typescript
import { PrismaClient, Prisma } from '.prisma/client';
```

While this works locally (because Prisma generates this folder), it fails in production because:
1. `.prisma/client` is not a valid npm package name
2. The path is relative to `node_modules` and doesn't exist in deployed environments
3. TypeScript preserves this import path in the compiled output

## Solution

Changed all Prisma imports to use `@prisma/client` while preserving full type information:

### `backend/src/db/client.ts`
```typescript
// Import types from .prisma/client to get full generated types
// Runtime imports use @prisma/client for production compatibility
import type { PrismaClient as GeneratedPrismaClient, Prisma as GeneratedPrisma } from '.prisma/client';
import { PrismaClient } from '@prisma/client';

// @prisma/client re-exports Prisma namespace but TypeScript may not see it
// Import it as any and cast to correct type
import * as PrismaClientModule from '@prisma/client';
export const Prisma = (PrismaClientModule as any).Prisma as typeof GeneratedPrisma;

// ... rest of the code

// Create instance and cast to generated type to preserve all model information
const prismaInstance = (USE_IN_MEMORY 
  ? createInMemoryPrismaClient()
  : new PrismaClient()) as unknown as GeneratedPrismaClient;

export const prisma = prismaInstance;
```

### Key Points

1. **Type-only imports from `.prisma/client`**: We import types (using `import type`) from `.prisma/client` to get full generated types including all models and methods. These imports are stripped during compilation.

2. **Runtime imports from `@prisma/client`**: All runtime imports use `@prisma/client`, which is the proper npm package that works in production.

3. **Type casting**: We cast the runtime instance to the generated type to preserve full type information for TypeScript.

4. **Prisma namespace**: The `Prisma` namespace is imported dynamically using namespace import and type casting because TypeScript's module resolution doesn't always detect it in the type definitions.

## Files Modified

- `backend/src/db/client.ts` - Main Prisma client wrapper
- `backend/src/learning/strategyOptimizer.ts` - Import Prisma from db/client
- `backend/src/learning/tradeEvaluationLogger.ts` - Import Prisma from db/client  
- `backend/src/services/abTesting.ts` - Import Prisma from db/client
- `backend/src/services/adaptiveThresholdLearning.ts` - Import Prisma from db/client
- `backend/src/services/symbolSpecificOptimization.ts` - Import Prisma from db/client
- `backend/src/services/intelligentAgent/autoUniverseScheduler.ts` - Import Prisma from db/client

## Verification

✅ `npm run build` - Compiles without errors
✅ `node dist/src/db/client.js` - Runs without ERR_INVALID_MODULE_SPECIFIER
✅ `node -e "import('./dist/src/services/abTesting.js')"` - Loads successfully
✅ `node -e "import('./dist/src/learning/personalityProfile.js')"` - Loads successfully

## Why This Works

`@prisma/client` is a proper npm package that:
- Re-exports everything from `.prisma/client` at runtime
- Works in all environments (local dev, production, Docker, etc.)
- Is a valid module specifier according to Node.js ESM rules

By using type-only imports from `.prisma/client` and runtime imports from `@prisma/client`, we get:
- Full type information during development (all generated models and methods)
- Working imports in production (valid package name)
- No runtime overhead (type imports are stripped during compilation)
