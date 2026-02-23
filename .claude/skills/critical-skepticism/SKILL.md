---
name: critical-skepticism
description: Use when results look too good, metrics seem unusually favorable, a plan has no apparent downsides, or you're about to trust data/conclusions without verification. Also use when the user says something feels off, or when a change is based on a single data source without cross-validation.
---

# Critical Skepticism (The Devil's Advocate)

**If something looks too good to be true, it usually is. Your job is to find the trap BEFORE it costs money.**

This skill is a forced pause. When triggered, you STOP forward momentum and interrogate your own conclusions. The goal is not to be negative — it's to find the hidden failure mode that optimism conceals.

## When to Use

- Backtest results look amazing (WR > 70%, ROI > 500%)
- A new filter/strategy "fixes everything" with no downsides
- A metric is suspiciously clean (perfect correlation, zero edge cases)
- You're about to deploy based on a single overnight sample
- Confidence is high but sample size is small (< 50 trades)
- Someone says "it just works" without explaining WHY it works
- A price/score/signal looks like free money (VHigh confidence = 50% WR trap)
- Cross-validation between sources disagrees (Gamma vs CLOB divergence)

## The Skepticism Protocol

### Step 1: Name the Claim
Write ONE sentence: what exactly is being claimed?

> "VHigh confidence (70+) has strong edge because the scorer gives it the highest score."

### Step 2: Inversion — What Would Make This FALSE?

For every claim, ask: **Under what conditions is this wrong?**

| Claim | Inversion |
|-------|-----------|
| "High score = high WR" | Score doesn't account for market price (high score = expensive entry = thin margin) |
| "73.8% virtual WR" | Virtual doesn't pay the spread. Real fills at worse prices |
| "Filter X improves WR by 3pp" | But reduces trade count by 20% → less total PnL |
| "Overnight data confirms the pattern" | 84 trades = 1 night. Weather ≠ climate |
| "This symbol prints money" | Survivorship bias. When did you start tracking it? |

### Step 3: The Five Traps

Check EVERY result against these:

```
TRAP 1: SAMPLE SIZE
  → N < 30? Your "pattern" is noise.
  → Is the timeframe cherry-picked? (only bull market? only one session?)

TRAP 2: HIDDEN COSTS
  → Does the result include spread, slippage, fees, failed fills?
  → Virtual WR ≠ Real WR (the 13pt gap: 73.8% vs 60.7%)

TRAP 3: SURVIVORSHIP BIAS
  → Are you only looking at winners? What about the 34 wins that never sold?
  → "71$ stuck in tokens" means your real PnL ≠ your displayed PnL

TRAP 4: OVERFITTING / LOOK-AHEAD
  → If I change the dates by 1 week, does the conclusion hold?
  → Is this parameter tuned on the same data that validates it?
  → Out-of-sample test MANDATORY before deploying any threshold

TRAP 5: COMPOSITION FALLACY
  → Metric A is good AND Metric B is good → overall good? NOT NECESSARILY.
  → Example: 73.8% WR but -62$ PnL. WR is vanity, PnL is sanity.
```

### Step 4: Cross-Validate

Never trust a single source. For every conclusion:

| Source A | Source B (cross-check) |
|----------|----------------------|
| Gamma odds | CLOB ask price (can diverge 20%+) |
| Virtual WR | Real CLOB WR (spread costs matter) |
| Backtest PnL | Live PnL (execution gaps) |
| Score confidence | Actual price paid (high score ≠ cheap entry) |
| 1 night's data | 7-day rolling average |
| WR by symbol | WR by time-of-day (hidden confounders) |

### Step 5: State the Residual Risk

After all checks, write: **"The remaining risk is..."**

If you can't articulate the remaining risk, you haven't looked hard enough.

## Red Flags Checklist

Mark each before proceeding:

- [ ] Have I checked the SAMPLE SIZE? (minimum 50 verified trades)
- [ ] Have I compared VIRTUAL vs REAL metrics?
- [ ] Have I checked for TIME-OF-DAY or SYMBOL confounders?
- [ ] Have I verified the COST MODEL is realistic?
- [ ] Have I tested with OUT-OF-SAMPLE data?
- [ ] Have I identified WHO LOSES if I'm wrong? (user's capital)
- [ ] Can I explain WHY this works, not just THAT it works?

## The Golden Rule

**Before deploying any change based on data analysis:**

1. State the claim in one sentence
2. Find ONE scenario where it fails
3. Check sample size, hidden costs, survivorship
4. Cross-validate with a second source
5. Articulate the remaining risk

If you skip any step, you're gambling, not trading.

## Examples of Past Traps (Remezz)

| What looked good | What was actually happening |
|-----------------|---------------------------|
| VHigh confidence (70+) = strong edge | 50% WR at avg 0.794 entry = -EV (expensive tokens) |
| 73.8% virtual WR | 60.7% real WR (13pt gap from CLOB spread) |
| 84 overnight trades = solid sample | 5 LOTTERY trades at confidence=0, all lost |
| 51 wins! | 34/51 never auto-sold = 71$ stuck tokens |
| "Works on all symbols" | XRP = 16.7% WR, 2h-6h UTC = 50% WR |
| S/R filter improved WR +1pp, Sharpe +0.19 | ROI dropped -361% (fewer trades killed volume) |
| Exhaustion detector on 15m = +$33K | 1m replay showed -47% PnL (false triggers) |
