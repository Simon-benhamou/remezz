# Trade Evaluation Inconsistency Fix

## Problem Statement

When checking the API endpoint `/api/ops/events?limit=160`, the logs showed many "blocked_trade" entries with various reasons (capital exhausted, predictor confidence too low, cooldown active, etc.). However, when examining the TradeEvaluation table, there were many "filter_passed" entries, yet 0 actual orders were placed. This created a significant inconsistency between what the logs said and what the learning system recorded.

## Root Cause Analysis

The issue was in the `logMetaAdaptiveEvaluation` function in `/backend/src/quantai/strategies/metaAdaptive/evaluationLogger.ts`.

### The Problematic Flow

1. **Signal Evaluation** (in metaAdaptiveAgent.ts):
   - Entry filters check (ADX, CMF, trend strength, confidence, etc.)
   - If filters passed → `evaluation.ok = true`
   - **BUG**: Immediately logged `filter_passed` to TradeEvaluation table

2. **Execution Checks** (in metaAdaptiveOrchestrator.ts and recognizedStrategies.ts):
   - Position sizing check → could fail with `order_blocked_sizing`
   - Predictor confidence check → could fail with `filter_blocked`
   - Cooldown check → could fail with `filter_blocked`
   - Capital pool reservation → could fail with `order_blocked_capital`
   - Broker order placement → could fail with `order_rejected`

3. **Result**:
   - TradeEvaluation table: Shows `filter_passed` (from step 1)
   - Ops logs: Shows `trade_blocked` with specific reason (from step 2)
   - **INCONSISTENCY**: Learning system thought signal was good (filter_passed) but no trade happened

## The Fix

Modified `evaluationLogger.ts` to implement the correct logging strategy:

### Before (Incorrect)
```typescript
// Logged BOTH filter_passed AND filter_blocked based on evaluation.ok
const decision = evaluation.ok ? 'filter_passed' : 'filter_blocked';
await logTradeEvaluation({ symbol, decision, ... });
```

### After (Correct)
```typescript
// ONLY log filter_blocked when entry filters fail
// If evaluation.ok is true, return early without logging
// Let execution stage log the final outcome
if (evaluation.ok) {
  // Signal passed initial entry filters - don't log yet
  // The orchestrator will log the final outcome after execution checks
  return;
}

// Log filter_blocked with detailed reasons
await logTradeEvaluation({
  symbol,
  decision: 'filter_blocked',
  blockedReason: reasons.join('; '),
  ...
});
```

## Trade Evaluation Decision Flow

After the fix, the decision logging follows this clear hierarchy:

### Entry Filter Stage (metaAdaptiveAgent)
- **`filter_blocked`**: Entry filters failed (low ADX, negative CMF, weak trend, etc.)
  - Logged immediately when detected
  - No further processing happens

### Execution Stage (orchestrator and brokers)
If entry filters pass, one of these outcomes is logged:

- **`filter_blocked`**: Predictor confidence too low OR cooldown period active
  - These are analysis filters that evaluate signal quality
  - Logged in orchestrator after registration attempt

- **`order_blocked_sizing`**: Position sizing returned qty=0
  - Stop loss too wide for available capital
  - Logged in orchestrator before broker call

- **`order_blocked_capital`**: Capital pool exhausted
  - Not enough free capital to reserve for this trade
  - Logged in CapitalPoolBroker during reservation

- **`order_placed`**: Trade successfully placed on exchange
  - Only logged when broker.place() succeeds
  - The "success" case

- **`order_rejected`**: Broker rejected the order
  - Exchange error, rate limit, insufficient balance
  - Logged in orchestrator after broker response

## Benefits of the Fix

1. **Consistent Reality**: Trade evaluations now accurately reflect execution outcomes
2. **Better Learning**: Strategy optimizer sees true blocked reasons, not false positives
3. **Clearer Debugging**: No more confusion between logs and database records
4. **Proper Categorization**: Each outcome is logged exactly once at the right stage

## Testing

Created comprehensive unit tests in `/backend/test/unit/evaluation-logger-fix.spec.ts`:

```typescript
✓ should NOT log when evaluation.ok is true (filters passed)
✓ should log filter_blocked when evaluation.ok is false
✓ should include all blocked reasons in the log
```

All tests pass successfully.

## Impact

This fix ensures that:
- The strategy optimizer gets accurate data about which signals were truly good vs blocked
- Developers can trust the TradeEvaluation table to reflect reality
- The learning system can properly identify missed opportunities vs correctly filtered signals
- Production monitoring and alerting are based on consistent data

## Files Changed

1. `/backend/src/quantai/strategies/metaAdaptive/evaluationLogger.ts`
   - Added early return when evaluation.ok is true
   - Only logs filter_blocked when filters fail
   - Added comprehensive documentation

2. `/backend/test/unit/evaluation-logger-fix.spec.ts`
   - New test file with 3 test cases
   - Verifies correct logging behavior
   - Uses proper vitest mocking
