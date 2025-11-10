# Paper Mode Balance Persistence Fix - Implementation Summary

## Problem Statement
In paper mode, when users updated their balance from the modal in the frontend, the change was only stored in memory. When the backend restarted, it would fallback to the default $1000 balance.

## Root Cause
The `setPaperBalance()` function in `backend/src/services/capitalPool.ts` only updated in-memory variables without persisting to the database. On restart, the system would always initialize with the default balance.

## Solution Overview
Added database persistence for the paper balance using a new `SystemSetting` model, and implemented automatic loading on server startup.

## Changes Made

### 1. Database Schema (`backend/prisma/schema.prisma`)
- Added new `SystemSetting` model for storing system-wide configuration
- Created migration file: `backend/prisma/migrations/20241110_add_system_setting/migration.sql`

```prisma
model SystemSetting {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())

  @@map("system_setting")
}
```

### 2. Capital Pool Service (`backend/src/services/capitalPool.ts`)

#### New Functions:
- `loadPersistedPaperBalance()`: Loads the paper balance from the database
  - Returns persisted value if found
  - Falls back to $1000 if not found or on error
  
- `initializePaperBalance()`: Public function called on server startup
  - Calls `loadPersistedPaperBalance()`
  - Updates in-memory state with persisted value

#### Modified Functions:
- `setPaperBalance()`: Now persists the balance to database
  - Uses `prisma.systemSetting.upsert()` to save/update
  - Maintains backward compatibility with in-memory state
  - Adds logging for debugging

### 3. Server Initialization (`backend/src/server.ts`)
- Added call to `initializePaperBalance()` during startup
- Ensures persisted balance is loaded before agents start
- Includes error handling with warning logs

### 4. Testing (`backend/test/api/capital.persistence.spec.ts`)
- Created comprehensive test suite
- Tests:
  1. Setting balance saves to database
  2. Snapshot reflects correct balance
  3. Balance persists across initialization (simulated restart)
  4. Balance updates correctly

### 5. Configuration (`.gitignore`)
- Added `.env` files to gitignore for security

## How It Works

### Normal Operation Flow:
1. User updates paper balance via frontend modal
2. Frontend calls `POST /api/capital/paper/set-balance`
3. `setPaperBalance()` updates both:
   - In-memory state (immediate effect)
   - Database (persistence)
4. Balance is now persisted

### Server Restart Flow:
1. Server starts up
2. `initializePaperBalance()` is called
3. Function reads from `system_setting` table
4. If found: loads persisted value
5. If not found: uses default $1000
6. In-memory state is initialized with loaded value
7. All agents use the correct balance

## Live Mode Behavior
✅ **No changes to live mode**
- Live mode continues to use only exchange balance
- `updateLiveExchangeBalance()` remains unchanged
- Only paper mode uses the persisted balance

## Security Considerations
✅ All endpoints are protected by `authMiddleware` (line 112 in server.ts)
✅ Input validation for balance values (must be finite and positive)
✅ SQL injection safe (using Prisma ORM with parameterized queries)
✅ Database errors are caught and logged without exposing sensitive data

## Backward Compatibility
✅ If database table doesn't exist yet (before migration), falls back to default
✅ Existing sessions continue to work without modification
✅ No breaking changes to API contracts

## Migration Instructions

1. **Run Database Migration:**
   ```bash
   cd backend
   npx prisma migrate deploy
   ```

2. **Generate Prisma Client:**
   ```bash
   npx prisma generate
   ```

3. **Restart Backend:**
   - The paper balance will automatically load from database
   - If this is first time, it will use $1000 default

4. **Set Your Balance:**
   - Update via frontend modal
   - Balance will now persist across restarts

## Testing

### Manual Testing:
1. Start backend
2. Update paper balance to $5000 via frontend
3. Verify database has the value:
   ```sql
   SELECT * FROM system_setting WHERE key = 'paper_balance_usd';
   ```
4. Restart backend
5. Check that balance is still $5000 (not $1000)

### Automated Testing:
```bash
cd backend
npm run test test/api/capital.persistence.spec.ts
```

## Future Enhancements
- Could extend to support per-user paper balances
- Could add audit trail for balance changes
- Could add UI indicator showing "balance restored from last session"

## Related Files
- `backend/src/services/capitalPool.ts` - Main implementation
- `backend/src/routes/capital.ts` - API endpoints
- `backend/src/server.ts` - Initialization logic
- `backend/prisma/schema.prisma` - Database schema
- `frontend/src/components/PortfolioBalanceModal.tsx` - UI component

## Deployment Notes
- Zero downtime deployment possible
- Migration is additive only (no data loss risk)
- Can be rolled back safely if needed
