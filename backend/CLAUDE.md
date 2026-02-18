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
- `symbolEngine.ts` - Per-symbol signal computation (shared across users). Uses same `checkMomentumSignal()` as agents. **Must stay aligned with regime timeframe config** (V5.105 fix: was using 1h candles when config was 15m)
- `cacheManager.ts` - Mutex-protected BTC 15m/1h candle caches and leverage cache (`globalCacheManager` singleton)

**Config & Types** (`src/config/`, `src/types/`)
- `config/constants.ts` - Centralized magic numbers: `CACHE_TTLS`, `SYNC_INTERVALS`, `ORDER_QUEUE`, `WS_THROTTLE`, `USER_LIMITS`, `IP_WEIGHT`
- `types/exchange.ts` - Typed CCXT interfaces: `CcxtOrder`, `CcxtPosition`, `CcxtTrade`, `CcxtBalance`, `CcxtMarket`, `Exchange`

**Services** (`src/services/`)
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
- **Mutex Caches**: BTC 15m/1h candle caches and leverage cache are mutex-protected via `globalCacheManager` to prevent concurrent fetch races
- **Error Handling**: Use `errMsg(error: unknown): string` helper for safe error extraction in `catch (error: unknown)` blocks (no `catch (error: any)`)
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
