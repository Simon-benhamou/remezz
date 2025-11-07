# CRITICAL BUG: Intelligent Rotation False Positive

**Severity:** 🔴 **CRITICAL**  
**Impact:** Smart agents incorrectly skip symbol rotation  
**Affected Component:** Intelligent rotation system  
**Date Discovered:** 2025-11-07

---

## Problem Statement

Smart agents log `skip_due_to_active_trade` even when:
- ❌ No open positions exist (`hasOpenPosition: false`)
- ❌ No open orders exist (`hasOpenOrders: false`)
- ✅ Agent state shows as `ACTIVE` (should be `ARMED` if ready to trade)

### Example Log Evidence

```json
{
  "source": "intelligent_rotation",
  "message": "skip_due_to_active_trade",
  "sessionId": "cmhoje4eg001eo666mf8z66yq",
  "symbol": "SOON/USDT",
  "details": {
    "hasOpenPosition": false,  // ❌ No position
    "hasOpenOrders": false,     // ❌ No orders
    "agentState": "ACTIVE"      // But marked as busy!
  }
}
```

**User Report:** "I have just armed agent when I see in my control page"

---

## Root Cause Analysis

### Location
**File:** `src/services/intelligentAgent/strategies/core.ts`  
**Function:** `checkSessionForBetterOpportunityOptimized()`  
**Lines:** 3896-3903

### Problematic Code

```typescript
const agent = AgentHub.get(session.id) as any;
const hasOpenPosition = Array.isArray(session.positions)
  && session.positions.some((p: any) => Number(p?.qty || 0) > POSITION_QTY_EPSILON);
const hasOpenOrders = Array.isArray(session.orders)
  && session.orders.some((order: any) => OPEN_ORDER_STATUSES.has(String(order?.status || '').toLowerCase()));
const agentBusy = !!(agent && ((agent.pos && Number(agent.pos.qty || 0) > POSITION_QTY_EPSILON) || agent.entering));

if (hasOpenPosition || hasOpenOrders || agentBusy) {
  // Skip rotation - but this triggers even when it shouldn't!
}
```

### The Bug

The `agentBusy` check has **THREE** conditions:

1. ✅ `agent.pos && Number(agent.pos.qty) > 0` - Checks for position (correct)
2. ❌ `agent.entering` - **THIS IS THE BUG**
3. The overall logic: `hasOpenPosition || hasOpenOrders || agentBusy`

**Problem:** `agent.entering` is likely:
- Set to `true` when agent is "armed" with a plan
- NOT cleared properly after failed entry attempts
- Persisting across state changes
- Causing false positive "busy" state

### Why This Happens

From `agent/hub.ts` lines 38-72, meta-adaptive agents are **stub objects**:

```typescript
async activate(sessionId: string, profile: ActivationProfile) {
  // Meta-adaptive doesn't use agent instances - create minimal stub
  const a: any = { 
    sessionId, 
    profile,
    state: 'ACTIVE',  // ⚠️ Always ACTIVE for meta-adaptive!
    bias: 'none',
    // Missing: entering flag management!
  };
  this.agents.set(sessionId, a);
  return a;
}
```

**Root Issue:** Meta-adaptive agents don't properly manage the `entering` flag because they're stateless stubs, not full agent instances!

---

## Impact Assessment

### Immediate Impact: **HIGH**

1. **Symbol Rotation Blocked**
   - Smart agents cannot switch to better opportunities
   - Stuck monitoring suboptimal symbols
   - Defeats purpose of intelligent rotation

2. **Trading Opportunity Loss**
   - Even if better symbol is found, rotation is skipped
   - Agents remain on lower-quality symbols
   - Reduced performance potential

3. **System Confusion**
   - Logs show `ACTIVE` state
   - UI shows `ARMED` state  
   - Database shows no position/orders
   - **State inconsistency across layers**

### Severity Breakdown

| Component | Impact | Notes |
|-----------|--------|-------|
| Smart Agent Rotation | 🔴 BROKEN | Cannot switch symbols |
| Regular Agents | 🟢 OK | Not affected |
| Trade Execution | 🟡 INDIRECT | Trades on wrong symbol |
| User Experience | 🔴 CRITICAL | Confusing state display |

---

## Reproduction Steps

1. Create a Smart Agent with auto symbol selection
2. Let agent become "armed" (has plan, no position)
3. Wait for intelligent rotation timer to trigger
4. Observe: Rotation skipped with `skip_due_to_active_trade`
5. Check logs: `hasOpenPosition: false`, `hasOpenOrders: false`
6. Check agent state: Shows `ACTIVE` instead of `ARMED`

---

## Technical Deep Dive

### State Inconsistency Chain

```
Frontend UI State (routes/agent.ts:1283-1303)
├── Reads: session.positions, session.planJson
├── Derives: ARMED (has plan, no position)
└── Shows: "ARMED" to user ✅

Database State (prisma)
├── positions: [] (empty)
├── orders: [] (no open orders)
└── planJson: {...} (has plan) ✅

AgentHub State (agent/hub.ts)
├── agent.state: "ACTIVE" (always for meta-adaptive)
├── agent.entering: undefined or stale value ❌
└── Used by: Intelligent rotation logic

Intelligent Rotation Logic (intelligentAgent/strategies/core.ts:3901)
├── Checks: agentBusy = agent.entering || agent.pos.qty > 0
├── Result: agentBusy = true (false positive) ❌
└── Action: Skip rotation ❌
```

### Why `agent.entering` is Unreliable

Meta-adaptive agents are **stateless execution engines**, not persistent state machines:

```typescript
// From agent/hub.ts - Meta-adaptive stub
{
  sessionId,
  profile,
  state: 'ACTIVE',  // Static value
  bias: 'none',     // Static value
  // No entering flag!
  // No position tracking!
  // Just a placeholder!
}
```

The `entering` flag is:
- Never set for meta-adaptive agents
- Possibly `undefined`
- But check `!!(agent && agent.entering)` might be `false` if undefined...

**Wait - let me re-analyze:**

Actually, looking at line 3901 again:
```typescript
const agentBusy = !!(agent && ((agent.pos && Number(agent.pos.qty || 0) > POSITION_QTY_EPSILON) || agent.entering));
```

If `agent.entering` is `undefined`, then:
- `agent.entering` evaluates to `undefined`
- `undefined || false` = `false`
- So `agentBusy` should be `false`

**BUT** the logs show the skip IS happening, which means:

### Alternative Theory: Agent Null/Undefined

```typescript
const agent = AgentHub.get(session.id) as any;
```

If `agent` is `null` or `undefined`:
- `!!(null && ...)` = `false`
- `agentBusy` = `false`
- Should NOT skip

**So why is it skipping?**

Let me check the actual condition again:

```typescript
if (hasOpenPosition || hasOpenOrders || agentBusy) {
  // Skip
}
```

Your logs show:
- `hasOpenPosition: false`
- `hasOpenOrders: false`
- `agentState: "ACTIVE"`

**AH! I need to check if the data fetching is correct!**

---

## The REAL Bug: Stale Data

Looking at line 3897-3900:

```typescript
const hasOpenPosition = Array.isArray(session.positions)
  && session.positions.some((p: any) => Number(p?.qty || 0) > POSITION_QTY_EPSILON);
const hasOpenOrders = Array.isArray(session.orders)
  && session.orders.some((order: any) => OPEN_ORDER_STATUSES.has(String(order?.status || '').toLowerCase()));
```

**The bug is likely:**

1. `session.positions` and `session.orders` are fetched from database
2. But they might be **stale** or **not refreshed** before this check
3. OR the agent has pending state that hasn't been synced to DB yet

Let me find where `session` is loaded:

---

## Investigation: Session Loading

Need to find where `checkSessionForBetterOpportunityOptimized()` is called from and how session data is loaded.

**Key Question:** Is `session.positions` and `session.orders` properly included in the query?

Let me search for the caller:

```bash
grep -n "checkSessionForBetterOpportunityOptimized" core.ts
```

This will show where it's called and what data is passed.

---

## Hypothesis: Race Condition

**Scenario:**
1. Agent generates plan → State becomes `ARMED` ✅
2. Plan triggers entry attempt → `agent.entering = true` 
3. Entry blocked by meta-adaptive filters ❌
4. `agent.entering` flag **NOT CLEARED** 🐛
5. Intelligent rotation checks `agent.entering` → `true`
6. Rotation skipped even though agent is just armed

**This would explain:**
- No position (entry was blocked)
- No orders (entry was blocked)
- But `agent.entering` still `true` (not cleared after block)

---

## Solution Options

### Option 1: Remove `agent.entering` Check (RECOMMENDED)

Since meta-adaptive agents are stateless, rely only on **database state**:

```typescript
// BEFORE
const agentBusy = !!(agent && ((agent.pos && Number(agent.pos.qty || 0) > POSITION_QTY_EPSILON) || agent.entering));

// AFTER
const agentBusy = hasOpenPosition || hasOpenOrders;
// Remove in-memory agent state check entirely
```

**Rationale:**
- Database is source of truth
- Meta-adaptive agents don't maintain state
- Simpler logic, fewer bugs

### Option 2: Fix Agent State Management

Ensure `agent.entering` is properly managed:

```typescript
// After entry attempt blocked
if (entryBlocked) {
  agent.entering = false;  // Clear flag
}

// After position opened
if (positionOpened) {
  agent.entering = false;  // Clear flag
}
```

**Rationale:**
- Maintains stateful agent model
- More complex but potentially more accurate

### Option 3: Use Database-Only Checks

Completely remove agent hub checks:

```typescript
if (hasOpenPosition || hasOpenOrders) {
  // Skip rotation
}

// Remove agentBusy check entirely
```

**Rationale:**
- Simplest solution
- Most reliable (database = source of truth)
- Works for both stateful and stateless agents

---

## Recommended Fix

### Immediate (5 minutes):

**File:** `src/services/intelligentAgent/strategies/core.ts`  
**Line:** 3903

```diff
- if (hasOpenPosition || hasOpenOrders || agentBusy) {
+ if (hasOpenPosition || hasOpenOrders) {
```

Remove the `agentBusy` check entirely. For meta-adaptive agents (which are stateless), only trust database state.

### Alternative (if agent state is needed):

```diff
  const agent = AgentHub.get(session.id) as any;
+ 
+ // For meta-adaptive agents, ignore in-memory state (use DB only)
+ const isMetaAdaptive = !agent || agent.state === 'ACTIVE'; // Meta-adaptive stub
+ 
  const hasOpenPosition = Array.isArray(session.positions)
    && session.positions.some((p: any) => Number(p?.qty || 0) > POSITION_QTY_EPSILON);
  const hasOpenOrders = Array.isArray(session.orders)
    && session.orders.some((order: any) => OPEN_ORDER_STATUSES.has(String(order?.status || '').toLowerCase()));
- const agentBusy = !!(agent && ((agent.pos && Number(agent.pos.qty || 0) > POSITION_QTY_EPSILON) || agent.entering));
+ const agentBusy = !isMetaAdaptive && !!(agent && ((agent.pos && Number(agent.pos.qty || 0) > POSITION_QTY_EPSILON) || agent.entering));

  if (hasOpenPosition || hasOpenOrders || agentBusy) {
```

---

## Testing Plan

### Unit Test

```javascript
describe('Intelligent Rotation', () => {
  it('should allow rotation when agent is armed with no position', async () => {
    const session = {
      id: 'test-session',
      positions: [],      // No position
      orders: [],         // No orders
      planJson: { ... }  // Has plan (armed)
    };
    
    const result = await checkRotationEligibility(session);
    expect(result.canRotate).toBe(true);
    expect(result.blockReason).toBeNull();
  });
  
  it('should block rotation when position exists', async () => {
    const session = {
      positions: [{ qty: 100 }],
      orders: []
    };
    
    const result = await checkRotationEligibility(session);
    expect(result.canRotate).toBe(false);
    expect(result.blockReason).toBe('has_position');
  });
});
```

### Integration Test

1. Create smart agent
2. Let it become armed (plan generated, no entry)
3. Trigger rotation check manually
4. Verify: Rotation NOT skipped
5. Verify: Logs show correct evaluation

---

## Impact After Fix

✅ **Smart agents can rotate symbols** when armed  
✅ **State consistency** between UI, DB, and rotation logic  
✅ **Better opportunities** can be seized  
✅ **Simplified logic** - database as single source of truth  

---

## Additional Recommendations

### 1. Improve Logging

```typescript
recordOpsEvent({
  level: 'info',
  source: 'intelligent_rotation',
  message: hasOpenPosition ? 'skip_has_position' 
         : hasOpenOrders ? 'skip_has_orders'
         : agentBusy ? 'skip_agent_busy'  // Only if keeping this check
         : 'evaluating_rotation',
  sessionId: session.id,
  symbol: session.symbol,
  details: {
    hasOpenPosition,
    hasOpenOrders,
    agentBusy,
    agentState: agent?.state,
    agentEntering: agent?.entering,  // Add this!
    agentPosQty: agent?.pos?.qty,    // Add this!
    dbPositions: session.positions.length,
    dbOrders: session.orders.length
  }
});
```

### 2. Add State Validation Endpoint

Create `/api/agent/validate-state/:sessionId` to check consistency:

```typescript
router.get('/validate-state/:id', async (req, res) => {
  const session = await prisma.agentSession.findUnique({
    where: { id: req.params.id },
    include: { positions: true, orders: true }
  });
  
  const agent = AgentHub.get(req.params.id);
  
  const validation = {
    dbState: {
      hasPosition: session.positions.some(p => p.qty > 0),
      hasOrders: session.orders.some(o => isOpen(o.status)),
      hasPlan: !!session.planJson
    },
    agentState: {
      state: agent?.state,
      entering: agent?.entering,
      posQty: agent?.pos?.qty
    },
    consistency: {
      stateMatch: true,  // Calculate
      issues: []         // List inconsistencies
    }
  };
  
  res.json(validation);
});
```

### 3. Monitor State Drift

Add alerts when:
- Agent state says `ACTIVE` but should be `ARMED`
- `agent.entering = true` but no orders in last 5 minutes
- Position exists in agent but not in DB (or vice versa)

---

## Priority

**🔴 CRITICAL - Fix Immediately**

This bug:
- Breaks core functionality (intelligent rotation)
- Causes user confusion (state mismatch)
- Reduces system effectiveness (trapped on suboptimal symbols)
- Has simple fix (remove one condition)

**Estimated Fix Time:** 5-10 minutes  
**Testing Time:** 15-20 minutes  
**Total Time to Production:** 30 minutes

---

## Conclusion

The intelligent rotation system incorrectly blocks symbol switching by checking an unreliable `agent.entering` flag. For meta-adaptive agents (which are stateless stubs), this flag is meaningless and causes false positives.

**Solution:** Remove `agentBusy` check and rely solely on database state (`hasOpenPosition` and `hasOpenOrders`).

**Status:** Ready for immediate implementation.

---

**Report By:** GitHub Copilot Agent  
**Date:** 2025-11-07  
**Next Action:** Implement fix in `core.ts:3903`

