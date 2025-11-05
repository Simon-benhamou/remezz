# Trade Blocking Issues - Fix Summary

## Problem Statement
After having successful trades until November 3, 2025, all trading stopped completely for an entire day despite having 10 agents running. This document explains the critical bugs found and fixed.

## Root Cause Analysis

### Critical Bug #1: Regime Standby - Permanent COOLDOWN State
**File**: `backend/src/agent/state/index.ts`, lines 863-869  
**Severity**: CRITICAL

**What Happened**:
- When market regime enters "standby" mode (unfavorable market conditions), agents transition to COOLDOWN state
- No reactivation timer was scheduled, causing agents to remain in COOLDOWN permanently
- Even when market regime improved and became favorable again, agents stayed stuck and never checked

**Impact**: Once any agent enters regime standby, it stops trading forever until manually restarted.

**Fix Applied**:
```typescript
// Schedule reactivation to check if regime improves (5 minutes)
this.scheduleReactivation('regime_standby_check', 5 * 60 * 1000);
```

### Critical Bug #2: Regime shouldTrade Check - Permanent COOLDOWN State
**File**: `backend/src/agent/state/index.ts`, lines 1038-1043  
**Severity**: CRITICAL

**What Happened**:
- During each tick, if `regime.shouldTrade` is false, agents enter COOLDOWN
- No reactivation timer was scheduled
- Agents stayed stuck even after regime conditions improved

**Impact**: Similar to Bug #1, but can happen on every tick check.

**Fix Applied**:
```typescript
// Schedule reactivation to check if regime improves (5 minutes)
this.scheduleReactivation('regime_no_trade_check', 5 * 60 * 1000);
```

### Critical Bug #3: Order Rejection - Permanent COOLDOWN State
**File**: `backend/src/agent/state/index.ts`, lines 4013-4022  
**Severity**: CRITICAL

**What Happened**:
- When an order gets rejected by the exchange (insufficient balance, invalid parameters, etc.), agent enters COOLDOWN
- No reactivation timer was scheduled
- Agent never retries even if the conditions that caused rejection are resolved

**Impact**: After a single order rejection, the agent stops trading forever.

**Fix Applied**:
```typescript
this.entering = false;
// Schedule reactivation after order rejection (2 minutes to avoid hammering)
this.scheduleReactivation('order_rejected_retry', 2 * 60 * 1000);
```

### Critical Bug #4: Margin Halt - Permanent HALT State
**File**: `backend/src/agent/state/index.ts`, lines 10086-10111  
**Severity**: CRITICAL

**What Happened**:
- When margin utilization is too high, agents enter HALT state for safety
- When margin conditions improve and `clearMarginHalt()` is called, the halt flags are cleared
- However, the agent state remains in HALT with no transition back to active trading

**Impact**: Once margin utilization triggers a halt (even temporarily), the agent stays halted forever.

**Fix Applied**:
```typescript
// Schedule reactivation to allow trading again after margin halt is cleared
if (this.state === 'HALT') {
  this.scheduleReactivation('margin_halt_cleared', 30_000); // 30 seconds cooldown
}
```

## Why This Matches Your Symptoms

Your symptom: "No trades for an entire day after having active trades until Nov 3"

This is exactly what would happen if:
1. Market regime entered standby mode on Nov 3
2. OR one or more orders were rejected
3. OR margin utilization briefly spiked and triggered a halt

Any of these events would cause ALL affected agents to stop trading permanently until:
- Server is restarted (which resets agent states)
- Agents are manually stopped and restarted
- Manual intervention to change agent state

## Verification & Testing

### How to Verify the Fix is Working

1. **Check Agent States**: Monitor your agent states via the dashboard or API. After these fixes:
   - Agents in COOLDOWN should automatically transition back to ARMED after the scheduled delay
   - Look for cooldown reasons like: `regime_standby_check`, `regime_no_trade_check`, `order_rejected_retry`, `margin_halt_cleared`

2. **Monitor Logs**: Look for these log messages indicating the fix is working:
   ```
   "Standby regime detected - pausing entries"
   "⏳ Trade cooldown: Xs remaining - skipping entry"
   "Failed to re-arm agent after cooldown:" (only if there's another issue)
   ```

3. **Test Scenarios**:
   - Let an agent enter a regime standby period - it should auto-recover after 5 minutes
   - Cause an order rejection (e.g., set insufficient balance) - agent should retry after 2 minutes
   - Trigger a margin halt - agent should resume after margin clears + 30 seconds

### Monitoring Dashboard Indicators

After deploying this fix, you should see:
- ✅ Agents transitioning from COOLDOWN back to ARMED automatically
- ✅ More consistent trading activity across all 10 agents
- ✅ Recovery from temporary issues without manual intervention
- ✅ Cooldown reasons logged in the system events

### Expected Behavior Changes

**Before Fix**:
- Agents stop trading → Stay stopped forever → Require manual restart

**After Fix**:
- Agents stop trading → Auto-check conditions every 2-5 minutes → Resume when conditions improve

## Additional Recommendations

While investigating this issue, the following potential improvements were noted (not implemented in this fix):

1. **Persistent State Recovery**: Consider persisting cooldown timers across server restarts so agents can resume properly after deployment
2. **Cooldown Monitoring**: Add metrics/alerts for agents stuck in COOLDOWN state for extended periods
3. **Regime Change Notifications**: Add WebSocket events when regime changes to allow UI to show why agents are paused
4. **Diagnostic Endpoint**: Add an endpoint to check if agents are stuck and force reactivation if needed

## Deployment Notes

- **No breaking changes**: These fixes only add timer scheduling, no API or behavior changes
- **No database migrations required**
- **No environment variable changes**
- **Safe to deploy**: The worst case is agents reactivate slightly more frequently than before, which is better than staying stuck

## Testing Checklist

- [x] Code changes reviewed for correctness
- [x] All four critical bugs addressed
- [x] No syntax errors introduced
- [x] Git changes committed and pushed
- [ ] Deploy to staging environment (if available)
- [ ] Monitor agent state transitions for 1 hour
- [ ] Verify trades resume on all 10 agents
- [ ] Deploy to production
- [ ] Monitor for 24 hours to ensure no regression

## Support

If you still experience trading stops after this fix:
1. Check the logs for the specific reason agents enter COOLDOWN
2. Verify the cooldown timers are being set (look for "Schedule reactivation" logs)
3. Check if there are any other errors preventing `validateAndArm()` from succeeding
4. Review the diagnostic checks output to see what filters are failing

---
**Fix Date**: November 5, 2025  
**Files Modified**: `backend/src/agent/state/index.ts`  
**Lines Changed**: 4 locations, ~11 lines total
