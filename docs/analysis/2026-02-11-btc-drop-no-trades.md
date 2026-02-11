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

## Root Cause: WebSocket vs Historical Candle Data Discrepancy

**Important context**: V5.93 Low-Volume Demotion was added AFTER this trade.
The live at trade time had NO demotion. Yet the parity simulation (which runs
with current code INCLUDING demotion) still exits earlier. This rules out
NFS demotion as the cause and narrows the issue to **data differences**.

### What the parity simulation does

The parity tool (`parityVerificationServiceV2.ts:simulateExit()`) fetches
**historical candles from Binance REST API** and simulates exit forward from
the recorded entry. It does NOT replay WebSocket data from trade time.

This means:
- **Parity/Backtest**: Uses finalized historical REST candle data (high/low/volume/close)
- **Live at trade time**: Used real-time WebSocket kline data

### Three possible causes (in priority order):

**1. Candle high/low differ between WebSocket (live) and REST API (backtest)**

For the trailing stop breach check (`momentumSimple.ts:2674`):
```
wickBreached = effectiveHigh >= trailingStopPrice  // SHORT
closeBreached = currentPrice >= trailingStopPrice
```
Both conditions must pass. If the candle's HIGH as seen live (WebSocket) was
slightly lower than the finalized HIGH in REST API, the wick breach wouldn't
trigger in live but would in backtest.

Binance can adjust candle extremes (high/low) after the candle closes - late
trades or aggregation corrections. WebSocket klines are built incrementally
from tick data; REST historical candles are the finalized version.

**2. Volume difference affecting NFS score**

NFS score has volume as 20% of its weight. If the breach candle's volume
differed between live (WebSocket) and backtest (REST):
- Volume component alone can swing the NFS score by 10-20 points
- If score drops from 75 to 62 → HIGH becomes MEDIUM
- MEDIUM requires 1-candle confirmation → adds 1+ candles delay
- If the next candle's close recovers below the trailing stop → counter resets
- Fresh breach needed → adds another 1-2 candles

**3. LowWaterMark tracking difference from candle data**

For SHORT: `trailingStop = lowWaterMark * (1 + distance%)`

If a prior candle's LOW was lower in WebSocket (real-time) than in REST (historical):
- Live lowWaterMark would be LOWER → trailing stop would be LOWER
- Price needs to rise MORE to breach the live's trailing stop
- Could delay breach detection by 1-2 candles

### The likely cascade:

```
Candle 15:45-16:00 (breach candle):
  Parity (REST data):    HIGH >= trailingStop? YES → closeBreached? YES → NFS HIGH → EXIT
  Live (WebSocket data): HIGH >= trailingStop? NO (slightly lower high) → no breach detected

Candle 16:00-16:15:
  Live: Still no breach (or wick-only breach, close recovers → reset)

Candle 16:15-16:30:
  Live: Price rises further → breach confirmed → NFS HIGH → EXIT at 16:30
```

## Is This a Bug?

**Not a logic bug** - the code paths are correctly aligned and use the same functions.
It's a **data source discrepancy**: WebSocket kline data during the trade differed
from finalized REST API historical data used by the parity simulation.

This is an inherent limitation of comparing a live WebSocket-driven system against
a backtest/parity simulation that uses historical REST data. The code at
backtestService.ts:750-753 acknowledges the timing difference:
```
// NOTE: Backtest uses EXIT_TRAIL_NFS_HIGH (immediate per-candle evaluation).
// Live 15m layer uses EXIT_TRAIL_NFS_HIGH_15M (deferred to 15m close per V5.90).
// The _15M suffix distinguishes the deferral path - same scoring logic,
// different timing. This is intentional, not a parity bug.
```

But the comment attributes it to architectural timing when the real issue may be
**different candle data between live and backtest**.

## Impact Assessment

- **Frequency**: Occurs whenever candle extremes (high/low) or volume differ between
  WebSocket and REST API at a moment when the trailing stop is near the price
- **PnL cost**: In this case, 2.66% lost profit due to 30-minute delayed exit
- **For SHORT**: Price bounced up between 16:00 and 16:30, reducing profit from 5.65% to 2.99%

## Recommended Actions

### Immediate diagnostics

1. **Was proactive LIMIT (V5.87) active for this trade?**
   If yes → why didn't it fill at the trailing stop price?
   If no → this is expected behavior for the 15m exit layer

2. **Add candle data comparison logging**: When the 15m exit check runs, log
   the candle high/low/volume alongside what the REST API returns for the same
   candle. This will confirm if data discrepancy is the cause.

3. **Log NFS score components on breach**: Both live and parity should log
   the exact NFS components (breachATR, breachDepth, volume, bodyRatio, momentum)
   so divergence can be pinpointed.

### Structural improvements

4. **NFS hysteresis band**: Instead of hard threshold at 70, use a band (68-72).
   If score is in the band AND trailing is breached, default to HIGH.
   This reduces sensitivity at the boundary.

5. **Parity verification with WebSocket data**: Store the raw WebSocket candle
   data used at trade time and replay it in parity verification instead of
   fetching from REST API. This would make parity comparisons truly apples-to-apples.

6. **Volume data stabilization**: Fetch candle data 2-3 seconds after close
   (instead of immediately) to allow Binance to finalize the volume.
   Trade-off: adds 2-3s latency to ALL exits.
