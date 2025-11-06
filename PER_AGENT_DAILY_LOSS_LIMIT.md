# Per-Agent Daily Loss Limit Fix

## Problem

The XRP agent was blocked by the daily loss limit despite not having made any trades. From the logs:

```json
{
  "message": "Daily loss limit hit",
  "agent": "XRP/USDT:USDT",
  "traded": false
}
```

**Root Cause:** The circuit breaker calculated daily loss using the change in the global capital pool equity, not per-agent performance. When any agent lost money, the pool equity decreased, affecting ALL agents.

## Architecture Overview

### How the Capital Pool System Works (Correct Behavior)

All agents work together to grow a **shared capital pool**:

1. **Shared Pool** - All agents contribute to and benefit from the same capital pool
2. **Dynamic Allocation** - When an agent finds a trading opportunity:
   - It **reserves/locks** the required capital from the pool
   - The reserved capital is committed to that agent's trade
   - Remaining capital stays **available** for other agents
3. **Rejection on Full Allocation** - If the pool is fully invested and another agent finds an opportunity, that trade is **rejected** (no capital available)
4. **Independent Risk Management** - Each agent:
   - Has its own performance-based limits
   - Manages its own risk and execution
   - Has its own circuit breaker with per-agent daily loss limit
5. **No Permanent Blocking** - Agents are never stuck forever:
   - They re-arm and revalidate when conditions change
   - They keep watching for new opportunities
   - Circuit breakers reset on new trading days

## Solution

Modified the circuit breaker to track and use **per-agent cumulative daily PnL** instead of global pool equity changes for daily loss calculations.

### Key Principles
- ✅ **Capital pooling preserved** - agents share the pool and lock capital for trades
- ✅ **Daily loss limit is per-agent** - based on each agent's own trading performance
- ✅ **Independent circuit breakers** - one agent's losses don't block others
- ✅ **No permanent blocking** - agents continue watching for opportunities

## How It Works

### Capital Pool Flow (Already Correct)
```
Global Pool: $10,000 (shared by all agents)
│
├─ Agent A (SOL) finds opportunity
│   ├─ Reserves $2,000 from pool → Lock capital
│   ├─ Opens trade
│   └─ Pool available: $8,000
│
├─ Agent B (ETH) finds opportunity
│   ├─ Reserves $3,000 from pool → Lock capital
│   ├─ Opens trade
│   └─ Pool available: $5,000
│
└─ Agent C (XRP) finds opportunity
    ├─ Needs $6,000 but only $5,000 available
    └─ Trade REJECTED (insufficient capital) ✅
```

### Daily Loss Limit (Fixed)

**Before (Incorrect):**
```
Global Pool: $10,000
├─ Agent A trades, loses $120
├─ Agent B hasn't traded
└─ Agent C hasn't traded

Pool Equity: $10,000 → $9,880 (-1.2%)
Daily Loss Check: ALL agents see -1.2% loss
Result: If limit is 1%, ALL agents blocked! ❌
```

**After (Correct):**
```
Global Pool: $10,000 (shared, grows with all agents' profits)
├─ Agent A: daily PnL = -$120 (from own trades)
│   ├─ Loss check: -$120 / $3,000 start = -4%
│   ├─ Exceeds 3% limit → ❌ BLOCKED
│   └─ But continues watching for opportunities
├─ Agent B: daily PnL = $0 (no trades yet)
│   ├─ Loss check: $0 / $3,000 start = 0%
│   └─ ✅ ACTIVE, can reserve capital from pool
└─ Agent C: daily PnL = $0 (no trades yet)
    ├─ Loss check: $0 / $4,000 start = 0%
    └─ ✅ ACTIVE, can reserve capital from pool
```

## Technical Changes

### 1. CircuitBreakerState (`circuitBreaker.ts`)
Added `dailyPnlUsd` field to track per-agent cumulative PnL for the day:

```typescript
export type CircuitBreakerState = {
  // ... existing fields ...
  dailyPnlUsd: number; // NEW: Track per-agent daily PnL
};
```

### 2. Circuit Breaker Class
- Added `dailyPnlUsd` private field
- Resets to 0 at day start
- Accumulates on each trade via `onTradeResult()`

### 3. Daily Loss Calculation
**Before:**
```typescript
const drawdownPct = ((equity - equityStartDay) / equityStartDay) * 100;
// Uses pool equity delta - affects all agents!
```

**After:**
```typescript
const dailyLossPct = (this.dailyPnlUsd / this.equityStartDay) * 100;
// Uses agent's own PnL - independent per agent!
```

### 4. Trade Result Tracking
Updated `onTradeResult()` to accept and accumulate PnL in USD:

```typescript
onTradeResult(now: Date, pnlPct: number, equity: number, pnlUsd?: number) {
  // Track per-agent daily PnL
  if (typeof pnlUsd === 'number' && Number.isFinite(pnlUsd)) {
    this.dailyPnlUsd += pnlUsd;
  }
  // ... rest of logic ...
}
```

### 5. Agent Integration
Updated the agent to pass realized PnL to the circuit breaker:

```typescript
// Before
this.circuitBreaker.onTradeResult(new Date(), pnlPct, equityAfter);

// After  
this.circuitBreaker.onTradeResult(new Date(), pnlPct, equityAfter, realizedPnl);
```

## Example Scenario

**Setup:**
- Global pool: $10,000 (shared by all agents)
- Agent A (SOL): starts with $3,000 allocation
- Agent B (ETH): starts with $3,000 allocation
- Agent C (XRP): starts with $4,000 allocation
- Daily loss limit: 3% per agent

**Events:**
1. Agent A opens a trade on SOL
2. Trade closes with -$120 realized loss
3. Agent B and C haven't traded

**Daily Loss Calculations:**
- Agent A: `dailyPnlUsd = -$120` → `-120 / 3000 = -4%` → **BLOCKED** (exceeds 3%)
- Agent B: `dailyPnlUsd = $0` → `0 / 3000 = 0%` → **ACTIVE**
- Agent C: `dailyPnlUsd = $0` → `0 / 4000 = 0%` → **ACTIVE**

**Result:** Only Agent A is blocked. Agents B and C continue trading normally. ✅

## Benefits

1. **Fair Risk Management** - Each agent is only affected by its own trading
2. **Maintains Capital Pooling** - Agents still share the same capital efficiently
3. **Independent Operation** - One agent's losses don't block others
4. **Accurate Circuit Breaking** - Works as intended on per-agent basis

## Testing

To verify the fix:

1. Start multiple agents (e.g., SOL, ETH, XRP)
2. Make one agent lose >3% of its allocation
3. Verify:
   - The losing agent is blocked
   - Other agents continue trading normally
   - Pool is still shared (agents can use available capital)

## Log Output

After the fix, you should see per-agent daily PnL in circuit breaker logs:

```json
{
  "level": "info",
  "source": "circuit_breaker",
  "message": "Daily loss check",
  "agentId": "xrp-agent",
  "details": {
    "dailyPnlUsd": 0,
    "startingEquity": 4000,
    "dailyLossPct": 0,
    "dailyLossLimit": 3,
    "allowed": true
  }
}
```

## Implementation Details

### State Persistence
- `dailyPnlUsd` is included in the persisted circuit breaker state
- Resets to 0 on each new trading day
- Restored from database when agent restarts

### Backwards Compatibility
- Existing agents will have `dailyPnlUsd = 0` initially
- Will start tracking correctly after first trade
- No migration required

## Comparison with Previous Approach

| Aspect | Pool Equity Delta (Wrong) | Per-Agent PnL (Correct) |
|--------|--------------------------|-------------------------|
| **Capital Sharing** | ✅ Shared | ✅ Shared |
| **Daily Loss Isolation** | ❌ Global (all agents affected) | ✅ Per-Agent |
| **Fairness** | ❌ Unfair to non-trading agents | ✅ Fair |
| **Complexity** | Low (but wrong) | Low (and correct) |

## Files Changed

1. `backend/src/quantai/risk/circuitBreaker.ts` - Add dailyPnlUsd tracking
2. `backend/src/agent/state/index.ts` - Pass realizedPnl to circuit breaker

## No Changes To

- ✅ Capital pool architecture (remains unchanged)
- ✅ CapitalManager (no modifications needed)
- ✅ Capital allocation logic (untouched)
- ✅ Capital sharing between agents (preserved)

## Date

2025-11-06
