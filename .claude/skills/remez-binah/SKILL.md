---
name: remez-binah
description: Use when adding, modifying, or tuning indicators, filters, or signal detection logic in checkMomentumSignal. Also use when researching new patterns, testing parameter sensitivity, evaluating filter chain changes, or deciding whether to enable or disable a filter.
---

# Remez-Binah (Hint and Discernment)

**Every indicator is an interpretation of the market -- not the market itself. Read the hints, but know their limits. Confluence of weak hints beats a single strong one.**

Remez sits above Pshat (verified data) and below Drash (decisions). It transforms raw price data into meaning. The danger is seeing patterns that aren't there (overfitting) or trusting a single indicator too much.

## When to Use

- Adding a new filter to `checkMomentumSignal()` (LONG or SHORT path)
- Tuning thresholds (ROC_MIN, VOL_MULTIPLIER, etc.)
- Enabling/disabling a filter in `MomentumConfig`
- Changing indicator timeframes or periods
- Researching a new pattern hypothesis
- Evaluating whether a filter is pulling its weight

## The Remez Questions

| Question | What it prevents |
|----------|-----------------|
| What is this indicator ACTUALLY measuring? | Cargo-cult use of indicators |
| Under what conditions does it produce FALSE signals? | Blind trust in a single hint |
| Is this confirmed by at least one independent hint? | Uncorroborated interpretation |
| Have I tested on data NOT used for discovery (OOS)? | Overfitting to noise |
| Does the filter chain still make logical sense end-to-end? | Filter bloat / contradiction |
| Is the timeframe appropriate for what this measures? | Mismatched resolution |

## The Filter Lifecycle

Every filter change must follow this sequence:

```
1. HYPOTHESIS: "I believe [indicator] at [threshold] captures [market behavior]"
2. IMPLEMENT: Add to checkMomentumSignal() in momentumSimple.ts
3. BACKTEST: Run comparison script (baseline vs new filter)
4. OOS TEST: Test on symbols NOT used in discovery (e.g., ADA, DOT, STX, TIA)
5. WALK-FORWARD: Split time (H1 vs H2) to detect regime-dependence
6. DECIDE: Enable only if 3/4 validation tests PASS
7. DOCUMENT: V5.XX tag in CLAUDE.md with discovery + validation results
```

**Never skip steps 4-5.** A filter that works on in-sample data but fails OOS is overfitting.

## Current Filter Chain (V5.102)

### BULL -> LONG
```
Regime (SMA200 BULL) -> Cash mode -> isBullish -> consecUp<=5
-> close > bb.upper -> roc10 >= 1.75% -> volRatio >= 1.15x
-> BTC volatility (ATR% >= 0.15%) -> MTF alignment (ROC > 0)
-> Green ratio < 70% -> alternation5 <= 2 -> BB touches >= 1
```

### BEAR -> SHORT
```
Regime (SMA200 BEAR) -> isBearish -> StochRSI filter
-> consecDown <= 6 -> roc5 <= -1.5% -> volRatio >= 2.0x
-> price < MA20 -> price < bb.lower -> BTC volatility
-> MTF alignment (ROC < 0) -> ROC acceleration <= 0
```

Each filter is a **hint**. The chain requires ALL hints to agree. This is confluence -- the Remez principle.

## Key Files

| File | Lines | What |
|------|-------|------|
| `momentumSimple.ts:1843-2397` | `checkMomentumSignal()` | Main filter chain |
| `momentumSimple.ts:1446-1475` | `checkMTFAlignment()` | BTC ROC confluence |
| `momentumSimple.ts:1485-1514` | `checkBTCVolatility()` | ATR-based vol filter |
| `momentumSimple.ts:1517-1522` | `calcROC()` | Rate of change |
| `momentumSimple.ts:3103-3121` | `calcATR()` | Average true range |
| `momentumSimple.ts:1-200` | `MomentumConfig` | All thresholds |
| `signalRanker.ts:62-104` | `calculateSignalScore()` | Multi-factor scoring |

## Validation Template

When testing a filter change, use this comparison structure:

```typescript
// Compare: [baseline] vs [your change]
// Symbols: DOGE, IMX, AVAX, FET, WIF (in-sample)
// OOS: ADA, DOT, STX, TIA (never used in discovery)
// Period: full range of local data
// Metrics: ROI, WR, Sharpe, MaxDD, trade count
```

**Pass criteria**: Improvement on in-sample AND at least 3/4 OOS/walk-forward tests pass. If OOS degrades significantly (Sharpe drops > 0.5), it's overfitting.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Adding a filter that only helps 1 symbol | Test across all symbols; likely overfitting |
| Tightening threshold until backtest looks great | OOS will punish you; keep thresholds loose |
| Adding filter without checking trade count drop | A filter that removes 80% of trades needs justification |
| Changing indicator period without understanding why | SMA200 on 15m = 50h window. Know what you're measuring |
| Testing only on bull market data | Walk-forward H1/H2 catches regime-dependent filters |
| Disabling a filter without measuring impact | Even "useless" filters may prevent rare catastrophic trades |

## The Remez Principle

A single indicator is an opinion. Two independent indicators agreeing is a hint. Three is a signal. The filter chain in `checkMomentumSignal()` demands that data (Pshat), trend (SMA200), momentum (ROC), volatility (ATR), volume, and pattern (BB/candle) all agree before acting. This is how Remez works: meaning emerges from confluence, not from any single interpretation.
