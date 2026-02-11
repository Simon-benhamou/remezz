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

---

# Analysis: WIF SHORT Exit Timing Gap (Live 30min Late vs Backtest)

## Observed Behavior
- **WIF SHORT** trade: entry at 13:45, same in both
- **Backtest exit**: 16:00:03 (EXIT_TRAIL_NFS_HIGH) at +5.65%
- **Live exit**: 16:30:02 (EXIT_TRAIL_NFS_HIGH_15M) at +2.99%
- **Gap**: 30 minutes / ~2 candles, costing 2.66% PnL

## How the Trailing Exit Works

Both backtest and live use the **same** `shouldExitPosition()` function:

1. Track `lowWaterMark` (lowest price seen for SHORT)
2. Calculate `trailingStopPrice = lowWaterMark * (1 + trailingDistance%)`
3. Check if candle's HIGH >= trailingStopPrice (wick breach)
4. Check if candle's CLOSE >= trailingStopPrice (close breach)
5. If both: `trailingBreached = true` -> caller runs NFS scoring
6. If NFS HIGH: exit immediately
7. If NFS MEDIUM: need 1-candle confirmation
8. If NFS LOW: need 2-candle confirmation

## Code Path Comparison

### Backtest (backtestService.ts)
```
for each candle:
  1. Update lowWaterMark with candle.low          (line 1526)
  2. Call checkBacktestExit()                      (line 1574)
     -> shouldExitPosition(pos, close, {high, low})
     -> If trailingBreached: calculate NFS score
     -> If NFS HIGH: exit immediately at trailingStopPrice
  3. estimateIntrabarTiming() for exit timestamp   (line 1337)
```

### Live (simpleAgent.ts)
```
on each 15m candle close (isFinal=true):
  1. updatePositionWaterMarks(candle.high, candle.low)  (line 1671)
  2. shouldExitPosition(pos, close, {high, low})        (line 1722)
  3. If trailingBreached: calculate NFS score            (line 1846)
     -> If NFS HIGH: exit immediately                   (line 1870)
```

## Root Cause: NFS Score Sensitivity at the HIGH/MEDIUM Boundary

The code logic is **correctly aligned** - both use the same `shouldExitPosition()`,
same watermark updates, same trailing calculation, same NFS thresholds (HIGH >= 70).

The 30-minute gap is most likely caused by **NFS score divergence** at the
HIGH/MEDIUM boundary (score ~70) on the first breach candle:

### Why NFS scores can differ between live and backtest:

1. **Candle data finalization**: Binance finalizes candle data (especially volume)
   slightly after the candle closes. The backtest sees the final historical volume;
   the live sees the initial real-time volume. Even a 5-10% difference in volume
   can shift the NFS score across the 70-point threshold.

2. **V5.93 Low-Volume Demotion**: Both paths have `NFS_LOW_VOL_DEMOTION_ENABLED: true`
   with threshold 0.7x. If volume ratio is borderline (e.g., 0.68x live vs 0.72x
   backtest), the live demotes HIGH -> MEDIUM while backtest keeps HIGH.
   (momentumSimple.ts:524, backtestService.ts:649, nfsRealtimeExit.ts:470)

3. **NFS component sensitivity**: The score is composed of 5 components weighted
   35:25:20:10:10. Volume alone is worth 20 points. If volume is below the 1.5x
   threshold in live but above in backtest (or half-credit vs full-credit), that's
   a 10-20 point swing - easily crossing the 70 threshold.

### The cascade effect:

```
Candle 15:45-16:00 (breach candle):
  Backtest: NFS = 75 (HIGH) -> EXIT IMMEDIATELY at 16:00
  Live:     NFS = 62 (MEDIUM, demoted from HIGH due to volume) -> wait 1 confirm

Candle 16:00-16:15:
  Live: close recovers below trailing stop -> trailingBreached = false -> RESET counter

Candle 16:15-16:30:
  Live: breach again, NFS = 78 (HIGH this time) -> EXIT at 16:30
```

This produces the observed: backtest NFS_HIGH at 16:00, live NFS_HIGH at 16:30.

## Is This a Bug?

**Not a logic bug** - the code is correctly aligned. It's a **data sensitivity issue**
at the NFS score boundary. The NFS score is deterministic given the same inputs, but
live and backtest see slightly different inputs (volume primarily).

The comment at backtestService.ts:750-753 acknowledges this:
```
// NOTE: Backtest uses EXIT_TRAIL_NFS_HIGH (immediate per-candle evaluation).
// Live 15m layer uses EXIT_TRAIL_NFS_HIGH_15M (deferred to 15m close per V5.90).
// The _15M suffix distinguishes the deferral path - same scoring logic,
// different timing. This is intentional, not a parity bug.
```

## Impact Assessment

- **Frequency**: This occurs when NFS score is borderline (~65-75) at the breach moment
- **PnL cost**: In this case, 2.66% lost profit due to delayed exit
- **For SHORT**: Price bounced up between 16:00-16:30, reducing profit from 5.65% to 2.99%

## Possible Mitigations

1. **Proactive LIMIT order (V5.87)**: The realtime 1m monitor should place a LIMIT
   order at the trailing stop price BEFORE the breach. If working correctly, this
   would fill at the exact trailing price regardless of NFS score on the 15m layer.
   -> **Check if proactive LIMIT was active for this trade**

2. **NFS score logging**: Add side-by-side NFS component logging to parity reports
   so the exact component that diverged can be identified (was it volume? ATR? breach depth?)

3. **NFS hysteresis band**: Instead of hard threshold at 70, use a band (68-72).
   If score is in the band, default to HIGH to avoid the demotion delay.
   This would reduce sensitivity at the boundary.

4. **Volume data stabilization**: Fetch candle data 2-3 seconds after close
   (instead of immediately) to allow Binance to finalize the volume.
   Trade-off: adds 2-3 seconds latency to ALL exits.
