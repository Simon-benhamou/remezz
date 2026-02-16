# Drash & Sod Implementation Plan
## S/R Framework Levels 3-4 for Remezz Strategy

### Framework Overview (PaRDeS)

| Level | Name | Status | Description |
|-------|------|--------|-------------|
| 1 | **Peshat** (Simple) | DONE V5.96 | Basic S/R proximity filter - pivot-based support/resistance detection |
| 2 | **Remez** (Hint) | DONE V5.96 | Multi-touch S/R + volume confirmation + cluster merging |
| 3 | **Drash** (Investigation) | PLANNED | Dynamic zones, breakout/bounce classification, trend-aware S/R |
| 4 | **Sod** (Secret) | PLANNED | Multi-TF confluence, institutional levels, order flow integration |

---

## Current V5.96 Backtest Results (Peshat + Remez)

### S/R Filter Impact (18-month backtest, 10 symbols, Jun 2024 - Dec 2025)

| Metric | Baseline | V5.96 (S/R) | Delta |
|--------|----------|-------------|-------|
| Trades | 776 | 653 | -123 (-15.9%) |
| Win Rate | 62.9% | 63.9% | **+1.0pp** |
| Sharpe Ratio | 3.11 | 3.30 | **+0.19** |
| Profit Factor | 1.48 | 1.53 | **+0.05** |
| ROI | 1571% | 1210% | -361% |
| Max DD | 25.4% | 33.3% | +7.9% |
| Final Capital | $33,422 | $26,197 | -$7,225 |

### Direction Breakdown

| Direction | Baseline Trades | V5.96 Trades | Filtered | Baseline WR | V5.96 WR | Delta |
|-----------|----------------|--------------|----------|-------------|----------|-------|
| LONG | 318 | 298 | -20 | 64.2% | 64.8% | +0.6pp |
| SHORT | 458 | 355 | -103 | 62.0% | 63.1% | +1.1pp |

### Per-Trade Quality

| Metric | Baseline | V5.96 |
|--------|----------|-------|
| Avg PnL/trade (ALL) | +2.025% | +1.853% |
| Avg PnL/trade (LONG) | +1.554% | +1.766% |
| Avg PnL/trade (SHORT) | +1.481% | +1.186% |

### Key Insights

1. **SHORT filter is too aggressive:** 103 SHORT trades filtered, but LONG per-trade quality improved (+0.21% avg PnL) while SHORT per-trade quality actually decreased (-0.30%). The filter removes too many good SHORT trades.
2. **LONG filter is precise:** Only 20 LONG trades filtered, WR improved, and avg PnL/trade improved by +0.21%. LONG filter is well-calibrated.
3. **Thresholds need recalibration:** The SHORT `MAX_SR_RATIO: 0.5` and `MAX_DIST_RESISTANCE_PCT: 5.0` are too tight. Drash D5 should loosen them.
4. **Max DD worsened:** From 25.4% to 33.3% - fewer trades = less diversification = bigger drawdowns. Needs attention.
5. **Quality vs quantity trade-off:** Better Sharpe (+0.19) and PF (+0.05) confirm per-trade quality is higher, but fewer trades means compounding works against us on ROI.

### Signal-Level Analysis (1,774 signals from offline analysis)

| Context | Win Rate | Avg PnL | Profit Factor |
|---------|----------|---------|---------------|
| SHORT near resistance (<1.5%) | 82% | +0.90% | 3.14 |
| SHORT far from resistance (>5%) | 62% | +0.10% | 1.10 |
| LONG near resistance (ratio <0.2) | 53% | -0.47% | < 1.0 |
| LONG away from resistance (ratio >0.2) | 67% | +0.25% | > 1.5 |

---

## DRASH Level (Investigation) - V5.97-V5.99

### D1: Dynamic Zone Width (V5.97)
**Problem:** Current S/R uses fixed pivot points = single price line. Real S/R is a **zone**.
**Solution:** Calculate zone width based on ATR and touch density.

**Implementation:**
- File: `momentumSimple.ts` - extend `calcSRProximity()`
- New function: `calcSRZone(pivotPrice, candles, atrPeriod) => { center, upper, lower, width }`
- Zone width = `max(ATR * 0.5, cluster_spread)` where cluster_spread = max - min of merged pivots
- **Entry logic change:**
  - LONG: Enter when price is **inside** support zone (not just "below resistance")
  - SHORT: Enter when price is **inside** resistance zone (touching it, not just "near")
- **Expected impact:** Reduces false signals from being "near" but not "at" the zone

**Backtest validation:**
- Run on same 1,774 signals with zone detection
- Compare zone-aware WR vs simple proximity WR
- Target: +2-3pp WR improvement for both LONG and SHORT

**Files to modify:**
- `backend/src/strategies/momentumSimple.ts` - new `calcSRZone()` function, update filter logic
- `backend/scripts/analyze-sr-proximity.ts` - add zone analysis

---

### D2: Breakout vs Bounce Classification (V5.97)
**Problem:** After BB breakout, price either **continues** (true breakout) or **reverses** (bounce off S/R). Current filter doesn't distinguish.
**Solution:** Classify whether the signal is a breakout through S/R or a bounce off S/R.

**Implementation:**
- Detect if price is **approaching** S/R from below (potential breakout) vs **at** S/R and failing (bounce)
- **Breakout signal:** Price closes above resistance zone + volume > 1.5x avg + ROC accelerating
  - LONG: This is a breakout = good entry (confirmed break of overhead resistance)
  - SHORT: Skip this - don't short into a breakout
- **Bounce signal:** Price touches resistance zone but fails to close above + wick rejection
  - SHORT: This is a rejection = great entry
  - LONG: Skip this - price is being rejected at resistance

**New fields in signal result:**
```typescript
srClassification: 'breakout' | 'bounce' | 'neutral'
srConfidence: number  // 0-100
```

**Entry rules:**
- LONG: Allow breakout (+ vol confirm), skip bounce
- SHORT: Allow bounce (rejection at resistance), skip breakout

**Expected impact:** +3-5pp WR by only taking signals aligned with S/R interaction type

**Files to modify:**
- `backend/src/strategies/momentumSimple.ts` - new `classifyBreakoutBounce()` function
- Signal return object extended with classification

---

### D3: Trend-Aware S/R Weighting (V5.98)
**Problem:** S/R levels in a strong trend behave differently. In uptrend, support is strong (holds), resistance is weak (breaks). Current filter treats all S/R equally.
**Solution:** Weight S/R reliability by trend strength (ADX + direction).

**Implementation:**
- Use existing ADX (14-period, already computed in backtest)
- **In uptrend (ADX > 25, price > SMA50):**
  - Support levels: weight 1.5x (strong, reliable)
  - Resistance levels: weight 0.5x (likely to break)
  - LONG filter relaxed (resistance less meaningful)
  - SHORT filter tightened (resistance likely to be broken)
- **In downtrend (ADX > 25, price < SMA50):**
  - Resistance levels: weight 1.5x (strong, reliable)
  - Support levels: weight 0.5x (likely to break)
  - SHORT filter relaxed (support less meaningful)
  - LONG filter tightened (support likely to break)
- **In range (ADX < 20):**
  - Both S/R levels weighted equally (current behavior)
  - Best environment for S/R-based trading

**New config:**
```typescript
TREND_AWARE_SR: {
  ENABLED: true,
  ADX_TREND_THRESHOLD: 25,     // ADX above this = trending
  ADX_RANGE_THRESHOLD: 20,     // ADX below this = ranging
  TREND_WEIGHT_STRONG: 1.5,    // Multiplier for S/R in trend direction
  TREND_WEIGHT_WEAK: 0.5,      // Multiplier for S/R against trend
}
```

**Expected impact:** +2pp WR in trending markets, reduces losses from fighting the trend

**Files to modify:**
- `backend/src/strategies/momentumSimple.ts` - modify S/R filter section
- Use ADX already available from `MomentumConfig.CANDLE_PATTERN_FILTER`

---

### D4: S/R Level Strength Scoring (V5.98)
**Problem:** Not all S/R levels are equal. A level touched 5 times is stronger than one touched once.
**Solution:** Score each S/R level by number of touches, recency, and volume at touch.

**Implementation:**
- When clustering pivot points, track:
  - `touchCount`: Number of pivot highs/lows that merged into this level
  - `lastTouchAge`: Candles since most recent touch (fresher = stronger)
  - `avgVolumeAtTouch`: Average volume when price touched this level
- **Level Strength Score:**
  ```
  strength = touchCount * 2.0
            + recencyBonus * 1.5   (1.0 if < 50 bars, 0.5 if < 100, 0.0 if > 100)
            + volumeBonus * 1.0     (1.0 if vol > 1.5x avg at touch, 0.5 if > 1.0x)
  ```
- **Filter adjustment:** Only consider S/R levels with strength > 2.0 (removes noise)

**Expected impact:** Better signal quality by focusing on proven, high-touch S/R levels

**Files to modify:**
- `backend/src/strategies/momentumSimple.ts` - extend `clusterSRLevels()` to return strength
- `calcSRProximity()` - use weighted nearest S/R

---

### D5: Loosen S/R Thresholds (V5.99 - Quick Win)
**Problem:** Current thresholds are too aggressive - filtering 15.9% of trades but some filtered trades are profitable (negative ROI impact of -361%).
**Solution:** Relax thresholds based on backtest data.

**Proposed changes:**
```typescript
SR_PROXIMITY_FILTER: {
  LONG_MIN_SR_RATIO: 0.15,     // Was 0.2 - only filter worst 10% instead of 20%
  SHORT_MAX_SR_RATIO: 0.6,     // Was 0.5 - allow slightly further from resistance
  SHORT_MAX_DIST_RESISTANCE_PCT: 7.0,  // Was 5.0 - widen to 7%
}
```

**Validation:** Grid search across thresholds to find optimal balance:
- `LONG_MIN_SR_RATIO`: test [0.10, 0.15, 0.20, 0.25]
- `SHORT_MAX_SR_RATIO`: test [0.4, 0.5, 0.6, 0.7]
- `SHORT_MAX_DIST_RESISTANCE_PCT`: test [3.0, 5.0, 7.0, 10.0]

**Expected impact:** Recover some filtered profitable trades while keeping quality improvement

---

## SOD Level (Secret) - V6.00-V6.05

### S1: Multi-Timeframe S/R Confluence (V6.00)
**Problem:** Only using 15m candles for S/R detection. A resistance level visible on 1h AND 4h is far more significant than one only on 15m.
**Solution:** Detect S/R on multiple timeframes and score confluence.

**Implementation:**
- Compute S/R levels on **3 timeframes**: 15m, 1h, 4h
- **Confluence scoring:**
  ```
  Single TF (15m only):          weight = 1.0
  Two TF confluence (15m + 1h):  weight = 2.5
  Triple TF (15m + 1h + 4h):    weight = 5.0
  ```
- Two levels "match" if they're within 0.5% of each other across timeframes
- **Entry boost:** Signals near triple-confluence S/R get +15 score in signalRanker
- **Entry block:** Skip entries near single-TF-only weak levels

**Data requirements:**
- 4h candle data needed - add to `localOhlcvJsonStore.ts`
- Download script for 4h candles
- Or derive from existing 1h candles (aggregate 4 consecutive 1h candles)

**New function:**
```typescript
function calcMultiTFSRConfluence(
  candles15m: Candle[],
  candles1h: Candle[],
  candles4h: Candle[],
  currentPrice: number
): {
  nearestSupport: { price: number, confluence: number, timeframes: string[] },
  nearestResistance: { price: number, confluence: number, timeframes: string[] },
  confluenceScore: number  // 0-100
}
```

**Files to modify:**
- `momentumSimple.ts` - new multi-TF S/R computation
- `backtestService.ts` - load 4h candles (or derive from 1h)
- `signalRanker.ts` - integrate confluence score

**Expected impact:** +3-5pp WR, significantly reduced false signals

---

### S2: Institutional Level Detection (V6.01)
**Problem:** Round numbers ($100K BTC, $200 SOL) and weekly/monthly pivots are institutional levels where large orders cluster.
**Solution:** Detect and integrate institutional-grade S/R levels.

**Implementation:**
1. **Round number levels:**
   - BTC: every $5,000 ($85K, $90K, $95K, $100K)
   - Altcoins: contextual (every $10 for $50-200 coins, every $1 for $5-50 coins)
   - Psychological levels: exact round numbers within 0.2% = strong S/R

2. **Weekly/Monthly pivots:**
   - Classic Pivot Points: P = (H + L + C) / 3
   - R1 = 2P - L, S1 = 2P - H
   - R2 = P + (H - L), S2 = P - (H - L)
   - Requires weekly/monthly high-low-close data

3. **Integration:**
   - Add institutional levels to S/R level list with high strength score
   - Round numbers get strength = 5.0 (equivalent to 5-touch level)
   - Weekly pivots get strength = 3.0
   - Monthly pivots get strength = 8.0

**Files to modify:**
- `momentumSimple.ts` - new `getInstitutionalLevels()` function
- Merge with existing pivot-based S/R in `calcSRProximity()`

**Expected impact:** Better alignment with where large orders actually sit

---

### S3: Funding Rate Signal Integration (V6.02)
**Problem:** `PerpetualMetrics` type exists but `getMarketContext()` returns null. Funding rate is one of the strongest predictive signals for crypto futures.
**Solution:** Connect Binance funding rate data to signal filtering.

**Implementation:**
1. **Data fetching:**
   - Binance endpoint: `GET /fapi/v1/fundingRate`
   - Fetch every 8h (funding rate update interval)
   - Cache in memory with 1h refresh

2. **Signal logic:**
   ```
   High positive funding (>0.05%):
     → Market overleveraged LONG → SHORT bias (contrarian)
     → Boost SHORT signal score by +10
     → Penalize LONG signal score by -5

   High negative funding (<-0.05%):
     → Market overleveraged SHORT → LONG bias (contrarian)
     → Boost LONG signal score by +10
     → Penalize SHORT signal score by -5

   Neutral funding (-0.01% to +0.01%):
     → No adjustment (balanced market)
   ```

3. **Integration points:**
   - `signalRanker.ts` - add funding rate component to score
   - `momentumSimple.ts` - optional filter (skip LONG when funding > 0.1%)
   - New service: `fundingRateService.ts`

**Backtest integration:**
- Historical funding rate data available from Binance
- Download and cache in `data/` folder for offline backtesting
- Script: `scripts/download-funding-rates.ts`

**Files to create:**
- `backend/src/services/fundingRateService.ts`
- `backend/scripts/download-funding-rates.ts`
- `backend/data/funding/` directory

**Expected impact:** +2-4pp WR based on published research on funding rate alpha

---

### S4: Open Interest Divergence (V6.03)
**Problem:** Price moving up while OI drops = short squeeze (unsustainable). Price moving up with OI rising = genuine buying. This distinction is critical.
**Solution:** Track OI changes and detect divergences with price.

**Implementation:**
1. **Data:** Binance `GET /fapi/v1/openInterest` + historical
2. **Divergence types:**
   ```
   BULLISH divergence: Price down + OI up → shorts accumulating → squeeze risk → LONG bias
   BEARISH divergence: Price up + OI down → longs closing → exhaustion → SHORT bias
   CONFIRMING: Price and OI moving same direction → trend is genuine
   ```
3. **Integration:** Add OI divergence as signal scoring component in signalRanker

**Expected impact:** +2-3pp WR, fewer trapped entries

---

### S5: Liquidation Cascade Detection (V6.04)
**Problem:** Liquidation cascades cause violent moves. Entering just before a cascade = great trade. Entering during one = disaster.
**Solution:** Detect potential liquidation clusters and adjust entry timing.

**Implementation:**
1. **Estimate liquidation prices:**
   - Long liquidation price = entry * (1 - 1/leverage)
   - At common leverages (5x, 10x, 20x), estimate where liquidation walls sit
   - E.g., BTC at $100K → 10x longs liquidate at ~$90K, 20x at ~$95K

2. **Cascade detection:**
   ```
   Large OI drop (>5% in 1h) + price move >2% = cascade in progress
   → DO NOT ENTER (wait for cascade to complete)
   → After cascade stabilizes (2-3 candles of low volatility), enter contrarian
   ```

3. **Integration:**
   - New filter in `checkMomentumSignal()`: skip entries during active cascades
   - Add cascade recovery as high-priority signal

---

### S6: Orderbook Imbalance Scoring (V6.05)
**Problem:** Large bid/ask imbalances predict short-term direction. A 3:1 bid/ask ratio = buying pressure.
**Solution:** Integrate orderbook depth snapshots into signal scoring.

**Implementation:**
1. **Use existing `depth.ts`** - already fetches orderbook
2. **Imbalance calculation:**
   ```
   bidVolume = sum of top 10 bid levels
   askVolume = sum of top 10 ask levels
   imbalance = (bidVolume - askVolume) / (bidVolume + askVolume)
   // Range: -1 (all asks) to +1 (all bids)
   ```
3. **Signal scoring:**
   - LONG: bonus if imbalance > +0.3 (strong bids)
   - SHORT: bonus if imbalance < -0.3 (strong asks)
   - Neutral if -0.1 to +0.1

**Backtest limitation:** No historical orderbook data → only usable in live trading
**Alternative for backtest:** Use volume at candle high/low as proxy

---

## Implementation Priority & Timeline

### Phase 1: Quick Wins (V5.97-V5.99)
1. **D5: Loosen thresholds** - 1 day - recover ROI without losing WR
2. **D4: S/R strength scoring** - 2 days - filter noise, keep strong levels
3. **D2: Breakout vs bounce** - 3 days - major WR improvement expected

### Phase 2: Advanced Drash (V5.98-V5.99)
4. **D1: Dynamic zone width** - 2 days - better zone detection
5. **D3: Trend-aware weighting** - 2 days - ADX already available

### Phase 3: Sod Foundation (V6.00-V6.02)
6. **S1: Multi-TF confluence** - 4 days - biggest expected impact
7. **S3: Funding rate** - 3 days - data type already defined, just needs connection
8. **S2: Institutional levels** - 2 days - round numbers + pivots

### Phase 4: Sod Advanced (V6.03-V6.05)
9. **S4: OI divergence** - 3 days - requires data pipeline
10. **S5: Liquidation cascades** - 3 days - requires OI data
11. **S6: Orderbook imbalance** - 2 days - live only (no backtest historical data)

---

## Parity Considerations

Each new feature MUST:
1. Be implemented in `checkMomentumSignal()` (shared function for backtest + live)
2. Use only data available at signal time (no look-ahead)
3. Have a `ENABLED: true/false` toggle in `MomentumConfig`
4. Be validated with the parity test (`scripts/test-parity-v2.ts`)
5. Have a comparison backtest script (like `scripts/compare-sr-filter.ts`)

**Current parity status:** V5.96 S/R filter IS covered by parity since it's inside `checkMomentumSignal()` which is imported by `parityVerificationServiceV2.ts`.

---

## Success Metrics

| Level | Target WR | Target Sharpe | Target PF | Target Max DD |
|-------|-----------|---------------|-----------|---------------|
| Current (V5.96) | 63.9% | 3.30 | 1.53 | < 25% |
| Drash (V5.99) | 67% | 3.50 | 1.70 | < 20% |
| Sod (V6.05) | 70% | 4.00 | 2.00 | < 15% |

---

## Risk Management

- **Overfitting risk:** Each new feature adds parameters. Use walk-forward validation.
- **Data snooping:** Don't optimize on the same data used for testing. Split Jun 2024-Jun 2025 (train) / Jul-Dec 2025 (test).
- **Complexity tax:** Each new feature adds latency and potential bugs. Keep features modular with kill switches.
- **Live vs backtest divergence:** More complex features = more parity risk. Test each feature with `test-parity-v2.ts` before deploying live.
