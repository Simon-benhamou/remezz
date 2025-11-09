# Prisma Schema Fix - Migration Instructions

## Issues Fixed

This fix addresses two critical Prisma-related errors causing server crashes:

### 1. Unknown field `positions` for include statement
**Root Cause**: The Prisma client in production was out of sync with the schema. After schema changes, the client needs to be regenerated.

**Solution**: Regenerate the Prisma client using `npm run prisma:gen` to sync with the current schema.

### 2. TradeEvaluation.create() error: "Argument `id` is missing"
**Root Cause**: The `regimeContext` column was added to the Prisma schema but no migration was created, causing schema/database mismatch. This made Prisma confused about required vs optional fields.

**Files Changed**:
- `backend/prisma/migrations/20251109_add_regime_context/migration.sql` - New migration to add the `regimeContext` column
- `backend/src/db/inMemoryClient.ts` - Added default factories for `tradeEvaluation` and `cryptoPersonalityProfile` to prevent test failures

## Deployment Steps

To apply these fixes in production, run the following commands:

### 1. Run the new migration

```bash
cd backend
npm run migrate
# This runs: prisma migrate deploy
```

This will execute the migration to add the `regimeContext` column to the `TradeEvaluation` table.

### 2. Regenerate the Prisma Client

```bash
cd backend
npm run prisma:gen
# This runs: prisma generate
```

**This is the critical step** - it ensures the Prisma client is in sync with the schema and includes proper type definitions.

### 3. Rebuild and Restart

```bash
# From backend directory
npm run build
npm start
```

Or in Docker:
```bash
docker-compose build backend
docker-compose up -d backend
```

## Verification

After deployment, verify the fixes by checking:

1. No more "Unknown field `positions`" errors in logs
2. No more "Argument `id` is missing" errors when creating TradeEvaluation records
3. Agent sessions load correctly with position data
4. Trade evaluation logging works without errors

## Root Cause Analysis

### Why the "Unknown field" errors occurred

The production Prisma client was generated from an older version of the schema before certain fields existed. When the code tried to use these fields in include statements, the client didn't recognize them.

**The fix**: Always run `prisma generate` after pulling schema changes or after migrations.

### Why the "Argument `id` is missing" errors occurred

The schema had `regimeContext` field but the database didn't have the column. This mismatch confused Prisma's validation logic, causing it to incorrectly report missing required fields.

**The fix**: Create proper migrations for all schema changes and run them before deploying code changes.

## Migration Safety

The migration uses `IF NOT EXISTS` to safely add the column without failing if it already exists:
```sql
ALTER TABLE "TradeEvaluation" ADD COLUMN IF NOT EXISTS "regimeContext" JSONB;
```

## Technical Details

### Prisma Include Convention
In Prisma, relation field names in includes use the **field name** from the schema (lowercase):

```prisma
model AgentSession {
  positions Position[]  // field name: positions
}
```

In code:
```typescript
// Include syntax - uses field name from schema
prisma.agentSession.findMany({ 
  include: { positions: true }  // lowercase field name
})

// Result access
session.positions  // Array of Position records
```

### Why Prisma Client Generation is Critical

The Prisma client is TypeScript code generated from the schema. It includes:
- Type definitions for all models
- Validation logic for queries
- Knowledge of what fields and relations exist

If the client is out of sync with the schema or database:
- TypeScript types will be wrong
- Runtime errors will occur ("Unknown field", validation errors)
- Auto-completion in IDEs will be incorrect

**Best practice**: Always regenerate the Prisma client after:
- Pulling schema changes from Git
- Running migrations
- Modifying the schema file
