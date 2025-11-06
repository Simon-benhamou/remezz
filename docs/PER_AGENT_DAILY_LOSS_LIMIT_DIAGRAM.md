# Per-Agent Daily Loss Limit - Visual Explanation

## Before: Global Daily Loss Limit (Problem)

```
┌─────────────────────────────────────────────────┐
│           Global Capital Pool                    │
│         Total Equity: $10,000                    │
│                                                  │
│  Day Start Equity: $10,000                       │
│  Current Equity:   $9,600                        │
│  Loss: -4% (DAILY LOSS LIMIT HIT!)               │
└─────────────────────────────────────────────────┘
                        │
                        │ Both agents blocked!
                        ├──────────────┬──────────────┐
                        │              │              │
                  ┌─────▼────┐   ┌────▼─────┐  ┌────▼─────┐
                  │ Agent A  │   │ Agent B  │  │ Agent C  │
                  │  SOL     │   │  ETH     │  │  XRP     │
                  ├──────────┤   ├──────────┤  ├──────────┤
                  │ Traded   │   │ Traded   │  │ NO TRADE │
                  │ Lost $400│   │ Break-even│  │          │
                  │ -4% loss │   │  $0 PnL  │  │  $0 PnL  │
                  ├──────────┤   ├──────────┤  ├──────────┤
                  │ ❌ BLOCKED│   │ ❌ BLOCKED│  │❌ BLOCKED │
                  └──────────┘   └──────────┘  └──────────┘
                                                     ▲
                                                     │
                                    PROBLEM: XRP blocked despite
                                    not trading! Global loss limit
                                    affects all agents.
```

## After: Per-Agent Daily Loss Limit (Solution)

```
┌─────────────────────────────────────────────────┐
│           Global Capital Pool                    │
│         Total Equity: $10,000                    │
│                                                  │
│  Per-Agent Equity Tracking:                      │
│  ┌────────────────────────────────────────────┐ │
│  │ Agent A: Start $3,000 → Current $2,880    │ │
│  │          Loss: -$120 (-4%)                 │ │
│  ├────────────────────────────────────────────┤ │
│  │ Agent B: Start $3,000 → Current $3,000    │ │
│  │          PnL: $0 (0%)                      │ │
│  ├────────────────────────────────────────────┤ │
│  │ Agent C: Start $4,000 → Current $4,000    │ │
│  │          PnL: $0 (0%)                      │ │
│  └────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
                        │
                        │ Each agent evaluated independently
                        ├──────────────┬──────────────┐
                        │              │              │
                  ┌─────▼────┐   ┌────▼─────┐  ┌────▼─────┐
                  │ Agent A  │   │ Agent B  │  │ Agent C  │
                  │  SOL     │   │  ETH     │  │  XRP     │
                  ├──────────┤   ├──────────┤  ├──────────┤
                  │ Traded   │   │ Traded   │  │ NO TRADE │
                  │ Lost $120│   │ Break-even│  │          │
                  │ -4% loss │   │  0% PnL  │  │  0% PnL  │
                  ├──────────┤   ├──────────┤  ├──────────┤
                  │ ❌ BLOCKED│   │ ✅ ACTIVE │  │ ✅ ACTIVE │
                  │(own loss)│   │(no loss) │  │(no loss) │
                  └──────────┘   └──────────┘  └──────────┘
                                                     ▲
                                                     │
                                    SOLUTION: XRP can continue!
                                    Only Agent A is blocked due
                                    to its own losses.
```

## Flow Diagram: How Per-Agent Equity Tracking Works

```
Agent Activation
      │
      ▼
┌──────────────────────────────────┐
│ 1. Initialize Agent Equity       │
│    - agentId: "xrp-agent"        │
│    - startingEquity: $4,000      │
│    - cumulativePnl: $0           │
└──────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────┐
│ 2. Agent Opens Trade             │
│    - Reserve capital from pool   │
│    - Commit to position          │
└──────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────┐
│ 3. Trade Closes (Win/Loss)       │
│    - Realized PnL: -$120         │
│    - Call: applyPnlDelta(        │
│        agentId="xrp-agent",      │
│        pnl=-$120                 │
│      )                           │
└──────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────┐
│ 4. Update Agent Equity           │
│    - cumulativePnl: $0 + (-$120) │
│                   = -$120        │
│    - currentEquity: $4,000 - $120│
│                   = $3,880       │
└──────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────┐
│ 5. Circuit Breaker Check         │
│    - Get per-agent equity        │
│    - Calculate daily loss:       │
│      ($3,880 - $4,000) / $4,000  │
│      = -3%                       │
│    - Compare to limit: -3%       │
│    - Decision: ALLOW (within 3%) │
└──────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────┐
│ 6. Independent Risk Management   │
│    - Other agents unaffected     │
│    - Each has own equity calc    │
│    - Fair and isolated           │
└──────────────────────────────────┘
```

## Code Flow

```typescript
// 1. Agent activates
await capitalManager.initializeAgentEquity('agent-xrp', 4000);

// 2. Later, trade closes with loss
await capitalManager.applyPnlDelta('agent-xrp', 'XRP/USDT', -120);

// 3. Circuit breaker checks daily loss
const broker = new CapitalPoolBroker({ agentId: 'agent-xrp', ... });
const balance = await broker.balance(); 
// Returns: { equityUsd: 3880, ... } (per-agent, not global!)

// 4. Circuit breaker calculates
const equity = balance.equityUsd; // 3880
const equityStartDay = 4000; // stored in circuit breaker state
const drawdownPct = ((3880 - 4000) / 4000) * 100; // -3%
const allowed = drawdownPct > -dailyLossLimitPct; // true if -3% > -3%

// 5. Other agents unaffected
const otherBroker = new CapitalPoolBroker({ agentId: 'agent-sol', ... });
const otherBalance = await otherBroker.balance();
// Returns: { equityUsd: 3000, ... } (different agent, different equity!)
```

## Key Benefits

| Aspect | Before (Global) | After (Per-Agent) |
|--------|----------------|-------------------|
| **Isolation** | One agent's loss blocks all | Each agent independent |
| **Fairness** | Unfair to non-trading agents | Fair to all agents |
| **Accuracy** | Inaccurate risk assessment | Accurate per-agent risk |
| **Scalability** | Poor (agents interfere) | Good (agents isolated) |
| **Circuit Breaker** | Global equity used | Per-agent equity used |

## Example Scenario

**Initial State:**
- Pool: $10,000
- Agent A (SOL): $3,000 starting equity
- Agent B (ETH): $3,000 starting equity  
- Agent C (XRP): $4,000 starting equity
- Daily loss limit: 3% per agent

**Events:**
1. Agent A trades SOL and loses $120 (4% loss)
2. Agent B trades ETH and breaks even ($0 PnL)
3. Agent C (XRP) hasn't traded yet

**Result:**
- ❌ Agent A: Blocked (own loss: 4% > 3% limit)
- ✅ Agent B: Active (no loss: 0% < 3% limit)
- ✅ Agent C: Active (no loss: 0% < 3% limit)

**Before this fix:**
- ❌ All three agents would be blocked (global loss of 1.2% affecting all)
