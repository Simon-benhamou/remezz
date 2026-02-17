---
name: sod-yichud
description: Use before committing or deploying any strategy change. Also use when investigating parity mismatches, verifying system consistency between backtest and live, updating CLAUDE.md version documentation, or auditing whether the system maintains its single-source-of-truth architecture.
---

# Sod-Yichud (The Secret of Unity)

**Live and backtest are ONE entity with two manifestations. The system must know itself. If intention (backtest) diverges from action (live), the system is lying to itself.**

Sod is the deepest level. Pshat ensures truth in data. Remez ensures honesty in interpretation. Drash ensures wisdom in decisions. Sod ensures the UNITY of all three -- that what we believe we do (backtest) is what we actually do (live), verified after every trade.

## When to Use

- Before committing ANY strategy change (the final gate)
- After modifying `momentumSimple.ts`, `backtestService.ts`, or `simpleAgent.ts`
- When investigating parity verification mismatches
- When updating CLAUDE.md with V5.XX version documentation
- Periodically, to audit system health and self-consistency
- When adding a new exit reason, filter, or execution path

## The Sod Questions

| Question | What it guards |
|----------|---------------|
| Is `momentumSimple.ts` still the single source of truth? | Duplicated logic that can diverge |
| Would the backtest produce the same exit for this trade? | Intention-action gap |
| Has CLAUDE.md been updated with V5.XX documentation? | Institutional memory loss |
| What is the current parity match rate? | System self-knowledge |
| Have I introduced any NEW gap between BT and live? | Accidental divergence |
| Did I run the Sod checklist before committing? | Skipping the final gate |

## The Single Source of Truth

The system's unity depends on shared logic:

```
momentumSimple.ts (THE source of truth)
├── checkMomentumSignal()    -- used by BOTH live and backtest
├── shouldExitPosition()     -- used by BOTH live and backtest
├── calcDynamicStopLoss()    -- used by BOTH live and backtest
├── getCooldownBars()        -- used by BOTH live and backtest
├── checkMTFAlignment()      -- used by BOTH live and backtest
├── checkBTCVolatility()     -- used by BOTH live and backtest
├── MomentumConfig           -- used by BOTH live and backtest
└── NFS scoring functions    -- used by BOTH live and backtest
```

**If you find yourself writing the same logic in two places, STOP. Extract it to `momentumSimple.ts`.** Duplication is the enemy of unity.

## Pre-Commit Checklist

Before every commit that touches strategy logic:

```
[ ] 1. SHARED LOGIC: Is the change in momentumSimple.ts (shared)?
       If not, should it be? Would both BT and live benefit?

[ ] 2. PROPAGATION: Did I check Drash's change propagation table?
       Does this change need to be reflected in other files?

[ ] 3. PARITY GAPS: Did I create a new gap between BT and live?
       If yes, document it in CLAUDE.md under known parity gaps.

[ ] 4. VERSION TAG: Is CLAUDE.md updated with V5.XX entry?
       Include: what changed, why, validation results, config values.

[ ] 5. TYPE CHECK: Does `npx tsc --noEmit` pass on modified files?

[ ] 6. BACKTEST: Did I run at least one backtest to verify no regression?
       Compare ROI, WR, Sharpe against baseline.
```

## Parity Verification System

The ultimate expression of Sod -- the system verifying itself:

```
Trade closes -> parityVerificationServiceV2.ts
  -> Floors entry to 15m boundary
  -> Calls runBacktest() with forcedEntry + parityMode
  -> Backtest uses SAME strategy logic as live
  -> Compares: exit reason (family), PnL (3% tolerance), duration (20%)
  -> Result: MATCH | EXIT_MISMATCH | NO_SIGNAL | PNL_VARIANCE | DURATION_MISMATCH
```

### Mismatch Severity

| Category | Meaning | Action |
|----------|---------|--------|
| `MATCH` | Unity preserved | None needed |
| `NO_SIGNAL` | BT wouldn't enter; data difference | Investigate candle data (WS vs REST) |
| `EXIT_MISMATCH` | Different exit family | **BUG** -- investigate immediately |
| `PNL_VARIANCE` | Same exit, PnL > 3% diff | Usually slippage/fees -- acceptable |
| `DURATION_MISMATCH` | Same exit, timing differs | Check trailing/stagnant timing |
| `DATA_ERROR` | Verification failed | Fix data pipeline (Pshat issue) |

### Health Thresholds

```
HEALTHY:  match rate >= 90%  -- system knows itself
WARNING:  match rate 70-90%  -- investigate recent changes
CRITICAL: match rate < 70%   -- STOP trading, audit everything
```

## V5.XX Documentation Template

Every strategy change gets a version entry in `backend/CLAUDE.md`:

```markdown
### V5.XXX: [Short description]
**Date**: YYYY-MM-DD
**What**: [What changed and where]
**Why**: [What problem this solves or what improvement this brings]
**Validation**: [Backtest results, OOS test results, walk-forward results]
**Config**: [Exact config values changed]
**Parity impact**: [New gaps introduced or gaps closed]
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Committing without running backtest | At minimum: one symbol, one month, compare baseline |
| Forgetting CLAUDE.md version entry | Future sessions lose institutional knowledge |
| Fixing a bug in live but not backtest | The fix must be in shared logic or BOTH paths |
| Ignoring parity match rate degradation | A dropping match rate means growing divergence |
| Adding logic directly to simpleAgent.ts that could be shared | Extract to momentumSimple.ts first |
| Skipping the pre-commit checklist "because it's a small change" | Small changes cause the worst parity bugs |

## The Sod Principle

The name "Remezz" is itself a hint (Remez) that the system is built on reading market hints. But the Sod -- the secret -- is that the system's true edge isn't in any indicator or filter. It's in the architectural commitment to **self-consistency**: that what we believe (backtest) matches what we do (live), verified after every trade, with shared logic as the foundation of truth. A system that doesn't know itself cannot be trusted, no matter how good its backtest looks.
