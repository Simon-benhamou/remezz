# Signal Logging Table — Design Document

**Date**: 2026-03-04
**Goal**: Persist every valid signal (from `checkMomentumSignal`) with full feature snapshot, link to trade outcome when executed, and capture filter rejection reasons for non-executed signals.

## Scope

- **Live/paper only** — backtest does not write to this table
- **Valid signals only** — signals that pass `checkMomentumSignal()` (valid=true)
- **Post-signal filters captured** — toxic hour, capital, ranking, max positions, blacklist
- **Trade outcome linked** — `tradeId` FK when signal results in a trade

## Prisma Schema

```prisma
model Signal {
  id              String    @id @default(cuid())
  userId          String
  sessionId       String?
  symbol          String
  candleTs        DateTime  // Candle OPEN timestamp (15m boundary)

  // Signal result
  side            String    // 'long' | 'short'
  confidence      Float?    // 0-1 from checkMomentumSignal
  score           Float?    // 0-100 from signalRanker

  // Outcome
  status          String    // 'traded' | 'filtered_toxic_hour' | 'filtered_capital' | 'filtered_ranking' | 'filtered_max_positions' | 'filtered_blacklist'
  tradeId         String?   // FK -> Trade (null if filtered)

  // Timing context
  hour            Int       // UTC hour (0-23)
  dayOfWeek       Int       // UTC day (0-6)

  // BTC context
  btcRegime       String    // 'bull' | 'bear'
  btcPrice        Float
  btcSma200       Float
  btcDistSma200   Float     // % distance from SMA200
  btcAtr          Float     // BTC ATR (volatility filter value)
  btcRoc1h        Float     // BTC MTF momentum %

  // Symbol OHLCV (signal candle)
  candleOpen      Float
  candleHigh      Float
  candleLow       Float
  candleClose     Float
  candleVolume    Float

  // Core features (typed columns for SQL queries)
  roc10           Float     // ROC 10-period %
  roc5            Float     // ROC 5-period %
  roc1            Float     // Current candle ROC %
  volRatio        Float     // Volume vs 20-period avg
  bbUpper         Float     // Bollinger upper
  bbLower         Float     // Bollinger lower
  bbMa20          Float     // Middle band (MA20)
  consecUp        Int       // Consecutive up candles
  consecDown      Int       // Consecutive down candles
  stochRsi        Float?    // 0-100 (SHORT only)
  atr14           Float     // ATR 14-period raw
  atr14Pct        Float     // ATR as % of price
  adx             Float     // ADX trend strength
  greenRatio      Float     // % green candles in lookback
  alternation5    Int       // Choppiness 0-5
  bbTouches       Int       // BB touch count in last 10 candles
  rangePosition   Float     // 0-1 position in 20-candle range

  // Extensible extras (JSON)
  extras          Json?     // trendStrength, bbPosition, rocAcceleration, marketRegime, sma200Slope, etc.

  createdAt       DateTime  @default(now())

  // Relations
  user            User      @relation(fields: [userId], references: [id])
  trade           Trade?    @relation(fields: [tradeId], references: [id])

  @@index([userId, createdAt])
  @@index([symbol, candleTs])
  @@index([status])
  @@index([tradeId])
}
```

## Integration Architecture

### New file: `src/strategies/signalLogger.ts`

Single function `saveSignal()` that:
1. Receives signal result + candles + market conditions + status + optional tradeId
2. Computes additional features from candles (adx, greenRatio, alternation5, bbTouches, rangePosition)
3. Inserts into DB asynchronously (fire-and-forget, never blocks trading)
4. Catches errors silently (logging must never crash a trade)

```typescript
export async function saveSignal(params: {
  userId: string;
  sessionId?: string;
  symbol: string;
  signal: SignalResult;
  marketConditions: MarketConditions;
  candles: Candle[];
  btcCandles: Candle[];
  score?: number;
  status: SignalStatus;
  tradeId?: string;
}): Promise<void>
```

### Insertion points

#### 1. `positionOpener.ts` — pre-entry filter rejections

At each early return (blacklist, toxic hour, max positions, capital):
```typescript
saveSignal({ ...context, status: 'filtered_toxic_hour' });
return { position: null, ... };
```

#### 2. `positionOpener.ts` — successful trade

After trade creation (we have tradeId):
```typescript
saveSignal({ ...context, status: 'traded', tradeId: trade.id });
```

#### 3. `orchestrator.ts` — ranking rejection

When `getTopSignals()` does not select this symbol's signal:
```typescript
saveSignal({ ...context, status: 'filtered_ranking' });
```

### Trade outcome queries

Once signals are linked to trades, analysis is straightforward:

```sql
-- Signals that became losing trades: what features do they share?
SELECT s.roc10, s.volRatio, s.rangePosition, s.adx, t.realizedPnlUsd
FROM Signal s JOIN Trade t ON s.tradeId = t.id
WHERE t.realizedPnlUsd < 0
ORDER BY t.realizedPnlUsd ASC;

-- Filtered signals that WOULD have been winners (missed opportunities)
-- Requires backtest replay of filtered signals (future enhancement)

-- Feature distribution: losing vs winning trades
SELECT
  CASE WHEN t.realizedPnlUsd >= 0 THEN 'win' ELSE 'loss' END as outcome,
  AVG(s.roc10), AVG(s.volRatio), AVG(s.adx), AVG(s.rangePosition)
FROM Signal s JOIN Trade t ON s.tradeId = t.id
GROUP BY outcome;

-- Toxic hour analysis: are we correctly filtering?
SELECT s.hour, COUNT(*) as filtered,
  (SELECT COUNT(*) FROM Signal s2 WHERE s2.hour = s.hour AND s2.status = 'traded') as traded
FROM Signal s WHERE s.status = 'filtered_toxic_hour'
GROUP BY s.hour;
```

## Data Volume Estimate

- ~9 symbols × ~1-3 valid signals/day each = ~10-27 signals/day
- ~30 columns × ~200 bytes = ~6KB per row
- ~10K signals/year = ~60MB/year (negligible)

## Non-goals

- No backtest signal logging (keep BT fast)
- No rejected signal logging (invalid signals from checkMomentumSignal — too noisy)
- No real-time dashboard for signals (analysis is offline/ad-hoc)
- No automatic filter tuning based on signal data (future ML enhancement)
