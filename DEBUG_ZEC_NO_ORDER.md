# Debugging: ZEC/USDT No Order Despite "executed" Log

## Situation (French)

L'utilisateur voit:
- ✅ Log `meta_entry_checklist` avec `decision: "executed"` et `registrationResult: "registered"`
- ✅ Agent en status **ACTIVE** (devrait être ARMED)
- ❌ **Aucun ordre visible dans l'interface ou la base de données**

## Situation (English)

User sees:
- ✅ `meta_entry_checklist` log with `decision: "executed"` and `registrationResult: "registered"`
- ✅ Agent status is **ACTIVE** (should be ARMED)
- ❌ **No order visible in UI or database**

---

## Critical Insight: Agent Status

**ACTIVE status means the agent thinks it has an open position!**

Agent states:
- **ARMED**: Monitoring markets, no position open
- **ACTIVE**: Has an open position (or thinks it does)

If agent shows ACTIVE but no position in database → **Ghost Position Bug**

---

## Root Cause Analysis

### The "executed" Log Is Misleading

The log `decision: "executed"` from `meta_entry_checklist` does NOT mean the order was executed. It means:

1. ✅ Signal passed all filters
2. ✅ Trade was registered with `registerAdaptiveTradeEntry()`
3. ❌ **But broker.place() may never have been called!**

### Why broker.place() Might Not Be Called

Looking at the execution flow in `metaAdaptiveOrchestrator.ts`, there's a critical check at line 175-180:

```typescript
// Check for existing position from DATABASE, not just agent memory
const dbPosition = await prisma.position.findFirst({
  where: {
    sessionId: session.sessionId,
  },
});
const hasPosition = dbPosition !== null;

if (!hasPosition) {
  // Only execute entry if no position exists
  await executeEntryTrade(session, bestSignal, tech);
} else {
  // Block entry if position exists
  logger.info(`Entry signal blocked - existing position present`);
}
```

**If there's ANY position record in the database for this session, entry is blocked!**

---

## Diagnostic Steps

### Step 1: Check for Ghost Position

Run this SQL query:

```sql
SELECT 
  id,
  symbol,
  side,
  qty,
  "entryPrice",
  "openedAt",
  "updatedAt"
FROM "Position" 
WHERE "sessionId" = 'cmhoizqks0006o6666e7r4uwe'
ORDER BY "openedAt" DESC;
```

**Expected Results:**

#### If Ghost Position Exists:
```
id | symbol | side | qty | entryPrice | openedAt | updatedAt
---+--------+------+-----+------------+----------+----------
123| ZEC/.. | buy  | 50  | 45.50      | [old]    | [old]
```

**Problem**: Position exists but shouldn't. It was created before the fix and never properly closed.

#### If No Position:
```
(no rows)
```

**Problem**: Different issue - need to check logs.

### Step 2: Check Agent Hub State

The agent's in-memory state might be out of sync:

```typescript
const agent = AgentHub.get('cmhoizqks0006o6666e7r4uwe');
console.log('Agent pos:', agent?.pos);
```

If `agent.pos` is not null but database has no position → In-memory state is wrong.

### Step 3: Check Console Logs

Search logs for these patterns around timestamp `1762713938665`:

**Should See:**
```
[cmhoizqks0006o6666e7r4uwe] Found 1 signal(s):
[cmhoizqks0006o6666e7r4uwe] Best entry signal: classic_trend_following (long) score=0.7077
[MetaOrchestrator] Calling executeEntryTrade for agent=cmhoizqks0006o6666e7r4uwe, symbol=ZEC/USDT, bias=long
```

**If Entry Was Blocked:**
```
[cmhoizqks0006o6666e7r4uwe] Entry signal blocked - existing position present
```

**If Order Was Placed:**
```
[MetaOrchestrator.executeEntryTrade] START: agent=...
[MetaOrchestrator.executeEntryTrade] Got broker, fetching balance...
[MetaOrchestrator.executeEntryTrade] Balance: equity=..., free=...
```

---

## Solutions

### Solution 1: Clear Ghost Position (If Exists)

**⚠️ WARNING: Only do this if you're CERTAIN there's no actual open position!**

```sql
-- First, verify the position is a ghost (no actual broker position)
-- Then delete it:
DELETE FROM "Position" 
WHERE "sessionId" = 'cmhoizqks0006o6666e7r4uwe'
AND "qty" = 0;  -- Only delete if qty is 0

-- Or update qty to 0 if it's not:
UPDATE "Position"
SET "qty" = 0
WHERE "sessionId" = 'cmhoizqks0006o6666e7r4uwe';
```

### Solution 2: Restart Agent

If in-memory state is corrupt:

1. Stop the agent session
2. Restart it
3. Agent will reload from database (which should be clean)

### Solution 3: Deploy the Fix

The fix we just implemented ensures future orders are persisted correctly. Deploy the updated code:

```bash
cd /home/runner/work/QuantAILabs/QuantAILabs/backend
npm run build
# Restart the backend service
```

---

## Prevention Going Forward

### Database Cleanup Script

Create a script to find and fix ghost positions:

```sql
-- Find positions with qty = 0 (should be deleted)
SELECT * FROM "Position" WHERE "qty" <= 0;

-- Find stale positions (open for >24 hours)
SELECT * FROM "Position" 
WHERE "openedAt" < NOW() - INTERVAL '24 hours'
AND "qty" > 0;

-- Clean up ghost positions
DELETE FROM "Position" WHERE "qty" <= 0;
```

### Agent Status Sync

Add a periodic check to sync agent status with database:

```typescript
// In metaAdaptiveOrchestrator.ts
async function syncAgentStatus(sessionId: string) {
  const dbPosition = await prisma.position.findFirst({
    where: { sessionId, qty: { gt: 0 } }
  });
  
  const agent = AgentHub.get(sessionId);
  if (agent) {
    if (!dbPosition && agent.pos) {
      // Ghost in-memory position, clear it
      console.warn(`[${sessionId}] Clearing ghost in-memory position`);
      agent.pos = null;
    } else if (dbPosition && !agent.pos) {
      // Position exists but not in memory, reconstruct it
      console.warn(`[${sessionId}] Reconstructing in-memory position from DB`);
      // Reconstruct agent.pos from dbPosition
    }
  }
}
```

---

## Understanding the Flow

### Complete Execution Chain

```
1. Market tick arrives
   ↓
2. evaluateRecognizedStrategies() 
   → Generates signal
   → Logs entry_context_pass
   ↓
3. registerAdaptiveTradeEntry()
   → Validates signal
   → Logs meta_entry_checklist with "executed" ✅ YOU ARE HERE
   → Returns "registered"
   ↓
4. Check database for existing position
   → If position exists: BLOCK and log "Entry signal blocked"
   → If no position: Continue to step 5
   ↓
5. executeEntryTrade() is called
   → Log: "Calling executeEntryTrade"
   → Log: "START"
   → Get broker
   → Calculate position size
   → Call broker.place()
   → Log: "Order placed!"
   ↓
6. recordEnter() is called (NEW FIX)
   → Persists order to database
   → Persists position to database
   → Log: "Position persisted to database"
   ↓
7. Agent status becomes ACTIVE
   ↓
8. Position visible in UI
```

**Your case stopped between step 3 and 4!**

---

## Quick Checklist

Run these checks in order:

- [ ] Check database for ghost position: `SELECT * FROM "Position" WHERE "sessionId" = 'cmhoizqks0006o6666e7r4uwe'`
- [ ] If ghost position found: Delete or set qty=0
- [ ] Check console logs for "Entry signal blocked"
- [ ] Check console logs for "Calling executeEntryTrade"
- [ ] Restart agent if needed
- [ ] Deploy the fix if not already deployed
- [ ] Try the trade again
- [ ] Verify order appears in database
- [ ] Verify agent status is correct

---

## Expected Log Sequence (Complete Flow)

```json
// Step 1: Signal generated
{
  "level": "info",
  "event": "entry_context_pass",
  "symbol": "ZEC/USDT",
  "strategy": "classic_trend_following"
}

// Step 2: Trade registered
{
  "level": "info", 
  "event": "meta_entry_checklist",
  "decision": "executed",  ← YOU SAW THIS
  "registrationResult": "registered"
}

// Step 3: Entry execution starts
[MetaOrchestrator] Calling executeEntryTrade for agent=cmhoizqks0006o6666e7r4uwe
[MetaOrchestrator.executeEntryTrade] START: agent=cmhoizqks0006o6666e7r4uwe

// Step 4: Order placed
[MetaOrchestrator.executeEntryTrade] Order placed! id=paper_xxx, status=filled

// Step 5: Database persistence (NEW FIX)
[MetaOrchestrator.executeEntryTrade] Position persisted to database

// Step 6: Trade evaluation logged
{
  "decision": "order_placed",
  "symbol": "ZEC/USDT"
}
```

**Missing logs indicate where the flow was interrupted!**

---

## Summary

The issue is most likely one of these:

1. **Ghost Position** - Database has old position record blocking new entries
2. **In-Memory State** - Agent thinks it has position but DB doesn't
3. **The Fix Not Deployed** - Running old code without recordEnter() calls

**Action Required**: Check database for ghost positions and deploy the fix!
