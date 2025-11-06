# Per-Agent Daily Loss Limit - Implementation Summary

## Task Complete ✅

Fixed the daily loss limit to be per-agent instead of global, while preserving the capital pooling architecture.

## The Problem

From the user's logs, the XRP agent was blocked by daily loss limit despite not having made any trades:
```json
{
  "message": "Daily loss limit hit",
  "agent": "XRP/USDT:USDT",
  "traded": false
}
```

**Root Cause:** The circuit breaker calculated daily loss using the global capital pool equity delta. When ANY agent lost money, the pool equity decreased, which affected ALL agents' daily loss calculations.

## The Solution

Changed the circuit breaker to track and use **per-agent cumulative daily PnL** instead of global pool equity changes.

### Key Changes

#### 1. Added Daily PnL Tracking to Circuit Breaker State
```typescript
export type CircuitBreakerState = {
  // ... existing fields ...
  dailyPnlUsd: number; // NEW: Track per-agent daily PnL
};
```

#### 2. Modified Daily Loss Calculation
**Before (Wrong):**
```typescript
const drawdownPct = ((equity - equityStartDay) / equityStartDay) * 100;
// Used pool equity delta - affected all agents
```

**After (Correct):**
```typescript
const dailyLossPct = (this.dailyPnlUsd / this.equityStartDay) * 100;
// Uses agent's own cumulative PnL - independent per agent
```

#### 3. Updated Trade Result Tracking
```typescript
onTradeResult(now: Date, pnlPct: number, equity: number, pnlUsd?: number) {
  // Track per-agent daily PnL
  if (typeof pnlUsd === 'number' && Number.isFinite(pnlUsd)) {
    this.dailyPnlUsd += pnlUsd;
  }
  // ... rest of logic ...
}
```

#### 4. Agent Passes Realized PnL
```typescript
// Agent state passes realizedPnl (in USD) to circuit breaker
this.circuitBreaker.onTradeResult(new Date(), pnlPct, equityAfter, realizedPnl);
```

## Architecture (Unchanged)

The capital pooling system continues to work as designed:

### How Capital Pooling Works

```
┌─────────────────────────────────────────────┐
│         Shared Capital Pool: $10,000        │
│   (All agents work to grow this pool)       │
└─────────────────────────────────────────────┘
                    │
      ┌─────────────┼─────────────┐
      │             │             │
┌─────▼──────┐ ┌───▼──────┐ ┌───▼──────┐
│ Agent A    │ │ Agent B  │ │ Agent C  │
│ (SOL)      │ │ (ETH)    │ │ (XRP)    │
├────────────┤ ├──────────┤ ├──────────┤
│ Finds opp  │ │ Watching │ │ Watching │
│ Locks $3k  │ │          │ │          │
└────────────┘ └──────────┘ └──────────┘
      │
      ▼
┌─────────────────────────────────────────────┐
│  Pool After Lock: $7,000 available          │
│  (Agents B & C can still use this)          │
└─────────────────────────────────────────────┘
```

### Daily Loss Limit (Per-Agent)

```
Agent A: 
  - Daily PnL: -$120 (from own trades)
  - Starting Equity: $3,000
  - Daily Loss: -120 / 3000 = -4%
  - Status: BLOCKED (exceeds 3% limit)
  - Behavior: Keeps watching, will re-arm

Agent B:
  - Daily PnL: $0 (no trades)
  - Starting Equity: $3,000
  - Daily Loss: 0 / 3000 = 0%
  - Status: ACTIVE
  - Can reserve from pool: YES

Agent C:
  - Daily PnL: $0 (no trades)  
  - Starting Equity: $4,000
  - Daily Loss: 0 / 4000 = 0%
  - Status: ACTIVE
  - Can reserve from pool: YES
```

## System Behavior

### Capital Allocation
1. Agent finds trading opportunity
2. Agent requests capital reservation from pool
3. CapitalManager checks:
   - Is there enough free capital?
   - Does it exceed per-symbol cap?
4. If yes: Reserve granted, capital locked
5. If no: Trade rejected (insufficient capital)

### Risk Management (Per-Agent)
1. Each agent has own circuit breaker
2. Circuit breaker tracks agent's daily PnL
3. If agent loses >3% of starting equity → Agent blocked
4. Other agents continue trading normally
5. Blocked agent keeps watching, re-validates when conditions change
6. Circuit breaker resets on new trading day

### Key Principles
- ✅ **Shared Growth** - All agents contribute to pool growth
- ✅ **Fair Allocation** - Capital allocated based on availability
- ✅ **Independent Risk** - Each agent's losses only affect themselves
- ✅ **No Permanent Blocks** - Agents continue monitoring and re-arm

## Testing

To verify the fix works:

1. Start multiple agents (e.g., SOL, ETH, XRP)
2. Make Agent A (SOL) trade and lose >3%
3. Verify:
   - Agent A is blocked from new trades
   - Agent A continues watching for opportunities
   - Agents B & C remain active
   - Agents B & C can reserve capital from pool
   - Pool equity reflects all agents' performance

## Files Modified

1. `backend/src/quantai/risk/circuitBreaker.ts`
   - Added `dailyPnlUsd` tracking
   - Modified daily loss calculation
   - Updated `onTradeResult()` signature

2. `backend/src/agent/state/index.ts`
   - Pass `realizedPnl` to circuit breaker

3. `PER_AGENT_DAILY_LOSS_LIMIT.md`
   - Complete documentation

## No Changes To

- ✅ CapitalManager (capital pooling logic)
- ✅ Capital reservation/commit/release flow
- ✅ Per-symbol caps
- ✅ Capital sharing between agents
- ✅ Balance provider architecture

## Benefits

1. **Fair** - Each agent only affected by own trading
2. **Efficient** - Capital pool shared optimally
3. **Independent** - One agent's losses don't block others
4. **Resilient** - Agents never permanently stuck
5. **Simple** - Minimal changes, clear logic

## Example Scenario

**Initial State:**
- Pool: $10,000 (shared)
- Agent A allocation: $3,000
- Agent B allocation: $3,000
- Agent C allocation: $4,000
- Daily loss limit: 3%

**Timeline:**
1. **T0:** Agent A finds opportunity, locks $2,000
2. **T1:** Agent A's trade closes with -$120 loss
3. **T2:** Circuit breaker calculates: -120 / 3000 = -4%
4. **T3:** Agent A blocked (exceeds 3% limit)
5. **T4:** Agent B finds opportunity, locks $3,000 → ✅ Allowed
6. **T5:** Agent C finds opportunity, locks $4,000 → ✅ Allowed
7. **T6:** Agent A keeps watching, waiting for re-arm conditions

**Result:**
- Agent A: Blocked but monitoring
- Agents B & C: Trading normally
- Pool: Shared efficiently
- Total pool value: $10,000 - $120 = $9,880 (reflects all performance)

## Deployment

1. No database migration required
2. Existing agents will start tracking daily PnL on next trade
3. Circuit breaker state includes `dailyPnlUsd` (persisted)
4. Backwards compatible (pnlUsd parameter is optional)

## Monitoring

Check circuit breaker logs for per-agent daily PnL:
```json
{
  "level": "info",
  "source": "circuit_breaker",
  "agentId": "xrp-agent",
  "dailyPnlUsd": 0,
  "startingEquity": 4000,
  "dailyLossPct": 0,
  "allowed": true
}
```

## Date
2025-11-06

## Author
Implementation by GitHub Copilot
