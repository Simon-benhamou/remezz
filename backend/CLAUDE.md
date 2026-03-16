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
- `simpleAgent.ts` - **Barrel re-export file** (V5.108). Re-exports from capitalPool.ts and orchestrator.ts. All existing consumers import from here.
  - `capitalPool.ts` - CapitalPool class (~540 lines). Shared capital management: reserve→commit→release lifecycle, live balance sync, skip-N-trades rule.
  - `orchestrator.ts` - AgentOrchestrator class (~1830 lines, formerly SimpleAgent). Core lifecycle: tick, checkEntry, checkExit. Delegates close/sync/data to extracted modules.
  - `agent/candleFetcher.ts` - CandleFetcher class (~250 lines). Candle data acquisition: symbol 15m, BTC 15m, BTC 1h. WebSocket-first with REST fallback.
  - `agent/exchangeSync.ts` - ExchangeSync class (~570 lines). Position sync with Binance: 3-case mismatch handler, missing trade reconciliation. Callback injection pattern.
  - `agent/positionCloser.ts` - PositionCloser class (~740 lines). Full close-position lifecycle: paper/live close, partial fill handling, exit slippage validation, additional position cleanup. Owns exitAttemptCount/lastExitAttemptTs internally.
  - `agent/agentState.ts` - State types (PositionState, TrailingState, SignalState, etc.) + TradeEvent interface + AgentStateSnapshot/AgentStateResult + `buildAgentState()` pure function.
- `positionOpener.ts` - Extracted `openPosition()` (~970 lines). Pre-entry filters, capital sizing, exchange order placement, multi-position support
- `realtimeExitHandler.ts` - Extracted `checkRealtimeExit()` (~845 lines). Owns all RT exit state, NFS system, proactive limit tracking, trailing breach detection
- `momentumSimple.ts` - **Barrel re-export file** (V5.108). Re-exports all 54 exports from 5 focused modules below. All existing consumers import from here.
  - `config/momentumConfig.ts` - MomentumConfig object, all types (Candle, Position, SignalResult, ExitSignal, MarketConditions), CANDLE_15M_MS
  - `indicators/technicalIndicators.ts` - All indicator functions (calcATR, calcBB, calcROC, calcADX, calcSMA, detectMarketRegime, etc.)
  - `signals/momentumSignal.ts` - checkMomentumSignal, getMarketConditions, wick breakout functions
  - `exits/exitLogic.ts` - shouldExitPosition (single exit logic source of truth)
  - `risk/positionSizing.ts` - calculatePositionSize, calcDynamicStopLoss, liquidity config
- `signalRanker.ts` - ML-powered signal scoring with XGBoost integration
- `positionPersistence.ts` - Extracted DB operations (load/save/update positions, session KPIs)
- `exchangeOrderManager.ts` - Extracted exchange order placement (SL, trailing stop, proactive limits)
- `symbolEngine.ts` - Per-symbol signal computation (shared across users). Uses same `checkMomentumSignal()` as agents. Gets BTC data from `BtcDataService`
- `cacheManager.ts` - Mutex-protected leverage cache (`globalCacheManager` singleton). BTC candle caches still present as fallback but primary source is `BtcDataService`

**Config & Types** (`src/config/`, `src/types/`)
- `config/constants.ts` - Centralized magic numbers: `CACHE_TTLS`, `SYNC_INTERVALS`, `ORDER_QUEUE`, `WS_THROTTLE`, `USER_LIMITS`, `IP_WEIGHT`
- `types/exchange.ts` - Typed CCXT interfaces: `CcxtOrder`, `CcxtPosition`, `CcxtTrade`, `CcxtBalance`, `CcxtMarket`, `Exchange`

**Services** (`src/services/`)
- `btcDataService.ts` - **Single source of truth** for BTC candles and regime. `filterClosed()` + `computeRegime()` are pure functions replacing 6 inline variants. `LiveBtcDataService` reads WS cache directly (5s polling), singleton via `getBtcDataService()`. `BacktestBtcDataProvider` available for cursor-based access. Consumers: symbolEngine, orchestrator, positionOpener, server.ts. `btcCandlesRegime` is the canonical param name (renamed from misleading `btcCandles1h`)
- `orderQueue.ts` - Rate-limited order execution (3 concurrent, 350ms delays), per-user queues for multi-user isolation
- `binanceWebSocket.ts` - Real-time market data with REST fallback. Per-user data streams (ORDER_TRADE_UPDATE, balance, positions). Order cache with 2000-entry cap
- `ipWeightTracker.ts` - Global singleton tracking all Binance REST API weight per minute (2400w/min limit). Exposes stats to `/api/health`
- `userCredentials.ts` - Per-user API key management with encryption/decryption
- `backtestService.ts` - Historical simulation with parity verification. `SignalOverrides` supports EXIT params via index signature
- `walkForwardService.ts` - Walk-forward testing: sliding train+test windows, in-sample vs out-of-sample comparison
- `optimizationService.ts` - Grid search over parameter combinations, ranked by out-of-sample Sharpe ratio
- `nfsRealtimeExit.ts` - Advanced trailing stop with stagnant detection
- `apiDeduplicator.ts` - Deduplicates concurrent API calls (3x reduction)
- `binanceRestQueue.ts` - **Single gateway** for ALL Binance REST calls. Priority-based execution (critical > high > normal > low), automatic weight tracking via `ipWeightTracker`, IP ban detection, retry logic, ban-expired callbacks (triggers candle re-seeding). All callers (`fetchBinanceOhlcv`, `scheduleBinanceRestFallback`, `parityVerificationServiceV2`, `loadHistoricalOhlcv`, `candleCache`) route through this queue
- `binanceRest.ts` - OHLCV fetcher using direct HTTP to Binance. Routes through `binanceRestQueue` for weight tracking. Response parsing and normalization
- `candleCache.ts` - PostgreSQL candle storage with background updates (V5.77)

**Exchange** (`src/exchange/`)
- `ccxtClient.ts` - CCXT wrapper with market preloading and IP ban tracking

**API Routes** (`src/routes/`)
- `auth.ts` - JWT/API key authentication (JWT + API key dual auth)
- `backtest.ts` - Backtest execution, parity verification, walk-forward testing (`POST /walk-forward`), grid optimization (`POST /optimize`)
- `user.ts` - User management, API key CRUD
- `orders.ts`, `portfolio.ts`, `perf.ts` - Trading data endpoints
- `debug.ts` - Internal diagnostics

**Middleware** (`src/middleware/`)
- `auth.ts` - JWT token verification, user extraction from request
### Data Flow

1. WebSocket receives real-time klines/tickers
2. Agents poll for signals on 15m candle close
3. Signal ranker scores opportunities with ML
4. Order queue executes with rate limiting
5. Position sync via WebSocket (0 API weight)

### Key Patterns

- **Capital Pool**: Shared across agents with mutex-protected reservation
- **Order Priority**: Stop loss > exits > entries (see `ExitReason` union in `orderPriority.ts`)
- **WebSocket First**: REST fallback only when WS unavailable
- **Fail Fast**: Markets must be preloaded at startup (no ad-hoc loadMarkets)
- **BTC Data Service**: `getBtcDataService()` is the single source of truth for BTC candles, regime, and market conditions. Consumers: symbolEngine, orchestrator (checkEntry/checkExit/getMarketConditions), positionOpener, server.ts. Pure functions `filterClosed()` and `computeRegime()` eliminate 6 formerly-duplicated implementations. Param name: `btcCandlesRegime` (not `btcCandles1h`)
- **Mutex Caches**: Leverage cache is mutex-protected via `globalCacheManager`. BTC candle caches in cacheManager still exist as fallback but primary source is `BtcDataService`
- **Error Handling**: Use `errMsg(error: unknown): string` helper for safe error extraction in `catch (error: unknown)` blocks (no `catch (error: any)`)
- **MANDATORY: Combined Backtest BEFORE Code Changes**: Any strategy filter, threshold, or exit logic change MUST be validated with a full combined multi-symbol engine-integrated backtest BEFORE modifying `momentumConfig.ts` or `momentumSignal.ts`. The workflow is: (1) implement change, (2) run combined backtest on 2024+2025, (3) compare against baseline, (4) only commit if results are positive. Post-filter simulations (MAE/MFE sweeps, trade removal scripts) are EXPLORATION ONLY — they overestimate improvements due to slot replacement effect and missed side-effects (e.g., BE clipping winners). Three confirmed failures: V5.149 DNA filter (+27% post-filter, -$864 engine), V5.150 sweep (+222% post-filter, bug), V5.151 combo (+$4,417 post-filter, -$6,922 engine).
- **MomentumConfig Mutability**: `MomentumConfig` is a mutable `const` object (not `as const`) so tests can toggle fields like `CASH_MODE.ENABLED`
- **Cash Mode**: Market regime detection (ADX + ATR + SMA200 slope) skips entries in CHOPPY/LOW_VOL regimes. Integrated at top of `checkMomentumSignal()`
- **Single REST Gateway**: ALL Binance REST calls route through `binanceRestQueue` (single gateway). The queue handles weight tracking via `ipWeightTracker`, IP ban detection, priority ordering, rate limiting (100ms between calls), retry logic, and **post-ban candle re-seeding** via `onBanExpired()` callbacks. When an IP ban expires, `seedFreshCandles()` is triggered automatically to repopulate the WS kline cache (prevents agents being stuck at 2/61 candles). No direct `fetch()` or `exchange.*()` calls to Binance outside the queue. Key callers: `fetchBinanceOhlcv` (OHLCV via direct HTTP), `scheduleBinanceRestFallback` (ticker fallbacks), `candleCache` (startup seeding), `parityVerificationServiceV2` (parity checks), `loadHistoricalOhlcv` (backtest data). Exception: WS manager internal calls (exchangeInfo, time, bookTicker) use own limiters with manual `ipWeightTracker.record()`. Soft limit 1800w/min (75%), hard limit 2400w/min. Stats exposed at `/api/health`
- **Paper Mode Without API Keys**: Users without Binance keys can use paper trading. `createPaperExchangeStub()` in server.ts provides a minimal exchange interface. All exchange method calls in paper mode are guarded by truthiness checks
- **Live Mode API Key Guard**: `requireApiKeysForLive()` blocks live session creation without valid API keys (checked on all 4 session endpoints + restore)

## Database Schema (Prisma)

Key models: `User`, `AgentSession`, `Position`, `Trade`, `Order`, `Fill`, `SessionKpi`, `MarketCandle`

Position tracking includes: `trailingActive`, `trailingBreachCandles`, `stagnantState` (JSON)

V5.77 `MarketCandle`: Cached candle data shared across all users (public market data). Eliminates REST API calls at startup.

## Testing

- Unit tests: `backend/test/unit/**/*.mjs` and `backend/test/**/*.test.ts` (Jest)
- Integration tests: `backend/test/integration/**/*.mjs` and `backend/test/integration/*.test.ts`
- `UNIT_TEST_MODE=true` uses in-memory Prisma
- Multi-agent test validates capital pool sharing across 9 agents

### Test files added during refactoring
- `test/cacheManager.test.ts` - Mutex BTC/leverage cache (concurrent access, TTL, dedup)
- `test/walkForward.test.ts` - Walk-forward window generation (date math, step size)
- `test/unit/marketRegime.test.ts` - ADX calculation, regime classification, cash mode skip logic
- `test/integration/parity.test.ts` - Backtest determinism, snapshot, trailing/SL/stagnant behavior
- `test/integration/refactoring-regression.test.ts` - Post-refactor regression (trade count, win rate, PnL, Sharpe, drawdown)

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
- V5.88: Progressive + volatility-adaptive trailing for big winners:
  - **Problem**: XRP trade captured only 56% of move (12% of potential 67% lev PnL). Price bounced 2.33% from low, triggering exit at 0.8% trailing, then dropped another 55%.
  - **Solution**: Wider trailing on bigger moves AND on high volatility days.
  - **Progressive tiers** (momentumSimple.ts):
    - Tier 1: 3% raw profit → 0.8% trailing (unchanged)
    - Tier 2: 4% raw profit → 1.5% trailing (lowered from 5%)
    - Tier 3: 6% raw profit → 2.5% trailing (lowered from 7%)
  - **Volatility adaptation**: Trailing distances scaled by volatility regime multiplier:
    - LOW volatility: 0.8x (tighter trailing, safe markets)
    - MEDIUM volatility: 1.0x (base distances)
    - HIGH volatility: 1.6x (wider trailing for bigger bounces)
  - **XRP example**: 4.55% profit + HIGH vol → 1.5% × 1.6 = 2.4% trailing. Bounce was 2.33% → SURVIVES
  - **Config**: `TRAILING_PROGRESSIVE_ENABLED`, `TRAILING_VOL_ADAPT_ENABLED`, `TRAILING_VOL_HIGH_MULT`, etc.
  - **Applies to**: Live, paper, and backtest (all use shared `shouldExitPosition()`).
- V5.91: Audit fixes — backtest parity + execution safety:
  - **Wick breakout entry disabled in backtest**: Always uses `current.close` instead of wick breakout price. Wick breakout gave backtest unrealistically better entries vs live (disabled in live since V5.78).
  - **NFS HIGH exit uses close price**: Backtest NFS HIGH exits now use candle close (like paper) instead of theoretical trailing stop price. Eliminates three-way parity split — backtest, paper, and live all use realistic exit prices.
  - **syncWithExchange race condition guard**: Added `closingPosition` check in Case 1 of `syncWithExchange()`. Prevents double capital release + double DB save when `closePosition()` is in progress and exchange simultaneously fills the order.
  - **NFS_CONFIG reads from MomentumConfig.EXIT**: Backtest NFS scoring config replaced hardcoded values with getter-based object reading from `MomentumConfig.EXIT.NFS_*` fields. Single source of truth for weights/thresholds.
  - **Paper capital release ordering**: Moved `this.position = null` to after successful DB save in paper `closePosition()`. Prevents orphan positions in DB if save fails. `closingPosition` flag prevents re-entry during the gap.
  - **Exit reason documentation**: Clarifying comment explaining `EXIT_TRAIL_NFS_HIGH` (backtest) vs `EXIT_TRAIL_NFS_HIGH_15M` (live 15m layer) naming difference is intentional (deferral path distinction, not parity bug).
  - **Known remaining parity gaps** (documented, not yet fixed):
    - Position sizing: backtest uses simplified inline calc; live uses full `calculatePositionSize()` with ATR-based leverage, 24h volume caps, risk-based sizing
    - Symbol blacklist: not checked in backtest (only affects blacklisted symbols like BNB/ATOM)
    - Toxic hours: backtest uses candle open time, live uses wall clock (boundary-case at hour transitions)
    - Max positions: backtest uses static `initialCapital`, live uses dynamic `totalCapitalUsd`
    - Fee recording: live DB records only exchange fee; backtest/paper include slippage + funding

- V5.92: Strategy optimization — parameter sweep + critical bug fix:
  - **CRITICAL BUG FIX: NFS HIGH exit price reverted** from `current.close` back to `trailingStopPrice`. V5.91 change destroyed strategy (51.9% WR, -54% ROI). Fix restores edge because live uses proactive LIMIT orders at trailing stop (V5.87).
  - **Wick breakout entry**: Kept disabled in backtest (V5.91 correct — live can't replicate wick entries).
  - **MAX_POSITIONS_BASE**: Reverted from 3 back to 2 (V5.90 change caused overexposure on small capital).
  - **STAGNANT_TRADE_TIME_MINUTES**: 45 → 60 (optimization showed +67% PnL, -6% DD, +1.8% WR).
  - **TRAILING_ACTIVATION_PCT**: 0.8 → 1.0 (later activation = more room for trade to develop).
  - **TRAILING_DISTANCE_PCT**: 0.5 → 0.4 (tighter trail = faster profit lock-in).
  - **ETH removed from default symbols**: ETH drags WR and PnL (-$172 over 68 trades). Without ETH: 61.5% WR vs 58.4%, +688% vs +212% PnL.
  - **Default symbols**: DOGE, IMX, SEI, SUI, XRP (5 symbols, no ETH).
  - **fundingRateService.ts fix**: Replaced broken `import { errMsg }` with local function definition.
  - **Optimization script**: `scripts/optimize-strategy.ts` — 3-phase parameter sweep (entry, exit, symbols). `scripts/test-all-symbols.ts` — individual symbol profitability testing.
  - **Findings document**: `docs/optimization-findings-v5.92.md` — full analysis of 28+ backtest runs.

- V5.101 PnL display fix:
  - **Problem**: Sessions page (`/agents`) showed -$38 for WIF when dashboard showed -$16. Stale `unrealizedPnlUsd` in SessionKpi was being added to realized PnL.
  - **Root cause 1**: `simpleAgent.ts` `saveExitToDb` wrapper called `updateSessionKpi(pnlUsd, pnlPct, this.position, this.lastPrice)` — `this.position` still non-null after trade close, causing stale unrealized snapshot in KPI.
  - **Root cause 2**: `SessionsPage.tsx` `enrichSession()` added `perf.unrealizedPnlUsd` (stale -$21.63) to realized (-$16.88).
  - **Fix backend**: Pass `null` for `currentPosition` in `updateSessionKpi` call within `saveExitToDb` — position is closed, unrealized = 0.
  - **Fix frontend**: `enrichSession()` uses only `realized` PnL, drops stale unrealized.
  - **Also fixed**: `kpi.ts` now subtracts fees from `Fill.realizedPnl` (was GROSS, now NET — aligned with `positionPersistence.ts`). `useSessionState.ts` cockpit netPnl now subtracts `Trade.feesUsd` from `Trade.realizedPnlUsd` (was GROSS).
  - **Data model**: `Fill.realizedPnl` = GROSS, `Fill.fee` = separate. `Trade.realizedPnlUsd` = GROSS, `Trade.feesUsd` = separate. `SessionKpi.realizedPnlUsd` = NET (gross - fees).

- V5.101: SR Filter Internalization + Parity via Backtest Engine:
  - **Problem 1**: S/R filter lived outside `checkMomentumSignal()` — applied separately in backtestService.ts and simpleAgent.ts. Parity missed it entirely. Every new filter required replication in 3 places.
  - **Problem 2**: Parity reimplemented ~600 lines of exit logic (NFS, trailing, SL, regime) instead of using the backtest engine's `forcedEntry` + `parityMode` (built in V5.54).
  - **Solution Part 1**: Moved `findSRLevels()` + `calcSRProximityScore()` + `SRLevel` from `contextScore.ts` into `momentumSimple.ts`. Added SR filter check inside `checkMomentumSignal()` before both LONG and SHORT `return { valid: true }` statements. Config: `MomentumConfig.SR_FILTER` (flat, replaces nested `DRASH_CONTEXT`). **SR_FILTER.ENABLED = false** (V5.98 proved it destroys ROI; internalized for future toggle). Deleted `contextScore.ts`, removed DRASH blocks from backtestService.ts and simpleAgent.ts, cleaned `contextScore` param from signalRanker.ts.
  - **Solution Part 2**: Rewrote `parityVerificationServiceV2.ts` from ~630 lines to ~350 lines. Now calls `runBacktest()` with `forcedEntry` mode. Backtest handles signal detection, NFS, trailing, SL, regime exits — zero reimplementation. Signal validity checked via `validSignals` array (specifically looks for `NO_SIGNAL_AT_FORCED_TIME` reason to avoid false positives from parityMode signals at other candles).
  - **Auto-parity benefits**: Any future strategy change (new filters, exit tweaks) is automatically reflected in parity with zero maintenance. ~10s per trade verification.
  - **Config**: `MomentumConfig.SR_FILTER` with `ENABLED: false`, `FILTER_THRESHOLD: -0.3`, `LOOKBACK_CANDLES: 200`, `PIVOT_LOOKBACK: 5`, `MIN_TOUCHES: 2`, `CLUSTER_PCT: 0.3`, `NEAR_THRESHOLD_PCT: 1.5`, `FAR_THRESHOLD_PCT: 5.0`.
  - **Deleted files**: `contextScore.ts`, `scripts/sensitivity-drash-weight.ts`, `scripts/compare-drash-context.ts`, `scripts/compare-drash-filter.ts`.
  - **Modified files**: `momentumSimple.ts`, `backtestService.ts`, `simpleAgent.ts`, `signalRanker.ts`, `parityVerificationServiceV2.ts`, `test/unit/contextScore.test.ts`.
  - **Parity test script**: `scripts/run-parity-v2-test.ts` — runs `verifyTradeV2()` on recent DB trades. Validated on WIF/FET trades: 1 MATCH, 1 EXIT_MISMATCH (REGIME_CHANGE vs MOMENTUM_REVERSAL — pre-existing gap), 1 NO_SIGNAL (data difference between live WS and backtest historical candles).

- V5.98: S/R proximity filter REMOVED (reverted V5.96-V5.97):
  - **Context**: V5.96 added pivot-based S/R proximity filter (Peshat/Remez in PaRDeS framework). V5.97 loosened SHORT thresholds via 12-config grid search.
  - **Problem**: Filter improved quality metrics (WR +1pp, Sharpe +0.19) but DESTROYED ROI vs baseline:
    - Baseline (no filter): 776 trades, 62.9% WR, ROI **1571%**, Sharpe 3.11
    - V5.96 (aggressive):   653 trades, 63.9% WR, ROI 1210%, Sharpe 3.30 (-361% ROI)
    - V5.97 (loosened):     685 trades, 64.2% WR, ROI 1504%, Sharpe 3.55 (-67% ROI)
  - **Conclusion**: Even with optimized thresholds, filter still costs -67% ROI vs baseline. Trade volume reduction (776→685) outweighs quality improvement. Not worth it at current implementation level.
  - **Signal-level findings preserved** (useful for future Drash/Sod work):
    - SHORT near resistance (<1.5%): 82% WR, 3.14 PF (excellent edge)
    - SHORT far from resistance (>5%): 62% WR, 1.10 PF (weak)
    - LONG near resistance: 53% WR (filter correctly identifies bad entries)
    - LONG away from resistance: 67% WR (good)
  - **Future**: S/R has real signal value but needs smarter implementation (dynamic zones, breakout/bounce classification, multi-TF confluence) before re-enabling. See `docs/DRASH-SOD-PLAN.md`.
  - **Scripts preserved**: `scripts/compare-sr-filter.ts`, `scripts/grid-search-short-sr.ts`, `scripts/analyze-sr-proximity.ts` for future research.

- V5.108: Architectural refactoring — split momentumSimple.ts into 5 focused modules:
  - **Problem**: `momentumSimple.ts` was a 3,562-line monolith containing config, indicators, signal detection, exit logic, and position sizing. Logic changes in one domain could silently affect others. Config drift bugs (V5.102 regime timeframe, V5.105 SymbolEngine) were structural consequences of this coupling.
  - **Solution**: Extracted into 5 focused modules with strict acyclic dependency graph:
    - `config/momentumConfig.ts` (839 lines) — `MomentumConfig`, all types (`Candle`, `Position`, `SignalResult`, `ExitSignal`, `MarketConditions`), `CANDLE_15M_MS`, `calculateExitNowMs`
    - `indicators/technicalIndicators.ts` (850 lines) — All indicator functions: `calcATR`, `calcBB`, `calcROC`, `calcADX`, `calcSMA`, `calcVolRatio`, `detectMarketRegime`, `determineVolatilityRegime`, `updatePositionWaterMarks`, S/R functions, pattern filters
    - `signals/momentumSignal.ts` (897 lines) — `checkMomentumSignal`, `getMarketConditions`, wick breakout functions, `calcRSI`/`calcStochRSI` (private helpers)
    - `exits/exitLogic.ts` (563 lines) — `shouldExitPosition`
    - `risk/positionSizing.ts` (464 lines) — `calculatePositionSize`, `calcDynamicStopLoss`, `calcSafeLeverage`, liquidity config
  - **Dependency graph**: `config/ → indicators/ → signals/, exits/, risk/` (no cycles, no sibling imports)
  - **Backward compatibility**: `momentumSimple.ts` is now a 101-line barrel that re-exports all 54 exports. All 45+ consumers continue working with zero import changes.
  - **Single source of truth**: Each function/config lives in exactly ONE file. Changing `BTC_REGIME_TIMEFRAME` propagates automatically to all code paths.
  - **Zero behavioral changes**: No logic, values, or function signatures were modified.

- V5.108 Phase 2: Architectural refactoring — split simpleAgent.ts into focused modules:
  - **Problem**: `simpleAgent.ts` was a 3,793-line file containing both the agent orchestrator class AND the CapitalPool class — two completely independent concerns in one file. CapitalPool manages shared capital across agents; AgentOrchestrator manages a single agent's trading lifecycle.
  - **Solution**: Extracted into 2 focused modules:
    - `capitalPool.ts` (539 lines) — `CapitalPool` class, `getCapitalPool`, `resetCapitalPool`. Shared capital management with atomic reserve→commit→release, live balance sync, skip-N-trades rule.
    - `orchestrator.ts` (3,276 lines) — `AgentOrchestrator` class (renamed from `SimpleAgent`), `SimpleAgentConfig`, event types, factory functions.
  - **Backward compatibility**: `simpleAgent.ts` is now a 24-line barrel that re-exports everything. `AgentOrchestrator` is exported as `SimpleAgent` for all existing consumers. Zero import changes needed.
  - **Circular dep fix**: `positionOpener.ts` now imports `CapitalPool` directly from `capitalPool.ts` instead of via the barrel (avoids orchestrator → positionOpener → simpleAgent → orchestrator cycle).
  - **Zero behavioral changes**: No logic, values, or function signatures were modified.

- V5.108 Phase 3: Further split orchestrator.ts — extract CandleFetcher + ExchangeSync:
  - **Problem**: `orchestrator.ts` was still 3,276 lines after Phase 2, mixing core lifecycle logic with data acquisition and exchange synchronization.
  - **Solution**: Extracted into 3 focused modules under `agent/` subdirectory:
    - `agent/candleFetcher.ts` (253 lines) — `CandleFetcher` class: fetchCandles (symbol 15m), fetchBtcCandles (BTC 15m), fetchBtcCandles1h (BTC 1h). Owns per-symbol candle cache.
    - `agent/exchangeSync.ts` (568 lines) — `ExchangeSync` class: loadExistingPosition, syncWithExchange (3-case position mismatch handler), checkMissingTrades. Uses callback injection pattern (same as RealtimeExitHandler, PositionOpener).
    - `agent/agentState.ts` (97 lines) — State type interfaces: PositionState, TrailingState, SignalState, TimeKeeper, CooldownState, LifecycleState, ErrorState.
  - **Result**: orchestrator.ts reduced from 3,276 → 2,553 lines (723 lines extracted).
  - **Zero behavioral changes**: Callback injection pattern preserves all state access; all call sites updated mechanically.

- V5.108 Phase 4: Extract closePosition + getAgentState from orchestrator.ts:
  - **Problem**: `orchestrator.ts` still contained `closePosition()` (~600 lines of paper/live close, partial fill handling, exit slippage validation) and `getAgentState()` (~200 lines of state snapshot assembly). These were the two largest remaining extractable units.
  - **Solution**: Extracted into 2 modules:
    - `agent/positionCloser.ts` (740 lines) — `PositionCloser` class with `PositionCloserDeps` interface (18 callback fields). Split into: `closePaper()`, `closeLive()`, `handlePartialFills()`, `validateExitSlippage()`, `closeAdditionalPositionsLive()`. Owns `exitAttemptCount` and `lastExitAttemptTs` internally (previously orphaned in orchestrator).
    - `agent/agentState.ts` updated (314 lines) — Added `TradeEvent` interface (moved from orchestrator to break circular dep), `AgentStateSnapshot` interface (12 fields), `AgentStateResult` interface, `buildAgentState()` pure function.
  - **Result**: orchestrator.ts reduced from 2,553 → ~1,830 lines (723 lines extracted). Total reduction from original: 3,793 → 1,830 (52% smaller).
  - **Circular dep fix**: `TradeEvent` moved from orchestrator.ts to agentState.ts. Both positionCloser and orchestrator import from agentState (no cycle). Orchestrator re-exports `TradeEvent` for backward compat.
  - **Zero behavioral changes**: All 217 tests pass, build clean.

- V5.108 Phase 4b: Dead code cleanup — 49 unused files deleted:
  - **Problem**: Repository had accumulated 49 unused .ts files (analytics, broker, core, exec, infra, quantai modules) plus 3 root test scripts. These files were never imported by any active code path. Total noise: ~10,700 lines.
  - **Audit method**: Mapped all 115 .ts files in `src/`, traced import graphs to find files with zero importers, then recursively found transitively dead files (only imported by other dead files).
  - **Deleted**: 49 files from `src/` (entire directories eliminated: `analytics/`, `broker/`, `core/`, `exec/`, `infra/`, `quantai/`, `src/scripts/`), 3 root test scripts, 12 empty directories.
  - **Result**: `src/` reduced from 115 → 66 .ts files (43% reduction). All 217 tests pass, build clean.
  - **Near-miss**: `data/indicators.ts` was wrongly deleted (import from `data/market.ts` was missed in initial analysis). Restored immediately from git.

- V5.108 Phase 4c: PARDES audit bug fix — resetTrailingState signal leak:
  - **Problem**: `exchangeSync.ts`'s `resetTrailingState` callback (fired when exchange closes a position, e.g. SL hit) was missing `currentBias = null` and `lastSignal = null` resets. Only trailing flags were reset. This caused signal state from the old trade to leak into the next evaluation cycle after an exchange-side close.
  - **Fix**: Added `this.currentBias = null; this.lastSignal = null;` to the `resetTrailingState` callback in orchestrator.ts constructor (exchangeSync deps wiring). Now matches the complete state reset done by positionCloser's `resetTrailingAndSignalState`.
  - **Also fixed**: Removed orphaned `exitAttemptCount` and `lastExitAttemptTs` instance variable declarations from orchestrator.ts (now owned internally by PositionCloser).
  - **Impact**: Prevents potential stale signal bias after exchange-side position closes. No test regression.

- V5.107: Fix parity forced entry timestamp — V5.106 was one candle too LATE (not early):
  - **Problem**: V5.106 assumed `Trade.entryTs` = candle OPEN time (per V5.46), but V5.86 added `realEntryTime = Date.now()` which takes priority in `positionPersistence.ts:233` (`realEntryTime ?? entryTime ?? Date.now()`). So `Trade.entryTs` is actually **wall-clock** (~candle_close + 2s). V5.106's `+CANDLE_15M_MS` pushed `forcedEntryTimestamp` one candle too far → wrong entry price → systematic EXIT_MISMATCH and PNL_VARIANCE on every trade.
  - **Fix**: `forcedEntryTimestamp = floor(entryTs / 15min) * 15min` (NO offset). `floor(wallClock / 15min)` naturally gives the candle close boundary, which is exactly `btcCandle.timestamp` when the signal candle was just processed. Diagnostic confirmed: SUI SHORT trade went from EXIT_MISMATCH (SL @ -10.90%) to MATCH (TRAIL_NFS_MED @ +14.86%, 0% PnL diff).
  - **Root cause chain**: V5.46 set `position.entryTime = candle_open` → V5.86 added `position.realEntryTime = Date.now()` → persistence uses `realEntryTime` first → `Trade.entryTs = wall-clock` → V5.106 assumed candle_open and added wrong offset.
  - **Documentation**: Added comment in `positionPersistence.ts` warning about the `realEntryTime` priority and its parity implications.
  - **Files**: `parityVerificationServiceV2.ts` line 123, `positionPersistence.ts` line 233.

- V5.106: (SUPERSEDED by V5.107) Parity verification off-by-one candle fix:
  - **Problem**: `forcedEntryTimestamp` was one candle too early. V5.46 changed `position.entryTime` from `Date.now()` (~candle close + 2s) to `lastCandle.timestamp` (candle OPEN time). But `parityVerificationServiceV2.ts` still assumed wall-clock entry time. Result: `forcedEntryTimestamp = candle_open` matched `btcCandle.timestamp = candle_open` in the BT loop, where the signal candle ISN'T closed yet → NO_SIGNAL for every trade.
  - **Fix**: `forcedEntryTimestamp = floor(entryTs / 15min) * 15min + CANDLE_15M_MS`. Adding one candle shifts from open time to close time, aligning with when the BT loop has the signal candle available.
  - **NOTE**: This fix was based on incorrect assumption that Trade.entryTs = candle open time. In reality, Trade.entryTs = Date.now() (wall-clock) due to V5.86's realEntryTime priority. The +CANDLE_15M_MS actually pushed one candle TOO LATE. Fixed in V5.107.
  - **File**: `parityVerificationServiceV2.ts` line 122.

- V5.105: Critical fixes — exit loop, circuit breaker double-gate, SymbolEngine parity:
  - **Exit loop fix** (`simpleAgent.ts`, `realtimeExitHandler.ts`): When exchange SL fired, `reduceOnly` order failed (position already gone), failure path restarted RT monitor → infinite loop (5-6 close attempts). Fix: detect `ReduceOnly` rejection + check WS position cache before restarting monitor. Added 3-attempt/30s guard with `syncWithExchange()` fallback. Removed `setClosingPosition(false)` from `startIfNeeded()` that broke the re-entry guard.
  - **Circuit breaker double-gate** (`simpleAgent.ts`): `canMakeCriticalRequest()` was called in agent (Gate 1) AND order queue (Gate 2) with shared rate-limit state. Gate 1 consumed the 5s slot, so Gate 2 blocked all exits for 5 seconds. Fix: removed agent-level check — queue already handles CB + CRITICAL priority.
  - **SymbolEngine parity** (`symbolEngine.ts`): Was passing real BTC 1h candles to `checkMomentumSignal` while backtest/agent use BTC 15m per V5.102. Different SMA200 → different regime → live entering SHORT trades the backtest would never take (late entries on exhausted momentum). Fix: when `BTC_REGIME_TIMEFRAME === '15m'`, use BTC 15m candles.
  - **Parity impact**: SymbolEngine now matches backtest regime detection. Exit loop eliminated. Circuit breaker no longer delays exits.

- V5.104: PaRDeS audit fixes — gap detection (P1) + CHOPPY regime fallback (R4):
  - **P1: Backtest gap detection** (`localOhlcvJsonStore.ts`, `backtestService.ts`): Added `detectAndWarnGaps()` that walks sorted candles and warns about missing candles (gaps > 1.5x expected interval). Called in all 5 code paths of `fetchCandles()` and `fetchCandles1h()` (CCXT-only, local-only full coverage, local+CCXT merge). Informational only — candles not removed. Exports `CANDLE_15M_MS`, `CANDLE_1H_MS`, `CandleGap` type.
  - **R4: CHOPPY regime silent disable** (`momentumSimple.ts`): When `btcCandles1h` has < 205 candles for SMA200 slope check, falls back to `btcCandles` (15m) closes with `isFinal` filtering. Previously `sma200SlopeFlat` stayed `false` silently, making CHOPPY unreachable. Fallback mainly fires when V5.102 passes 15m candles as the "1h" param, or when `checkMomentumSignal` passes `btcCandles1h || []`.
  - **Parity impact**: Gap detection is informational (no behavioral change). Regime fallback closes a gap — CHOPPY now detectable even with short 1h data. Backtest verified identical: 27 trades, 59.26% WR, -$126.46 PnL (DOGE+SUI, Jun 2025).

- V5.103: PaRDeS audit fixes — signal scoring parity + config hygiene:
  - **CRITICAL: calcATR double-conversion in backtest** (`backtestService.ts`): Local `calcATR` returned percentage, then line 1887 converted again → near-zero ATR scoring (15% of signal score weight dead). Fixed by deleting local `calcATR`, `calcBBPosition`, `calcTrendStrength` and importing from `momentumSimple.ts`. Backtest signal ranking now matches live.
  - **BB scoring dead weight in signalRanker** (`signalRanker.ts`): Entry requires BB breakout, so bbPosition was always ~1.0 (LONG) or ~0.0 (SHORT), giving BB score = 0 for every signal. 30% weight contributed nothing. Fixed: `calcBBPosition` now returns unclamped value, scorer measures breakout depth (distance beyond band) instead of position within band.
  - **StochRSI filter ignoring config** (`momentumSimple.ts:2257`): Hardcoded thresholds `15` and `4.0` instead of `stochRsiConfig.MIN_STOCHRSI` and `stochRsiConfig.VOLUME_EXCEPTION_MULTIPLIER`. `ENABLED` flag completely ignored. Fixed to use config values and respect `ENABLED`.
  - **Emergency SL fallback** (`positionOpener.ts:891`): `EMERGENCY_STOP_MAX_PCT ?? 3.0` fallback exceeded documented 2.5% cap. Fixed to `?? 2.5`.
  - **Unity violations fixed**: Imported `CANDLE_15M_MS` in `parityVerificationServiceV2.ts` (was redefined locally). Replaced inline SMA200 in `server.ts` with `calcSMA()` import.
  - **Parity tolerances documented**: PnL 3%, duration max(30min, 20% of live), exit family comparison via `normalizeToFamily()`.
  - **Config**: `STOCHRSI_FILTER.ENABLED` now respected, `EMERGENCY_STOP_MAX_PCT` fallback aligned to 2.5%
  - **Parity impact**: Backtest signal ranking now uses correct ATR (was near-zero) and meaningful BB scoring (was dead weight). Signal selection may differ from pre-V5.103 backtests.

- V5.102b: Backtest entry timestamp fix (commit f1790517):
  - **Problem**: `calculateRealisticHoldMinutes()` used `estimateIntrabarTiming()` for entry time, but V5.91 disabled wick breakout entry — all entries are at candle close.
  - **Fix**: Entry timestamp = `entryCandle.timestamp + candleDurationMs` (candle close time). Removes unused intrabar estimation for entries.
  - **Impact**: More accurate hold duration calculation in backtest trade records.

- V5.102: Regime timeframe switched from 1h to 15m:
  - **Problem**: BTC regime SMA200 on 1h candles (200h = ~8 day lookback) was too slow for aggressive momentum breakout strategy. Regime shifts detected late, missing momentum windows.
  - **Discovery**: Tested 6 configurations (15m/30m/1h/4h SMA200, 30m SMA400, 1h SMA100) over 13 months. 15m SMA200 (50h lookback) dominated: +1435% ROI, +0.51 Sharpe vs 1h baseline on 5 symbols.
  - **Validation (3/4 tests PASS)**:
    - OOS symbols (ADA, DOT, STX, TIA): +2387% ROI, +5.1pp WR, +1.59 Sharpe, -27% DD
    - Walk-forward H2 (Aug-Feb): +512% ROI, +3.4pp WR, +1.67 Sharpe
    - All 9 symbols combined: +2325% ROI, +0.19 Sharpe (1155 trades, 63.4% WR)
    - Walk-forward H1 (Jan-Jul): marginal (+19% ROI but -0.31 Sharpe — stable period)
  - **Config changes**: `BTC_REGIME_TIMEFRAME: '15m'` (was '1h'), `MULTI_TIMEFRAME_FILTER.TIMEFRAME: '15m'` (was '1h'), `LOOKBACK_CANDLES: 40` (was 10, keeps ~10h window)
  - **Live/paper**: `simpleAgent.ts` now passes BTC 15m candles for regime/MTF instead of fetching separate 1h candles
  - **Backtest**: `regimeTimeframeMinutes` param defaults to config value. When 15m, uses BTC 15m candles directly (no aggregation). Cursor-based filtering for O(1) per-step performance.
  - **Why 15m works**: Strategy enters on 15m signal candles — regime should react at same speed. 50h SMA200 catches short-term regime shifts that matter for breakout entries. Generates more trades (816 vs 587) at same win rate (63.8%).
  - **Scripts**: `scripts/compare-regime-timeframes.ts` (6-config comparison), `scripts/validate-regime-15m.ts` (OOS + walk-forward validation)

- V5.100: Parity verification 1h candle filter fix (two bugs):
  - **Problem 1**: Parity filtered BTC 1h candles by open time (`c.timestamp <= lastClosedCandleTs`), including the forming 1h candle with its future close price (look-ahead bias). Flipped regime near SMA200.
  - **Problem 2**: Reference time was `lastClosedCandleTs` (15m candle OPEN time), 15min behind the backtest's `btcCandle.timestamp` (CURRENT 15m candle open = PREVIOUS candle CLOSE time). At hour boundaries (XX:45 signals), this excluded the 1h candle that just closed, causing MTF filter mismatches.
  - **Parity fix**: `c.timestamp + CANDLE_1H_MS <= currentCandleStart` — uses close-time filter with correct reference. `currentCandleStart` = close time of last closed 15m candle = backtest's `btcCandle.timestamp`.
  - **Known limitation**: Live uses `isFinal` flag from WS cache (authoritative Binance data). At hour boundaries, the 15-min cache TTL can cause the most recently closed 1h candle to still show `isFinal=false` in the snapshot. This makes live occasionally use one fewer 1h candle than backtest/parity, slightly changing ROC10/SMA200. This is inherent to the WS caching model and is rare (only at exact hour boundaries with unlucky cache timing).
  - **File**: `parityVerificationServiceV2.ts` line 284.

- V5.95: Parity sim fixed SL at entry time:
  - **Problem**: Parity sim let `shouldExitPosition()` recalculate dynamic SL% per candle (volatility regime can shift mid-trade). Live places a fixed `STOP_MARKET` order at entry using `calcDynamicStopLoss()` — never recalculated. This caused DURATION_MISMATCH when the sim's dynamic SL triggered earlier/later than the fixed live SL.
  - **Fix**: `simulateExit()` in `parityVerificationServiceV2.ts` now computes entry-time SL% via `calcDynamicStopLoss(candles.slice(0, entryIdx+1), symbol)` and checks `candle.low <= fixedSlPrice` (longs) / `candle.high >= fixedSlPrice` (shorts) before calling `shouldExitPosition()`. The `shouldExitPosition` stoploss path is skipped (already handled). Stagnant exits use the same fixed SL price.
  - **Also fixed**: Position symbol changed from `'SIM'` to actual symbol (needed for tier-based SL lookup in `calcDynamicStopLoss`).

- V5.94: Backtest BTC 15m look-ahead bias fix:
  - **Problem**: Backtest included the current (forming) BTC 15m candle in signal computation via `btcIdx+1`, using its final close/high/low/volume. Live excludes in-progress candles (`isFinal=false`), giving backtest a subtle advantage on BTC ATR/volatility and ADX calculations.
  - **Fix**: Use `btcIdx` (exclusive end) instead of `btcIdx+1` in `backtestService.ts`, matching live's `isFinal` filtering exactly.
  - **Impact**: 743 → 741 trades, 64.7% → 64.6% WR, $59,808 → $56,169 PnL (minimal degradation, better parity).
  - **Verification script**: `scripts/bt-verify-fix.ts` — compares before/after backtest results.

- V5.121: Dead code cleanup — signal chain audit (~425 lines removed):
  - **BREAKOUT_CONFIRMATION removed**: Config block (momentumConfig.ts), LONG/SHORT code blocks + 3 rejection paths each (momentumSignal.ts), snapshot field (backtestService.ts). Was ENABLED:false since V5.34. `distanceFromUpper`/`distanceFromLower` recalculated inline for confidence formula only.
  - **ANTICIPATORY_ENTRY removed**: Config block (momentumConfig.ts), 70-line code block in BULL path (momentumSignal.ts), `detectBBSqueeze()` + `BBSqueezeResult` + `detectVolumeAccumulation()` from technicalIndicators.ts. Was ENABLED:false since V5.32 (27x worse than classic).
  - **SR_FILTER removed**: Config block (momentumConfig.ts), LONG/SHORT filter blocks (momentumSignal.ts), `SRLevel` interface + `findSRLevels()` + `calcSRProximityScore()` from technicalIndicators.ts. Was ENABLED:false since V5.98 (destroys ROI).
  - **Dead indicators removed**: `rsi` (calcRSI result) and `btcRoc4h` computation+features in checkMomentumSignal (filter removed in V5.10, calc stayed). `btcMa50`+`btcAboveMa50` dead computation in getMarketConditions (overwritten by btcAboveSma200). Note: `btcMa50`/`btcAboveMa50` in checkMomentumSignal kept (used in features for dashboard).
  - **checkSignal_DEPRECATED removed**: 82-line deprecated function + local helpers (detectBBSqueeze, detectVolumeAccumulation, calcRSI, calcStochRSI) in backtestService.ts. Zero callers.
  - **Bug fix R1: SHORT alternation5**: Replaced inline close-vs-close comparison with `calcAlternation5(candles)` (candle direction: close>open). LONG already used `calcAlternation5()`. The inline version measured price direction (closes[i] > closes[i-1]) which is different from candle direction (close > open). Now both paths are identical.
  - **Types fixed**: `checkMTFAlignment(btcCandlesRegime: any[])` → `Candle[]`, `checkBTCVolatility(btcCandles: any[])` → `Candle[]`.
  - **Imports cleaned**: Removed unused imports from momentumSignal.ts (findSRLevels, calcSRProximityScore, detectBBSqueeze, detectVolumeAccumulation, calcBB, calcATR, calcADX, shouldSkipEntryForRegime). Barrel (momentumSimple.ts) cleaned: removed SRLevel, findSRLevels, calcSRProximityScore re-exports. Test mock (symbolEngine.test.ts) removed SR_FILTER.
  - **Zero behavioral change** on active filters. All 12 LONG + 13 SHORT filters intact: regime, cash mode, candle direction, consec, breakout, ROC, volume, BTC volatility, MTF, green ratio, alternation5, BB touches, StochRSI, ROC acceleration.
  - **Files**: momentumConfig.ts (-55 lines), momentumSignal.ts (-120 lines), technicalIndicators.ts (-160 lines), backtestService.ts (-85 lines), momentumSimple.ts (-6 lines), symbolEngine.test.ts (-1 line).

- V5.122: SOD parity — close 3 BT↔Live gaps + parity alert + dead config cleanup:
  - **Backtest sizing via `calculatePositionSize()`**: Replaced ~90 lines inline sizing + hardcoded `LIQUIDITY_CAPS` dict with shared `calculatePositionSize()` from `positionSizing.ts`. BT now uses identical sizing logic as live (adaptive %, liquidity tiers, safe leverage, multi-position plan). Forced entry also uses `calculatePositionSize()` instead of `capital * 0.25`.
  - **`fixedSlPct` on standard BT entries**: Added `fixedSlPct: slPct` to standard entry position creation. Previously only forced entries had it. `checkBacktestExit()` already checks `fixedSlPct` on wicks before calling `shouldExitPosition()` — standard entries now benefit from fixed SL matching live's STOP_MARKET.
  - **Parity degradation Telegram alert**: After each `verifyTradeV2()`, queries last 10 `tradeParityResult` rows. If match rate < 70%: warning alert. If < 50%: critical alert. Uses existing `notifySystemAlert()`.
  - **8 dead config fields removed** from `momentumConfig.ts`: `MIN_ROC5_BULL/BEAR` (gated by REQUIRE_MOMENTUM_CONFIRMATION=false), `ENTRY_LONG.BB_PERIOD/BB_STD` (duplicate of ENTRY.BB_*), `BTC_MOMENTUM_MIN/PERIOD` (superseded by SMA200), `ALLOWED_DAYS` (never checked), `CACHE_1H_CANDLES/CACHE_REFRESH_MINUTES` (1h regime vestige). Refs in `exitLogic.ts` replaced with inline constants; `backtestService.ts` refs pointed to `ENTRY.BB_*`.
  - **Gotcha**: Removing "dead" config fields can break TS compilation if other files reference them (even behind disabled flags). Always grep all callers before deleting config.
  - **Files**: `backtestService.ts`, `parityVerificationServiceV2.ts`, `momentumConfig.ts`, `exitLogic.ts`

- V5.123: Fix SessionKpi double-counting entry trading fee (Dashboard vs Ledger PnL mismatch):
  - **Problem**: Dashboard (Active Agents cards) showed worse PnL than Execution Ledger Net P&L. AVAX: $10.40 vs $10.81, DOT: $1.01 vs $1.41, IMX: -$9.22 vs -$8.98. Systematic ~$0.25-0.41 per trade.
  - **Root cause**: Entry fill `fee = entryNotional × PAPER_FEE_RATE` (created in `savePositionToDb`). Exit fill `fee = paperFeeUsd` (created in `saveExitToDb`). But `paperFeeUsd` already includes the entry trading fee (computed in `positionCloser.ts` as `tradingFeeEntry + tradingFeeExit + slippageEntry + slippageExit + fundingFee`). `recomputeKpi()` aggregates `SUM(Fill.fee) WHERE realizedPnl IS NOT NULL` — entry fills have `realizedPnl=0` (not null!) so they're included → entry trading fee counted twice.
  - **Fix**: Added `exitFillFee = feeUsd != null ? calculatedFee - entryTradingFee : calculatedFee` in `saveExitToDb`. Exit fill stores `exitFillFee` (excludes entry trading fee). `Trade.feesUsd` unchanged (still stores full `paperFeeUsd` for Ledger display). SessionKpi now sums: `entryFill.fee + exitFillFee = entryTradingFee + (paperFeeUsd - entryTradingFee) = paperFeeUsd` (correct).
  - **Data model**: `Trade.feesUsd` = total costs (for display). `Fill.fee` = per-fill fee (for KPI aggregation). `SessionKpi.realizedPnlUsd` = GROSS - SUM(Fill.fee) (NET).
  - **File**: `positionPersistence.ts`

- V5.125: SHORT filter sweep optimization + BB Lower permanently removed:
  - **Problem**: SHORT entry filters (ROC5 ≤ -1.5%, Volume ≥ 2.0x, Price < BB Lower) formed a "triple confirmation tardive" — all measure that a move has ALREADY happened. By the time all 3 pass, the breakout is exhausted and entries are too late. Live logs showed all symbols rejected by `roc5_not_low_enough` during dips that were over by the time filters triggered.
  - **Methodology**: 48-config parameter sweep over 18 months (Jun 2024–Dec 2025), 9 symbols. In-sample: DOGE, IMX, AVAX, FET, WIF. OOS: ADA, DOT, STX, TIA. Scripts: `scripts/sweep-short-filters.ts`, `scripts/sweep-long-filters.ts`.
  - **SHORT changes (applied)**:
    - `VOL_SPIKE`: 2.0 → 1.0 (captures breakouts earlier, before volume spike peaks)
    - `PRICE_BELOW_BB_LOWER`: **permanently removed** (config field + code deleted). BB Lower requires price at -2σ, which is a mean-reversion signal — contradicts our momentum/continuation strategy. Sweep showed BB=OFF dominates in ALL 20 config pairs (BB=Y vs BB=N).
  - **SHORT results**: Sharpe 3.54 → 4.33 (+0.79), PnL +$106K, DD 28.6% → 27.0% (-1.6pp), WR 66.2% → 66.0% (-0.2pp). OOS: PnL $23K → $54K, WR 63.2%.
  - **LONG sweep result**: Baseline (ROC10=1.75%, Vol=1.15x, BB Upper=ON) tied for best Sharpe (4.33). No changes needed — BB Upper confirms true breakout (close > +2σ), which IS correct for momentum.
  - **roc5 added to logs**: `orchestrator.ts` now displays ROC5 in feature summary alongside ROC10, so the actual filter value is visible.
  - **Alignment**: All code paths (live/paper/backtest/parity/symbolEngine) read from unified `MomentumConfig.ENTRY_SHORT` — single source of truth. Parity auto-aligned via backtest engine.
  - **Files**: `momentumConfig.ts`, `momentumSignal.ts`, `orchestrator.ts`, `agentState.ts`, `scripts/sweep-short-filters.ts`, `scripts/sweep-long-filters.ts`

- V5.125b: Comment/variable cleanup — eliminate misleading "1h" references + SHORT confidence fix:
  - **Regime variable naming**: All `btcCloses1h` → `btcClosesRegime`, `btcSma200_1h` → `btcSma200Regime`, `btcNow1h` → `btcNowRegime`, `cachedBtcCandles1hWindow` → `cachedBtcCandlesRegimeWindow`. Since V5.102 regime uses 15m by default — "1h" in variable names was confusing.
  - **Regime comments updated**: `// V5.82: Use 1h candles for SMA200 regime` → `// V5.102: Use regime-timeframe candles (default 15m, configurable via BTC_REGIME_TIMEFRAME)` in `getMarketConditions()`, `checkMomentumSignal()`, and `shouldExitPosition()`.
  - **SHORT confidence fix**: `distanceFromLower` (distance below BB Lower) replaced with `distanceBelowMa20` (distance below MA20). BB Lower filter was removed in V5.125 but the confidence calculation still used it — gave 0 or negative values since price is no longer required to be below BB Lower. MA20 is always positive here (filter `priceBelowMa20` guarantees it). Reason string: `dist=` → `dist_ma20=`.
  - **Zero behavioral change**: `confidence` field is informational only (never read downstream). Variable renames are cosmetic.
  - **Files**: `momentumSignal.ts`, `exitLogic.ts`, `backtestService.ts`

## Multi-User Scaling

System designed for 40+ users × 20 agents (800+ concurrent agents) with single Binance IP.

### API Weight Budget (2400w/min Binance limit)
- **Position sync**: 0w/min (WebSocket user data stream)
- **Balance sync**: 0w/min (WebSocket ACCOUNT_UPDATE)
- **Proactive limit check**: 0w/min (WS ORDER_TRADE_UPDATE cache, REST fallback after 10s)
- **Order execution**: ~100w/min (via orderQueue rate limiting)
- **SL/trailing placement**: ~50w/min (tracked via ipWeightTracker)
- **Dashboard fallbacks**: ~30w/min (deduped via exchangeAPIDeduplicator, 10s TTL)
- **Estimated total**: ~180w/min = 7.5% of budget

### Key Safeguards
- `ipWeightTracker.ts`: Single source of truth for all REST weight per minute. `binanceRestQueue` auto-records after each execution. All direct REST calls also record weight. Warns at 75% (1800w)
- `orderTradeUpdateByOrderId` cache: Capped at 2000 entries with LRU eviction
- `checkProactiveLimitFill()`: WS-first with REST fallback after 10s (prevents hang if WS event lost)
- Staggered session restore: 500ms between users at startup (avoids burst)
- Per-user order queues: Isolated so one user's burst doesn't block others
- `requireApiKeysForLive()`: Blocks live sessions without valid API keys
- Live sessions halted at restore if user's API keys were deleted

### Per-User Isolation
- Each user gets own exchange instance (CCXT), WS data stream, order queue
- `SignalRanker`: Per-user model instances
- `CapitalPool`: Per-user balance tracking
- Agent sessions scoped by userId in DB
- WS multiplexing: Shared market data streams, per-user data streams

## Refactoring (completed)

Major codebase refactoring across multiple phases:

1. **Centralized constants** (`config/constants.ts`): All magic numbers (cache TTLs, sync intervals, order queue config) extracted from `simpleAgent.ts` and `orderQueue.ts`
2. **Typed exchange interfaces** (`types/exchange.ts`): Replaced inline `any` Exchange type with `CcxtOrder`, `CcxtPosition`, `CcxtTrade`, `CcxtBalance`, `Exchange` interfaces. Eliminated 30+ `as any` casts
3. **Mutex caches** (`cacheManager.ts`): Promise-based mutex on global BTC 15m/1h candle caches and leverage cache. Prevents concurrent fetch races
4. **Extracted modules (phase 1)**: `positionPersistence.ts` (DB ops), `exchangeOrderManager.ts` (SL/trailing/proactive limits)
5. **Walk-forward testing** (`walkForwardService.ts`): Sliding train+test window validation. Route: `POST /api/backtest/walk-forward`
6. **Grid optimization** (`optimizationService.ts`): Parameter grid search ranked by OOS Sharpe. Route: `POST /api/backtest/optimize`
7. **Cash mode** (`momentumSimple.ts`): ADX + ATR + SMA200 slope regime detection. Skips entries in CHOPPY/LOW_VOL markets
8. **Error handling**: All `catch (error: any)` → `catch (error: unknown)` with `errMsg()` helper. `ExitReason` union extended for cleanup reasons
9. **Extracted modules (phase 2)**: `positionOpener.ts` (openPosition ~970 lines with PositionOpener class + context interface), `realtimeExitHandler.ts` (checkRealtimeExit ~845 lines with RealtimeExitHandler class owning NFS system, proactive limits, trailing breach state)
10. **V5.108 split momentumSimple.ts** into 5 focused modules (config, indicators, signals, exits, risk) with barrel re-export. 3,562 lines → 5 files totaling ~3,600 lines, zero import changes for consumers.
11. **V5.108 split simpleAgent.ts** into orchestrator.ts + capitalPool.ts + 4 agent/ modules (candleFetcher, exchangeSync, positionCloser, agentState). 3,793 lines → ~1,830 lines orchestrator + ~2,100 lines in extracted modules.
12. **Dead code cleanup**: 49 unused files deleted (10,700+ lines), reducing src/ from 115 → 66 .ts files (43% reduction).

## V5.110-V5.111: Momentum Exhaustion Detector (Proactive Trailing Exit)

### Problem
Trailing stop exits in live trading suffer from two issues:
1. **Proactive LIMIT order bug** (V5.87): SELL LIMIT below market fills immediately (wrong order type). Only activated within 0.6% of trailing (too late). Used NFS on partial 1m candles (unreliable).
2. **2-candle close confirmation delay**: Standard trailing exit waits for 2 consecutive candle closes below trailing stop. During this 30-min blind window, price can bounce or crash further.
3. **Exchange trailing stops** (Binance) trigger on wicks, killing momentum capture.

### Solution: Indicator-based exhaustion detection
Instead of waiting for price to breach the trailing stop, detect when momentum is DYING using 5 indicators, then place a STOP_MARKET proactively. The exhaustion score IS the noise filter — if 5 independent indicators say "momentum is dying," the stop triggering is signal, not noise.

**5 Components (100 points total):**
1. **ROC Deceleration** (25pts) — Rate of change declining over 3 windows
2. **Volume Dry-Up** (25pts) — Volume declining while price still advancing
3. **Body Shrinkage** (20pts) — Candle bodies getting smaller (indecision)
4. **Rejection Wicks** (15pts) — Growing wicks against the move direction
5. **Proximity to Trailing** (15pts) — How close price is to trailing stop

**Behavior:**
- Score >= PLACEMENT_THRESHOLD (65) → place STOP_MARKET at trailing price
- Score < CANCEL_THRESHOLD (45) → cancel stop (momentum recovered, hysteresis)
- In live: runs on closed 1m candles, not partial candle noise
- Order type: STOP_MARKET with reduceOnly + MARK_PRICE (not LIMIT)

### Files
- **`services/momentumExhaustion.ts`** — Core calculator (5 indicators, ExhaustionResult)
- **`strategies/exchangeOrderManager.ts`** — Changed from LIMIT to STOP_MARKET with stopLossPrice + reduceOnly
- **`strategies/realtimeExitHandler.ts`** — Exhaustion integration replacing old NFS partial-candle logic
- **`services/backtestService.ts`** — Exhaustion simulation in backtest loop (15m approximation + optional 1m zoom-in via `allData1m`)
- **`strategies/config/momentumConfig.ts`** — EXHAUSTION_STOP_ENABLED, EXHAUSTION_PLACEMENT_THRESHOLD (65), EXHAUSTION_CANCEL_THRESHOLD (45), EXHAUSTION_MIN_CANDLES (10)

### Testing Approach: Dynamic 1m Fetch Per Trade Window
The backtest runs on 15m candles, but simulating stop execution on 15m is inaccurate (15-min wicks that recover are caught as breaches). To properly test:

**DO NOT download full 1m data** (500MB+ for 1 year, can't commit to git, slow to process).

**Instead, use `scripts/analyze-exhaustion-1m.ts`:**
1. Run baseline 15m backtest (exhaustion OFF) → get all ~890 trades
2. Filter trailing exit trades (~400 trades)
3. For each trade, dynamically fetch 1m candles from Binance (only the entry→exit window)
4. Replay trailing stop + exhaustion at 1m resolution
5. Compare: did exhaustion catch the exit earlier? At a better price?

**Data needed:** ~400 trades × 300 candles = ~120K candles (~80 API requests, takes seconds)

```bash
# Single threshold analysis
npx tsx scripts/analyze-exhaustion-1m.ts

# Custom threshold
npx tsx scripts/analyze-exhaustion-1m.ts --threshold 55

# Sweep thresholds 35-80
npx tsx scripts/analyze-exhaustion-1m.ts --sweep
```

**What the script measures per trade:**
- Did exhaustion trigger before the standard trailing exit?
- Was the exit price better (higher PnL) or worse?
- How much earlier did it exit?
- Overall: total PnL delta, win rate change, per-trade breakdown

**Key insight:** The replay replicates the live trailing stop logic at 1m resolution:
- Incremental HWM tracking on each 1m candle
- Progressive trailing tiers (0.4% → 0.8% → 1.5% → 2.5% based on move size)
- Exhaustion calculated on last 20 closed 1m candles
- Stop triggers checked at 1m resolution (not 15m wick approximation)

### 15m Backtest Results (for reference, approximate)
On 15m data (less accurate due to wick simulation):
- Threshold 55: 21 proactive exits, -$582 delta, best DD at 25.6%
- Threshold 65: 8 proactive exits, -$1,866 delta (all 8 were winners, avg $385)
- Lower thresholds = more proactive exits but worse PnL (15m wicks create false triggers)
- 1m results expected to be significantly different (more accurate stop simulation)

### Next Steps
1. Run `analyze-exhaustion-1m.ts` on a machine with Binance API access
2. Find optimal threshold where exhaustion adds value (better PnL or better DD)
3. Decide: enable in live + backtest, or live-only (if 15m approximation stays negative)
4. Consider: exhaustion could replace 2-candle confirmation entirely for faster reactivity

### V5.111 Backtest Performance Optimization (67s → 53s, 21% faster)

Zero behavioral changes — identical results (891 trades, $59,148, 64.6% WR).

**Optimizations applied:**
1. **Remove `setImmediate` yields** (~7.5s saved): `runBacktestComputation` always runs in a worker thread (`backtestWorker.ts`) or standalone scripts — the ~50K `setImmediate` yields to protect the server event loop were pure overhead.
2. **Cache `btcCandles1h` window**: Previously `btcCandles1h.slice(0, regimeCursor)` was called twice per symbol per iteration (growing up to 500 elements). Now cached, only recreated when regime cursor advances.
3. **Hoist BTC regime + BTC window**: BTC SMA200 regime and BTC 15m window for signal detection were computed 10× per BTC step (once per symbol). Now computed once per BTC step.
4. **`calcMA` in-place summation**: `calcSMA(values, 200)` was creating a 200-element `slice(-200)` every call. Now sums in-place from array end. Eliminates ~100K allocations per run.

**Remaining bottleneck** (~53s): Indicator math inside `checkMomentumSignal()` and `shouldExitPosition()` — 350K calls computing ATR/BB/ROC/ADX/SMA on 200-candle windows. Further improvement would require incremental (rolling) indicator updates — significant refactor requiring parity verification.

### V5.113: 1m Post-Processing for Backtest Trailing Exits

**Problem**: Backtest trailing exits snap to 15m boundaries (timing faux, PnL approximatif). Live exhaustion detector places STOP_MARKET that fills on any 1m wick → systematic DURATION + PNL mismatch on TRAIL_PROACTIVE trades.

**Solution**: Two-pass architecture:
1. Pass 1: `runBacktestComputation()` on worker thread (15m, fast, 0 API)
2. Pass 2: `postProcess1mTrailingExits()` on main thread — fetch 1m candles per trailing trade window, replay exhaustion + STOP_MARKET, adjust trade results, recalculate summary

**Files:**
- **`services/backtest/trailingReplay1m.ts`** (~450 lines): `Candle1mFetcher` (cached per-symbol, rate-limited via ipWeightTracker + globalRestCircuitBreaker), `replayTradeAt1m()` (stop_market mode with progressive trailing + exhaustion hysteresis + 15m boundary fallback), `postProcess1mTrailingExits()` (orchestrator), `recalculateSummaryIncremental()` (V5.114: delta-based capital chain adjustment)
- **`backtestService.ts`**: `postProcess1m?: boolean` added to `BacktestParams` (default `false`). Called after worker via dynamic import. Graceful fallback on failure.
- **`parityVerificationServiceV2.ts`**: No changes needed — benefits automatically via `runBacktest()`.
- **`routes/backtest.ts`**: `stableParamsHash()` includes `postProcess1m` (V5.114 fix — was missing, caused cache collisions between 1m/non-1m runs)

**API budget**: ~400 trailing trades × 1-2 CCXT requests = ~600 requests, ~5min. Cache per-symbol reduces to ~100-200 actual requests.
**Config**: Uses `MomentumConfig.EXIT.EXHAUSTION_*` thresholds. Trailing tiers read from `MomentumConfig.EXIT.TRAILING_*`.
**Disable**: Pass `postProcess1m: false` to `runBacktest()` params.

- V5.114: Fix 1m post-processing capital chain corruption:
  - **Problem**: `recalculateSummary()` rebuilt the capital chain linearly (`capitalAfter = capitalBefore + netPnlUsd`) after 1m replay modified trailing trades' PnL. This ignored concurrent positions (the 15m backtest uses `capital` + `capitalInUse` separately). When 1m replay worsened early trades, all subsequent trades had reduced capitalBefore but kept their original large marginUsd → positions oversized relative to capital → cascading losses → capital went negative → DD 165.8% (impossible in reality).
  - **Fix**: Replaced `recalculateSummary()` with `recalculateSummaryIncremental()`. Saves original PnLs before replay, then applies cumulative PnL deltas to the original capital chain (which correctly models concurrency). Each replayed trade's delta shifts all subsequent trades' `capitalBefore`/`capitalAfter` without affecting position sizing.
  - **Also fixed**: `stableParamsHash()` in `routes/backtest.ts` now includes `postProcess1m` in the hash. Previously, enabling/disabling 1m replay returned the same cached result (hash collision).
  - **Validation** (Dec 2025, 1 month, $2K, 4.5x, 10 symbols): DD went from 165.8% → 20.7%. PnL: $1,419 (15m) vs $748 (with 1m replay) — 1m replay costs ~47% PnL because exhaustion detector on 1m candles exits trailing trades prematurely (fires on temporary dips that recover in 15m).
  - **Files**: `services/backtest/trailingReplay1m.ts`, `routes/backtest.ts`

- V5.115: Fix 1m post-processing DD > 100% + volatility adaptation parity:
  - **Problem 1 (DD > 100%)**: V5.114's `recalculateSummaryIncremental()` used delta-shifted `capitalAfter` for the equity curve. With ~661 trailing trades totaling ~$115K PnL, the 1m replay's cumDelta could reach -$57K — exceeding early capital ($2K), pushing `capitalAfter` negative → DD 165.8%. The incremental delta approach is correct for trade-level data but breaks equity curve when total delta >> early capital.
  - **Fix 1**: Equity curve and DD now rebuilt from **cumulative realized PnL** (`equity = initialCapital + Σ netPnlUsd`). Trades sorted by exit time, daily PnL summed. Monthly stats `capitalEnd` also uses cumulative PnL instead of `capitalAfter`. Trade-level `capitalBefore`/`capitalAfter` still adjusted incrementally (for display), but equity metrics don't depend on them.
  - **Problem 2 (volatility adaptation missing)**: `trailingReplay1m.ts` used raw `MomentumConfig.EXIT.TRAILING_*` values without volatility adaptation. Live's `shouldExitPosition()` applies TWO layers: (1) `determineVolatilityRegime()` adapts base distance by ATR regime, (2) `VOL_MULTIPLIER` (LOW=0.8, MED=1.0, HIGH=1.6) scales progressive tier distances. The replay had neither → trailing stops systematically tighter than live in HIGH vol markets.
  - **Fix 2**: Added `aggregate1mTo15m()` to bucket 1m candles into 15m for `determineVolatilityRegime()`. `computeVolMultiplier()` computes regime + multiplier. `getTrailingConfig()` accepts vol params. `getTrailingDistance()` applies `VOL_MULTIPLIER` to progressive tiers (matching exitLogic.ts:423-446). Falls back to MEDIUM regime if < 14 15m candles available.
  - **Also fixed**: Replayed trades now update `t.month` and `t.day` fields when exitTime changes (were stale).
  - **Files**: `services/backtest/trailingReplay1m.ts`

- V5.117: Full live-parity 1m replay + parity audit fixes:
  - **Problem 1 (Vol adaptation was static)**: V5.115 computed a SINGLE static vol regime from ALL 1m candles aggregated to 15m. Live's `shouldExitPosition()` recomputes `determineVolatilityRegime()` dynamically every call with the latest 15m candles. This mismatch caused wrong trailing stops (single regime ≠ dynamic regime), leading to 173% DD.
  - **Fix 1**: Replay now aggregates 1m→15m incrementally. At each 15m boundary, completes the current bucket, adds to 15m buffer, recomputes vol regime. Matches live's dynamic per-call behavior. Extended warmup from 25min to 4h for ATR-14 (14×15m). Zero extra API cost (cache + pure computation).
  - **Problem 2 (Test didn't match live)**: `analyze-exhaustion-1m.ts` used fixed trailing config with no vol adaptation. Results (+$33K) were based on tighter stops than live would use in HIGH vol markets. Also excluded TRAIL_NFS_HIGH and added 2-candle close confirmation to match live RT handler.
  - **Fix 2**: Test updated with same dynamic vol adaptation, TRAIL_NFS_HIGH exclusion, 4h warmup.
  - **Problem 3 (Parity audit: inconsistent fallback defaults)**: Exhaustion threshold fallbacks were 65/45 in `backtestService.ts` and `realtimeExitHandler.ts` but config defines 35/20. `TRAILING_VOL_HIGH_MULT` fallback was 1.5 in exitLogic.ts but config defines 1.6. Never reached at runtime (config IS defined), but dangerous if config fields are ever removed.
  - **Fix 3**: All fallback defaults now match config: exhaustion 35/20 everywhere, vol high mult 1.6 everywhere.
  - **Replay mechanisms** (2 exit paths, whichever fires first): (1) Exhaustion STOP_MARKET at trailing price on wick touch, (2) 2-candle 1m close confirmation as fallback.
  - **Excluded from replay**: TRAIL_NFS_HIGH (already at optimal trailing stop price), TRAIL_PROACTIVE (already handled by 15m MODE B).
  - **Files**: `services/backtest/trailingReplay1m.ts`, `scripts/analyze-exhaustion-1m.ts`, `strategies/exits/exitLogic.ts`, `strategies/realtimeExitHandler.ts`, `services/backtestService.ts`, `scripts/simulate-xrp-vol-adaptive.ts`
  - **Parity impact**: Closes vol adaptation gap between replay and live. Closes fallback default inconsistencies across all code paths.

- V5.118: Exhaustive audit fixes — ATR-scaled trailing, SHORT filter, COSTS centralization:
  - **ATR-scaled trailing**: Progressive trailing tiers now scale with asset's ATR at entry instead of fixed 3%/4%/6%. Tiers at `2×/3×/4.5× entryAtrPct` with distances `0.5×/1.0×/1.5× entryAtrPct × volMultiplier`. Falls back to fixed tiers when `entryAtrPct` is unavailable. Config: `TRAILING_ATR_SCALED_ENABLED: true`, `TIER1/2/3_ATR_MULT`, `TIER1/2/3_DIST_ATR_MULT`.
  - **entryAtrPct**: `calcATR(candles, 14) / lastClose * 100` snapshot at entry. Computed in `positionOpener.ts` (live/paper) and `backtestService.ts` (sim). Stored on Position interface. Propagated through `checkBacktestExit()` to `shouldExitPosition()`.
  - **SHORT alternation filter**: New filter in `checkMomentumSignal()` BEAR path — rejects signals when last 5 closes alternate direction > 2 times (choppy market). Config: `CANDLE_PATTERN_FILTER.SHORT_MAX_ALT5: 2`.
  - **Orchestrator regime fix**: 3 fallback paths in `orchestrator.ts` (checkEntry, checkExit, getMarketConditions) now respect `BTC_REGIME_TIMEFRAME` config instead of hardcoding 15m. Fetches real 1h candles when config is '1h'.
  - **COSTS centralization**: All fee references use `MomentumConfig.COSTS` (single source of truth). Moved hardcoded values from `backtestService.ts`, `trailingReplay1m.ts`, `positionPersistence.ts` to config block: `TRADING_FEE_PCT: 0.04`, `SLIPPAGE_PCT: 0.05`, `FUNDING_RATE_PCT: 0.01`, `PAPER_FEE_RATE: 0.0004`.
  - **calcSafeLeverage in backtest**: Imported from `positionSizing.ts` — backtest now reduces leverage in high-vol like live does.
  - **SEED_SYMBOLS expanded**: Added SEI, SUI, XRP to `candleCache.ts`.
  - **Dead config cleanup**: 8 unused config blocks marked with DEAD comments in `momentumConfig.ts`.
  - **Files**: `momentumConfig.ts`, `exitLogic.ts`, `momentumSignal.ts`, `orchestrator.ts`, `backtestService.ts`, `trailingReplay1m.ts`, `positionPersistence.ts`, `positionOpener.ts`, `candleCache.ts`, `analyze-exhaustion-1m.ts`

- V5.119: Fee doubling bug fix + entryAtrPct DB persistence + alignment audit:
  - **CRITICAL: Paper fees doubled in DB** (`positionPersistence.ts:284`): `positionCloser.ts` computes `paperFeeUsd` = entry fee + exit fee + slippage + funding (~$1.82 for $1K notional). This complete amount was passed to `positionPersistence.ts` which blindly applied `calculatedFee * 2`, storing ~$3.64 instead of ~$1.82. Fix: `feeUsd != null ? calculatedFee : calculatedFee * 2` — only double when using the fallback path (exit-side only).
  - **Data model clarification**: `Trade.realizedPnlUsd` = GROSS (price diff only). `Trade.feesUsd` = separate fee field. Frontend `Net P&L = GROSS - Fees` is structurally correct but was using the 2x-inflated fee.
  - **entryAtrPct DB persistence**: Added `entryAtrPct Float?` column to Prisma `Position` model. Saved in `savePositionToDb()`, loaded in `loadExistingPosition()`. Agent restart mid-trade now preserves ATR-scaled trailing behavior instead of falling back to fixed tiers.
  - **entryAtrPct multi-position**: Additional positions (paper+live) now receive the same `entryAtrPct` as the primary position. Previously missing → used fixed trailing tiers.
  - **Fee rate centralized in positionOpener**: Replaced 2 hardcoded `0.0004` (lines 401, 890) with `MomentumConfig.COSTS.PAPER_FEE_RATE`.
  - **Alignment audit result**: All 4 code paths (live/paper via orchestrator, backtest, parity via backtest, trailingReplay1m) confirmed aligned for: entryAtrPct computation, calcSafeLeverage, COSTS, SHORT alternation filter, ATR-scaled trailing. Parity service auto-aligned (delegates to backtest engine).
  - **Files**: `positionPersistence.ts`, `positionOpener.ts`, `prisma/schema.prisma`

- V5.120: Parity verification fixes — forcedEntryTimestamp, fixed SL, entryAtrPct, diagnostics:
  - **CRITICAL: forcedEntryTimestamp dual-path fix (V5.120b)**: `Trade.entryTs` is NOT always the same thing. Path A (agent restart): `realEntryTime` is overwritten by `openedAt` (candle OPEN) → entryTs = exact 15m boundary (offset = 0ms). Path B (no restart): `realEntryTime = Date.now()` → entryTs = wall-clock (offset > 0ms from boundary). V5.120 initially "always +15m" which broke Path B (pushed wall-clock entries one candle too far → BT checked WRONG candle → `bear_regime:bullish_candle`). Verified via Binance REST: DOGE at 16:15 UTC = BULLISH, but signal candle at 16:00 UTC = BEARISH. Fix: `offset === 0 ? floor + CANDLE_15M_MS : floor`. Both paths yield forcedEntryTimestamp = candle CLOSE boundary. Path A: candle_open + 15m = close. Path B: floor(wall_clock) = close (naturally).
  - **P0: Fixed SL in parity backtest** (`backtestService.ts`): Live places a fixed STOP_MARKET at entry via `calcDynamicStopLoss()` — never recalculated. But `shouldExitPosition()` recalculates SL dynamically per candle (volatility regime can shift). Added `fixedSlPct` to `BacktestSimPosition` interface. Forced entry block now computes dynamic SL at entry time and stores it. `checkBacktestExit()` checks fixed SL on wicks BEFORE calling `shouldExitPosition()`. Revives the V5.95 approach that was lost in V5.101's parity rewrite.
  - **P1: entryAtrPct in forced entry** (`backtestService.ts`): Forced entry block now computes `entryAtrPct = calcATR(window, 14) / lastClose * 100` at entry time. Without this, ATR-scaled trailing (V5.118) fell back to fixed tiers in parity, causing DURATION_MISMATCH on trailing exits.
  - **NO_SIGNAL diagnostics** (`backtestService.ts`, `parityVerificationServiceV2.ts`): When forced entry gets NO_SIGNAL, diagnostic now runs `checkMomentumSignal` to identify root cause (regime mismatch, toxic hour, signal rejection reason). Encoded in `NO_SIGNAL_AT_FORCED_TIME|regime=BULL_wanted=short` format. Parity service extracts and displays the diagnostic suffix.
  - **Timezone fix** (`ReportsPage.tsx`): Parity timestamps in frontend were displayed in browser locale (Israel UTC+2), while Telegram report used UTC. Added `dayjs.extend(utc)` and switched all parity timestamp displays to `.utc().format()`.
  - **Files**: `parityVerificationServiceV2.ts`, `backtestService.ts`, `ReportsPage.tsx`
  - **Parity impact**: Should resolve most NO_SIGNAL results. Fixed SL + entryAtrPct should reduce EXIT_MISMATCH and DURATION_MISMATCH. Pending end-to-end validation (requires running server).

- V5.130: Symbol tier system + SMA200 skip zone activation + signal ranker tier priority:
  - **Symbol selection overhaul**: Ran individual backtests for 26 symbols (Jan-Dec 2025, $2K, 5x). Classified into Tier A (9 symbols, Sharpe>=2, PF>=1.3) and Tier B (10 symbols, Sharpe>=1, PF>=1.1). Combined individual PnL: $93,447.
  - **Tier A**: WIF ($28,969), UNI ($8,275), FET ($7,727), STX ($7,674), IMX ($6,374), ARB ($4,077), SEI ($3,675), SUI ($3,504), NEAR ($3,456)
  - **Tier B**: ADA ($3,220), APT ($2,615), ETH ($2,503), SONIC ($2,321), RENDER ($1,997), XRP ($1,575), DOGE ($1,508), DOT ($1,491), BCH ($1,276), SOL ($1,212)
  - **Not compatible**: LTC, FTM, OP, LINK, AVAX, TIA, ATOM, BTC (negative or marginal individually), INJ, JUP, BNB
  - **SMA200 skip zone activated**: `BTC_SMA200_SKIP_ZONE_PCT: 1.0` (was 0/disabled). Skips entries when BTC is within 1% of SMA200. Validated: Sharpe 3.21 (+0.19), DD 37.1% (-17.8pp), PnL -9% (acceptable trade-off for risk reduction).
  - **Quality bypass**: Tested composite quality score (volRatio+ROC+smaSlope) to let high-quality signals through skip zone. Result: USELESS — no signals in skip zone have quality >= 55. Disabled: `BTC_SMA200_SKIP_ZONE_QUALITY_BYPASS: 0`.
  - **Signal ranker tier priority**: `getTopSignals()` sorted by tier first (A before B), then by score. **NOTE: Reverted in V5.131** — tier-first sorting hurt combined PnL. Pure score-based sorting restored.
  - **Config**: `SIGNAL_TIER_A` array added to `MomentumConfig` for Tier A symbol list. `SYMBOLS` updated to 19 (9 Tier A + 10 Tier B). **NOTE: Updated in V5.131** — reduced to 11 symbols based on combined BT.
  - **Files updated** (8 files): `momentumConfig.ts` (symbols, tiers, skip zone, leverage), `momentumSignal.ts` (quality bypass logic), `signalRanker.ts` (tier field, tier-first sorting), `orchestrator.ts` (tier in addSignal), `backtestService.ts` (tier-first ranking), `candleCache.ts` (20 seed symbols), `positionSizing.ts` (SONIC liquidity), `exchangeOrderManager.ts` (new symbol precisions), `backtest.ts` (defaults, presets, walk-forward/optimize symbols via MomentumConfig.SYMBOLS), `AgentCreationModal.tsx` (19 recommended symbols, banner V5.130)
  - **Parity**: Skip zone + quality bypass in shared `checkMomentumSignal()` → auto-aligned across live/paper/backtest/parity. Signal ranking tier-first in both live and backtest.

- V5.131: Combined-BT symbol validation + tier-first sort removal:
  - **CRITICAL INSIGHT: Individual BT ≠ Combined BT**: Per-symbol backtests give misleading results because they don't model signal competition for limited capital (max 2 positions). A symbol can be excellent solo (e.g., SEI $3,675 individual) but negative in combined BT because its signals coincide with higher-scoring symbols (WIF/FET fire simultaneously). XRP/DOT contribute in combined BT because their signals fill temporal gaps when top symbols are idle. **Always validate symbol selection with combined multi-symbol backtest.**
  - **Symbols reduced from 19 to 11** based on combined BT results (later superseded by V5.132).
  - **Tier-first sorting REMOVED from signalRanker**: V5.130 added sorting by tier (A before B) then score. Combined BT showed this HURTS PnL — pure score-based sorting performs better. `getTopSignals()` now sorts by `score` only.
  - **Market filter disabled**: BT shows +174% PnL without market filter.

- V5.132: Optimized 9-symbol portfolio — +47% PnL vs V5.131:
  - **Methodology**: Systematic combined-BT sweep testing 8 combinations (baseline 11, user combo 9, union 14, C9+UNI, C9+ARB, C9+NEAR, C9+UNI+ARB, B11+AVAX, B11+ADA). All on 2025 full year, $2K, 5x leverage.
  - **Winner: 9 symbols** (AVAX, FET, WIF, DOT, IMX, STX, ADA, RENDER, XRP):
    - **$86,524 PnL** (+47% vs V5.131 $59,018)
    - **65.9% WR** (+2.3pp vs 63.6%)
    - **33.2% DD** (-3.1pp vs 36.3%)
    - **Sharpe 3.53**, PF 1.51, 1043 trades
  - **Key findings from sweep**:
    - Adding ANY symbol to the 9 dilutes PnL: C9+NEAR $85,687, C9+UNI+ARB $85,381, C9+ARB $80,591, C9+UNI $75,307
    - UNION_14 (all symbols): $68,867 — more symbols = more signal competition = worse
    - B11+AVAX: $66,953, B11+ADA: $64,600 — baseline can't be saved by adding symbols
  - **Per-symbol combined PnL**: WIF $17,122, AVAX $15,725, FET $14,058, ADA $10,502, STX $10,145, XRP $5,713, DOT $5,170, RENDER $4,179, IMX $3,910
  - **Tier A** (>$5K): WIF, AVAX, FET, ADA, STX
  - **Tier B** (<$5K): XRP, DOT, RENDER, IMX
  - **Removed from V5.131** (dilute combined PnL): UNI, ARB, NEAR, APT, ETH
  - **Files updated**: `momentumConfig.ts` (SYMBOLS 9, SIGNAL_TIER_A 5, LEVERAGE), `candleCache.ts` (SEED_SYMBOLS 10), `telegramReporter.ts` (REPORT_SYMBOLS 9), `backtest.ts` (presets/defaults), `AgentCreationModal.tsx` (V5.132 banner, 9 recommended), `BacktestPage.tsx` (9 defaults)
  - **Data files cleaned**: Deleted 15m/1h JSON files for APT, ARB, ETH, NEAR, UNI, BTC_1h, FET_1h, WIF_1h. Restored AVAX, IMX, ADA from git (deleted in V5.131).
  - **SYMBOLS_NOT_COMPATIBLE fix**: ADA, IMX, AVAX were incorrectly left in `SYMBOLS_NOT_COMPATIBLE` from V5.131 era, blocking trades on 3 of the 9 optimal symbols. Removed. The NOT_COMPATIBLE list now has a guard comment to prevent recurrence.

- V5.134: NFS HIGH exit price — REVERTED (trailingStopPrice is a target, not an illusion):
  - **Investigation**: DOT trade parity gap (+6.95%: BT 11.2% vs paper 4.2%). NFS HIGH exits used `trailingStopPrice` in BT/live but paper got candle close. Analysis showed live places MARKET order → fills at ~candle close. Attempted fix: use `current.close` everywhere for "honest" pricing.
  - **Backtest result**: **CATASTROPHIC**. $86,524 → -$56 PnL, 65.9% → 58.85% WR, 33.2% → 78.8% DD. NFS HIGH = 350 trades (most frequent exit) — degrading each by $200+ avg destroyed the entire edge.
  - **LESSON (confirmed V5.92)**: `trailingStopPrice` is NOT optimistic — it's a **TARGET** the system achieves via: (1) exhaustion detector placing proactive STOP_MARKET at trailing price, (2) NFS filtering noise so breaches are real. The mechanism WORKS — most NFS HIGH exits DO get close to trailing price via the proactive stop. Paper uses candle close (no exchange orders) which explains the parity gap on DOT.
  - **Resolution**: All 3 files reverted to `trailingStopPrice`. Paper 15m handler keeps `currentPrice` (realistic paper simulation). Comments updated with V5.92/V5.134 lesson. Drash skill asymmetry table restored.
  - **Parity gap status**: NFS HIGH BT-vs-paper gap is ACCEPTED (paper can't simulate proactive stops). BT-vs-live gap is small (proactive stop fills at ~trailing price).
  - **Files**: `realtimeExitHandler.ts`, `orchestrator.ts`, `backtestService.ts`, `.claude/skills/drash-chokhmah/skill.md`

- V5.126: Fix BTC 15m stale cache when no agents active:
  - **Problem**: `btcDataService.ts` reads WS kline cache every 5s but never called `subscribeToKline()`. Agents keep the subscription alive via `candleFetcher.ts:130`, but with 0 active sessions, the 10-min TTL pruned the `btcusdt@kline_15m` stream → cache stale after 45min → STALE_CACHE warnings every 5s.
  - **Fix**: Added `getBinanceWebSocket().subscribeToKline('BTCUSDT', '15m')` in `refresh()`. Since refresh runs every 5s, TTL (10min) is never reached.
  - **Pattern**: Any service that reads WS kline cache (`getKlinesWithMeta`/`getKlines`) MUST also re-subscribe periodically to prevent TTL pruning. The WS subscription is not permanent — it has a 10-min TTL (`klineSubscriptionTtlMs`) and gets pruned by `pruneStaleKlineSubscriptions()` if no caller refreshes `lastRequestedAt`.
  - **File**: `btcDataService.ts`

- V5.136: Optimised RT trailing exits — proactive STOP + crash safety:
  - **PRE_BREACH zone widened (0.6% → 1.5%)**: NFS state machine starts monitoring earlier, giving the exhaustion detector more time to place proactive STOP_MARKET before trailing breach. Config: `PRE_BREACH_DISTANCE_PCT: 1.5` in both `momentumConfig.ts` and `nfsRealtimeExit.ts`.
  - **Exhaustion proximity thresholds recalibrated**: In `momentumExhaustion.ts`, proximity scoring bands widened to match new PRE_BREACH zone: `<0.5%` (15pts), `<1.0%` (12pts), `<1.5%` (8pts), `<2.0%` (4pts), `>2.0%` (0pts).
  - **Exhaustion thresholds lowered (35→25 placement, 20→15 cancel)**: Places proactive STOP_MARKET earlier/more often. At 25, proximity (15) + one partial component (10) suffices. 10-point hysteresis gap maintained. Fallback defaults aligned to 25/15 across all 3 code paths (V5.117 pattern).
  - **Crash safety STOP (3% below trailing)**: Permanent STOP_MARKET as flash crash insurance. Never fires in normal conditions (data: 1.5% = 116 false exits, 3% = ~0). Lifecycle: placed when trailing activates, updated on ratchet (>0.1% move), re-placed after cancelAllOrders kills it (1s poll), cancelled on normal exit. Both exhaustion and crash safety stops coexist independently on exchange.
  - **New exit reason**: `EXIT_TRAIL_CRASH_SAFETY` in `exitReasons.ts`, maps to `TRAIL` family via `normalizeToFamily()`.
  - **Paper simulation**: Orchestrator checks 15m candle wicks against crash safety price for paper mode (live uses exchange STOP_MARKET via RT handler).
  - **No backtest change**: Crash safety not simulated in BT (no exchange orders). Exhaustion thresholds auto-aligned via shared `MomentumConfig`.
  - **Propagation**: PRE_BREACH → NFS state machine only (RT handler). Proximity → MomentumExhaustionCalculator (RT + BT + 1m replay, auto-aligned). Exhaustion 25/15 → config (auto-aligned). Crash safety → RT handler (live) + orchestrator (paper).
  - **Sharp reversal enabled**: 6th exhaustion component (`EXHAUSTION_SHARP_REVERSAL_ENABLED: true`). Detects big opposite-direction candles (body > 2x avg + ROC threshold). BT validation: V136+Sharp vs V136: +$1K PnL ($87,721 vs $86,711), -2.9pp DD (38.0% vs 40.9%), +18 proactive exits (110 vs 92), Sharpe 3.44 vs 3.42. Net positive with no downside.
  - **Files**: `momentumConfig.ts`, `nfsRealtimeExit.ts`, `momentumExhaustion.ts`, `exitReasons.ts`, `exchangeOrderManager.ts`, `realtimeExitHandler.ts`, `orchestrator.ts`, `backtestService.ts`, `trailingReplay1m.ts`

- V5.137: Paper realistic NFS MED/LOW exit pricing:
  - **Problem**: Paper NFS MED and LOW exits used `Math.max(trailingStopPrice, currentPrice)` for LONG (and min for SHORT) — always picking the best price. This is unrealistic: paper has no exchange orders, so it can't achieve trailing stop price via proactive STOP_MARKET. Result: paper systematically better than BT (e.g., FET +7.98% paper vs +6% BT on same NFS MED exit).
  - **Fix**: Paper now uses `currentPrice` (candle close = market order) for NFS MED and LOW exits, matching the existing NFS HIGH paper behavior (V5.87). Live keeps `max/min(trailing, close)` since proactive stops CAN fill at trailing price.
  - **Pricing table**:
    - NFS HIGH: paper=`currentPrice`, live=`trailingStopPrice`, BT=`trailingStopPrice`
    - NFS MED: paper=`currentPrice` (was `max/min`), live=`max/min(trail,close)`, BT=`current.close`
    - NFS LOW: paper=`currentPrice` (was `max/min`), live=`max/min(trail,close)`, BT=`current.close`
  - **Impact**: Paper NFS MED/LOW results now aligned with BT (both use candle close). Paper is realistic; live is optimistic (justified by proactive stops).
  - **File**: `orchestrator.ts`

- V5.139-V5.141: Realistic NFS HIGH pricing + entry quality filters:
  - **V5.139: Range Position Filter**: Rejects entries in "death zone" of 20-candle range (40-80%). Filters mid-range chop entries. Config: `RANGE_POSITION_FILTER.ENABLED: true`, `DEATH_ZONE_LOW: 0.40`, `DEATH_ZONE_HIGH: 0.80`. Added to both LONG and SHORT paths in `checkMomentumSignal()`.
  - **V5.140: NFS HIGH = current.close (permanent)**: Backtest NFS HIGH exits use candle close instead of trailingStopPrice. Conservative: live can only do BETTER via proactive STOP_MARKET. Previous attempts (V5.91, V5.134) failed because they didn't have the Range Position Filter to remove death-zone entries.
  - **V5.141: Entry quality filters — Vol 1.5x + ADX Rising**: New `ENTRY_QUALITY` config block in `momentumConfig.ts`. `ENTRY_LONG.VOL_MULTIPLIER: 1.5` (was 1.15) — requires stronger volume spike on LONG entries. `ADX_RISING_ENABLED: true` with lookback=3 — requires ADX(14) to be increasing vs 3 candles ago (trend strengthening). `BODY_RATIO_ENABLED: false` — proven useless in sweep.
  - **Sweep results** (13 configs, real BT with compounding, Jan-Dec 2025, $2K, 5x, 9 symbols):
    - Baseline (no filter): 964 trades, -$718, 77.6% DD, Sharpe 0.07
    - Vol1.5+ADXRising3 (winner): 654 trades, 61.0% WR, +$1,866, 46.1% DD, Sharpe 1.14
    - ADX Rising alone: +$1,843, Sharpe 1.14 (very close to combo)
    - Body ratio: all configs NEGATIVE (doji candles don't predict bad trades)
    - Vol 1.5x SHORT: HARMFUL (-$1,246) — low-volume SHORT entries work better
  - **Confirmed Breakout + Retest strategy**: Standalone backtest script, 27-config sweep. ALL configs negative (-$775 to -$1,914). Strategy is definitively -EV (stagnant exits dominate 63%).
  - **Propagation**: All entry filters in shared `checkMomentumSignal()` — auto-propagates to live/paper/backtest/parity. No exit/trailing/SL/sizing changes.
  - **Files**: `momentumConfig.ts`, `momentumSignal.ts`, `backtestService.ts`

- V5.142: Fix crash safety STOP false trigger in paper mode:
  - **Problem**: After deploy, all open paper positions immediately closed via crash safety at prices far below market (e.g., RENDER at $1.3644 when market was $1.42, STX at $0.2552 when market was $0.2638). Logs showed `crashPrice=$undefined`.
  - **Root cause**: `realtimeExitHandler.ts:327` passed hardcoded `0` as `lastPrice` to `checkCrashSafetyFill()`. In paper mode (`exchangeOrderManager.ts:528-535`), the check is `lastPrice <= crashSafetyPrice` for LONG. With `lastPrice=0`, this is **always true** → crash safety "fills" on every RT check cycle (every ~200ms). The crash safety block ran BEFORE `currentPrice` was obtained from the WS ticker (line 380).
  - **Why live wasn't affected**: In live mode, `checkCrashSafetyFill()` checks WS ORDER_TRADE_UPDATE events (ignores `lastPrice` param). Only paper mode uses the `lastPrice` comparison.
  - **Fix**: Moved crash safety check block to AFTER `currentPrice` is computed from WS ticker. Now passes `currentPrice` instead of `0`. The check only runs when we have a valid, recent price from WebSocket.
  - **File**: `realtimeExitHandler.ts`

- V5.143: BB Breakout Depth Filter — **TESTED & REJECTED**:
  - **Hypothesis**: SL pattern analysis (Cohen's d = 0.82) showed losing trades enter too close to BB band. Filter requiring minimum BB breakout depth (close - BB.upper) before entry should eliminate shallow breakout losers.
  - **Tested**: 8 thresholds (0.05% to 0.30%) via real compounded BT, full year Jan-Dec 2025.
  - **Results**: MARGINAL. Best config (BB>=0.05%) = $1,956 vs baseline $1,866 (+$90 only). Post-hoc analysis inflated expected gain (+745%) because sum-of-trade-PnL% ≠ compounded BT.
  - **Walk-forward FAIL**: ALL configs go NEGATIVE in H1 (Jan-Jun). Not regime-stable.
  - **Monthly stability**: No improvement — still 5/12 positive months.
  - **Decision**: REMOVED from code. Post-hoc SL feature analysis is unreliable for filter design. The compounding effect + signal competition make single-feature filters much less impactful than post-hoc PnL% sums suggest.
  - **Lesson**: V5.140 confirmed again — always validate with `runBacktestComputation()`, never trust post-hoc PnL% simulation.

- V5.144: MQS (Momentum Quality Score) — **TESTED & REJECTED**:
  - **Hypothesis**: Post-hoc analysis showed ROC Acceleration (Cohen's d = 0.698, HIGH: 91.7% WR) and RSI Divergence (d = 0.312) strongly discriminate winners from losers. Composite MQS >= 0.70 bucket: 85.6% WR.
  - **Tested**: 8 configs (ROC Accel alone, RSI Div at LB=5/10/15, combos) via real compounded BT.
  - **Results**: ROC Accel alone **DESTROYS** $1,250 PnL (Sharpe 0.72 vs 1.14). RSI Div LB=15 marginal (+$223). Combo Accel+RSI(LB=15) best Sharpe (1.28) but -$72 PnL.
  - **Walk-forward**: H1 NEGATIVE for all configs (RSI Div LB=15: -$116 H1). H2 excellent but regime-dependent.
  - **Decision**: Both filters remain OFF (`ROC_ACCEL_ENABLED: false`, `RSI_DIVERGENCE_ENABLED: false`). Post-hoc Cohen's d is unreliable for filter design — 3rd confirmation after V5.143 and V5.140.

- V5.144: Trailing Activation Sweep — **TESTED, only BE=0.7% kept**:
  - **Trailing activation lowered (0.4-0.8%)**: ALL levels HURT PnL. Act=0.4%: -$2,383. Act=0.8%: -$796. Reason: trades "protected" early would have been winners at 1.0% activation. SL savings (-$8K) dwarfed by trailing profit destruction (-$14K).
  - **Breakeven trigger**: BE=0.3% catastrophic (41.6% WR). BE=0.5% harmful. **BE=0.7% only winner**: +$338 PnL, +0.09 Sharpe, same DD, walk-forward stable (H1: Sharpe 1.20 vs 1.02, H2: identical).
  - **Decision**: `BREAKEVEN_TRIGGER_PCT: 1.0 → 0.7` applied in V5.145.

- V5.145: SHORT quality filters + breakeven optimization:
  - **BREAKEVEN_TRIGGER_PCT: 1.0 → 0.7**: Protects trades reaching +0.7% that never hit trailing activation (1.0%) from falling to full SL. Exit at +0.1% instead. Walk-forward stable.
  - **ADX_MIN_SHORT: 0 → 15**: Requires minimum ADX(14) >= 15 for SHORT entries. Rejects shorts in trendless markets. Sweep: +$985 PnL, -5.5pp DD, +0.26 Sharpe alone.
  - **WICK_REJECTION_SHORT: OFF → ON (threshold 60%)**: Rejects SHORT entries when lower wick > 60% of candle range (buying pressure signal). Sweep: +$1,314 PnL, +0.7pp DD, +0.31 Sharpe alone.
  - **Combo ADX15+WICK60 results** (full year Jan-Dec 2025, $2K, 5x, 9 symbols):
    - 606 trades, 62.4% WR, **$5,119 PnL** (+$3,253 vs V5.141), **38.7% DD** (-7.4pp), **Sharpe 1.81** (+0.67)
    - LONG: 170 trades, 67.6% WR, $2,313 PnL
    - SHORT: 436 trades, 60.3% WR, $2,806 PnL (was $502 in V5.141 — **+$2,304**)
    - Monthly: 8/12 positive months (was ~5-6)
  - **Walk-forward**: H2 dominant (Sharpe 2.73, SHORT $2,785). H1 positive ($623) but SHORT is -$847 (LONG compensates at $1,469). Filters are regime-dependent but net-positive full year.
  - **Per-symbol**: WIF $2,445, STX $2,281, DOT $956, IMX $477, AVAX $384, ADA $226, FET $181. RENDER -$878, XRP -$953.
  - **Propagation**: Both filters in shared `checkMomentumSignal()` → auto-aligned live/paper/backtest/parity. BE in shared `shouldExitPosition()` → auto-aligned.
  - **Files**: `momentumConfig.ts` (3 config values), `momentumSignal.ts` (filter code added by V5.144 agent, configs activated in V5.145)

- V5.146: BTC 24h crash filter for SHORT + daily circuit breaker (tested & rejected):
  - **BTC 24h drop filter for SHORT** (`SHORT_BTC_DROP_24H_MAX: -5`): Skip SHORT entries when BTC has already dropped >5% in last 24h. Exhausted moves produce violent counter-trend bounces that trigger our stop losses (35% WR on shorts during >5% drops).
  - **Discovery**: November 2025 analysis — BTC crashed -17.6% but our SHORTs lost $1,806. Root cause: choppy crash with 3-5% intraday bounces hitting SL before trend resumed. Post-hoc feature analysis identified BTC Δ24h as strongest discriminator (Cohen's d = 0.37, 35% WR when Δ24h < -5%).
  - **Sweep results** (12 configs, real compounded BT, Jan-Dec 2025, $2K, 5x, 9 symbols):
    - **BTC24h>-5% (winner)**: 552 trades, 65.4% WR, **$9,782 PnL** (+91%), **36.0% DD** (-6.4pp), **Sharpe 2.39** (+0.58). SHORT PnL: $2,806→$7,022 (+$4,216).
    - BTC24h>-4%: $8,250, 38.9% DD, Sharpe 2.41
    - BTC24h>-3%: $7,700, 31.9% DD (best DD), Sharpe 2.35
    - ConsecRed alone: ALL configs worse than baseline (DD increases, PnL drops)
    - CR≥1 + 24h>-4%: Sharpe 2.48 (marginal +0.09 vs -4% alone, extra complexity)
  - **Walk-forward PASS (both halves)**:
    - H1 (Jan-Jun): $623→$999 (+$377), DD 42.4%→36.0% (-6.4pp), Sharpe 1.01→1.30
    - H2 (Jul-Dec): $3,429→$5,772 (+$2,343), DD 37.5%→22.7% (-14.9pp), Sharpe 2.73→3.57
  - **Daily circuit breaker REJECTED**: Tested stop-after-N-losses (1,2,3 losses/day) and time-based cooldowns (2-8h). None reduced DD — losses come from SL on already-open positions, not from new entries. Circuit breaker just kills profitable late-day trades.
  - **ConsecRed filter REJECTED**: Requiring N consecutive red BTC candles before SHORT destroyed PnL in all configs. Removed too many good shorts that enter on the first red candle.
  - **Propagation**: BTC 24h filter in shared `checkMomentumSignal()` → auto-aligned live/paper/backtest/parity. Circuit breaker code in `backtestService.ts` only (testing infrastructure, not deployed to live).
  - **Files**: `momentumConfig.ts` (SHORT_BTC_DROP_24H_MAX), `momentumSignal.ts` (filter code), `backtestService.ts` (dailyLossLimit + lossBreakHours params)

- V5.149: DNA Correlation Filter — block trades when symbol BTC correlation > 0.85 (30d rolling):
  - **Problem**: In bull/crash markets, alts become highly correlated with BTC (>0.85). Breakout signals lose independence — moves are herd-driven, not symbol-specific alpha.
  - **Solution**: Rolling 30-day Pearson correlation between symbol and BTC daily returns. If corr > 0.85, block entry.
  - **Validation**: Sweep on 2024+2025 (post-filter): baseline $7,874 → corr<0.85 $9,964 (+27%). 2025: $9,742→$11,506 (+18%), DD 30.9%→22.0%.
  - **No look-ahead bias**: Correlation uses only PAST 30 days of daily returns at each entry timestamp.
  - **Infrastructure**: Symbol candle window increased to 3000 in backtestService. WS kline cache already 3100 from V5.148.
  - **Files**: `momentumConfig.ts` (DNA_CORR_FILTER_ENABLED, DNA_BTC_CORR_MAX: 0.85, DNA_ROLLING_DAYS: 30), `momentumSignal.ts` (correlation computation + filter), `backtestService.ts` (windowCandles 200→3000)

- V5.148: Bull Run Detector — stop trading when BTC Δ30d > 10%:
  - **Problem**: Strategy loses money in strong uptrends (2024: -$1,916). Breakouts in trending markets don't produce mean-reverting exits.
  - **Solution**: Block all entries when BTC has risen >10% in last 30 days (2880 15m candles).
  - **Validation**: Sweep 16 configs on 2024+2025. Δ30d>10% optimal. 2025: $6,173→$9,742 (+58%), DD 38.7%→28.1%, Sharpe 2.01→2.51. Combined: $4,257→$7,874 (+85%).
  - **Infrastructure**: BTC candle window 201→3000 in backtestService, WS kline cache 500→3100, REST seed 300→1000, quick-single-bt lookback 250→3200.
  - **Files**: `momentumConfig.ts`, `momentumSignal.ts`, `backtestService.ts`, `binanceWebSocket.ts`, `candleCache.ts`

- V5.147: BTC 24h drop tolerance buffer + btcChange24h diagnostics:
  - **Problem**: Parity NO_SIGNAL when btcChange24h differs between live (WS) and backtest (REST). Observed variance up to ~1% (live -4.8% vs BT -5.8%) due to WS/REST candle close differences.
  - **Fix**: `SHORT_BTC_DROP_24H_TOLERANCE: 1.0` — effective threshold becomes `-6.0%` instead of `-5.0%`. Trades in -5.0% to -6.0% zone (grey area) pass through, only genuine crash entries (<-6%) are filtered.
  - **Diagnostics**: Added `btcChange24h` to signal features + signal logger extras. Future parity NO_SIGNAL can be diagnosed by comparing live vs BT btcChange24h values.
  - **Parity impact**: Eliminates borderline NO_SIGNAL from WS/REST candle data variance.
  - **Files**: `momentumConfig.ts` (SHORT_BTC_DROP_24H_TOLERANCE: 1.0), `momentumSignal.ts` (btcChange24h in features + tolerance), `signalLogger.ts` (btcChange24h in extras)

- V5.150: SL predictor analysis + sweep scripts — timestamp bug discovery:
  - **Goal**: Find novel entry-time features that predict SL trades. Extract 20+ features per trade, compute Cohen's d effect size for SL vs WIN separation.
  - **Scripts created**: `scripts/sl-predictor-analysis.ts` (feature extraction + statistical analysis), `scripts/sweep-sl-predictors.ts` (post-filter backtest with consecSameDir, btcCandleBody, volSurge filters), `scripts/analyze-exits.ts` (PnL breakdown by exit reason)
  - **Exit analysis findings**: SL (-$16,481 in 2025, -$4,875 in 2024) and STAGNANT (-$7,319, -$1,676) are the real PnL killers. NFS HIGH/MED are both profitable exit types.
  - **CRITICAL BUG FOUND**: Both analysis scripts used `trade.entryTime` directly for candle lookup. But `entryTime = candle.timestamp + 15min` (candle CLOSE, not OPEN — see V5.46 realisticTiming in backtestService.ts line 1041). `Math.floor(entryTime / grid) * grid` lands on the NEXT candle, not the signal candle. This caused: (1) features extracted from wrong candle (look-ahead bias), (2) consec >= 1 and >= 2 giving identical results (artifact), (3) inflated +222% PnL improvement (meaningless).
  - **Fix**: `gridTs = Math.floor((entryTs - grid) / grid) * grid` — subtract 15min to recover signal candle's OPEN timestamp.
  - **Lesson**: `trade.entryTime` in backtest is candle CLOSE time (V5.46 realisticTiming). Any script that maps trades back to candles must subtract one candle duration (15min) to find the signal candle. This applies to ALL post-hoc analysis scripts.
  - **Status**: Scripts fixed, sweep re-running for valid results. Post-filter results may still differ from engine-integrated results due to slot replacement effect (see V5.149 DNA filter lesson).
  - **Files**: `scripts/sl-predictor-analysis.ts`, `scripts/sweep-sl-predictors.ts`, `scripts/analyze-exits.ts`

- V5.151: Deep SL analysis + ATR/BlockHours/BE combo — **REVERTED** (post-filter trap confirmed):
  - **Goal**: Reduce SL losses using MAE/MFE behavioral analysis findings.
  - **Deep analysis** (`scripts/sl-deep-analysis.ts`): 928 trades analyzed. Key findings:
    - 88% of SL trades go positive first (MFE > 0.1%) → entry signal is RIGHT, problem is exit
    - 83% of SL trades hit SL within 8 bars (2h) → too fast for stagnant to save
    - ATR% is #1 SL predictor (Cohen's d = 0.76). MED volatility (ATR 2-3.5%) = 71-77% SL rate
    - 20-24 UTC = worst SL window (33-46% SL rate), SHORT = 79% of all SL trades
  - **Solutions sweep** (`scripts/sl-solutions-sweep.ts`): Fast MAE/MFE simulation of 4 approaches + combos:
    - SL widening: CATASTROPHIC (-$13,584 when combined with BE). Wider SL = bigger losses when trades truly crash
    - ATR<2% filter: +$774 (2025), +$272 (2024) — marginal
    - Block 20-24 UTC: +$2,001 (2025), +$393 (2024) — moderate
    - BE@0.3%: +$1,295 (2025), +$557 (2024) — best single
    - Best combo: ATR<2% + Block20-24 + BE@0.4% = +$4,417 combined (post-filter simulation)
  - **Engine-integrated backtest** (the real test):
    - 2025: 488 trades, **53.3% WR** (was 65.8%), **$2,820** PnL (was $9,742), Sharpe 1.22 (was 2.51) → **-$6,922 degradation**
    - 2024: 417 trades, 40.0% WR (was 51.2%), -$1,901 PnL (was -$1,868) → marginally worse
  - **Root cause**: BE@0.4% is too aggressive — it moves SL to breakeven too early, converting future winners (+3-5% runs) into breakeven exits. Trades touch +0.4%, BE triggers, then a small dip exits at +0.1% before the real move. The post-filter simulation didn't capture this because it only measured "would the SL have been avoided" without modeling the clipped winners.
  - **CRITICAL LESSON**: Post-filter MAE/MFE simulations are UNRELIABLE for breakeven changes. They model the upside (SL avoided) but not the downside (winners clipped). Engine-integrated backtest is the ONLY valid test. This is the 3rd confirmation of the slot-replacement/post-filter trap (after V5.149 DNA filter and V5.150 sweep).
  - **Status**: All 3 changes REVERTED (ATR filter disabled, block hours disabled, BE back to 0.7%). Config flags remain in code (disabled) for future reference. Analysis scripts committed for institutional knowledge.
  - **Files**: `momentumConfig.ts` (reverted), `momentumSignal.ts` (filter code remains, disabled), `scripts/sl-deep-analysis.ts`, `scripts/sl-solutions-sweep.ts`, `docs/plans/2026-03-09-sl-deep-analysis-results.md`

- V5.152: ADA early exit investigation — two approaches tested, both **REJECTED**:
  - **Context**: ADA trade 2026-03-16 entered LONG @0.2698, exited NFS HIGH @0.2704 (+0.22%), then price ran +8% to 0.294 without us. Investigation to find why and fix it.
  - **Approach 1: Continuous ATR-proportional trailing distance** — replace discrete volatility buckets (LOW=0.3%, MED=0.4%, HIGH=0.8%) with `distance = clamp(MULT × currentATR%, 0.3%, 3.0%)`.
    - **Hypothesis**: ADA (ATR 0.63%) classified as LOW vol → trailing distance 0.3% was below noise floor, causing premature NFS HIGH exit.
    - **Sweep**: DIST_ATR_MULT ∈ [0.5, 0.75, 1.0, 1.25, 1.5], 9 symbols, 2024+2025.
    - **Result**: CATASTROPHIC. Best (MULT=0.5): 2025 Sharpe 0.57 (was 2.40), PnL $338 (was $8,769). Formula gave distances 3-5× wider than fixed buckets for LOW/MED vol assets, doubling SL count and halving trail exits.
    - **Root cause**: Fixed buckets (0.3-0.4%) are actually optimal. ATR-proportional gives too much room.
  - **Approach 2: ADX Rising filter tolerance** — allow entries when ADX is declining but above a high threshold or declining by small amount.
    - **Discovery**: Traced PM2 logs to find the actual blocker. After NFS HIGH exit at 00:30, the real breakout came at 03:30-03:45 UTC. At 03:30: `roc_low` (0.9% < 1.75%). At 03:45: `adx_not_rising` (ADX 39.1 declined from 40.8). The ADX Rising filter (V5.141) killed the re-entry signal despite ADX being very high (39.1 = strong trend).
    - **Sweep**: 15 configs testing 3 tolerance mechanisms: (A) min decline threshold (2/3/5 pts), (B) high ADX bypass (25/30/35), (C) reduced lookback (2 vs 3), plus A+B and A+B+C combos, plus ADX_RISING=OFF.
    - **Result**: ALL 14 alternatives worse than strict baseline. Best (minDecline=2): Sharpe 1.79 vs 2.40, PnL $4,249 vs $8,769 (-$4,520). Walk-forward: ❌ FAIL on all 3 top configs (H1 collapses: $232/$97/$-92 vs baseline $1,310).
    - **Root cause**: Each tolerance admits ~50-200 extra trades that are overwhelmingly losers. The ADA case was exceptional (+8% raté); statistically ADX Rising strict blocks far more bad trades than good ones.
  - **CRITICAL LESSON #4**: Salience bias — a single spectacular missed trade (+8%) makes the filter look broken, but the filter prevents ~150 losing trades worth -$5,000+. Always validate with full compounded backtest, not single-trade anecdotes. Joins V5.143 (BB depth), V5.144 (MQS), V5.149 (DNA), V5.151 (SL predictors) as confirmed post-hoc traps.
  - **Status**: Both approaches REVERTED. ADX Rising strict is optimal (Sharpe 2.40). No code changes committed.
  - **Scripts**: `scripts/sweep-adx-rising-tolerance.ts` (ADX tolerance sweep), `scripts/sweep-trailing-dist-atr.ts` (deleted — ATR trailing sweep)
