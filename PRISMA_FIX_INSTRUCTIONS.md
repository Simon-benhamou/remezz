# Prisma Schema Fix - Migration Instructions

## Issues Fixed

This fix addresses two critical Prisma-related errors causing server crashes:

### 1. Unknown field `positions` for include statement
**Root Cause**: Code was using lowercase `positions` in include statements, but Prisma expects the capitalized model name `Position` for relation includes.

**Files Changed**:
- `backend/src/routes/agent.ts` - Changed `include: { positions: true }` to `include: { Position: true }`
- `backend/src/monitor/ops.ts` - Changed from `select` with `positions` to `include` with `Position`, and updated code references

### 2. TradeEvaluation.create() error: "Argument `id` is missing"
**Root Cause**: The `regimeContext` column was added to the Prisma schema but no migration was created, causing schema/database mismatch.

**Files Changed**:
- `backend/prisma/migrations/20251109_add_regime_context/migration.sql` - New migration to add the `regimeContext` column
- `backend/src/db/inMemoryClient.ts` - Added default factories for `tradeEvaluation` and `cryptoPersonalityProfile`

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

This ensures the Prisma client is in sync with the schema and includes proper type definitions.

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

## Technical Details

### Prisma Include Convention
In Prisma, when including relations:
- Use the **field name** from the schema for the include key
- However, when Prisma generates the client, relation fields are accessible by their **model name** in TypeScript

Example:
```prisma
model AgentSession {
  positions Position[]  // field name: positions, model name: Position
}
```

In code:
```typescript
// Include syntax - uses field name
prisma.agentSession.findMany({ 
  include: { Position: true }  // Capitalized model name in newer Prisma versions
})

// Result access
session.Position  // Array of Position records
```

### Migration Safety
The migration uses `IF NOT EXISTS` to safely add the column without failing if it already exists:
```sql
ALTER TABLE "TradeEvaluation" ADD COLUMN IF NOT EXISTS "regimeContext" JSONB;
```
