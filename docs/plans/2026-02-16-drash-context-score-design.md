# Drash Context Score Design
## V5.99: Signal Context Scoring System

**Date**: 2026-02-16
**Status**: Design approved, pending implementation
**Goal**: Add contextual awareness to signal ranking without reducing trade count

---

## Problem Statement

V5.96 proved S/R has real signal value (SHORT near resistance: 82% WR vs 62% far away), but implementing it as a binary filter destroyed ROI (-361%) by removing 16% of trades. The compounding loss from fewer trades outweighed the quality improvement.

The strategy lacks contextual awareness:
- No S/R proximity information at entry time
- No breakout quality assessment (small breakouts near S/R bounce to SL)
- No market-wide correlation detection (herd moves vs isolated opportunities)
- Parity test shows trades like `bull_regime:bearish_candle` near support that would benefit from context

## Solution: Modular Context Score

Add a **contextScore** to the existing `calculateSignalScore()` function. The score is composed of independently-toggleable factors that adjust signal ranking without blocking trades.

### Key Principles

1. **Score, don't filter**: Context adjusts ranking, never blocks entries
2. **Neutral = 0 impact**: Missing S/R data means no penalty, not a disadvantage
3. **Modular factors**: Each factor has its own ENABLED toggle and weight
4. **Backtest-validated**: Train/test split (Jun 2024 - Jun 2025 train, Jul - Dec 2025 test)
5. **Parity-safe**: All computation uses data available in both backtest and live

---

## Architecture

### Config Structure

```typescript
// In MomentumConfig (momentumSimple.ts)
DRASH_CONTEXT: {
  ENABLED: true,
  WEIGHT_IN_SIGNAL_SCORE: 0.20,  // Context factor weight in total calculateSignalScore

  FACTORS: {
    SR_PROXIMITY: {
      ENABLED: true,
      WEIGHT: 0.40,               // Weight within context score
      LOOKBACK_CANDLES: 200,       // How far back to scan for pivots
      PIVOT_LOOKBACK: 5,           // Candles each side for local extrema
      MIN_TOUCHES: 2,              // Minimum touches to consider level valid
      CLUSTER_PCT: 0.3,            // % tolerance for merging nearby levels
      NEAR_THRESHOLD_PCT: 1.5,     // "Near" S/R = within 1.5%
      FAR_THRESHOLD_PCT: 5.0,      // "Far" from S/R = beyond 5%
    },
    BREAKOUT_QUALITY: {
      ENABLED: true,
      WEIGHT: 0.35,
      STRONG_BREAKOUT_PCT: 1.5,    // Breakout distance > 1.5% = strong
      WEAK_BREAKOUT_PCT: 0.3,      // Breakout distance < 0.3% = weak
      STRONG_BODY_RATIO: 0.7,      // Body/range > 70% = conviction
      WEAK_BODY_RATIO: 0.3,        // Body/range < 30% = rejection wick
      VOL_CONFIRM_MULT: 2.0,       // Volume > 2x avg = confirmed
    },
    MARKET_CORRELATION: {
      ENABLED: true,
      WEIGHT: 0.25,
      ROC1_THRESHOLD_PCT: 0.5,     // Same-direction if |ROC1| > 0.5%
      HERD_THRESHOLD: 0.6,         // >60% same direction = herd move
      ISOLATED_THRESHOLD: 0.3,     // <30% same direction = isolated
      LOOKBACK_CANDLES: 2,         // How many candles back to check (30min)
    },
  }
}
```

### Data Flow

```
checkMomentumSignal()
  |
  v  (signal valid, side determined)
  |
  +---> calcContextScore(candles, price, side, allSymbolsROC)
  |       |
  |       +---> calcSRProximityScore(candles, price, side)      [if SR_PROXIMITY.ENABLED]
  |       +---> calcBreakoutQualityScore(candle, bb, side)      [if BREAKOUT_QUALITY.ENABLED]
  |       +---> calcMarketCorrelationScore(allROC, side)        [if MARKET_CORRELATION.ENABLED]
  |       |
  |       +---> weightedSum(enabledFactors) => contextScore [-1.0, +1.0]
  |
  v
calculateSignalScore({...existing, contextScore})
  |
  v
signalCandidates.sort(by score)
```

### New Function: `calcContextScore()`

```typescript
interface ContextScoreResult {
  score: number;              // Final weighted score [-1.0, +1.0]
  srScore: number | null;     // Individual factor score (null if disabled)
  breakoutScore: number | null;
  correlationScore: number | null;
  srDetail?: {                // For logging/analysis
    nearestSupport: number;
    nearestResistance: number;
    supportStrength: number;
    resistanceStrength: number;
    distToSupport: number;
    distToResistance: number;
  };
}

function calcContextScore(params: {
  candles: Candle[];           // Symbol's historical candles
  current: Candle;             // Current candle
  bb: { upper: number; lower: number; middle: number };
  side: 'long' | 'short';
  allSymbolsROC1: Map<string, number>;  // ROC1 for all tracked symbols
  currentSymbol: string;
}): ContextScoreResult
```

---

## Factor Implementations

### Factor 1: S/R Proximity Score

**Detection algorithm**:
1. Scan `candles` for pivot highs (local max with PIVOT_LOOKBACK candles lower on each side)
2. Scan for pivot lows (local min with PIVOT_LOOKBACK candles higher on each side)
3. Cluster pivots within CLUSTER_PCT of each other → S/R levels
4. Count touches per level (each pivot that merged = 1 touch)
5. Filter: only levels with touches >= MIN_TOUCHES
6. Find nearest support (below price) and nearest resistance (above price)

**Scoring**:

| Scenario | Score | Logic |
|----------|-------|-------|
| LONG, price within NEAR% above strong support | +1.0 | Buying at support = ideal |
| SHORT, price within NEAR% below strong resistance | +1.0 | Selling at resistance = ideal |
| LONG, price within NEAR% below strong resistance | -1.0 | Resistance overhead = bad |
| SHORT, price within NEAR% above strong support | -0.8 | Support below = bad |
| No strong S/R within FAR% | 0.0 | No data, no penalty |

Strength bonus: levels with 4+ touches get 1.2x score multiplier (capped at 1.0 absolute).

### Factor 2: Breakout Quality Score

**Components** (each -0.5 to +0.5, summed and clamped to [-1.0, +1.0]):

1. **Breakout distance**:
   - LONG: `dist = (close - bb.upper) / close`
   - SHORT: `dist = (bb.lower - close) / close`
   - `> STRONG_BREAKOUT_PCT%` → +0.5
   - `< WEAK_BREAKOUT_PCT%` → -0.5
   - Linear interpolation between

2. **Candle body conviction**:
   - `bodyRatio = abs(close - open) / (high - low)`
   - `> STRONG_BODY_RATIO` → +0.3
   - `< WEAK_BODY_RATIO` → -0.3

3. **Volume vs breakout proportion**:
   - Big breakout + high volume (>VOL_CONFIRM_MULT) → +0.2
   - Big breakout + low volume (<1.0x) → -0.3 (fake breakout)

### Factor 3: Market Correlation Score

**Algorithm**:
1. At signal time, compute ROC1 (1-candle change) for all tracked symbols
2. Count symbols with same-direction move > ROC1_THRESHOLD_PCT
3. `herdRatio = sameDirectionCount / totalSymbols`

**Scoring**:

| herdRatio | Score | Meaning |
|-----------|-------|---------|
| < ISOLATED_THRESHOLD | +0.5 | Isolated move = genuine signal |
| ISOLATED to HERD | 0.0 | Normal, neutral |
| > HERD_THRESHOLD | -0.5 | Everything moving together = herd, not edge |

---

## Backtest Integration

### In `backtestService.ts`

The backtest loop already iterates all symbols per BTC candle. To compute market correlation:

```typescript
// After collecting signalCandidates, compute ROC1 for all symbols
const allSymbolsROC1 = new Map<string, number>();
for (const symbol of symbols) {
  const sData = allData[symbol];
  const sIdx = symbolIdx[symbol];
  if (sIdx >= 2) {
    const prevClose = sData[sIdx - 1].close;
    const prevPrevClose = sData[sIdx - 2].close;
    allSymbolsROC1.set(symbol, (prevClose - prevPrevClose) / prevPrevClose);
  }
}

// Then for each candidate, compute context score
for (const candidate of signalCandidates) {
  candidate.contextScore = calcContextScore({
    candles: candidate.candles,
    current: candidate.current,
    bb: candidate.bb,  // Need to pass BB through
    side: candidate.signal.side,
    allSymbolsROC1,
    currentSymbol: candidate.symbol,
  });

  // Re-score with context
  candidate.score = calculateSignalScore({
    ...existingParams,
    contextScore: candidate.contextScore.score,
  });
}
```

### In live (`simpleAgent.ts`)

Same `calcContextScore()` called before `addSignal()` to the ranker. Market correlation computed from WebSocket ticker cache (all symbol prices available).

---

## Validation Plan

### Script: `scripts/compare-drash-context.ts`

Runs all 8 factor combinations:

| Run | SR | Breakout | Correlation | Description |
|-----|---|----------|-------------|-------------|
| 0 | OFF | OFF | OFF | Baseline (current V5.98) |
| 1 | ON | OFF | OFF | SR only |
| 2 | OFF | ON | OFF | Breakout quality only |
| 3 | OFF | OFF | ON | Market correlation only |
| 4 | ON | ON | OFF | SR + Breakout |
| 5 | ON | OFF | ON | SR + Correlation |
| 6 | OFF | ON | ON | Breakout + Correlation |
| 7 | ON | ON | ON | All 3 factors |

Each run reports: trades, WR, ROI, Sharpe, PF, max DD, avg PnL/trade.
Split into train (Jun 2024 - Jun 2025) and test (Jul - Dec 2025) periods.

### Sensitivity Analysis

For the winning combination, vary `WEIGHT_IN_SIGNAL_SCORE` across [0.10, 0.15, 0.20, 0.25, 0.30] to find optimal context weight.

### Success Criteria

- WR improvement >= +1pp on out-of-sample (test period)
- ROI not degraded vs baseline (no trade count destruction)
- Sharpe ratio improvement >= +0.10 on out-of-sample
- Both train and test periods improve (not just in-sample)

---

## Files to Create/Modify

### New files:
- `backend/src/strategies/contextScore.ts` — All 3 factor functions + `calcContextScore()`
- `backend/scripts/compare-drash-context.ts` — 8-combination comparison script
- `backend/test/unit/contextScore.test.ts` — Unit tests for each factor

### Modified files:
- `backend/src/strategies/momentumSimple.ts` — Add `DRASH_CONTEXT` config, call `calcContextScore()` at signal return
- `backend/src/strategies/signalRanker.ts` — Add `contextScore` param to `calculateSignalScore()`
- `backend/src/services/backtestService.ts` — Compute allSymbolsROC1, pass context score to ranking
- `backend/src/strategies/simpleAgent.ts` — Compute context score in live signal path

### Parity:
- `calcContextScore()` is a pure function called from shared signal path
- Both backtest and live use identical function with identical inputs
- No look-ahead: only uses closed candles and current price

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Overfitting S/R parameters | Train/test split + out-of-sample validation |
| Context score too weak to matter | Start at 20% weight, test up to 30% |
| Context score kills trade count | Score only, never filter — can't reduce trade count |
| S/R detection is slow | 200-candle pivot scan is O(n) — <1ms per symbol |
| Market correlation needs all symbols | Gracefully degrade: if <3 symbols available, skip factor (score = 0) |
| Complexity creep | Each factor is independently toggleable and removable |
