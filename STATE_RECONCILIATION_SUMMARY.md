# State Reconciliation Service Implementation Summary

## Problem Statement

The trading bot was experiencing critical issues with state desynchronization between the application and the exchange:

1. **Ghost Positions**: The system showed positions in local state that didn't exist on the exchange (e.g., margin warning for DOT/USDT with no actual position).
2. **Exposure Mismatches**: Local state showed positions (UAI/USDT with non-zero localQty) while the exchange had no position (remoteQty: 0).
3. **Incorrect Margin Calculations**: The margin monitor was using potentially stale local state instead of actual exchange data.

These issues led to:
- False margin warnings
- Incorrect risk calculations
- Dangerous trading decisions based on phantom positions

## Solution Implemented

### 1. StateReconciler Service (`src/services/stateReconciler.ts`)

A comprehensive service that maintains accurate state synchronization:

**Key Features:**
- **Periodic Reconciliation**: Queries exchange every 60 seconds for fresh data
- **Position Fetching**: Retrieves all open positions with full metadata (qty, entry price, mark price, liquidation price, etc.)
- **Margin Snapshot**: Fetches complete margin data (equity, free balance, committed capital, margin ratio)
- **Discrepancy Detection**: Identifies three types of issues:
  - Ghost positions (local but not on exchange)
  - Orphaned positions (on exchange but not tracked locally)
  - Quantity mismatches (both have position but quantities differ by >5%)

**API:**
```typescript
// Start periodic reconciliation for a user
stateReconciler.startPeriodicReconciliation(userId: string)

// Get current reconciled state
stateReconciler.getReconciledState(userId: string): ReconciledState | null

// Get specific position
stateReconciler.getReconciledPosition(userId: string, symbol: string): ExchangePosition | null

// Get margin snapshot
stateReconciler.getReconciledMarginSnapshot(userId: string): BrokerMarginSnapshot | null

// Force immediate reconciliation
stateReconciler.forceReconciliation(userId: string): Promise<ReconciliationResult>
```

**Monitoring & Alerts:**
- Logs all detected discrepancies with detailed information
- Emits high-severity alerts for orphaned positions
- Records operational events for troubleshooting
- Provides status API for monitoring dashboard

### 2. MarginMonitor Integration (`src/services/marginMonitor.ts`)

Modified to use reconciled state as the primary data source:

**Changes:**
- For live sessions, checks StateReconciler first for margin data
- Uses reconciled margin snapshot if available and not stale
- Falls back to direct broker.balance() calls only if reconciled state unavailable
- Logs when using reconciled state vs. fallback for transparency

**Benefits:**
- Eliminates false margin warnings from ghost positions
- Ensures margin calculations based on actual exchange state
- Reduces API calls to exchange (uses cached reconciled data)

### 3. PositionSyncService Enhancement (`src/services/positionSyncService.ts`)

Updated to leverage StateReconciler for better accuracy:

**Changes:**
- Checks StateReconciler for position data before querying exchange directly
- Uses reconciled position data when available
- Falls back to direct inspectExposure() only if needed
- Logs data source for debugging

**Benefits:**
- More reliable position synchronization
- Reduced exchange API calls
- Consistent with margin monitor's data source

### 4. Server Integration (`src/server.ts`)

Automatic initialization on startup and agent creation:

**Startup Initialization:**
- Queries database for all active live trading sessions
- Starts reconciliation for each unique userId
- Logs initialization status

**Agent Creation Hook:**
- When a new live agent is created, checks if reconciliation is active for that user
- Starts reconciliation if not already running
- Ensures all live trading has state reconciliation enabled

### 5. Unit Tests (`test/unit/state-reconciler.spec.ts`)

Comprehensive test suite covering all scenarios:

**Test Cases:**
1. Initial reconciliation with no previous state
2. Ghost position detection (DOT/USDT missing on exchange)
3. Orphaned position detection (UAI/USDT not tracked locally)
4. Quantity mismatch detection (BTC 1.0 → 0.5)
5. Complex scenario with multiple issues simultaneously
6. No changes scenario (everything in sync)

**Test Results:** All tests passing ✅

## Technical Details

### Data Flow

```
Server Startup
    ↓
Query Active Live Sessions
    ↓
Start StateReconciler for each user
    ↓
Every 60 seconds:
    ↓
Fetch Positions from Exchange
    ↓
Fetch Margin Balance from Exchange
    ↓
Compare with Previous State
    ↓
Detect Discrepancies
    ↓
Update Reconciled State Cache
    ↓
Log & Alert if Issues Found
    ↓
MarginMonitor & PositionSync read from cache
```

### State Caching

The StateReconciler maintains a cache of reconciled state per user:

```typescript
{
  positions: Map<symbol, ExchangePosition>,
  marginSnapshot: BrokerMarginSnapshot,
  lastUpdate: timestamp,
  isStale: boolean  // true if older than 2 minutes
}
```

### Error Handling

- Exchange query timeouts after 15 seconds
- Prevents concurrent reconciliation for same user
- Graceful degradation to direct exchange queries if reconciled state unavailable
- All errors logged with full context for debugging

## Configuration

Default settings (can be adjusted):
- `RECONCILIATION_INTERVAL_MS = 60_000` (1 minute)
- `RECONCILIATION_TIMEOUT_MS = 15_000` (15 seconds)
- `POSITION_QTY_EPSILON = 1e-6` (minimum position size)
- Stale threshold: 2x reconciliation interval (2 minutes)
- Quantity mismatch threshold: 5% difference

## Benefits

1. **Eliminates Ghost Positions**: Local state always reflects exchange reality
2. **Accurate Margin Calculations**: Margin warnings based on actual exchange data
3. **Reduced Exchange API Calls**: Services use cached reconciled data
4. **Better Monitoring**: Clear visibility into state synchronization
5. **Proactive Issue Detection**: Identifies orphaned positions before they cause problems
6. **Improved Reliability**: Reduces risk of trading based on stale data

## Example Scenarios Addressed

### Scenario 1: Ghost Position (DOT/USDT)
**Before:** System shows margin warning for DOT/USDT despite no position on exchange
**After:** StateReconciler detects no position on exchange, clears ghost position, no false warning

### Scenario 2: Orphaned Position (UAI/USDT)
**Before:** Exchange has UAI/USDT position but system doesn't track it
**After:** StateReconciler detects orphaned position, emits alert, logs for manual review

### Scenario 3: Quantity Mismatch (BTC)
**Before:** System thinks it has 1.0 BTC but exchange shows 0.5 BTC
**After:** StateReconciler detects 50% mismatch, updates local state, logs discrepancy

## Monitoring & Operations

### Logs to Watch

- `state_reconciler.reconciliation_completed`: Normal periodic reconciliation
- `state_reconciler.ghost_positions_detected`: Ghost positions found and cleared
- `state_reconciler.orphaned_positions_detected`: Positions on exchange not tracked
- `state_reconciler.quantity_mismatches_detected`: Quantity differences detected
- `margin_monitor.using_reconciled_state`: MarginMonitor using reconciled data

### Alerts Generated

- **High severity**: Orphaned positions detected on exchange
- **Warning level**: Ghost positions or quantity mismatches

### API Endpoints for Monitoring

The StateReconciler provides status API:
```typescript
const status = stateReconciler.getReconciliationStatus(userId);
// Returns: { active, lastReconciliation, inProgress, stateAge, positionsCount }
```

## Migration Notes

- No database schema changes required
- Backward compatible - falls back to existing behavior if reconciliation unavailable
- Can be disabled per-user if needed (don't start reconciliation)
- Existing agents continue working without interruption

## Security Considerations

- Uses existing user credentials (no new authentication)
- Respects exchange rate limits via existing CCXT client
- No sensitive data stored beyond existing broker integration
- All exchange communication uses established secure channels

## Performance Impact

- Minimal: One exchange API call per user per minute
- Reduces overall API calls by enabling cache reuse
- Timeout protection prevents hanging operations
- Concurrent reconciliation prevention avoids resource waste

## Future Enhancements (Optional)

1. Configurable reconciliation intervals per user/strategy
2. Historical reconciliation results for trend analysis
3. Automatic position adoption (import orphaned positions)
4. Integration with automated recovery workflows
5. Dashboard widget showing reconciliation health

## Conclusion

The StateReconciler service provides a robust solution to position and margin state desynchronization issues. It operates transparently in the background, maintaining accurate state while providing visibility into any discrepancies. The implementation is backward compatible, well-tested, and production-ready.
