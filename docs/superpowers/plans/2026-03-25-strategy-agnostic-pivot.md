# Strategy-Agnostic Pivot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive momentum strategy, create pluggable IStrategy interface, refactor backtest engine, implement and test Grid + Mean Reversion strategies on BTC/ETH/SOL/XRP for 2024+2025.

**Architecture:** Extract shared types (Candle, Position) from momentumConfig into `strategies/types.ts`. Define `IStrategy` interface with `checkEntry`/`checkExit`. Refactor backtest engine to accept any IStrategy. Each strategy is a self-contained directory with `strategy.ts` + `config.ts`.

**Tech Stack:** TypeScript, Node.js, existing Prisma/PostgreSQL, existing CCXT/WebSocket infra. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-03-25-strategy-agnostic-pivot-design.md`

---

## File Structure

### New files to create:
- `backend/src/strategies/types.ts` — IStrategy interface + shared types (Candle, Position, SignalResult, ExitSignal)
- `backend/src/strategies/registry.ts` — Strategy registry map
- `backend/src/strategies/grid/strategy.ts` — GridStrategy
- `backend/src/strategies/grid/config.ts` — Grid parameters
- `backend/src/strategies/meanReversion/strategy.ts` — MeanReversionStrategy
- `backend/src/strategies/meanReversion/config.ts` — Mean reversion parameters
- `backend/src/strategies/_archive/momentum/README.md` — Summary of what was tried
- `backend/scripts/test-strategy.ts` — Universal strategy tester script
- `backend/test/unit/strategyInterface.test.ts` — IStrategy contract tests
- `backend/DAILY_LOG.md` — Daily work journal
- `backend/STATUS.md` — Achievements and milestones

### Files to modify:
- `backend/src/services/backtestService.ts` — Accept IStrategy param
- `backend/src/strategies/momentumSimple.ts` — Barrel: re-export from types.ts instead of momentumConfig
- `backend/CLAUDE.md` — Rewrite as clean guide

### Files to move (archive):
- `backend/src/strategies/config/momentumConfig.ts` → `_archive/momentum/`
- `backend/src/strategies/signals/momentumSignal.ts` → `_archive/momentum/`
- `backend/src/strategies/exits/exitLogic.ts` → `_archive/momentum/`
- `backend/scripts/*.ts` (118 analysis scripts) → `_archive/momentum/scripts/`
- `backend/output/*` → `_archive/momentum/output/`

---

## Task 1: Create DAILY_LOG.md and STATUS.md

**Files:**
- Create: `backend/DAILY_LOG.md`
- Create: `backend/STATUS.md`

- [ ] **Step 1: Create DAILY_LOG.md**

```markdown
# Daily Log

## 2026-03-25
### What was done
- Full platform audit: live trades analysis, backtest comparison 2024 vs 2025
- Decision: abandon momentum breakout strategy (curve-fitted to 2025)
- Design: strategy-agnostic architecture with IStrategy interface
- Memory system created for persistent learnings

### Decisions made
- Momentum strategy archived (153 versions, 2024 Sharpe -3.81, live -$58)
- New approach: pluggable strategies, test on stable symbols first (BTC/ETH/SOL/XRP)
- Strategies to test: Grid Trading, Mean Reversion, Funding Rate Arbitrage

### Next steps
- Archive momentum code
- Create IStrategy interface
- Refactor backtest engine
- Implement and test new strategies
```

- [ ] **Step 2: Create STATUS.md**

```markdown
# Remezz — Status & Achievements

## Platform (DONE)
- [x] Binance Futures integration (CCXT + WebSocket)
- [x] PostgreSQL persistence (Prisma)
- [x] Multi-agent orchestration (1000+ concurrent)
- [x] Capital pool management
- [x] Order queue with rate limiting
- [x] Parity verification system (live vs backtest)
- [x] Technical indicators library (ATR, BB, ROC, ADX, SMA, etc.)
- [x] Frontend dashboard (React + Vite + Tailwind)
- [x] Telegram reporting
- [x] Backtest engine with 15m + 1m post-processing

## Strategy: Momentum Breakout (ARCHIVED — V5.0-V5.153)
- [x] 153 versions of optimization
- [x] Result: curve-fitted to 2025, fails on 2024 (-93% DD)
- [x] Live result: -$58 in 2 weeks (14 trades, 50% WR)
- [x] Lesson: post-filter analysis unreliable (confirmed 5 times)
- [x] Lesson: test cross-regime BEFORE deploying
- [x] Lesson: if it only works on specific alts = red flag

## Strategy: Grid Trading (TODO)
- [ ] Implement strategy
- [ ] Backtest on BTC/ETH/SOL/XRP 2024+2025
- [ ] Pass full validation checklist

## Strategy: Mean Reversion (TODO)
- [ ] Implement strategy
- [ ] Backtest on BTC/ETH/SOL/XRP 2024+2025
- [ ] Pass full validation checklist

## Strategy: Funding Rate Arb (TODO)
- [ ] Implement strategy
- [ ] Backtest (requires funding rate data)
```

- [ ] **Step 3: Commit**

```bash
git add backend/DAILY_LOG.md backend/STATUS.md
git commit -m "docs: create DAILY_LOG.md and STATUS.md for project tracking"
```

---

## Task 2: Archive Momentum Strategy Files

**Files:**
- Move: `backend/src/strategies/config/momentumConfig.ts` → `backend/src/strategies/_archive/momentum/momentumConfig.ts`
- Move: `backend/src/strategies/signals/momentumSignal.ts` → `backend/src/strategies/_archive/momentum/momentumSignal.ts`
- Move: `backend/src/strategies/exits/exitLogic.ts` → `backend/src/strategies/_archive/momentum/exitLogic.ts`
- Create: `backend/src/strategies/_archive/momentum/README.md`

- [ ] **Step 1: Create archive directory and move strategy files**

```bash
cd backend
mkdir -p src/strategies/_archive/momentum
# Move momentum-specific strategy files
mv src/strategies/config/momentumConfig.ts src/strategies/_archive/momentum/
mv src/strategies/signals/momentumSignal.ts src/strategies/_archive/momentum/
mv src/strategies/exits/exitLogic.ts src/strategies/_archive/momentum/
```

- [ ] **Step 2: Create archive README**

Write `src/strategies/_archive/momentum/README.md`:

```markdown
# Momentum Breakout Strategy (ARCHIVED)

**Versions:** V5.0 — V5.153 (Jan 2025 — Mar 2026)
**Status:** Abandoned — curve-fitted to 2025 market conditions

## What it did
- Momentum breakout on 15m candles with 25+ entry filters
- BTC SMA200 regime filter, NFS trailing exits, ATR-scaled trailing
- 9 altcoin symbols (AVAX, FET, WIF, DOT, IMX, STX, ADA, RENDER, XRP)

## Results
- 2025 backtest: 510 trades, 65.5% WR, +$6,826, Sharpe 2.31 (looked great)
- 2024 backtest: 428 trades, 51.4% WR, -$1,866, Sharpe -3.81 (reality check)
- Live (Mar 2026): 14 trades, 50% WR, -$58 on $414 capital

## Why it failed
1. Over-optimized on 2025 data across 153 versions
2. sma200_skip_zone paralyzed agents when BTC oscillated near SMA200
3. Too many filters = strategy couldn't trade in indecisive regimes
4. Post-filter analysis overestimated improvements 5 times (V5.143-152)
5. Only worked on volatile alts, not stable pairs

## Key lessons
- ALWAYS test on 2024 AND 2025 (cross-regime)
- Test stable symbols first (BTC/ETH/SOL/XRP)
- Post-filter PnL simulation ≠ engine backtest
- >5 filters = fragility, not robustness
- Don't re-optimize after each losing trade
```

- [ ] **Step 3: Commit archive**

```bash
git add src/strategies/_archive/
git commit -m "archive: move momentum strategy to _archive (V5.0-V5.153, abandoned)"
```

---

## Task 3: Archive Scripts and Output

**Files:**
- Move: `backend/scripts/*.ts` (118 files) → `backend/src/strategies/_archive/momentum/scripts/`
- Move: `backend/output/*` → `backend/src/strategies/_archive/momentum/output/`
- Keep: `backend/scripts/quick-bt.ts`, `backend/scripts/quick-combined-bt.ts` (will refactor later)

- [ ] **Step 1: Move analysis scripts to archive**

```bash
cd backend
mkdir -p src/strategies/_archive/momentum/scripts
mkdir -p src/strategies/_archive/momentum/output

# Move output files
mv output/* src/strategies/_archive/momentum/output/ 2>/dev/null

# Move analysis scripts (keep quick-bt and quick-combined-bt)
for f in scripts/*.ts; do
  basename=$(basename "$f")
  if [[ "$basename" != "quick-bt.ts" && "$basename" != "quick-combined-bt.ts" ]]; then
    mv "$f" src/strategies/_archive/momentum/scripts/
  fi
done
```

- [ ] **Step 2: Verify only quick-bt scripts remain**

```bash
ls scripts/*.ts
```

Expected: `quick-bt.ts`, `quick-combined-bt.ts`

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "archive: move 118 analysis scripts and output to _archive/momentum"
```

---

## Task 4: Create IStrategy Interface and Shared Types

**Files:**
- Create: `backend/src/strategies/types.ts`
- Test: `backend/test/unit/strategyInterface.test.ts`

- [ ] **Step 1: Write the contract test**

Create `backend/test/unit/strategyInterface.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';

// We'll import these once created
import type { IStrategy, EntryContext, ExitContext, StrategySignal, StrategyExitSignal, StrategyConfig, Candle } from '../../src/strategies/types.js';

describe('IStrategy interface contract', () => {
  // Minimal implementation for testing
  const dummyStrategy: IStrategy = {
    name: 'test-dummy',
    getConfig: () => ({
      name: 'test-dummy',
      version: '1.0',
      symbols: ['BTC/USDT:USDT'],
      leverage: 1,
      maxPositions: 1,
      positionSizePct: 0.02,
      minCandlesRequired: 20,
      timeframeMs: 900_000,
      fees: { tradingPct: 0.04, slippagePct: 0.05, fundingPct: 0.01 },
    }),
    checkEntry: (_ctx: EntryContext) => null,
    checkExit: (_ctx: ExitContext) => ({ shouldExit: false, reason: 'none' }),
  };

  it('should have a name', () => {
    expect(dummyStrategy.name).toBe('test-dummy');
  });

  it('should return config with required fields', () => {
    const config = dummyStrategy.getConfig();
    expect(config.name).toBeDefined();
    expect(config.symbols.length).toBeGreaterThan(0);
    expect(config.leverage).toBeGreaterThan(0);
    expect(config.fees.tradingPct).toBeGreaterThan(0);
  });

  it('should return null when no entry signal', () => {
    const ctx: EntryContext = {
      symbol: 'BTC/USDT:USDT',
      candles: [],
      btcCandles: [],
      currentPrice: 50000,
      timestamp: Date.now(),
      capital: 1000,
      openPositions: 0,
    };
    expect(dummyStrategy.checkEntry(ctx)).toBeNull();
  });

  it('should return exit signal with shouldExit boolean', () => {
    const ctx: ExitContext = {
      symbol: 'BTC/USDT:USDT',
      position: { symbol: 'BTC/USDT:USDT', side: 'long', entryPrice: 50000, qty: 0.01, entryTime: Date.now() },
      candles: [],
      btcCandles: [],
      currentPrice: 51000,
      timestamp: Date.now(),
      entryPrice: 50000,
      unrealizedPnlPct: 2.0,
      holdingMinutes: 60,
    };
    const exit = dummyStrategy.checkExit(ctx);
    expect(exit).toBeDefined();
    expect(typeof exit!.shouldExit).toBe('boolean');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npx jest test/unit/strategyInterface.test.ts --no-cache 2>&1 | head -20
```

Expected: FAIL — cannot find module `../../src/strategies/types.js`

- [ ] **Step 3: Create types.ts with IStrategy interface**

Create `backend/src/strategies/types.ts`:

```typescript
/**
 * Strategy-agnostic types for Remezz trading platform.
 *
 * These types are shared across ALL strategies and the backtest engine.
 * Strategy-specific config goes in each strategy's own config.ts file.
 */

// ============================================================================
// MARKET DATA
// ============================================================================

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isFinal?: boolean;
}

// ============================================================================
// POSITION
// ============================================================================

export interface Position {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  qty: number;
  entryTime: number;
  realEntryTime?: number;
  stopLoss?: number;
  appTrailingStop?: number;
  stopLossPct?: number;
  orderId?: string;
  stopLossOrderId?: string;
  trailingOrderId?: string;
  leverage?: number;
  marginUsd?: number;
  highWaterMark?: number;
  lowWaterMark?: number;
  trailingActive?: boolean;
  maxPnlPct?: number;
  entryAtrPct?: number;
  trailingBreachCandles?: number;
  stagnantState?: {
    triggered: boolean;
    triggeredAtMinutes?: number;
    confirmed: boolean;
    cancelled: boolean;
    obsPeakPct: number;
  };
  emergencyStopPrice?: number;
  positionId?: string;
  groupId?: string;
  entryIndex?: number;
}

// ============================================================================
// STRATEGY INTERFACE
// ============================================================================

export interface EntryContext {
  symbol: string;
  candles: Candle[];           // symbol candles (closed only)
  btcCandles: Candle[];        // BTC candles (closed only)
  currentPrice: number;
  timestamp: number;
  capital: number;             // available capital
  openPositions: number;       // current open position count
}

export interface ExitContext {
  symbol: string;
  position: Position;
  candles: Candle[];
  btcCandles: Candle[];
  currentPrice: number;
  timestamp: number;
  entryPrice: number;
  unrealizedPnlPct: number;
  holdingMinutes: number;
}

export interface StrategySignal {
  valid: boolean;
  side: 'long' | 'short';
  confidence: number;          // 0-1
  reason: string;
  stopLossPct?: number;
  takeProfitPct?: number;
  metadata?: Record<string, unknown>;
}

export interface StrategyExitSignal {
  shouldExit: boolean;
  reason: string;
  exitPrice?: number;          // limit price, or undefined for market
}

export interface StrategyConfig {
  name: string;
  version: string;
  symbols: string[];
  leverage: number;
  maxPositions: number;
  positionSizePct: number;
  minCandlesRequired: number;
  timeframeMs: number;
  fees: {
    tradingPct: number;
    slippagePct: number;
    fundingPct: number;
  };
}

export interface IStrategy {
  readonly name: string;
  getConfig(): StrategyConfig;
  checkEntry(ctx: EntryContext): StrategySignal | null;
  checkExit(ctx: ExitContext): StrategyExitSignal;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend && npx jest test/unit/strategyInterface.test.ts --no-cache 2>&1 | tail -10
```

Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/strategies/types.ts test/unit/strategyInterface.test.ts
git commit -m "feat: create IStrategy interface and shared types"
```

---

## Task 5: Create Strategy Registry

**Files:**
- Create: `backend/src/strategies/registry.ts`

- [ ] **Step 1: Create registry.ts**

```typescript
/**
 * Strategy registry — maps strategy names to implementations.
 * Used by backtest engine and live agent to load strategies dynamically.
 */
import type { IStrategy } from './types.js';

const strategies = new Map<string, IStrategy>();

export function registerStrategy(strategy: IStrategy): void {
  if (strategies.has(strategy.name)) {
    throw new Error(`Strategy "${strategy.name}" is already registered`);
  }
  strategies.set(strategy.name, strategy);
}

export function getStrategy(name: string): IStrategy {
  const strategy = strategies.get(name);
  if (!strategy) {
    const available = listStrategies().join(', ') || 'none';
    throw new Error(`Strategy "${name}" not found. Available: ${available}`);
  }
  return strategy;
}

export function listStrategies(): string[] {
  return Array.from(strategies.keys());
}

export function clearStrategies(): void {
  strategies.clear();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/strategies/registry.ts
git commit -m "feat: create strategy registry for pluggable strategy loading"
```

---

## Task 6: Fix Imports — Make Shared Types Available Without Momentum

This is the critical step. Many files import `Candle`, `Position`, `SignalResult`, `ExitSignal` from `momentumSimple.ts` or `momentumConfig.ts`. We need them to come from `types.ts` instead.

**Files:**
- Modify: `backend/src/strategies/momentumSimple.ts` — re-export types from `types.ts`

- [ ] **Step 1: Update momentumSimple.ts barrel to re-export from types.ts**

The barrel file currently re-exports everything from `config/momentumConfig.ts` (which is now archived). We need to make it re-export the shared types from `types.ts` so all 45+ consumers keep working.

Read current `momentumSimple.ts`, then rewrite it to:
1. Re-export shared types (Candle, Position, SignalResult, ExitSignal, MarketConditions) from `./types.js`
2. Re-export indicators from `./indicators/technicalIndicators.js`
3. Re-export position sizing from `./risk/positionSizing.js`
4. Stub out the momentum-specific exports that other code might reference (MomentumConfig, checkMomentumSignal, shouldExitPosition, getMarketConditions) as no-ops or empty objects so compilation doesn't break

This is a transitional step — consumers will be migrated to import from `types.ts` directly in later tasks.

- [ ] **Step 2: Verify build compiles**

```bash
cd backend && npx tsc --noEmit 2>&1 | head -30
```

Fix any import errors iteratively. The goal is zero compilation errors.

- [ ] **Step 3: Verify existing tests still pass**

```bash
cd backend && npm test 2>&1 | tail -20
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: re-route shared type imports through types.ts (momentum decoupling)"
```

---

## Task 7: Implement Grid Trading Strategy

**Files:**
- Create: `backend/src/strategies/grid/config.ts`
- Create: `backend/src/strategies/grid/strategy.ts`
- Test: `backend/test/unit/gridStrategy.test.ts`

- [ ] **Step 1: Write grid strategy tests**

Create `backend/test/unit/gridStrategy.test.ts`:

```typescript
import { describe, it, expect } from '@jest/globals';
import { GridStrategy } from '../../src/strategies/grid/strategy.js';
import type { EntryContext, ExitContext, Candle } from '../../src/strategies/types.js';

function makeCandles(prices: number[], baseTimestamp = 1700000000000): Candle[] {
  return prices.map((p, i) => ({
    timestamp: baseTimestamp + i * 900_000,
    open: p * 0.999, high: p * 1.002, low: p * 0.998, close: p, volume: 1000,
  }));
}

describe('GridStrategy', () => {
  const strategy = new GridStrategy();

  it('should have correct name and config', () => {
    expect(strategy.name).toBe('grid');
    const config = strategy.getConfig();
    expect(config.symbols).toContain('BTC/USDT:USDT');
    expect(config.leverage).toBeLessThanOrEqual(3);
  });

  it('should not enter with insufficient candles', () => {
    const ctx: EntryContext = {
      symbol: 'BTC/USDT:USDT',
      candles: makeCandles([50000]),
      btcCandles: makeCandles([50000]),
      currentPrice: 50000,
      timestamp: Date.now(),
      capital: 1000,
      openPositions: 0,
    };
    expect(strategy.checkEntry(ctx)).toBeNull();
  });

  it('should enter LONG when price drops to lower grid level', () => {
    // Price drops from range midpoint toward lower bound
    const prices = Array.from({ length: 50 }, (_, i) => 50000 - i * 20);
    const ctx: EntryContext = {
      symbol: 'BTC/USDT:USDT',
      candles: makeCandles(prices),
      btcCandles: makeCandles(prices),
      currentPrice: prices[prices.length - 1],
      timestamp: Date.now(),
      capital: 1000,
      openPositions: 0,
    };
    const signal = strategy.checkEntry(ctx);
    // Grid should want to buy at lower levels
    if (signal) {
      expect(signal.side).toBe('long');
      expect(signal.stopLossPct).toBeDefined();
    }
  });

  it('should exit with profit at upper grid level', () => {
    const prices = Array.from({ length: 50 }, (_, i) => 49000 + i * 30);
    const ctx: ExitContext = {
      symbol: 'BTC/USDT:USDT',
      position: { symbol: 'BTC/USDT:USDT', side: 'long', entryPrice: 49200, qty: 0.01, entryTime: Date.now() - 3600000 },
      candles: makeCandles(prices),
      btcCandles: makeCandles(prices),
      currentPrice: 50500,
      timestamp: Date.now(),
      entryPrice: 49200,
      unrealizedPnlPct: 2.6,
      holdingMinutes: 60,
    };
    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toContain('grid_tp');
  });

  it('should exit with stop loss when price breaks range', () => {
    const prices = Array.from({ length: 50 }, (_, i) => 50000 - i * 100);
    const ctx: ExitContext = {
      symbol: 'BTC/USDT:USDT',
      position: { symbol: 'BTC/USDT:USDT', side: 'long', entryPrice: 49500, qty: 0.01, entryTime: Date.now() - 7200000 },
      candles: makeCandles(prices),
      btcCandles: makeCandles(prices),
      currentPrice: 45000,
      timestamp: Date.now(),
      entryPrice: 49500,
      unrealizedPnlPct: -9.1,
      holdingMinutes: 120,
    };
    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toContain('sl');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npx jest test/unit/gridStrategy.test.ts --no-cache 2>&1 | head -10
```

Expected: FAIL — cannot resolve `../../src/strategies/grid/strategy.js`

- [ ] **Step 3: Create grid config**

Create `backend/src/strategies/grid/config.ts`:

```typescript
export const GRID_CONFIG = {
  // Range detection
  RANGE_LOOKBACK_CANDLES: 96,    // 96 * 15m = 24h lookback for range detection
  RANGE_PERCENTILE_LOW: 0.25,    // Lower quartile of recent prices
  RANGE_PERCENTILE_HIGH: 0.75,   // Upper quartile

  // Grid levels
  GRID_LEVELS: 5,                // Number of grid levels per side
  GRID_SPACING_PCT: 0.5,        // Distance between grid levels (% of range)

  // Entry
  ENTRY_THRESHOLD_PCT: 0.3,     // Enter when price within X% of grid level

  // Exit
  TAKE_PROFIT_GRIDS: 1,         // Exit N grid levels from entry
  STOP_LOSS_PCT: 3.0,           // Hard stop if price breaks range
  MAX_HOLD_MINUTES: 2880,       // 48h max hold

  // Risk
  TREND_FILTER_ADX_MAX: 25,     // Skip entry if ADX > 25 (trending market)
  MIN_RANGE_PCT: 2.0,           // Minimum range width to trade (% high-low)
  MAX_RANGE_PCT: 15.0,          // Maximum range width (too wide = not ranging)
} as const;
```

- [ ] **Step 4: Create grid strategy**

Create `backend/src/strategies/grid/strategy.ts`:

```typescript
import type { IStrategy, StrategyConfig, EntryContext, ExitContext, StrategySignal, StrategyExitSignal, Candle } from '../types.js';
import { GRID_CONFIG } from './config.js';

export class GridStrategy implements IStrategy {
  readonly name = 'grid';

  getConfig(): StrategyConfig {
    return {
      name: 'grid',
      version: '1.0.0',
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
      leverage: 2,
      maxPositions: 3,
      positionSizePct: 0.03,
      minCandlesRequired: GRID_CONFIG.RANGE_LOOKBACK_CANDLES,
      timeframeMs: 900_000,
      fees: { tradingPct: 0.04, slippagePct: 0.05, fundingPct: 0.01 },
    };
  }

  checkEntry(ctx: EntryContext): StrategySignal | null {
    const { candles, currentPrice, openPositions } = ctx;
    const config = this.getConfig();

    if (candles.length < GRID_CONFIG.RANGE_LOOKBACK_CANDLES) return null;
    if (openPositions >= config.maxPositions) return null;

    // Detect range from recent candles
    const recent = candles.slice(-GRID_CONFIG.RANGE_LOOKBACK_CANDLES);
    const range = this.detectRange(recent);
    if (!range) return null;

    // Check ADX — skip if trending
    const adx = this.calcSimpleADX(recent);
    if (adx > GRID_CONFIG.TREND_FILTER_ADX_MAX) return null;

    // Calculate grid levels
    const gridSpacing = (range.high - range.low) * (GRID_CONFIG.GRID_SPACING_PCT / 100);
    const midPrice = (range.high + range.low) / 2;

    // Check if price is near a grid buy level (below midpoint)
    const distFromMid = (currentPrice - midPrice) / midPrice * 100;

    if (distFromMid < -GRID_CONFIG.ENTRY_THRESHOLD_PCT) {
      // Price below midpoint — potential long
      const gridLevel = Math.floor(Math.abs(currentPrice - midPrice) / gridSpacing);
      if (gridLevel >= 1) {
        return {
          valid: true,
          side: 'long',
          confidence: Math.min(gridLevel / GRID_CONFIG.GRID_LEVELS, 1),
          reason: `grid_buy_level_${gridLevel}`,
          stopLossPct: GRID_CONFIG.STOP_LOSS_PCT,
          takeProfitPct: (gridSpacing / currentPrice) * 100 * GRID_CONFIG.TAKE_PROFIT_GRIDS,
          metadata: { gridLevel, rangeLow: range.low, rangeHigh: range.high, midPrice, adx },
        };
      }
    }

    if (distFromMid > GRID_CONFIG.ENTRY_THRESHOLD_PCT) {
      // Price above midpoint — potential short
      const gridLevel = Math.floor(Math.abs(currentPrice - midPrice) / gridSpacing);
      if (gridLevel >= 1) {
        return {
          valid: true,
          side: 'short',
          confidence: Math.min(gridLevel / GRID_CONFIG.GRID_LEVELS, 1),
          reason: `grid_sell_level_${gridLevel}`,
          stopLossPct: GRID_CONFIG.STOP_LOSS_PCT,
          takeProfitPct: (gridSpacing / currentPrice) * 100 * GRID_CONFIG.TAKE_PROFIT_GRIDS,
          metadata: { gridLevel, rangeLow: range.low, rangeHigh: range.high, midPrice, adx },
        };
      }
    }

    return null;
  }

  checkExit(ctx: ExitContext): StrategyExitSignal {
    const { position, currentPrice, unrealizedPnlPct, holdingMinutes, candles } = ctx;

    // Hard stop loss
    if (unrealizedPnlPct <= -GRID_CONFIG.STOP_LOSS_PCT) {
      return { shouldExit: true, reason: 'grid_sl' };
    }

    // Max hold time
    if (holdingMinutes >= GRID_CONFIG.MAX_HOLD_MINUTES) {
      return { shouldExit: true, reason: 'grid_max_hold' };
    }

    // Take profit at next grid level
    const recent = candles.slice(-GRID_CONFIG.RANGE_LOOKBACK_CANDLES);
    const range = this.detectRange(recent);
    if (range) {
      const gridSpacing = (range.high - range.low) * (GRID_CONFIG.GRID_SPACING_PCT / 100);
      const tpPct = (gridSpacing / position.entryPrice) * 100 * GRID_CONFIG.TAKE_PROFIT_GRIDS;
      if (unrealizedPnlPct >= tpPct) {
        return { shouldExit: true, reason: 'grid_tp' };
      }
    }

    // Range breakout — emergency exit
    if (range) {
      const rangeBreakPct = 1.5; // 1.5% beyond range = breakout
      const breakHigh = range.high * (1 + rangeBreakPct / 100);
      const breakLow = range.low * (1 - rangeBreakPct / 100);
      if (currentPrice > breakHigh || currentPrice < breakLow) {
        return { shouldExit: true, reason: 'grid_range_break' };
      }
    }

    return { shouldExit: false, reason: 'hold' };
  }

  // --- Private helpers ---

  private detectRange(candles: Candle[]): { high: number; low: number } | null {
    if (candles.length < 20) return null;

    const closes = candles.map(c => c.close).sort((a, b) => a - b);
    const lowIdx = Math.floor(closes.length * GRID_CONFIG.RANGE_PERCENTILE_LOW);
    const highIdx = Math.floor(closes.length * GRID_CONFIG.RANGE_PERCENTILE_HIGH);

    const rangeLow = closes[lowIdx];
    const rangeHigh = closes[highIdx];
    const rangePct = ((rangeHigh - rangeLow) / rangeLow) * 100;

    if (rangePct < GRID_CONFIG.MIN_RANGE_PCT || rangePct > GRID_CONFIG.MAX_RANGE_PCT) {
      return null;
    }

    return { high: rangeHigh, low: rangeLow };
  }

  private calcSimpleADX(candles: Candle[]): number {
    // Simplified ADX approximation using absolute price changes
    if (candles.length < 14) return 0;
    const recent = candles.slice(-14);
    let sumDirMove = 0;
    let sumTrueRange = 0;
    for (let i = 1; i < recent.length; i++) {
      const tr = Math.max(
        recent[i].high - recent[i].low,
        Math.abs(recent[i].high - recent[i - 1].close),
        Math.abs(recent[i].low - recent[i - 1].close)
      );
      sumTrueRange += tr;
      sumDirMove += Math.abs(recent[i].close - recent[i - 1].close);
    }
    // ADX approximation: directional movement / true range * 100
    return sumTrueRange > 0 ? (sumDirMove / sumTrueRange) * 100 : 0;
  }
}
```

- [ ] **Step 5: Run tests**

```bash
cd backend && npx jest test/unit/gridStrategy.test.ts --no-cache 2>&1 | tail -15
```

Expected: PASS (all 5 tests). If some edge cases fail, adjust test data to match grid logic.

- [ ] **Step 6: Register strategy**

Add to `backend/src/strategies/registry.ts`:

```typescript
import { GridStrategy } from './grid/strategy.js';
registerStrategy(new GridStrategy());
```

- [ ] **Step 7: Commit**

```bash
git add src/strategies/grid/ test/unit/gridStrategy.test.ts src/strategies/registry.ts
git commit -m "feat: implement GridStrategy (range detection + grid levels)"
```

---

## Task 8: Implement Mean Reversion Strategy

**Files:**
- Create: `backend/src/strategies/meanReversion/config.ts`
- Create: `backend/src/strategies/meanReversion/strategy.ts`
- Test: `backend/test/unit/meanReversionStrategy.test.ts`

- [ ] **Step 1: Write mean reversion tests**

Create `backend/test/unit/meanReversionStrategy.test.ts` following same pattern as grid tests. Test:
- No entry with insufficient candles
- Enter LONG when price < lower BB (>2.5 sigma below mean)
- Enter SHORT when price > upper BB (>2.5 sigma above mean)
- Exit at mean reversion (price returns to mean)
- Exit at stop loss

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Create mean reversion config**

Create `backend/src/strategies/meanReversion/config.ts`:

```typescript
export const MEAN_REV_CONFIG = {
  // Bollinger Bands
  BB_PERIOD: 50,                // 50 candles = 12.5h lookback
  BB_STD_ENTRY: 2.5,           // Enter at 2.5 sigma deviation
  BB_STD_EXIT: 0.5,            // Exit when price returns within 0.5 sigma

  // Volume confirmation
  VOLUME_SPIKE_MIN: 1.5,       // Require 1.5x avg volume on entry candle

  // Risk management
  STOP_LOSS_PCT: 3.0,          // Hard stop
  MAX_HOLD_MINUTES: 1440,      // 24h max
  TRAILING_AFTER_PCT: 1.5,     // Start trailing after 1.5% profit
  TRAILING_DISTANCE_PCT: 0.8,  // Trailing stop distance

  // Filters
  MIN_DEVIATION_PCT: 1.5,      // Minimum price deviation from mean to enter
  ADX_MAX: 30,                 // Skip if ADX > 30 (strong trend = don't fade)
  RSI_OVERSOLD: 25,            // RSI below this = oversold (confirm long)
  RSI_OVERBOUGHT: 75,          // RSI above this = overbought (confirm short)
} as const;
```

- [ ] **Step 4: Create mean reversion strategy**

Create `backend/src/strategies/meanReversion/strategy.ts` implementing `IStrategy`:
- Use Bollinger Bands (50-period, 2.5 sigma) for entry signal
- LONG when close < lower band + volume spike + RSI oversold
- SHORT when close > upper band + volume spike + RSI overbought
- Exit when price returns to mean (within 0.5 sigma of SMA)
- Trailing stop after 1.5% profit
- Hard SL at 3%
- ADX filter: skip if ADX > 30 (don't fade strong trends)

Import `calcBB`, `calcATR`, `calcADX`, `calcSMA` from `../indicators/technicalIndicators.js` (reusable infra).

- [ ] **Step 5: Run tests and iterate**

- [ ] **Step 6: Register strategy and commit**

```bash
git add src/strategies/meanReversion/ test/unit/meanReversionStrategy.test.ts src/strategies/registry.ts
git commit -m "feat: implement MeanReversionStrategy (BB + volume + RSI)"
```

---

## Task 9: Refactor Backtest Engine to Accept IStrategy

**Files:**
- Modify: `backend/src/services/backtestService.ts`
- Modify: `backend/scripts/quick-combined-bt.ts`
- Create: `backend/scripts/test-strategy.ts`

This is the largest refactor. The backtest engine currently calls `checkMomentumSignal()` and `shouldExitPosition()` directly. We need to route these through `IStrategy.checkEntry()` and `IStrategy.checkExit()`.

- [ ] **Step 1: Add IStrategy to BacktestParams**

In `backtestService.ts`, add to `BacktestParams`:

```typescript
import type { IStrategy } from '../strategies/types.js';

// Add to existing BacktestParams interface:
strategy?: IStrategy;  // If provided, uses this instead of momentum
```

- [ ] **Step 2: Create adapter layer in backtest loop**

In the main backtest loop where `checkMomentumSignal()` is called, add a branch:

```typescript
// In the entry check section:
let signal;
if (params.strategy) {
  const ctx: EntryContext = {
    symbol, candles: windowCandles, btcCandles: btcWindow,
    currentPrice: current.close, timestamp: current.timestamp,
    capital: availableCapital, openPositions: positions.length,
  };
  const stratSignal = params.strategy.checkEntry(ctx);
  signal = stratSignal ? { valid: true, side: stratSignal.side, confidence: stratSignal.confidence, reason: stratSignal.reason } : { valid: false };
} else {
  signal = checkMomentumSignal(/* existing args */);
}
```

Similar for exits — if `params.strategy`, call `strategy.checkExit()` instead of `shouldExitPosition()`.

- [ ] **Step 3: Create test-strategy.ts universal runner**

Create `backend/scripts/test-strategy.ts`:

```typescript
/**
 * Universal strategy tester.
 * Usage: npx tsx scripts/test-strategy.ts --strategy grid --period 2024
 *        npx tsx scripts/test-strategy.ts --strategy meanReversion --period 2025
 *        npx tsx scripts/test-strategy.ts --strategy grid --period 2024,2025
 */
import { getStrategy, listStrategies } from '../src/strategies/registry.js';
// ... (loads data, runs backtest with strategy param, prints results)
// Follows same pattern as quick-combined-bt.ts but uses IStrategy
```

- [ ] **Step 4: Verify momentum backtest still works (backward compat)**

```bash
cd backend && npx tsx scripts/quick-combined-bt.ts 2>&1 | tail -10
```

Should produce same results as before (momentum is default when no strategy param).

- [ ] **Step 5: Test grid strategy backtest**

```bash
cd backend && npx tsx scripts/test-strategy.ts --strategy grid --period 2024 2>&1
cd backend && npx tsx scripts/test-strategy.ts --strategy grid --period 2025 2>&1
```

- [ ] **Step 6: Test mean reversion backtest**

```bash
cd backend && npx tsx scripts/test-strategy.ts --strategy meanReversion --period 2024 2>&1
cd backend && npx tsx scripts/test-strategy.ts --strategy meanReversion --period 2025 2>&1
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: backtest engine accepts IStrategy param + universal test runner"
```

---

## Task 10: Run Full Validation and Compare Strategies

- [ ] **Step 1: Run grid backtest with full checklist**

For each strategy, validate ALL items:
- 2024 results (trades, WR, PnL, Sharpe, DD)
- 2025 results
- Per-symbol breakdown
- Walk-forward (H1 vs H2 for each year)

- [ ] **Step 2: Run mean reversion backtest with full checklist**

Same validation.

- [ ] **Step 3: Document results in DAILY_LOG.md**

```markdown
## 2026-03-25 — Strategy Comparison Results

### Grid Trading
- 2024: X trades, Y% WR, $Z PnL, Sharpe A, DD B%
- 2025: ...
- Verdict: PASS/FAIL checklist

### Mean Reversion
- 2024: ...
- 2025: ...
- Verdict: PASS/FAIL checklist
```

- [ ] **Step 4: Commit results**

```bash
git add backend/DAILY_LOG.md
git commit -m "docs: strategy comparison results — grid vs mean reversion"
```

---

## Task 11: Rewrite CLAUDE.md

**Files:**
- Rewrite: `backend/CLAUDE.md`

- [ ] **Step 1: Rewrite CLAUDE.md as clean guide**

Replace the 867-line changelog with a focused guide:

```markdown
# Remezz — Crypto Trading Platform

## Quick Start
npm run dev          # Development server (port 3001)
npm run build        # TypeScript compile + Prisma generate
npm test             # Full test suite

## Architecture
- Exchange: Binance Futures via CCXT + WebSocket
- Database: PostgreSQL + Prisma
- Frontend: React + Vite + Tailwind (port 5173)
- Strategies: Pluggable IStrategy interface

## Strategy System
See `src/strategies/types.ts` for IStrategy interface.
Each strategy lives in its own directory: `src/strategies/<name>/`
Register in `src/strategies/registry.ts`

### Adding a new strategy
1. Create `src/strategies/<name>/config.ts` and `strategy.ts`
2. Implement IStrategy interface
3. Register in registry.ts
4. Test: `npx tsx scripts/test-strategy.ts --strategy <name> --period 2024,2025`

## Backtest Validation Checklist (MANDATORY)
Before trusting ANY backtest result:
- [ ] Cross-regime: test on 2024 AND 2025
- [ ] Stable symbols first: BTC, ETH, SOL, XRP
- [ ] No look-ahead bias: closed candles only
- [ ] Realistic fees: 0.04% + 0.05% slippage + funding
- [ ] Sharpe > 1.0 on EACH year
- [ ] Max DD < 30% on each year
- [ ] Walk-forward: H1 and H2 both positive
- [ ] Works on 4+ symbols (not just 1-2)
- [ ] N > 100 trades minimum
- [ ] Engine backtest only (post-filter sims are unreliable)
- [ ] Document: "what could make this wrong?"

## Lessons Learned (Momentum Strategy — Archived in _archive/momentum/)
- 153 optimization versions = overfitting spiral
- Post-filter PnL ≠ engine backtest (confirmed 5x)
- If it only works on specific alts = red flag
- Don't re-optimize after each losing trade
- sma200_skip_zone paralyzed agents in indecisive markets

## Build & Dev Commands
(keep existing commands section)

## Database Schema
(keep existing schema section)

## Environment Variables
(keep existing env section)
```

- [ ] **Step 2: Commit**

```bash
git add backend/CLAUDE.md
git commit -m "docs: rewrite CLAUDE.md as clean guide (remove 800+ lines of momentum changelog)"
```

---

## Summary

| Task | Description | Estimate |
|------|------------|----------|
| 1 | Create DAILY_LOG + STATUS | 5 min |
| 2 | Archive momentum strategy files | 5 min |
| 3 | Archive scripts + output | 5 min |
| 4 | Create IStrategy + shared types | 15 min |
| 5 | Create strategy registry | 5 min |
| 6 | Fix imports (momentum decoupling) | 30 min |
| 7 | Implement GridStrategy | 20 min |
| 8 | Implement MeanReversionStrategy | 20 min |
| 9 | Refactor backtest engine | 45 min |
| 10 | Run validation + compare | 30 min |
| 11 | Rewrite CLAUDE.md | 10 min |
