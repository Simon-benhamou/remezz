# Polymarket Confidence-Tiered Pricing Design

**Date**: 2026-02-22
**Problem**: 76.5% prediction WR but only 41% execution rate (7/17 traded). 10 missed predictions had 90% WR — scorer is excellent, MAX_CLOB_PRICE=0.55 is too restrictive.

## Data-Driven Analysis (3-day DB sample)

| Metric | Value |
|--------|-------|
| Windows observed | 151 |
| Predictions (score >= 40) | 17 (11.3%) |
| Traded | 7 (41.2% of predictions) |
| Traded WR | 57.1% (4W/3L) |
| Missed WR | 90.0% (9W/1L) |
| Overall prediction WR | 76.5% (13W/4L) |
| Avg exec price (traded) | 0.58 |
| Avg Gamma odds (missed) | 0.497 |

Key finding: Missed predictions had Gamma odds ~0.50 (market uncertain) but CLOB ask already > 0.55 at T+1:00. Observation phase (dip hunting T+1:00 to T+4:00) has 70% failure rate.

## EV Analysis (76.5% WR)

| Entry Price | EV per $1 | Breakeven WR |
|-------------|-----------|-------------|
| 0.55 | +$0.39 | 55% |
| 0.58 | +$0.32 | 58% |
| 0.63 | +$0.21 | 63% |
| 0.68 | +$0.11 | 68% |
| 0.765 | $0.00 | 76.5% |

## Design

### 1. Confidence-Tiered Pricing

Replace single `MAX_CLOB_PRICE = 0.55` with dynamic tiers:

| Score | Max CLOB Price | Rationale |
|-------|---------------|-----------|
| 40-49 | 0.58 | Weak signal — conservative cap |
| 50-59 | 0.63 | Solid signal — moderate cap |
| 60+ | 0.68 | Strong signal — premium cap |

### 2. Simplified Entry Flow

Remove observation phase. Replace with:

1. T+1:00: Scorer runs → score + direction
2. If score >= 40: fetch CLOB ask, compute `tierMax`
3. If CLOB ask <= tierMax: **immediate FOK** at CLOB ask
4. If CLOB ask > tierMax: **GTC LIMIT** at tierMax (passive fill), cancel at T+4:00
5. No observation polling

### 3. Take-Profit Adjustment

- Old: TP when `executionPrice < 0.40`, sell at 2.5x
- New: TP when `executionPrice < 0.50`, sell at 2.0x

### 4. No Changes

- fiveMinScorer.ts (scoring unchanged)
- Hedge logic (still skipEvCheck=true at T+4:00)
- Oracle verification
- Pre-sell at T+4:00-T+4:55

## Files Impacted

| File | Changes |
|------|---------|
| polymarketTrader.ts | Replace MAX_CLOB_PRICE with getMaxPriceForScore(), update placePolymarketBet signature |
| polymarketWorker.ts | Remove observation phase (~100 lines), add GTC limit fallback, pass score to trader |
| polymarketTypes.ts | Add tier config types |

## Expected Impact

| Metric | Before | After |
|--------|--------|-------|
| Trade rate | 41% | 82-100% |
| Trades/day | 2-3 | 5-6 |
| Est. daily PnL ($5/trade) | $3-5 | $8-15 |
