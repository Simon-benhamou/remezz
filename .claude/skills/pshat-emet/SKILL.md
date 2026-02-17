---
name: pshat-emet
description: Use when working on data pipeline, candle fetching, WebSocket subscriptions, caching, timestamp alignment, candle aggregation, or local JSON stores. Also use when debugging data discrepancies between live and backtest, investigating look-ahead bias, or validating isFinal flag handling.
---

# Pshat-Emet (The Literal Truth)

**There is only one truth. Data must be factual, validated, and simple. No interpretation, no assumption.**

Pshat is the foundation. If the data is wrong, every layer above it (Remez, Drash, Sod) is built on sand. Before you interpret (Remez), decide (Drash), or verify unity (Sod), you must ensure the data is TRUE.

## When to Use

- Modifying candle fetching (`fetchCandles`, `fetchBtcCandles`, `fetchBtcCandles1h`)
- Changing WebSocket subscriptions or `isFinal` handling
- Working on `globalCacheManager`, cache TTLs, or dedup logic
- Modifying `aggregate15mCandles()` or candle aggregation
- Changing local JSON store (`localOhlcvJsonStore.ts`)
- Working on API fallback (`fetchCandlesFromCcxt`)
- Debugging why live and backtest see different candle data
- Adding new data sources or timeframes

## The Pshat Questions

Before ANY data change, answer each:

| Question | What it catches |
|----------|----------------|
| Is this candle CLOSED (`isFinal: true`)? | Using forming candles as truth |
| Is there look-ahead bias? Am I using data from the future? | BTC candle at index `btcIdx` vs `btcIdx-1` |
| Given the same input, does this always produce the same output? | Non-deterministic data access |
| Are timestamps aligned? Does symbol time match BTC time? | Cross-symbol timing drift |
| Are there gaps? What happens if a candle is missing? | Silent data holes |
| Is any interpretation mixed in here? | Interpretation belongs to Remez |

## Critical Data Invariants

```
CANDLE LAW: Only CLOSED candles are truth. A forming candle is opinion.

TIMESTAMP LAW: Candle at timestamp T represents the period [T, T+interval).
  Its close price is known only AFTER T+interval.

LOOK-AHEAD LAW: At time T, you may only use data with timestamp < T.
  The BTC candle at btcIdx has timestamp T -- it is FORMING.
  Use btcCandles.slice(0, btcIdx), never btcCandles.slice(0, btcIdx+1).

CACHE LAW: A cache hit must return the same data as a fresh fetch would.
  If isFinal status can change, the cache must respect TTL.
```

## Key Files and Their Pshat Responsibilities

| File | Pshat concern |
|------|--------------|
| `simpleAgent.ts:2618-2813` | `fetchCandles`, `fetchBtcCandles`, `fetchBtcCandles1h` -- WS data with isFinal |
| `backtestService.ts:1098-1129` | `fetchCandles` -- local JSON + API hybrid merge |
| `backtestService.ts:93-119` | `aggregate15mCandles` -- bucket alignment, OHLCV merge |
| `backtestService.ts:1514-1528` | Regime cursor -- monotonic advance, no look-ahead |
| `backtestService.ts:1569-1583` | Symbol cursor -- closed candle only (timestamp < btcCandle) |
| `backtest/localOhlcvJsonStore.ts` | LRU cache, file parsing, `sliceCandlesByTime`, `mergeDedupCandles` |
| `cacheManager.ts` | `globalCacheManager` -- TTL, mutex, `minFinalCandles` |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using `btcCandles.slice(0, btcIdx+1)` | Exclude current: `slice(0, btcIdx)` (V5.94 fix) |
| Assuming WS 1h candle is final at hour boundary | Check `isFinal` flag; cache TTL can show stale data |
| Aggregating without aligning to bucket boundaries | `Math.floor(c.timestamp / targetMs) * targetMs` |
| Missing 200-bar warmup for SMA200 | `startIdx = Math.max(startIdx, 200)` |
| Using REST and WS data interchangeably | WS authoritative (Binance). REST only for warmup/fallback |
| `.filter()` on large arrays per loop iteration | Use monotonic cursor for O(1) (V5.102 regimeCursor) |

## The Pshat Test

After your change, verify:

1. **Determinism**: Run the same backtest twice with identical params. Results must match exactly.
2. **No look-ahead**: At candle index N, no data from index > N is accessible.
3. **Alignment**: BTC candle timestamp and symbol candle timestamp reference the same moment.
4. **Completeness**: No gaps in the candle series. `mergeDedupCandles` handles overlaps.
