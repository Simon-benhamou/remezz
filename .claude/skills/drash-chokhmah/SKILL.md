---
name: drash-chokhmah
description: Use when modifying entry or exit logic, position sizing, trailing stops, NFS scoring, stop loss mechanics, risk management, cooldowns, capital pool, or execution flow. Also use when a change must propagate across live, paper, and backtest code paths.
---

# Drash-Chokhmah (Inquiry and Wisdom)

**Wisdom is knowing what to DO with understanding. Every decision has consequences that ripple across the entire system. A change in one code path that doesn't propagate to the others is a lie.**

Drash sits between Remez (interpretation) and Sod (unity). Remez tells you what the market hints. Drash decides how to act. The danger is acting in one place and forgetting the others.

## When to Use

- Modifying `shouldExitPosition()` exit logic
- Changing position sizing or `calculatePositionSize()`
- Adjusting trailing stop mechanics (activation, distance, tiers)
- Modifying NFS scoring or breach thresholds
- Changing `calcDynamicStopLoss()` tiers or volatility multipliers
- Adjusting cooldown logic (`getCooldownBars`)
- Modifying `CapitalPool` (reserve/commit/release)
- Changing max positions, Skip-N rule, signal ranking
- Any change to `positionOpener.ts` or `realtimeExitHandler.ts`

## The Drash Questions

| Question | What it prevents |
|----------|-----------------|
| Does this change exist in ALL code paths? | Silent divergence (backtest wins, live loses) |
| What is the worst case? What's the max I can lose? | Unbounded risk |
| Is the fee model realistic after this change? | Flattering backtests with optimistic costs |
| Does this adapt to conditions? (vol regimes, capital) | Brittle logic that works in one regime only |
| Can this decision be reversed if wrong? | Irreversible damage (no SL = catastrophic) |
| Have I checked the live/paper/backtest difference table? | Known asymmetries that affect this change |

## The Three Code Paths

Every execution decision lives in three places. A change to ONE must be reflected in ALL:

```
                    momentumSimple.ts
                   (shared logic: single source of truth)
                  /          |          \
    simpleAgent.ts    backtestService.ts    realtimeExitHandler.ts
    (15m tick loop)   (main simulation)     (1s realtime loop)
```

### Change Propagation Checklist

| If you change... | Check these files |
|-----------------|-------------------|
| Exit logic in `shouldExitPosition()` | Shared -- auto-propagates. But check `checkBacktestExit` wrapper and RT handler |
| Trailing stop activation/distance | `shouldExitPosition` + `realtimeExitHandler.ts` (1m kline path) + `backtestService.ts` (NFS scoring) |
| Stop loss calculation | `calcDynamicStopLoss` (shared) + `positionOpener.ts` (exchange STOP_MARKET) + backtest entry |
| Position sizing | `calculatePositionSize` (live) + inline sizing in `backtestService.ts` (simplified) |
| NFS scoring | `calculateNfsScoreForBreach` in backtest + RT handler NFS state machine |
| Cooldown bars | `getCooldownBars` (shared) -- but verify backtest uses it at line ~1482 |
| Max positions | `positionOpener.ts` (live) + `backtestService.ts` CONFIG.SIZING |
| Capital management | `CapitalPool` (live/paper) + `capital`/`capitalInUse` in backtest |
| BTC regime timeframe | `symbolEngine.ts` (btcCandles1h source) + `simpleAgent.ts` + `backtestService.ts` (V5.105: SymbolEngine was missed in V5.102) |

## Known Live vs Backtest Asymmetries

These are ACCEPTED gaps. Know them before making changes:

| Aspect | Live | Backtest |
|--------|------|----------|
| **Entry price** | Market order fill (slippage) | `candle.close` (exact) |
| **SL placement** | Fixed STOP_MARKET at entry | Recalculated per candle (vol regime shift) |
| **NFS HIGH exit** | Proactive LIMIT at trailing stop | `trailingStopPrice` (simulated limit) |
| **Position sizing** | Full `calculatePositionSize()` with ATR leverage | Simplified: `capital * pct * leverage` |
| **Fee model** | Exchange fee only in DB | 0.04% + 0.05% slippage + funding per 8h |
| **Max positions** | Dynamic `totalCapitalUsd` | Static `initialCapital` |

## Risk Boundaries

These limits must NEVER be weakened without explicit user approval:

```
MAX_HOLD:        2880 min (48h) -- prevents infinite bag-holding
EMERGENCY_SL:    baseSlPct * 2.5, capped at 2.5% -- exchange-side safety net
BREAKEVEN:       moves SL to entry+0.1% when maxPnl >= 0.7% -- protects winners (V5.145: was 1.0%)
SKIP_N:          after 2 consecutive losers, skip 1 trade -- immune response
TOXIC_HOURS:     UTC 4,5,9,18,21 -- statistically bad entry times
TRAILING_TIERS:  progressive widening at +3%, +4%, +6% HWM -- let winners run
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Changing SL logic in `shouldExitPosition` but not the exchange STOP_MARKET | Exchange SL is the safety net. Must be >= app SL |
| Tightening trailing without checking NFS thresholds | Tighter trailing = more breaches = NFS matters more |
| Adding exit logic only to 15m layer | RT handler (1s loop) also calls `shouldExitPosition` on 1m closes |
| Changing position sizing in backtest without documenting gap | Known parity gap; document or fix, never ignore |
| Removing cooldown "because it reduces trade count" | Cooldown is the immune system after losses |
| Testing risk changes only in bull market backtest | Bear market + drawdown is where risk logic matters most |

## The Drash Principle

Every decision creates consequences. Position sizing determines how much you risk. Trailing stop distance determines how much profit you keep. NFS scoring determines exit urgency. These are not parameters to optimize -- they are judgments that must be wise across all conditions. A trailing stop that maximizes backtest ROI but causes live slippage is foolish, not optimal. Wisdom (Chokhmah) is knowing that the best configuration is the one that works acceptably in ALL regimes, not perfectly in one.
