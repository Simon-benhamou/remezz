# Per-Agent Daily Loss Limit

## Problem Statement

Previously, the daily loss limit was applied globally across all agents. When any agent lost money, it would affect the daily loss limit calculation for all other agents. This was problematic because:

1. An agent that hadn't traded could be blocked due to losses from other agents
2. The circuit breaker's daily loss calculation used the global account equity
3. This made it impossible to isolate agent performance and risk

## Solution

We implemented **per-agent equity tracking** to ensure each agent has its own independent daily loss limit calculation.

### Changes Made

#### 1. Added Per-Agent Equity Tracking Types (`types.ts`)
```typescript
export interface AgentEquitySnapshot {
  agentId: string;
  startingEquity: USD;
  cumulativePnl: USD;
  currentEquity: USD;
  lastUpdated: number;
}
```

#### 2. Extended CapitalManager (`CapitalManager.ts`)
- Added `agentEquity` map to track per-agent starting equity and cumulative PnL
- Added `initializeAgentEquity()` to set an agent's starting equity
- Added `getAgentEquity()` to retrieve per-agent equity snapshot
- Added `getAllAgentEquity()` to get all agents' equity
- Modified `applyPnlDelta()` to track PnL per agent

#### 3. Updated CapitalPoolBroker (`capitalPoolBroker.ts`)
- Modified `balance()` to return per-agent equity instead of global equity
- Modified `handleReduceFill()` to pass agentId when applying PnL delta

#### 4. Updated Agent Activation (`agent/state/index.ts`)
- Added initialization of agent starting equity when agent activates
- Uses `profile.startBalanceUsd` if provided, otherwise uses pool allocation

#### 5. Updated Tests
- Added agentEquity map initialization to all test fixtures
- Added comprehensive test for per-agent equity tracking

## How It Works

### Agent Equity Calculation

Each agent's equity is tracked independently:
```
Agent Equity = Starting Equity + Cumulative PnL
```

Where:
- **Starting Equity**: Set when the agent is activated (from `profile.startBalanceUsd`)
- **Cumulative PnL**: Sum of all realized PnL from that agent's trades

### Circuit Breaker Integration

The circuit breaker now uses per-agent equity for daily loss calculations:

1. When an agent activates, its starting equity is initialized in the CapitalManager
2. When the agent trades, PnL is tracked per-agent through `applyPnlDelta(agentId, symbol, pnl)`
3. When checking daily loss limits, the broker returns per-agent equity
4. The circuit breaker compares current agent equity vs. starting agent equity (not global)

### Example Scenario

**Before (Global Daily Loss Limit):**
- Agent A starts with $1000, loses $40 (4% loss)
- Agent B starts with $1000, hasn't traded
- Daily loss limit = 3%
- Result: Both Agent A AND Agent B are blocked ❌

**After (Per-Agent Daily Loss Limit):**
- Agent A starts with $1000, loses $40 (4% loss)
- Agent B starts with $1000, hasn't traded
- Daily loss limit = 3%
- Result: Only Agent A is blocked, Agent B can continue trading ✅

## Benefits

1. **Isolation**: Each agent's risk is isolated from other agents
2. **Fair**: Agents are only affected by their own trading performance
3. **Accurate**: Circuit breaker works on per-agent basis as intended
4. **Scalable**: Multiple agents can run in parallel without interfering with each other

## Testing

Run the capital manager tests to verify:
```bash
npm test test/capital/capitalManager.spec.ts
```

The test verifies:
- Agent equity is tracked independently
- PnL is accumulated per agent
- One agent's losses don't affect another agent's equity

## Migration Notes

- Existing agents will be automatically initialized when they activate
- No database migration required (equity is calculated in-memory)
- Circuit breaker state is already persisted per-session in the database

## Future Improvements

- Consider persisting agent equity snapshots for historical analysis
- Add API endpoints to view per-agent equity
- Add monitoring/alerts for per-agent performance
