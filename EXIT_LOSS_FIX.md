# Fix: Agent Fails to Exit Loss Position

## Issue
Conservative agent entered XRP/USDT position at 2.5476 and never achieved profit. Price fell below entry and agent continued to hold position indefinitely with a 1.76R loss, failing to exit even as loss accumulated.

## Root Causes
1. **Exit logic too strict**: Required BOTH loss threshold AND momentum failure, preventing exit on persistent losses with good momentum
2. **No retry logic**: When exit order failed (rejected or error), position stayed open forever with no retry
3. **No order failure tracking**: Failed exits were logged but not tracked or retried

## Solution

### 1. Hard Stop Loss at 0.5R
Added automatic exit when loss reaches 0.5R regardless of momentum indicators. This prevents holding positions with severe losses.

**Location**: `backend/src/quantai/strategies/metaAdaptive/exitManager.ts`

```typescript
// Exit on significant loss regardless of momentum (0.5R or more)
const hardStopLossR = 0.5;
if (lossR >= hardStopLossR && effectiveHoldSatisfied) {
  return { action: 'exit', reason: `Hard stop loss: ${lossR.toFixed(2)}R loss exceeded threshold` };
}
```

### 2. Exit Order Retry Logic
Implemented retry mechanism (up to 5 attempts) for failed exit orders with position tracking.

**Location**: `backend/src/services/metaAdaptiveOrchestrator.ts`

```typescript
const MAX_EXIT_RETRIES = 5;
const RETRY_DELAY_MS = 2000; // 2 seconds between retries

// Track attempts in position object
position.exitAttempts += 1;
position.firstExitAttemptTime = Date.now();

// Retry on failure
if (attemptNumber < MAX_EXIT_RETRIES) {
  setTimeout(() => {
    executeExitTrade(session, agent, exitPrice, reason).catch(err => {
      logger.error(`Retry failed:`, err);
    });
  }, RETRY_DELAY_MS);
}
```

## Tests Added

1. **`exit-manager-hard-stop-loss.mjs`**: Validates 0.5R hard stop behavior
   - Tests long/short positions with good and bad momentum
   - Verifies existing 0.35R early exit still works

2. **`exit-order-retry-logic.mjs`**: Documents retry scenarios
   - Broker unavailable
   - Order rejected
   - Multiple retry attempts

3. **`xrp-usdt-loss-scenario.mjs`**: Validates the reported issue
   - Entry: 2.5476, Current: 2.4803 (1.76R loss)
   - Confirms exit triggers regardless of momentum

## Impact

### Before
- Agent held XRP/USDT position with 1.76R loss indefinitely
- Required momentum failure to exit even with large loss
- Failed exit orders left positions stuck forever

### After
- Automatic exit at 0.5R loss (regardless of momentum)
- Up to 5 retry attempts for failed exits (10 seconds total)
- Critical error logging when max retries exceeded
- Position tracking prevents silent failures

## Verification

All tests pass:
```bash
✅ exit-manager-loss-cut.mjs
✅ exit-manager-hard-stop-loss.mjs (5 tests)
✅ exit-order-retry-logic.mjs
✅ xrp-usdt-loss-scenario.mjs
✅ exit-manager-smoke-backtest.mjs
```

## Configuration

Default values (can be overridden in config):
- Hard stop loss: **0.5R**
- Early exit with momentum failure: **0.35R**
- Max exit retries: **5**
- Retry delay: **2 seconds**

## Notes

### Pre-existing Issue
The test `exit-manager-min-hold.mjs` was already failing before these changes. It expects pre-lock trailing to respect min hold time, but the current code doesn't check `effectiveHoldSatisfied` in the pre-lock trailing condition. This is unrelated to the loss protection fixes.
