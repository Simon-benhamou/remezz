# Daily Loss Limit Fix - Per-Agent Implementation

## Issue Summary

**Problem:** XRP agent was blocked by daily loss limit despite not having traded. The logs showed:
```json
{
  "message": "Daily loss limit hit",
  "agent": "XRP/USDT:USDT",
  "traded": false
}
```

**Root Cause:** The daily loss limit was being applied globally across all agents. The circuit breaker used the global account equity to calculate daily losses, meaning any agent's losses would trigger the daily loss limit for ALL agents.

## Solution

Implemented **per-agent equity tracking** so each agent has an independent daily loss limit calculation.

## Changes Made

### 1. Core Types (`backend/src/core/capital/types.ts`)
Added `AgentEquitySnapshot` interface to track per-agent equity:
```typescript
export interface AgentEquitySnapshot {
  agentId: string;
  startingEquity: USD;
  cumulativePnl: USD;
  currentEquity: USD;
  lastUpdated: number;
}
```

### 2. Capital Manager (`backend/src/core/capital/CapitalManager.ts`)
- Added `agentEquity` map to store per-agent equity data
- Added `initializeAgentEquity(agentId, startingEquity)` method
- Added `getAgentEquity(agentId)` method
- Added `getAllAgentEquity()` method
- Modified `applyPnlDelta(agentId, symbol, pnl)` to track PnL per agent

### 3. Capital Pool Broker (`backend/src/broker/capitalPoolBroker.ts`)
- Modified `balance()` to return per-agent equity instead of global equity
- Modified `handleReduceFill()` to pass agentId when applying PnL

### 4. Agent State (`backend/src/agent/state/index.ts`)
- Added agent equity initialization when agent activates
- Uses `profile.startBalanceUsd` as starting equity

### 5. Capital Pool Service (`backend/src/services/capitalPool.ts`)
- Added `agentEquity` map initialization for paper and live managers

### 6. Tests
- Updated all test fixtures to include `agentEquity` map
- Added comprehensive test for per-agent equity tracking
- Verified isolation between agents

## How It Works

### Before (Global Daily Loss Limit)
```
Global Account: $10,000
├─ Agent A (SOL): Loses $400 → Total equity: $9,600
├─ Agent B (ETH): Break-even → Total equity: $9,600  
└─ Agent C (XRP): No trade → Total equity: $9,600

Daily Loss: ($9,600 - $10,000) / $10,000 = -4%
Result: ALL agents blocked! ❌
```

### After (Per-Agent Daily Loss Limit)
```
Global Account: $10,000
├─ Agent A (SOL): Start $3,000, Loses $120 → Current $2,880 (-4%)
│  └─ BLOCKED (own loss exceeds 3%) ❌
├─ Agent B (ETH): Start $3,000, PnL $0 → Current $3,000 (0%)
│  └─ ACTIVE (no loss) ✅
└─ Agent C (XRP): Start $4,000, PnL $0 → Current $4,000 (0%)
   └─ ACTIVE (no loss) ✅
```

## Benefits

1. **Fair Risk Management**: Each agent is only affected by its own trading performance
2. **Independent Operation**: Multiple agents can run in parallel without interfering
3. **Accurate Circuit Breaking**: Circuit breaker works as intended on per-agent basis
4. **Scalable**: System can handle many agents without cross-contamination

## Testing

### Unit Tests
Run capital manager tests:
```bash
cd backend
npm test test/capital/capitalManager.spec.ts
```

The test verifies:
- Agent equity is tracked independently
- PnL is accumulated per agent
- One agent's losses don't affect another agent's equity

### Integration Testing
1. Start multiple agents with different symbols
2. Make one agent lose money (trigger daily loss limit)
3. Verify other agents can continue trading
4. Check logs to confirm per-agent equity calculations

## Documentation

- **Detailed Explanation**: `docs/PER_AGENT_DAILY_LOSS_LIMIT.md`
- **Visual Diagrams**: `docs/PER_AGENT_DAILY_LOSS_LIMIT_DIAGRAM.md`

## Migration

- **No Breaking Changes**: Existing agents will work without modification
- **Automatic Initialization**: Agent equity is initialized on activation
- **No Database Changes**: Equity tracking is in-memory (circuit breaker state already persisted)

## Verification

To verify the fix is working:

1. **Check Logs**: Look for per-agent equity in circuit breaker logs
2. **Monitor Agents**: Verify agents are not blocked by other agents' losses
3. **Test Scenario**: 
   - Start Agent A and Agent B
   - Make Agent A lose >3%
   - Verify Agent A is blocked but Agent B continues trading

## Example Log Output (After Fix)

```json
{
  "level": "info",
  "source": "circuit_breaker",
  "message": "Daily loss check",
  "agentId": "xrp-agent",
  "details": {
    "startingEquity": 4000,
    "currentEquity": 4000,
    "cumulativePnl": 0,
    "dailyLossPct": 0,
    "dailyLossLimit": 3,
    "allowed": true
  }
}
```

## Rollback Plan

If issues arise, the fix can be reverted by:
1. Reverting the PR
2. Redeploying previous version
3. No database changes to undo

## Performance Impact

- **Memory**: Minimal (one map entry per active agent)
- **CPU**: Negligible (simple arithmetic operations)
- **Database**: None (no additional queries)

## Future Enhancements

- Persist agent equity snapshots for historical analysis
- Add API endpoints to view per-agent equity
- Add monitoring/alerts for per-agent performance
- Dashboard showing per-agent equity trends

## Related Issues

This fix resolves the issue described in the logs where the XRP agent was incorrectly blocked by the daily loss limit despite not having made any trades.

## Author

Implementation by GitHub Copilot
Co-authored-by: Simon-benhamou <84936931+Simon-benhamou@users.noreply.github.com>

## Date

2025-11-06
