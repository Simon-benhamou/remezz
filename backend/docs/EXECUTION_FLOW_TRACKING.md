# Trade Evaluation Status System - Complete Execution Flow Tracking

## Overview

The TradeEvaluation system now tracks the **complete execution flow** from signal evaluation to actual order placement, making it clear where trades succeed or get blocked.

## Previous System (Confusing)

**Old status values:**
- `executed` - Entry filters PASSED (but NOT necessarily an actual trade!)
- `blocked` - Entry filters FAILED

**Problem:** The term "executed" was misleading - it meant "filters passed" not "trade placed". This caused confusion when seeing "executed" evaluations with zero actual orders.

## New System (Clear & Comprehensive)

### Decision Values

#### **FILTER STAGE:**
1. **`filter_passed`** - Entry filters PASSED
   - ADX, confidence, volatility checks all OK
   - Signal quality acceptable
   - Ready to attempt execution

2. **`filter_blocked`** - Entry filters FAILED
   - Signal quality insufficient
   - Conditions not met (weak momentum, low confidence, etc.)
   - Blocked reason explains why

#### **EXECUTION STAGE** (only reached if filters passed):
3. **`order_placed`** - **ACTUAL TRADE** placed on exchange ✅
   - Sizing calculated successfully
   - Capital reserved
   - Registration passed
   - Broker accepted order
   - **This is the ONLY status that means a real trade**

4. **`order_blocked_capital`** - Capital reservation failed
   - Shared pool exhausted
   - Per-symbol cap exceeded  
   - Not enough free capital

5. **`order_blocked_sizing`** - Position sizing returned qty=0
   - Stop distance too wide
   - Equity too low
   - Risk calculation resulted in no quantity

6. **`order_blocked_registration`** - Blocked by meta-adaptive system
   - Predictor confidence below threshold
   - Active cooldown period
   - Strategy-specific gate

7. **`order_rejected`** - Broker rejected the order
   - Exchange error
   - Rate limit hit
   - Symbol not available

## Execution Flow Diagram

```
Signal Detected
      ↓
┌─────────────────┐
│ Entry Filters   │ → filter_blocked (ADX low, confidence low, etc.)
│ Evaluation      │
└─────────────────┘
      ↓ (passed)
  filter_passed
      ↓
┌─────────────────┐
│ Position Sizing │ → order_blocked_sizing (qty=0)
└─────────────────┘
      ↓
┌─────────────────┐
│ Registration    │ → order_blocked_registration (predictor/cooldown)
│ (Predictor)     │
└─────────────────┘
      ↓
┌─────────────────┐
│ Capital         │ → order_blocked_capital (pool exhausted)
│ Reservation     │
└─────────────────┘
      ↓
┌─────────────────┐
│ Broker Place    │ → order_rejected (exchange error)
│ Order           │
└─────────────────┘
      ↓
  order_placed ✅
   (REAL TRADE)
```

## Logging Points in Code

### 1. Filter Stage
**File:** `src/quantai/strategies/metaAdaptive/evaluationLogger.ts`
**Triggers:** After `entryFilters.evaluateEntry()`
- Logs `filter_passed` or `filter_blocked`

### 2. Position Sizing Block
**File:** `src/services/metaAdaptiveOrchestrator.ts` (line ~250)
**Triggers:** When `sizing.qty <= 0`
- Logs `order_blocked_sizing`

### 3. Registration Block
**File:** `src/services/metaAdaptiveOrchestrator.ts` (line ~270)
**Triggers:** When `registerAdaptiveTradeEntry()` returns "predictor_blocked" or "skipped"
- Logs `order_blocked_registration`

### 4. Capital Block
**File:** `src/broker/capitalPoolBroker.ts` (line ~85)
**Triggers:** When `capital.reserve()` returns null
- Logs `order_blocked_capital`

### 5. Order Placement
**File:** `src/services/metaAdaptiveOrchestrator.ts` (line ~305)
**Triggers:** After `broker.place()` succeeds
- Logs `order_placed` (success) or `order_rejected` (broker error)

## Analysis Commands

### Check Execution Flow
```bash
npx tsx scripts/analyze-execution-flow.ts
```

Shows:
- Filter pass/block rates
- Execution attempt rates
- Order placement success rates
- Blocking reasons breakdown
- Execution gaps (filters passed but no attempt)

### Migrate Old Records
```bash
npx tsx scripts/migrate-evaluation-decisions.ts
```

Updates existing records:
- `executed` → `filter_passed`
- `blocked` → `filter_blocked`

## Understanding the Data

### Healthy System Indicators:
- `filter_passed` rate: 40-70% (filters working)
- `order_placed` / `filter_passed`: >50% (good execution)
- No large execution gap (backend online)

### Warning Signs:
- Large execution gap = backend offline or not processing ticks
- High `order_blocked_capital` = pool size too small
- High `order_blocked_sizing` = stops too wide or equity too low
- High `order_blocked_registration` = predictor too strict or cooldowns too long

## Benefits of New System

1. **Clarity:** "order_placed" unambiguously means REAL TRADE
2. **Debugging:** Can pinpoint exactly where trades get blocked
3. **Optimization:** Can tune each blocking point independently
4. **Monitoring:** Can alert on specific failure patterns
5. **Learning:** Optimizer knows which evaluations resulted in actual trades

## Backward Compatibility

- Schema field name unchanged (`decision: String`)
- Application code uses new values
- Migration script updates old records
- No database schema change required

## Future Enhancements

Potential additional statuses:
- `order_filled` - Order filled completely
- `order_partial` - Order partially filled
- `order_cancelled` - Order cancelled before fill
- `order_timeout` - Order timed out

This would require tracking order lifecycle separately from initial placement.
