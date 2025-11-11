# Order Visibility and Capital Sync Fix - Summary

## Problem Statement

The system had critical bugs where:
1. Orders existed in the database but were not visible in the monitoring API
2. Backend allowed placing orders even when frontend showed $0 available capital
3. Capital pool calculations didn't properly sync with database state

## Root Causes Identified

### 1. Order Visibility Issue
**Location**: `backend/src/routes/orders.ts`

**Problem**: When no `sessionId` was provided in the query, the API only returned orders from the most recent active session:
```typescript
// OLD CODE (BUGGY)
const s = await prisma.agentSession.findFirst({ 
  where: { stoppedAt: null }, 
  orderBy: { startedAt: 'desc' } 
});
if (s?.id) where.sessionId = s.id;
```

This meant if multiple agents were running simultaneously, only the newest one's orders were visible.

### 2. Missing Capital Validation
**Location**: `backend/src/broker/capitalPoolBroker.ts`

**Problem**: There was no strict check to prevent order placement when free capital was exhausted. The capital reservation system could fail silently, but orders were still attempted.

### 3. Lack of Sync Monitoring
**Location**: `backend/src/services/capitalPool.ts`

**Problem**: No warnings when capital pool state diverged from database state, making debugging difficult.

## Solutions Implemented

### Fix 1: Order Visibility Across All Active Sessions

**File**: `backend/src/routes/orders.ts`

**Change**: Fetch orders from ALL active sessions, not just the most recent:
```typescript
// NEW CODE (FIXED)
const activeSessions = await prisma.agentSession.findMany({ 
  where: { stoppedAt: null }, 
  select: { id: true } 
});
if (activeSessions.length > 0) {
  where.sessionId = { in: activeSessions.map(s => s.id) };
}
```

**Benefits**:
- All orders from active agents now visible in monitoring API
- Frontend displays complete picture of capital usage
- Per-order session data included for accurate calculations

### Fix 2: Strict Capital Validation

**File**: `backend/src/broker/capitalPoolBroker.ts`

**Change**: Added critical pre-check before order placement:
```typescript
const preCheckSnapshot = await this.capital.getBalance();
const actualFreeCapital = preCheckSnapshot.freeUSD.toNumber() - preCheckSnapshot.reservedUSD.toNumber();

if (actualFreeCapital <= 0) {
  console.log(`[CapitalPoolBroker] ❌ CRITICAL BLOCK - zero_capital_available`);
  // ... detailed logging ...
  return this.rejectOrder(order, 'zero_capital_available');
}
```

**Benefits**:
- Prevents over-exposure when capital is exhausted
- Detailed logging for debugging capital issues
- Audit trail through trade evaluation system
- reduceOnly orders still allowed (exit trades)

### Fix 3: Capital Sync Monitoring

**File**: `backend/src/services/capitalPool.ts`

**Change**: Added discrepancy detection in both paper and live reconciliation:
```typescript
const previousSnapshot = await paperProvider.getSnapshot();
const previousPositionsUsd = previousSnapshot.inPositionsUSD.toNumber();
const positionsDifference = Math.abs(inPositionsTotal - previousPositionsUsd);

if (positionsDifference > 10 && totalPositionsCount > 0) {
  console.warn('⚠️ CAPITAL SYNC WARNING [Paper Mode]:');
  console.warn(`  Active Sessions: ${sessions.length}`);
  console.warn(`  Total Positions: ${totalPositionsCount}`);
  console.warn(`  Difference: $${positionsDifference.toFixed(2)}`);
  // ... more diagnostic info ...
}
```

**Benefits**:
- Early warning system for capital sync issues
- Helps operators identify problems before they escalate
- Detailed diagnostic information for troubleshooting

## Testing

### New Test Suites Created

1. **`backend/test/api/orders.visibility.spec.ts`** (176 lines)
   - ✅ Returns orders from all active sessions
   - ✅ Filters by specific session when requested
   - ✅ Excludes orders from stopped sessions

2. **`backend/test/capital/capitalValidation.spec.ts`** (262 lines)
   - ✅ Rejects orders when free capital is zero
   - ✅ Rejects orders when free minus reserved is zero
   - ✅ Allows orders when capital is available
   - ✅ Allows reduceOnly orders even with zero capital

### Test Results
- **Total Tests**: 127 files, 7 new test cases
- **Pass Rate**: 100%
- **No Regressions**: All existing tests still passing
- **Build Status**: Clean (no TypeScript errors)

## Deployment Considerations

### Zero Breaking Changes
- All changes are additive or fix bugs
- Backward compatible with existing frontend
- No database migrations required
- No configuration changes needed

### Monitoring After Deployment
Watch for these log messages:
- `⚠️ CAPITAL SYNC WARNING` - indicates sync issues detected
- `❌ CRITICAL BLOCK - zero_capital_available` - order blocked due to no capital
- `❌ REJECTED - capital_reservation_failed` - capital reservation failed

### Expected Behavior Changes
1. **Frontend**: Will now see ALL orders from all active agents
2. **Backend**: Will reject orders when capital is truly exhausted
3. **Logs**: More detailed capital debugging information

## Files Modified

| File | Lines Changed | Type |
|------|--------------|------|
| `backend/src/routes/orders.ts` | +29/-12 | Bug Fix |
| `backend/src/broker/capitalPoolBroker.ts` | +24/0 | Enhancement |
| `backend/src/services/capitalPool.ts` | +40/0 | Enhancement |
| `backend/test/api/orders.visibility.spec.ts` | +176/0 | Test |
| `backend/test/capital/capitalValidation.spec.ts` | +262/0 | Test |
| **Total** | **+531/-12** | **5 files** |

## Related Issues

- Resolves: Simon-benhamou/QuantAILabs#[issue_number]
- Related: Simon-benhamou/QuantAILabs#316, Simon-benhamou/QuantAILabs#318

## Verification Steps

To verify the fix works:

1. **Start multiple agents** on different symbols
2. **Check monitoring API** (`GET /api/orders`) without sessionId
3. **Verify all orders appear** from all active agents
4. **Invest all capital** through one agent
5. **Attempt another order** - should be rejected with clear message
6. **Check logs** for capital warnings if any sync issues

## Future Improvements

Consider in future iterations:
- Real-time WebSocket updates for order visibility
- Capital pool state dashboard in frontend
- Automated alerts when sync issues detected
- Historical tracking of capital discrepancies
