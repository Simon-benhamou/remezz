# Remezz — Crypto Trading Platform

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start

```bash
npm run dev          # Development server (port 3001)
npm run build        # TypeScript compile + Prisma generate
npm test             # Full test suite
npm run lint         # ESLint
npm run format:write # Prettier auto-fix
```

## Architecture

### Strategy System

- **IStrategy interface** (`src/strategies/types.ts`): Pluggable strategy with `checkEntry()` / `checkExit()`
- **Registry** (`src/strategies/registry.ts`): Register/load strategies by name
- **Strategies**: Each in own directory (`src/strategies/<name>/strategy.ts + config.ts`)
- **Indicators** (`src/strategies/indicators/technicalIndicators.ts`): Shared ATR, BB, ROC, ADX, SMA, etc.

### Adding a New Strategy

1. Create `src/strategies/<name>/config.ts` and `strategy.ts`
2. Implement `IStrategy` interface from `types.ts`
3. Register in `registry.ts`
4. Test: `npx tsx scripts/test-strategy.ts --strategy <name> --period 2024,2025`

### Infrastructure

- **Exchange**: Binance Futures via CCXT + WebSocket (`src/services/binanceWebSocket.ts`)
- **Database**: PostgreSQL + Prisma (`prisma/schema.prisma`)
- **Order Queue**: Rate-limited execution (`src/services/orderQueue.ts`)
- **Capital Pool**: Shared capital management (`src/strategies/capitalPool.ts`)
- **Backtest Engine**: Strategy-agnostic simulation (`src/services/backtestService.ts`)
- **Parity Verification**: Live vs backtest comparison (`src/services/parityVerificationServiceV2.ts`)
- **Frontend**: React + Vite + Tailwind (port 5173)

### Core Services

- `src/services/btcDataService.ts` — Single source of truth for BTC candles and regime. `filterClosed()` + `computeRegime()` are pure functions. Singleton via `getBtcDataService()`.
- `src/services/orderQueue.ts` — Rate-limited order execution (3 concurrent, 350ms delays), per-user queues for multi-user isolation
- `src/services/binanceWebSocket.ts` — Real-time market data with REST fallback. Per-user data streams (ORDER_TRADE_UPDATE, balance, positions)
- `src/services/binanceRestQueue.ts` — Single gateway for ALL Binance REST calls. Priority-based execution, automatic weight tracking, IP ban detection, retry logic
- `src/services/candleCache.ts` — PostgreSQL candle storage with background updates
- `src/services/walkForwardService.ts` — Walk-forward testing: sliding train+test windows, in-sample vs out-of-sample comparison
- `src/services/optimizationService.ts` — Grid search over parameter combinations, ranked by out-of-sample Sharpe ratio
- `src/exchange/ccxtClient.ts` — CCXT wrapper with market preloading and IP ban tracking

### Key Patterns

- **Capital Pool**: Shared across agents with mutex-protected reservation (reserve → commit → release lifecycle)
- **Order Priority**: Stop loss > exits > entries (see `ExitReason` union in `orderPriority.ts`)
- **WebSocket First**: REST fallback only when WS unavailable
- **Fail Fast**: Markets must be preloaded at startup (no ad-hoc `loadMarkets`)
- **Single REST Gateway**: ALL Binance REST calls route through `binanceRestQueue`. No direct `fetch()` or `exchange.*()` calls to Binance outside the queue. Soft limit 1800w/min (75%), hard limit 2400w/min. Stats exposed at `/api/health`
- **Error Handling**: Use `errMsg(error: unknown): string` helper for safe error extraction in `catch (error: unknown)` blocks (no `catch (error: any)`)
- **Paper Mode**: Users without Binance keys can use paper trading. `createPaperExchangeStub()` in server.ts provides a minimal exchange interface
- **Engine Backtest Only**: Post-filter PnL simulations are NOT valid — they overestimate improvements due to slot replacement effect. Always validate with full engine backtest

## Backtest Validation Checklist (MANDATORY)

Before trusting ANY backtest result:

- [ ] **Cross-regime:** Test on 2024 AND 2025 separately
- [ ] **Stable symbols first:** BTC, ETH, SOL, XRP — not just alts
- [ ] **No look-ahead bias:** Only closed candles (isFinal), no future data
- [ ] **Realistic fees:** Trading 0.04% + slippage 0.05% + funding
- [ ] **Sharpe > 1.0** on EACH year individually
- [ ] **Max DD < 30%** on each year
- [ ] **Walk-forward:** Split each year in half, both halves positive
- [ ] **Symbol-agnostic:** Works on 4+ symbols, not just 1-2
- [ ] **N > 100 trades** for statistical significance
- [ ] **Engine backtest only:** Post-filter PnL simulations are NOT valid
- [ ] **Self-critique:** Document "what could make this wrong?"
- [ ] **If it only works on specific alts = RED FLAG**

## Lessons Learned (Momentum Strategy — Archived)

The momentum breakout strategy (V5.0-V5.153) was abandoned after 153 optimization versions:

- **2025 backtest:** 65.5% WR, +$6,826, Sharpe 2.31 (looked great)
- **2024 backtest:** 51.4% WR, -$1,866, Sharpe -3.81 (curve-fitted)
- **Live trading:** -$58 in 2 weeks on $414 capital

Key failures:

1. Over-optimized on one market regime (153 versions)
2. 25+ entry filters = couldn't trade in indecisive markets
3. Post-filter analysis overestimated improvements 5 times
4. Only worked on volatile alts, not stable pairs
5. Don't re-optimize after each losing trade (optimization spiral)

Full archive: `src/strategies/_archive/momentum/`

## Database Schema (Prisma)

Key models: `User`, `AgentSession`, `Position`, `Trade`, `Order`, `Fill`, `SessionKpi`, `MarketCandle`

Position tracking includes: `trailingActive`, `trailingBreachCandles`, `stagnantState` (JSON)

`MarketCandle`: Cached candle data shared across all users (public market data). Eliminates REST API calls at startup.

Data model notes:
- `Fill.realizedPnl` = GROSS, `Fill.fee` = separate
- `Trade.realizedPnlUsd` = GROSS, `Trade.feesUsd` = separate
- `SessionKpi.realizedPnlUsd` = NET (gross - fees)

## Environment Variables

Critical:
- `DATABASE_URL` — PostgreSQL connection
- `JWT_SECRET` — Auth token signing
- `EXCHANGE_ID` — Exchange identifier (binance)

Trading:
- `RISK_PCT_PER_TRADE` (default 0.015)
- `MIN_RR` (default 2.0)
- `FEES_BPS` (default 7)

## Build Commands

```bash
npm run dev              # Watch mode with tsx
npm run dev:debug        # Debug mode (inspect port 9229)
npm run build            # TypeScript compile + Prisma generate
npm run prisma:gen       # Generate Prisma client only
npm run test:unit        # Unit tests
npm run test:integration # Integration tests
npm run test             # Full suite
npm run db:push          # Push Prisma schema
npm run migrate          # Run migrations
npm run lint             # ESLint
npm run format           # Prettier check
npm run format:write     # Prettier auto-fix
```

## Testing

- Unit tests: `backend/test/unit/**/*.mjs` and `backend/test/**/*.test.ts` (Jest)
- Integration tests: `backend/test/integration/**/*.mjs` and `backend/test/integration/*.test.ts`
- `UNIT_TEST_MODE=true` uses in-memory Prisma
- Multi-agent test validates capital pool sharing across 9 agents
