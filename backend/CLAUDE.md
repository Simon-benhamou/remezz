# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Momentum-based cryptocurrency trading system supporting 1000+ concurrent agents. Uses Binance Futures via CCXT + WebSocket with PostgreSQL/Prisma for persistence.

## Build & Development Commands

```bash
# Development
npm run dev                   # Watch mode with tsx
npm run dev:debug            # Debug mode (inspect port 9229)

# Build
npm run build                # TypeScript compile + Prisma generate
npm run prisma:gen          # Generate Prisma client only

# Testing
npm run test:unit           # Unit tests (backend/test/unit/*.mjs)
npm run test:integration    # Integration tests
npm run test:e2e            # WebSocket E2E tests
npm run test                # Full suite (build + all tests)
npm run test:jest           # Jest runner directly
npm run test:multi-agent    # 9-agent pool simulation over 10 days

# Python ML
npm run test:python         # Python tests
npm run train-model         # Train XGBoost model

# Code Quality
npm run lint                # ESLint
npm run format              # Prettier check
npm run format:write        # Prettier auto-fix

# Database
npm run db:push             # Push Prisma schema
npm run migrate             # Run migrations
```

## Architecture

### Core Components

**Strategy Engine** (`src/strategies/`)
- `simpleAgent.ts` - Main agent class with capital pool, position management, trailing stops, NFS adaptive exits
- `momentumSimple.ts` - Signal detection (BB breakout, ROC momentum, volume filters, BTC macro)
- `signalRanker.ts` - ML-powered signal scoring with XGBoost integration

**Services** (`src/services/`)
- `orderQueue.ts` - Rate-limited order execution (3 concurrent, 350ms delays) to prevent IP bans
- `binanceWebSocket.ts` - Real-time market data with REST fallback
- `backtestService.ts` - Historical simulation with parity verification
- `nfsRealtimeExit.ts` - Advanced trailing stop with stagnant detection
- `apiDeduplicator.ts` - Deduplicates concurrent API calls (3x reduction)
- `candleCache.ts` - PostgreSQL candle storage with background updates (V5.77)

**Exchange** (`src/exchange/`)
- `ccxtClient.ts` - CCXT wrapper with market preloading and IP ban tracking

**API Routes** (`src/routes/`)
- `auth.ts` - JWT/API key authentication
- `backtest.ts` - Backtest execution and parity verification
- `debug.ts` - Internal diagnostics

### Data Flow

1. WebSocket receives real-time klines/tickers
2. Agents poll for signals on 15m candle close
3. Signal ranker scores opportunities with ML
4. Order queue executes with rate limiting
5. Position sync via WebSocket (0 API weight)

### Key Patterns

- **Capital Pool**: Shared across agents with mutex-protected reservation
- **Order Priority**: Stop loss > exits > entries
- **WebSocket First**: REST fallback only when WS unavailable
- **Fail Fast**: Markets must be preloaded at startup (no ad-hoc loadMarkets)

## Database Schema (Prisma)

Key models: `User`, `AgentSession`, `Position`, `Trade`, `Order`, `Fill`, `SessionKpi`, `MarketCandle`

Position tracking includes: `trailingActive`, `trailingBreachCandles`, `stagnantState` (JSON)

V5.77 `MarketCandle`: Cached candle data shared across all users (public market data). Eliminates REST API calls at startup.

## Testing

- Unit tests auto-discovered from `backend/test/unit/**/*.mjs`
- Integration tests from `backend/test/integration/**/*.mjs`
- `UNIT_TEST_MODE=true` uses in-memory Prisma
- Multi-agent test validates capital pool sharing across 9 agents

## Python ML Integration

XGBoost model for signal scoring:
- Training: `npm run train-model` generates `python/xgboost_direction.json`
- Features: ATR, ADX, RSI, EMA slopes, volume ratios
- Prediction: `pythonPredictor.ts` calls Python via child process
- Timeout configurable via `PYTHON_PREDICT_TIMEOUT_MS`

## Environment Variables

Critical:
- `DATABASE_URL` - PostgreSQL connection
- `JWT_SECRET` - Auth token signing

Trading:
- `RISK_PCT_PER_TRADE` (default 0.015)
- `MIN_RR` (default 2.0)
- `FEES_BPS` (default 7)

## Version Tracking

Strategy improvements tracked with version tags (V5.60+). Current features:
- V5.63: Skip-N-trades after consecutive losers
- V5.64: Wick breakout early entry
- V5.66: API optimization fixes (leverage cache, parallel klines, deduplication)
- V5.67: Local 1h candle files for backtest (reduces API calls)
- V5.68: Realistic intrabar timing in backtest (not just 15m multiples)
- V5.69: NFS weight alignment (real-time matches backtest 35:25:20:10:10)
- V5.70: Parity verification duration comparison with tolerance
- V5.71: Signal Radar - real-time proximity tracking on every tick, logs only significant changes
- V5.72: Wick breakout limit orders - use limit order at wick price in live (10s timeout, fallback to market)
- V5.73: Critical fixes - multi-position reserve-before-commit race condition, paper/live parity (realtime exit enabled for paper)
- V5.77: PostgreSQL candle cache - stores candles in MarketCandle table, 0 REST calls at startup (IP ban safe), background job updates every 15min
- V5.86: Critical backtest/live parity fixes:
  - **BTC 1h candle count**: Increased from 50-100 to 250 candles for SMA200 regime calculation (candleCache.ts, simpleAgent.ts, backtestService.ts). Without 200+ candles, live fell back to 15m SMA200 giving different regime than backtest.
  - **isFinal flag in seedKlines**: Fixed WebSocket cache seeding to correctly mark last candle as `isFinal: false` (in-progress). Previously all seeded candles had undefined isFinal, causing in-progress 1h candle to be incorrectly included in MTF filter calculations.
  - **Real entry time for stagnant detection**: Added `realEntryTime` field to Position interface. Stagnant detection now uses actual entry time (not candle timestamp) to measure hold duration. Fixes early stagnant trigger when entering late in a 15m candle.
  - **Backtest exit with btcCandles1h**: Added btcCandles1h parameter to `checkBacktestExit()` and `shouldExitPosition()` call. Backtest exit now uses 1h SMA200 for regime calculation (was missing, fell back to 15m).
- V5.87: Proactive limit orders and paper realism:
  - **Realtime exit monitor re-enabled**: `REALTIME_APP_EXIT_ENABLED: true` (momentumSimple.ts). Enables proactive LIMIT order placement at trailing stop BEFORE breach. When breach happens, limit fills at exact trailing price (zero slippage). Previously disabled, causing live to use market orders with 1-2% slippage (XRP trade lost 7% to bounce/slippage).
  - **PRE_BREACH zone widened**: Increased from 0.3% to 0.6% (nfsRealtimeExit.ts). Gives more time to detect approaching breach and place proactive limit before price gaps through.
  - **Paper mode realistic exits**: Paper NFS HIGH exits now use candle close price instead of theoretical trailing stop (simpleAgent.ts). Simulates market order execution without slippage. When proactive limit fills, both paper and live get exact trailing price.
  - **Parity verification fixes**: BTC 1h warmup increased to 10 days for 240+ candles (parityVerificationServiceV2.ts). Fixed candle timestamp to use last CLOSED candle, not current forming candle.
