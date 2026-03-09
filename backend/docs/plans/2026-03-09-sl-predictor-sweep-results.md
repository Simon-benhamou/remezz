# SL Predictor Filter Sweep — Results (V5.150)

**Date**: 2026-03-09
**Period**: 2024 (full year) + 2025 (full year)
**Capital**: $2,000, 5x leverage, 9 symbols (AVAX, FET, WIF, DOT, IMX, STX, ADA, RENDER, XRP)

## Context

After analyzing exit reasons (SL = -$21K combined PnL killer), we extracted 20+ novel features at entry time and used Cohen's d effect size to find the best SL predictors. Three features showed strong SL vs WIN separation in the initial (buggy) analysis:

| Feature | Cohen's d (2024) | Cohen's d (2025) | What it measures |
|---------|-----------------|-----------------|------------------|
| consecSameDir | 1.26 | 0.93 | Consecutive candles in signal direction |
| btcCandleBody | 0.86 | 0.46 | BTC candle opposite to signal direction |
| volSurge | 0.45 | 0.27 | Signal candle volume / avg 5 prior |

## Critical Bug Found (V5.150)

The initial sweep showed `consec >= 1` improving combined PnL by +222% ($7,874 -> $25,373). This was **too good to be true**.

**Root cause**: `trade.entryTime` in backtestService = candle CLOSE (candle.timestamp + 15min), not candle OPEN. The scripts used `Math.floor(entryTs / grid) * grid` which landed on the **NEXT** candle, not the signal candle.

**Evidence**: `consec >= 1` and `consec >= 2` gave identical results (461 trades, $25,373) — impossible if the timestamp alignment was correct. The engine already guarantees `isBullish` (LONG) and `isBearish` (SHORT), meaning `consecSameDir >= 1` is always true for valid trades.

**Fix**: `gridTs = Math.floor((entryTs - 15*60*1000) / grid) * grid` — subtract one candle duration.

## Corrected Results

```
Config                  | 2024 Tr | 2024 PnL | 2024 SL$ | 2025 Tr | 2025 PnL | 2025 SL$ | COMBINED
--------------------------------------------------------------------------------------------------
BASELINE                |  428    |  $-1868  |  $-4875  |  500    |   $9742  | $-16481  |    $7874
consec >= 1             |  428    |  $-1868  |  $-4875  |  500    |   $9742  | $-16481  |    $7874
consec >= 2             |  351    |  $-1742  |  $-4209  |  415    |   $7173  | $-14552  |    $5431
consec >= 3             |  229    |  $-1533  |  $-3161  |  280    |   $5598  |  $-9730  |    $4065
BTC opposite            |   44    |   $-246  |   $-599  |   48    |     $72  |  $-1757  |    $-174
volSurge >= 1.2         |  357    |  $-1433  |  $-3959  |  397    |   $9053  | $-12714  |    $7620
volSurge >= 1.3         |  341    |  $-1508  |  $-3816  |  380    |   $9771  | $-11374  |    $8264
volSurge >= 1.5         |  313    |  $-1827  |  $-3620  |  348    |   $9837  |  $-9937  |    $8010
consec>=1 + BTC opp     |   44    |   $-246  |   $-599  |   48    |     $72  |  $-1757  |    $-174
consec>=2 + BTC opp     |   34    |      $7  |   $-379  |   35    |    $328  |  $-1041  |     $335
consec>=1 + vol>=1.2    |  357    |  $-1433  |  $-3959  |  397    |   $9053  | $-12714  |    $7620
consec>=1 + vol>=1.3    |  341    |  $-1508  |  $-3816  |  380    |   $9771  | $-11374  |    $8264
c>=1+BTC+vol>=1.2       |   30    |   $-130  |   $-344  |   30    |    $350  |   $-965  |     $219
```

## Analysis

### consec >= 1: NO-OP (confirmed)
Identical to baseline. The engine already requires `isBullish` for LONG and `isBearish` for SHORT, which guarantees the signal candle is in the trade direction. `consecSameDir >= 1` adds nothing.

### consec >= 2 and >= 3: HARMFUL
- consec >= 2: -$2,443 vs baseline (-31%). Removes 162 trades but the removed trades include winners.
- consec >= 3: -$3,809 vs baseline (-48%). Removes 419 trades — too aggressive, kills trade volume.

Requiring more momentum confirmation BEFORE entry hurts our breakout strategy. We want to catch breakouts early, not wait for multi-candle confirmation.

### BTC opposite: CATASTROPHIC
- Combined: -$174 vs $7,874 baseline (-102%). Only 92 trades survive.
- Requiring BTC to move opposite the signal direction (BTC red for LONG, BTC green for SHORT) kills nearly all trades. Our momentum breakout strategy often enters WITH BTC direction, not against it.

### volSurge >= 1.3: MARGINAL WINNER (but post-filter caveat)
- Combined: $8,264 vs $7,874 baseline (+5%).
- 2025: $9,771 vs $9,742 (+$29, essentially flat).
- 2024: -$1,508 vs -$1,868 (+$360, marginal improvement).
- SL reduction: -$15,190 vs -$21,356 (-29% less SL losses).
- But: removes 207 trades (22%) to gain $390. Not worth the complexity.
- **And**: this is a post-filter result. Engine integration would trigger the slot replacement effect (freed slots taken by worse trades). DNA filter showed +27% post-filter but -$864 in engine. volSurge's +5% would likely go negative.

### Combinations: WORSE
All combos are worse than baseline or marginal. The best combo (consec>=2 + BTC opp) keeps only 69 trades for +$335 combined — not viable.

## Conclusions

1. **None of these features are viable as engine filters.** The corrected results show no statistically significant improvement over baseline.

2. **The initial +222% result was a timestamp alignment bug**, not a real signal. The Cohen's d analysis was also affected — feature distributions were computed on wrong candles.

3. **SL reduction via entry-time features is extremely hard.** The features that separate SL from WIN trades in post-hoc analysis (with the correct candle) don't translate into actionable filters because:
   - They're too correlated with existing filters (isBullish already covers consecSameDir)
   - They remove good trades alongside bad ones
   - Post-filter improvements evaporate with slot replacement in the engine

4. **SL losses (-$21K) may need to be addressed at the EXIT level** (better trailing, tighter stops in specific conditions) rather than at the ENTRY level.

## Lessons Learned

1. **Always verify timestamp alignment** when mapping backtest trades back to candles. `trade.entryTime` = candle CLOSE time (V5.46 realisticTiming), not candle OPEN.
2. **Identical results for different thresholds is a red flag** — it means the underlying data has a binary artifact, not a continuous signal.
3. **Post-filter results are always optimistic.** The slot replacement effect means engine-integrated results will be worse. Small post-filter improvements (<10%) will likely go negative in the engine.
4. **Cohen's d is only as good as the data alignment.** High effect sizes on wrong data = garbage in, garbage out.

## Next Steps (potential)

- Re-run `sl-predictor-analysis.ts` with the corrected timestamp to get valid Cohen's d values
- Investigate SL reduction at the EXIT level (adaptive SL based on entry conditions)
- Consider per-symbol SL analysis (some symbols may have specific SL patterns)
- Explore time-of-day SL patterns (certain hours may produce more SL exits)
