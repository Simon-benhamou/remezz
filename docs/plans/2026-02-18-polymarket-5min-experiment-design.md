# Polymarket 5-Min Prediction Experiment

**Date**: 2026-02-18
**Status**: Design approved
**Goal**: Validate whether micro-structure indicators can predict 5-min BTC direction with enough edge to profit on Polymarket

## Architecture

Service within existing backend, using Prisma/Postgres and Binance WS.

```
backend/src/
├── services/
│   └── polymarket/
│       ├── polymarketWorker.ts      # Background loop (1 cycle per 5min window)
│       ├── polymarketClient.ts      # Gamma API client (fetch markets, odds)
│       ├── fiveMinScorer.ts         # Custom 5-min scoring system
│       └── polymarketTypes.ts       # Types
├── routes/
│   └── polymarket.ts               # REST API for frontend
frontend/src/
├── pages/
│   └── PolymarketPage.tsx           # Dashboard page
```

## Worker Flow (per 5-min cycle)

```
T+0:00  New 5-min window starts on Polymarket
        Worker records startPrice from Binance WS

T+0:00
 to     Accumulate 1m candle data (volume, OHLC, wicks)
T+2:30

T+2:30  DECISION POINT:
        1. Compute 5-min score on ~2-3 closed 1m candles + running candle
        2. Fetch current Polymarket odds via Gamma API
        3. Make prediction (UP/DOWN) if confidence >= 60
        4. Simulate share purchase at current odds
           e.g., UP share at $0.52 entry

T+5:00  RESOLUTION:
        1. Check final BTC price from Binance
        2. Result: UP if finalPrice >= startPrice, DOWN otherwise
        3. Calculate simulated P&L:
           - Win:  profit = (1.00 - entryPrice) per share
           - Loss: loss   = -entryPrice per share
        4. Persist to DB
```

## Scoring System (100 points)

Direction determined by sign of micro-ROC. Score determines confidence only.

| # | Component | Points | Logic | Rationale |
|---|-----------|--------|-------|-----------|
| 1 | Volume Spike | 0-25 | Avg volume of window 1m candles vs 20-candle avg. >=2x=25, >=1.5x=15 | Volume spike mid-window indicates directional pressure that tends to continue |
| 2 | Micro-ROC | 0-20 | ROC from window open to current price. >=0.15%=20, >=0.08%=12 | Inertia favors continuation over 2.5min |
| 3 | Body Ratio | 0-15 | Avg body/range ratio of window candles. >=0.7=15, >=0.5=10 | Large bodies = conviction, not noise |
| 4 | Wick Rejection | -15 to +15 | Wicks opposite to move direction. Large opposing wick >=40% range = -15, no wick = +15 | Rejection wicks are the best micro reversal predictor |
| 5 | Candle Alignment | 0-15 | All window 1m candles in same direction? 3/3=15, 2/3=10 | Alignment = coherent momentum |
| 6 | Pre-window Momentum | -10 to +10 | ROC of 5 candles 1m BEFORE window. Aligned=+10, Counter=-10 | Pre-existing trend tends to continue |

**Thresholds:**
- Score >= 60 → strong conviction → PREDICT (direction from micro-ROC sign)
- Score 40-59 → weak conviction → SKIP
- Score < 40 → noise → SKIP

## Database Schema

Table `polymarket_predictions` (Prisma):

```prisma
model PolymarketPrediction {
  id              Int      @id @default(autoincrement())
  createdAt       DateTime @default(now())
  symbol          String   @default("BTC")
  windowStart     DateTime
  windowEnd       DateTime
  startPrice      Float
  endPrice        Float?
  prediction      String?  // "UP" | "DOWN" | null (skip)
  confidence      Int?     // 0-100
  actualResult    String?  // "UP" | "DOWN"
  entryOdds       Float?   // price paid for share (0-1)
  simulatedPnl    Float?   // +/- USDC
  scoreBreakdown  Json?    // { volumeSpike: 25, microRoc: 20, ... }
  isCorrect       Boolean?
  skipped         Boolean  @default(false)
  polymarketSlug  String?
}
```

## Polymarket API Integration

- Base URL: `https://gamma-api.polymarket.com`
- Slug format: `btc-updown-5m-{unix_timestamp}` where timestamp = `Math.floor(now / 300) * 300`
- Fetch event: `GET /events?slug={slug}`
- Extract: `outcomePrices` array for current UP/DOWN share prices
- No authentication needed (public read API)

## Frontend Dashboard

Page at `/polymarket` route.

### Components:
1. **3 KPI Cards**: Win rate (W/L), Cumulative simulated P&L, Trade ratio (trades/total windows)
2. **Live Window Widget**: Current window timer, startPrice, currentPrice, score, prediction, potential P&L, progress bar
3. **Mini 1m Chart**: Candlestick chart of current window with horizontal startPrice line
4. **History Table**: Last 50 predictions with window time, prediction, actual result, score, entry odds, P&L

### Data flow:
- Frontend polls `GET /api/polymarket/status` every 5 seconds for live window state
- Frontend fetches `GET /api/polymarket/history?limit=50` for table
- Frontend fetches `GET /api/polymarket/stats` for KPIs

## Key Design Decisions

1. **Decision at T+2.5min**: Balance between having enough 1m data (2-3 closed candles) and entering early enough to capture value (odds near 0.50 = max profit potential)
2. **Scoring custom vs reusing NFS/Exhaustion**: NFS requires a trailing stop context, Exhaustion requires established momentum. Neither maps cleanly to 5-min prediction. Custom scorer borrows the best components.
3. **Simulation only**: No real Polymarket trading. Record entry odds and compute theoretical P&L.
4. **Single asset (BTC)**: Start with BTC only. Can extend to ETH/SOL/XRP later.

## Success Criteria

- Run for at least 1 full trading day (100+ windows)
- Win rate > 55% would indicate a real edge
- Positive cumulative P&L after simulated spreads
- If win rate < 52% after 200+ predictions → approach is likely not viable

## Sources

- [Polymarket 5-Min Crypto Markets](https://polymarket.com/crypto/5M)
- [Polymarket Gamma API Docs](https://docs.polymarket.com/developers/gamma-markets-api/fetch-markets-guide)
- [Slug format for timed markets](https://github.com/Polymarket/py-clob-client/issues/244)
