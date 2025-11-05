# Capital Pool and Leverage Management Fix

## Problem Statement

The system had a critical flaw in how it handled leverage and capital allocation. When an agent used leverage to open a position, the system was reserving the **full notional value** from the shared capital pool instead of just the **margin requirement**.

### Example of the Problem

With a $1000 shared capital pool:
- Agent wants to take a $1135.80 position with 10x leverage
- **Required margin**: $1135.80 / 10 = $113.58
- **Before fix**: System reserved full $1135.80 → Pool shown as exceeded → Margin alerts triggered
- **After fix**: System reserves only $113.58 → Pool has $886.42 available for other agents → No false alerts

## Root Cause Analysis

The issue existed in three key areas:

1. **CapitalManager.reserve()**: Was reserving the full requested notional without considering leverage
2. **CapitalPoolBroker.place()**: Was requesting full notional from capital manager
3. **Capital reconciliation**: Was calculating `inPositionsUSD` as full notional instead of margin requirement

## Solution Implementation

### 1. Updated Type Definitions

**File**: `backend/src/core/capital/types.ts`

Added `leverage` field to the `Reservation` interface to track leverage for each reservation:

```typescript
export interface Reservation {
  id: string;
  agentId: string;
  symbol: string;
  requestedUSD: USD;
  grantedUSD: USD;
  leverage?: number; // leverage multiplier (e.g., 10 for 10x)
  expiresAt: number;
  state: 'reserved' | 'committed' | 'released';
}
```

### 2. Updated CapitalManager

**File**: `backend/src/core/capital/CapitalManager.ts`

Modified the `reserve()` method to:
- Accept `leverage` parameter
- Calculate margin requirement: `requestedMarginUSD = requestedNotionalUSD / leverage`
- Reserve only the margin requirement, not full notional
- Track leverage in the reservation

```typescript
async reserve(req: {
  agentId: string;
  symbol: string;
  requestedUSD: USD | number | string;
  minUSD?: USD | number | string;
  leverage?: number;  // NEW: leverage parameter
}): Promise<Reservation | null>
```

### 3. Updated CapitalPoolBroker

**File**: `backend/src/broker/capitalPoolBroker.ts`

Modified the `place()` method to:
- Extract leverage from order
- Pass leverage to capital manager's reserve()
- Calculate margin when committing: `filledMarginUsd = filledUsd / leverage`

### 4. Updated Capital Pool Reconciliation

**File**: `backend/src/services/capitalPool.ts`

Modified both paper and live reconciliation to:
- Fetch `leverage` field from positions in database
- Calculate margin requirement for each position: `marginRequired = notional / leverage`
- Use margin requirement instead of notional for `inPositionsUSD` and exposure tracking

```typescript
for (const position of session.positions) {
  const qty = Math.abs(Number(position.qty ?? 0));
  const entryPrice = Math.abs(Number(position.entryPrice ?? 0));
  const leverage = Math.max(1, Number(position.leverage ?? 1));
  if (!(qty > 0) || !(entryPrice > 0)) continue;
  const notional = qty * entryPrice;
  // Track margin requirement (notional / leverage), not full notional
  const marginRequired = notional / leverage;
  inPositionsTotal += marginRequired;
  exposureMap.set(
    position.symbol,
    (exposureMap.get(position.symbol) ?? 0) + marginRequired,
  );
}
```

## Testing

Created comprehensive test suite in `backend/test/capital/capitalManagerLeverage.spec.ts`:

### Test Cases

1. **Basic Leverage Reservation**: Verifies 10x leverage reserves only margin requirement
2. **Multiple Agents Sharing Pool**: Confirms multiple agents can use remaining capital after leveraged position
3. **Commit with Leverage**: Validates margin tracking when committing positions
4. **No Leverage (1x)**: Ensures backward compatibility when no leverage is used
5. **High Leverage**: Tests that high leverage enables larger positions with less capital
6. **Partial Fill**: Verifies unused margin is properly refunded on partial fills

### Test Results

All tests pass:
```
✅ Test 1 passed: 10x leverage reserves only margin requirement
✅ Test 2 passed: Multiple agents can share pool with leverage
✅ Test 3 passed: Commit properly tracks margin in positions
✅ Test 4 passed: 1x leverage (no leverage) reserves full notional
✅ Test 5 passed: High leverage enables larger positions
✅ Test 6 passed: Partial fill refunds unused margin
✅ All leverage tests passed
✅ capitalManager.spec passed (existing tests - backward compatibility verified)
```

## Impact Assessment

### Before Fix
- **Capital Efficiency**: Very low - agents blocked entire notional values
- **Pool Utilization**: Incorrectly showed pool as exceeded with leveraged positions
- **Agent Capacity**: Limited - couldn't run multiple agents with leverage
- **Margin Alerts**: False positives showing "exceeding equity"

### After Fix
- **Capital Efficiency**: High - agents reserve only margin requirements
- **Pool Utilization**: Accurate - properly tracks margin vs notional
- **Agent Capacity**: Much higher - multiple agents can share pool effectively
- **Margin Alerts**: Accurate - only triggered when actual margin issues exist

### Numerical Example

**Scenario**: $1000 shared pool, 10x leverage

| Metric | Before Fix | After Fix |
|--------|------------|-----------|
| Position notional | $1135.80 | $1135.80 |
| Reserved from pool | $1135.80 ❌ | $113.58 ✓ |
| Available for others | -$135.80 ❌ | $886.42 ✓ |
| Margin alert | Yes ❌ | No ✓ |
| Additional agents possible | 0 | ~7 more |

## Backward Compatibility

The changes are **fully backward compatible**:

1. **No leverage specified**: System defaults to `leverage = 1`, which reserves full notional (original behavior)
2. **Existing tests**: All original capital manager tests still pass
3. **Database schema**: Uses existing `leverage` field on Position model (no migration needed)
4. **API compatibility**: No breaking changes to external interfaces

## Long-Running Stability

The fix improves long-running stability by:

1. **Accurate capital tracking**: No more false margin alerts that could confuse monitoring
2. **Better resource utilization**: Multiple agents can coexist without false conflicts
3. **Proper cleanup**: Existing expiration logic now works correctly with leverage-adjusted amounts
4. **No memory leaks**: Changes don't introduce any new timers or memory-holding structures

## Monitoring Recommendations

To verify the fix in production:

1. **Monitor capital pool metrics**: Check that `freeUSD` and `inPositionsUSD` are calculated correctly
2. **Track margin alerts**: Verify reduction in false positive margin alerts
3. **Agent capacity**: Observe that more agents can run concurrently with the same pool size
4. **Position reconciliation**: Ensure positions are properly tracked with leverage

## Future Enhancements

Potential improvements for future iterations:

1. **Frontend visibility**: Add leverage indicators in pool displays
2. **Dynamic leverage limits**: Consider per-symbol or per-strategy leverage caps
3. **Risk-adjusted capital**: Use VaR or similar metrics for more sophisticated capital allocation
4. **Performance monitoring**: Track capital efficiency metrics over time
5. **Documentation**: Add leverage handling to API documentation

## Related Files

- `backend/src/core/capital/types.ts` - Type definitions
- `backend/src/core/capital/CapitalManager.ts` - Core capital management logic
- `backend/src/broker/capitalPoolBroker.ts` - Broker integration
- `backend/src/services/capitalPool.ts` - Pool reconciliation
- `backend/test/capital/capitalManagerLeverage.spec.ts` - Leverage tests
- `backend/test/capital/capitalManager.spec.ts` - Original tests (backward compatibility)

## Conclusion

This fix resolves the critical issue of capital pool management with leverage. The system now properly tracks margin requirements instead of full notional values, enabling:

- Multiple agents to share capital efficiently
- Accurate margin calculations and alerts
- Better capital utilization with leverage
- Improved system stability for long-running deployments

All changes are tested, backward compatible, and production-ready.
