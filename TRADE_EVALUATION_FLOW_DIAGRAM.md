# Trade Evaluation Flow - Before vs After Fix

## BEFORE (Incorrect) ❌

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Entry Filter Stage (metaAdaptiveAgent.ts)                   │
│                                                                 │
│  Check: ADX, CMF, confidence, trend strength, etc.              │
│                                                                 │
│  ✓ Filters Pass (evaluation.ok = true)                         │
│    ⚠️  BUG: LOG "filter_passed" ← PREMATURE!                   │
│                                                                 │
│  ✗ Filters Fail (evaluation.ok = false)                        │
│    ✓ LOG "filter_blocked"                                      │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. Execution Stage (orchestrator + brokers)                    │
│                                                                 │
│  Check: Position sizing                                         │
│    ✗ qty = 0 → LOG "order_blocked_sizing"                     │
│                                                                 │
│  Check: Predictor confidence                                    │
│    ✗ Low confidence → LOG "filter_blocked"                     │
│                                                                 │
│  Check: Cooldown period                                         │
│    ✗ Cooldown active → LOG "filter_blocked"                    │
│                                                                 │
│  Check: Capital pool                                            │
│    ✗ Pool exhausted → LOG "order_blocked_capital"              │
│                                                                 │
│  Place order on broker                                          │
│    ✓ Success → LOG "order_placed"                              │
│    ✗ Rejected → LOG "order_rejected"                           │
└─────────────────────────────────────────────────────────────────┘

RESULT: Multiple evaluations logged for same signal!
- TradeEvaluation table: "filter_passed" (from stage 1)
- TradeEvaluation table: "order_blocked_capital" (from stage 2)
- Ops logs: "trade_blocked" with reason

PROBLEM: Inconsistent data! Optimizer thinks signal was good but trade blocked.
```

## AFTER (Correct) ✅

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Entry Filter Stage (metaAdaptiveAgent.ts)                   │
│                                                                 │
│  Check: ADX, CMF, confidence, trend strength, etc.              │
│                                                                 │
│  ✓ Filters Pass (evaluation.ok = true)                         │
│    ✓ RETURN without logging ← FIX!                             │
│    → Continue to execution stage                               │
│                                                                 │
│  ✗ Filters Fail (evaluation.ok = false)                        │
│    ✓ LOG "filter_blocked" with detailed reasons                │
│    → STOP (no execution)                                       │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. Execution Stage (orchestrator + brokers)                    │
│                                                                 │
│  Check: Position sizing                                         │
│    ✗ qty = 0 → LOG "order_blocked_sizing" → STOP              │
│                                                                 │
│  Check: Predictor confidence                                    │
│    ✗ Low confidence → LOG "filter_blocked" → STOP             │
│                                                                 │
│  Check: Cooldown period                                         │
│    ✗ Cooldown active → LOG "filter_blocked" → STOP            │
│                                                                 │
│  Check: Capital pool                                            │
│    ✗ Pool exhausted → LOG "order_blocked_capital" → STOP       │
│                                                                 │
│  Place order on broker                                          │
│    ✓ Success → LOG "order_placed" → DONE                       │
│    ✗ Rejected → LOG "order_rejected" → DONE                    │
└─────────────────────────────────────────────────────────────────┘

RESULT: Exactly ONE evaluation logged per signal!
- Entry filters fail → "filter_blocked" (with specific reasons)
- Execution blocks → "order_blocked_*" or "filter_blocked" (predictor/cooldown)
- Success → "order_placed"

BENEFIT: Consistent data! One truth source for what actually happened.
```

## Decision Code Mapping

| Decision Code            | Stage          | Meaning                                    |
|-------------------------|----------------|-------------------------------------------|
| `filter_blocked`        | Entry Filters  | Signal quality insufficient (ADX, CMF, etc.) |
| `filter_blocked`        | Execution      | Predictor confidence low or cooldown active |
| `order_blocked_sizing`  | Execution      | Position sizing returned qty=0            |
| `order_blocked_capital` | Execution      | Capital pool exhausted                    |
| `order_rejected`        | Execution      | Broker rejected order                     |
| `order_placed`          | Execution      | ✅ Trade successfully placed               |

## Example Scenario

### Scenario: Good signal but capital pool exhausted

**Before Fix:**
```
TradeEvaluation table:
1. filter_passed (from entry stage)
2. order_blocked_capital (from broker)

Ops logs:
- "trade_blocked" reason="capital_exhausted"

Problem: Optimizer sees "filter_passed" and thinks signal was good,
         but doesn't understand why trade didn't happen.
```

**After Fix:**
```
TradeEvaluation table:
1. order_blocked_capital (only entry)

Ops logs:
- "trade_blocked" reason="capital_exhausted"

Benefit: Clear understanding - signal was good, but operational
         constraint (capital) prevented execution. Optimizer can
         distinguish this from low-quality signals.
```
