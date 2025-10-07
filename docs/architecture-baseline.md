# Trading Agent Data Pipeline – Baseline Discovery (2025-10-07)

## High-Level Flow (Current Behaviour)

```
Binance
 ├─ WebSocket (fstream.binance.com/stream, !ticker@arr + kline streams)
 │    ↳ backend/src/services/binanceWebSocket.ts
 │       • Manages single WS connection, caches mini-ticker frames keyed by `symbol`
 │       • No frame validation; bid/ask may be null
 │       • Limited reconnect metrics (console logs only)
 └─ REST (ccxt binance / binanceusdm fetchTicker/fetchOHLCV)
      ↳ backend/src/data/market.ts
         • `getTicker` hits WS cache first, then ccxt REST fallback
         • `getOHLCV` uses ccxt to seed/pad kline data

Market Data Cache
 ├─ In-memory tickerCache (symbol → { data, timestamp })
 └─ In-memory kline caches in WS manager

Agent Consumption
 ├─ Agent state machines (`backend/src/agent/state.ts`) read tickers via `getTicker`
 │    ↳ When invalid data (bid=0/ask=0), agent still proceeds, emits zero-width zones
 └─ Intelligent selector (`backend/src/services/intelligentAgent.ts`) stores plan+history

API Layer
 ├─ `/api/market/ticker` → `getTicker`
 ├─ `/api/status`        → `getTicker/getOHLCV + buildTechSnapshot`
 ├─ `/api/monitor/*`     → various Prisma reads + cached telemetry

Frontend
 ├─ React (Vite) polling `/api/status`, `/api/monitor/analytics`, `/api/market/ticker`
 └─ No stale/invalid guards – zero values rendered without warning

```

## Key Components Identified

| Layer | Files | Notes |
|-------|-------|-------|
| WS ingestion | `backend/src/services/binanceWebSocket.ts` | Subscribes to `!ticker@arr`; caches raw frames but does not normalise or validate. |
| REST fallback | `backend/src/data/market.ts`, `backend/src/exchange/ccxtClient.ts` | Uses ccxt `binance` for spot and **still** `binance` for swaps; symbol resolution often returns `BTC/USD:USD`. |
| Ticker API | `backend/src/routes/market.ts` | Returns raw `getTicker` output; DTO allows zeroes + undefined fields. |
| Agent runtime | `backend/src/agent/state.ts`, `backend/src/services/intelligentAgent.ts` | Plans are armed using tickers before validation; diagnostics show zero-width zones. |
| Frontend consumption | `frontend/src/components/LiveMetrics.tsx`, `frontend/src/components/TickerCard.tsx` | Renders `bid/ask/percentage` directly; no stale/error state. |

## Baseline Telemetry (2025-10-07 18:46 UTC)

```
POST /api/market/ticker {"symbol":"ETH/USDT"}
→ {
     "last": 4458.45,
     "bid": 0,
     "ask": 0,
     "percentage": -4.828,
     ...
     "info": { "bid": null, "ask": null, ... }
   }

GET /api/agent/session
→ smart session `BTC/USDT` active

GET /api/agent/sessions/cmggvkb0p000lqczdf8n0xqw2/diagnostics
→ price=0.8274, entry zone [0.0, 0.0], agent state SCAN
```

## Gaps / Risks Observed

1. **Symbol normalisation**
   - `resolveSymbol` often returns `BTC/USD:USD` for Binance USDT-perp markets; ccxt returns partial data with null bid/ask.
   - WS mini-ticker key uses stripped ID (`BTCUSDT`), causing mismatch with colon-format.

2. **Data validation**
   - No guard rails for zero/invalid tickers; agents operate on them, UI renders silently.

3. **Fallback behaviour**
   - REST fallback uses ccxt `binance` (spot) rather than `binanceusdm` for swaps, returning spot data mismatched with futures positions.

4. **Observability**
   - Console logs only; no structured metrics for WS reconnects, invalid frames, or cache age.

5. **Frontend state handling**
   - No stale/error indicators when API returns zeros or agent still arming; user sees static zero data.

## Next Steps (Phase 1 Completion)

- Validate symbol mapping against Binance USDM catalogue.
- Instrument WS manager to log frame counts, invalid payloads, reconnects.
- Draft end-to-end test outline covering ticker validity, agent zone computation, frontend stale handling.
- Prepare formal architecture diagram (mermaid) + README entry before Phase 2 fixes.
