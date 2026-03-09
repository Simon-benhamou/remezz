# SL Deep Analysis — Trade Behavior Research (V5.150)

**Date**: 2026-03-09
**Period**: 2024 + 2025 (full years)
**Total trades**: 928 (195 SL, 548 WIN, 106 STAGNANT, 79 OTHER)

## Executive Summary

**The problem is NOT the entry signal — it's the SL distance vs volatility.**

- 88% of SL trades go positive first (MFE > 0.1%) → the entry was RIGHT
- 83% of SL trades hit SL within 8 bars (2h) → too fast for stagnant to save
- ATR% at entry is the #1 predictor (Cohen's d = 0.76) → high volatility = SL
- MED volatility regime has 71-77% SL rate vs 18-32% in LOW vol
- 20-24 UTC has 33-46% SL rate vs 14-21% at 08-12 UTC

---

## Finding 1: The Entry is RIGHT — 88% of SL trades go positive first

| Year | SL went positive (MFE > 0.1%) | Never went positive | Avg MFE before crash |
|------|-------------------------------|--------------------|-----------------------|
| 2025 | 70 / 80 = **88%** | 10 (13%) | +0.88% |
| 2024 | 89 / 115 = **77%** | 26 (23%) | +0.66% |

**Implication**: The momentum breakout signal is valid. Price moves in our favor first, then reverses and hits the SL. The problem is NOT at entry — it's that the trade reverses before reaching trailing activation.

WIN trades: MFE = +3.46% (2025), +2.71% (2024)
SL trades: MFE = +0.77% (2025), +0.52% (2024)

**The gap**: SL trades peak at ~0.7% profit vs ~3% for winners. The breakout doesn't have enough momentum to reach trailing territory.

---

## Finding 2: SL trades crash FAST — stagnant can't help

| Year | SL within 2 bars (30min) | SL within 8 bars (2h) | SL after 8+ bars |
|------|--------------------------|----------------------|-------------------|
| 2025 | 11 (14%) | 66 (83%) | 14 (18%) |
| 2024 | 17 (15%) | 105 (91%) | 10 (9%) |

**Stagnant needs 120 minutes (8 bars) to trigger + 60 min observation = 180 min total.** By that time, 83-91% of SL trades have already hit their stop.

**Why SL doesn't become STAGNANT**: Speed. The price crashes through the SL on wicks (checked on candle high/low) before the stagnant timer even starts. Stagnant can only save the 9-18% of "slow bleed" SL trades.

**STAGNANT trades comparison**: Stagnant trades have MAE of -1.85% (2025), -2.02% (2024) — less extreme than SL (-3.35%, -3.61%). Stagnant catches the "moderate losers" that don't crash hard enough to hit SL but don't recover either.

---

## Finding 3: ATR% is the #1 predictor — high volatility kills

| Feature | Cohen's d (2025) | Cohen's d (2024) | Separation |
|---------|-----------------|-----------------|------------|
| **ATR %** | **0.764** | **0.487** | **MEDIUM** |
| **BTC ATR %** | **0.695** | 0.086 | **MEDIUM (2025)** |
| BTC Change 1h % | -0.381 | -0.128 | SMALL (2025) |
| BTC Change 4h % | -0.366 | -0.171 | SMALL (2025) |
| ROC 5 | -0.319 | -0.296 | SMALL |
| ROC 10 | -0.291 | -0.333 | SMALL |

SL trades enter at ATR% = **1.33%** vs WIN trades at **0.99%** (2025).

### Volatility regime is DEADLY

| Vol Regime | SL rate (2025) | SL rate (2024) |
|-----------|---------------|---------------|
| LOW (<2%) | 17.6% | 31.9% |
| MED (2-3.5%) | **76.9%** | **71.4%** |
| HIGH (>3.5%) | 33.3% (n=3) | 0% (n=0) |

**MED volatility = death zone for SL**: 71-77% of trades in MED vol hit stop loss. The SL distance (2.5-3.0% for TIER2/TIER3) is NOT wide enough for MED vol conditions. The ATR is large enough to wick through the SL within a few candles.

**LOW vol trades are fine**: Only 18-32% SL rate. The SL distance is adequate.

---

## Finding 4: Time-of-day matters — 20-24 UTC is worst

| Time Block | SL rate (2025) | SL rate (2024) |
|-----------|---------------|---------------|
| 08-12 UTC | 15.8% | 20.6% |
| 12-16 UTC | 14.2% | 31.1% |
| 04-08 UTC | 17.4% | 31.8% |
| 16-20 UTC | 16.7% | 32.2% |
| 00-04 UTC | 24.6% | 41.2% |
| **20-24 UTC** | **32.8%** | **45.8%** |

**20-24 UTC is consistently the worst** window for SL across both years. This is the US market close / Asian session start — often volatile with thin liquidity.

**00-04 UTC is second worst** — Asian session with low liquidity.

---

## Finding 5: SHORT dominates SL (79% of SL trades)

| Year | LONG SL | SHORT SL | SHORT % of SL |
|------|---------|----------|---------------|
| 2025 | 17 | 63 | **79%** |
| 2024 | 27 | 88 | **77%** |

SHORT SL trades have deeper MAE (-3.45% vs -2.97% for LONG in 2025) but similar speed. SHORT breakdowns are more violent because bullish reversals (short squeezes) are faster than bearish reversals.

---

## Finding 6: Symbol-specific SL patterns

### 2025 worst SL symbols by rate:
1. ADA: 22.2% SL rate, -$2,428
2. STX: 20.6% SL rate, -$1,648
3. AVAX: 19.1% SL rate, -$1,098

### 2024 worst SL symbols by rate:
1. **WIF: 40.3%** SL rate, -$1,273
2. RENDER: 34.6% SL rate, -$191
3. DOT: 27.8% SL rate, -$500

WIF in 2024 was extremely SL-prone (40.3%!). This is likely due to WIF's extreme volatility in its early listing year.

---

## Finding 7: MAE/MFE patterns — the "breakout quality" gap

### SL trades lifecycle:
```
Entry → quick positive move (+0.7% avg MFE) →
reversal within 5 bars → crashes to SL (-3.4% avg MAE)
```

### WIN trades lifecycle:
```
Entry → quick dip (-0.7% avg MAE, bar 1) →
sustained move (+3.5% avg MFE) → trailing exit
```

**Key difference**: WIN trades dip early (MAE at bar 1) then run. SL trades peak early (MFE at bar 1) then crash. Both start with a brief favorable move, but WIN trades sustain it while SL trades can't.

---

## Actionable Conclusions

### 1. VOL REGIME FILTER (Highest Impact)
**Block entries in MED volatility regime (ATR 2-3.5%)**. This is where 71-77% of trades hit SL. Only 13-15 trades affected (small sample), but the SL rate is catastrophic.

- **Risk**: MED vol also has 3-6 WIN trades with very high MFE (8-10%). Blocking these loses those big winners.
- **Better approach**: Widen SL in MED vol regime (e.g., TIER2 MED: 2.5% → 3.5%).

### 2. TIME-OF-DAY FILTER (Moderate Impact)
**Block or widen SL for 20-24 UTC entries**. Consistent 33-46% SL rate across both years.

- 2025: 20 SL trades in 20-24 UTC = ~$4,100 in SL losses (25% of total)
- Could reduce SL losses by 25% if effective in engine

### 3. ADAPTIVE SL BASED ON ATR AT ENTRY (Structural Fix)
Instead of fixed tier-based SL, use: `SL% = max(tierBase, ATR_14 * 1.5)`. This widens the SL automatically when volatility is high, preventing wick-triggered stops.

- Current: TIER2 MED vol = 2.5% SL, but ATR is 2-3.5% → SL within 1 ATR = noise stop
- Proposed: SL = max(2.5%, ATR * 1.5) → in MED vol (ATR=2.5%): SL = 3.75% → gives room for wick noise

### 4. BREAKEVEN ACCELERATION (Protect Winners Earlier)
88% of SL trades went positive first. The breakeven trigger is at +0.7%. What if we moved it to +0.4%?

- SL trades peak at +0.65% median MFE → breakeven at +0.4% would catch some before the crash
- But tighter breakeven also clips more winners (Type I error)
- Needs backtest validation

### 5. STAGNANT TIMER ACCELERATION (Marginal)
Only 9-18% of SL trades could be saved by stagnant. Reducing stagnant trigger from 60min to 30min would help some, but most SL trades crash within 2-5 bars (30-75 min on wicks).

---

## Next Steps

1. **Backtest: Block MED vol entries** — highest expected impact, smallest sample concern
2. **Backtest: Adaptive SL = max(tierBase, ATR*1.5)** — structural fix, no trade count reduction
3. **Backtest: 20-24 UTC block or wider SL** — consistent pattern across both years
4. **Backtest: Breakeven at +0.4%** — protect the 88% of SL trades that go positive first
5. Re-run sl-predictor-analysis.ts with fixed timestamps for valid Cohen's d on all 20+ features
