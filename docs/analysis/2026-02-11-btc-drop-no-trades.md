# Analysis: Why No Trades Fired During BTC 69k -> 66k Drop (2026-02-11)

## Context
- BTC dropped from ~69k to ~66k (~4.3%) overnight (Feb 10-11, 2026)
- Altcoins followed the decline
- Agent was running and monitoring but no trades were executed
- Log samples from 01:45 - 02:00 UTC show all signals rejected

## Regime Detection: Correct

BTC was below SMA200 (1h) -> **BEAR REGIME** detected correctly.
Strategy routed to SHORT entry logic only. This is working as intended.

## Rejection Analysis

### Rejection 1: `bullish_candle` (majority of signals)

The **first check** in SHORT logic (`momentumSimple.ts:2049`) requires a bearish candle (close < open).

During this slow grind down, most individual 15m candles were actually **green** (small bounces within the downtrend):

| Time (UTC) | Symbol | Candle Change | Result |
|------------|--------|--------------|--------|
| 01:45 | DOGE | +0.26% green | bullish_candle |
| 01:45 | AVAX | +0.34% green | bullish_candle |
| 01:45 | FET | +0.32% green | bullish_candle |
| 01:45 | TIA | +0.32% green | bullish_candle |
| 01:45 | WIF | +0.37% green | bullish_candle |
| 01:45 | DOT | +0.31% green | bullish_candle |
| 01:45 | IMX | +0.65% green | bullish_candle |
| 02:00 | STX | +0.04% green | bullish_candle |
| 02:00 | ADA | 0.00% red | bullish_candle |
| 02:00 | FET | +0.06% green | bullish_candle |

### Rejection 2: `roc5_not_low_enough` (when candle was bearish)

When candles were actually red, they hit the second gate:
- **Required:** ROC5 <= -1.5% (ROC_DROP_MIN = -0.015)
- **Actual:** ROC values were positive or barely negative

| Time (UTC) | Symbol | ROC10 (logged) | Result |
|------------|--------|---------------|--------|
| 01:45 | STX | 0.7% | roc5_not_low_enough |
| 02:00 | AVAX | 0.7% | roc5_not_low_enough |
| 02:00 | DOGE | 0.3% | roc5_not_low_enough |
| 02:00 | BTC | 0.5% | roc5_not_low_enough |
| 02:00 | TIA | 0.3% | roc5_not_low_enough |

### Even Volume Would Have Failed

Volume ratios observed: 0.4x - 0.9x average.
SHORT requires **2.0x** (VOL_SPIKE). No volume spike present.

## Why the Strategy Missed This Move

The SHORT entry conditions require a **high-conviction breakdown**:
1. Bearish candle (close < open)
2. Strong 5-candle momentum (ROC5 <= -1.5%)
3. Volume spike (>= 2.0x average)
4. Price below BB lower band
5. Price below MA20

The BTC 69k->66k drop was a **slow grind** with these characteristics:
- Low volume (Asian session / late night)
- Frequent small green candles (bounces within the trend)
- No single 75-minute window showed -1.5% momentum
- No panic selling or volume spikes

## Assessment: By Design, But a Coverage Gap

### By Design
The strict SHORT filters exist for good reasons:
- V5.9 StochRSI filter: removed 848 losing trades, +368% equity
- V5.36 MTF filter: +13.5pp WR improvement, 100% filter accuracy
- V5.78 pattern filters: 45% fewer trades but +250% avg PnL/trade

### The Gap
The strategy only captures **"panic dump" shorts** - sharp breakdowns with volume confirmation.
It has **no pattern** for **"slow grind" shorts** - gradual multi-hour declines without any single candle showing extreme momentum or volume.

This is a legitimate missed opportunity of ~4.3% on BTC (and likely more on alts).

## Potential Improvements (Requires Backtesting)

1. **Cumulative ROC pattern**: Look at total decline over 10-20 candles rather than requiring -1.5% in any 5-candle window
2. **Reduced volume threshold**: Lower VOL_SPIKE for slow grinds when cumulative decline is significant
3. **Multi-candle trend detection**: Detect series of lower highs/lower lows over multiple candles without requiring individual candle extremes
4. **Relaxed bearish candle requirement**: When overall multi-timeframe alignment is strongly bearish, allow entry even on small green candles

**Caution**: Any loosening of SHORT filters must be validated via backtesting to ensure it doesn't re-introduce the false signals the current strict conditions were designed to eliminate.
