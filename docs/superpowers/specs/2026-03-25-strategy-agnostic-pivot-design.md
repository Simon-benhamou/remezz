# Strategy-Agnostic Pivot — Design Spec

**Date:** 2026-03-25
**Branch:** dev
**Status:** Draft

## Problem

Momentum breakout strategy (V5.0–V5.153) failed in live trading. Curve-fitted to 2025 market conditions. Need to:
1. Archive momentum code without breaking infrastructure
2. Make backtest engine strategy-agnostic
3. Test new strategies (Grid, Mean Reversion, Funding Arb) with rigorous validation

## Architecture

### IStrategy Interface

```ts
// strategies/types.ts

interface EntryContext {
  symbol: string;
  candles: Candle[];          // symbol 15m candles (closed only)
  btcCandles: Candle[];       // BTC 15m candles (closed only)
  currentPrice: number;
  timestamp: number;
  capital: number;
  openPositions: number;
}

interface ExitContext {
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

interface SignalResult {
  valid: boolean;
  side: 'long' | 'short';
  confidence: number;         // 0-1
  reason: string;             // human-readable rejection/entry reason
  stopLossPct?: number;       // strategy-defined SL
  takeProfitPct?: number;     // optional TP
  metadata?: Record<string, any>; // strategy-specific data for logging
}

interface ExitSignal {
  shouldExit: boolean;
  reason: string;
  exitPrice?: number;         // limit price, or undefined for market
}

interface StrategyConfig {
  name: string;
  version: string;
  symbols: string[];
  leverage: number;
  maxPositions: number;
  positionSizePct: number;    // % of capital per trade
  minCandlesRequired: number; // warmup period
  timeframeMs: number;        // candle interval (default 15m = 900000)
  fees: {
    tradingPct: number;
    slippagePct: number;
    fundingPct: number;
  };
}

interface IStrategy {
  readonly name: string;
  getConfig(): StrategyConfig;
  checkEntry(ctx: EntryContext): SignalResult | null;
  checkExit(ctx: ExitContext): ExitSignal | null;
  onTradeComplete?(trade: CompletedTrade): void;  // optional: for strategies that adapt
}
```

### Strategy Registry

```ts
// strategies/registry.ts
const strategies: Map<string, IStrategy> = new Map();

function registerStrategy(strategy: IStrategy): void;
function getStrategy(name: string): IStrategy;
function listStrategies(): string[];
```

### File Structure After Refactor

```
backend/src/strategies/
  types.ts                      ← IStrategy, EntryContext, ExitContext interfaces
  registry.ts                   ← Strategy map
  _archive/
    momentum/                   ← All old momentum files (reference only)
      momentumConfig.ts
      momentumSignal.ts
      exitLogic.ts
      README.md                 ← Summary of what was tried and why it failed
  grid/
    strategy.ts                 ← GridStrategy implements IStrategy
    config.ts                   ← Grid parameters
  meanReversion/
    strategy.ts
    config.ts
  fundingArb/
    strategy.ts
    config.ts
  indicators/
    technicalIndicators.ts      ← KEEP (reusable ATR, BB, SMA, etc.)
  risk/
    positionSizing.ts           ← KEEP + minor refactor (remove momentum liquidity caps)
  # These files stay but get refactored to use IStrategy:
  orchestrator.ts
  positionOpener.ts
  realtimeExitHandler.ts
  capitalPool.ts                ← KEEP as-is
  positionPersistence.ts        ← KEEP as-is
  exchangeOrderManager.ts       ← KEEP as-is
  signalRanker.ts               ← KEEP as-is
  symbolEngine.ts               ← Refactor: inject strategy
```

### Backtest Engine Refactor

```ts
// backtestService.ts changes

interface BacktestParams {
  strategy: IStrategy;          // NEW: injected strategy
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  symbols?: string[];           // override strategy defaults
  leverage?: number;            // override strategy defaults
  postProcess1m?: boolean;
}

// The engine loop becomes:
for (each candle) {
  // Check exits on open positions
  for (each position) {
    const exitSignal = strategy.checkExit(exitContext);
    if (exitSignal.shouldExit) closePosition(exitSignal);
  }
  // Check entries
  const signal = strategy.checkEntry(entryContext);
  if (signal?.valid) openPosition(signal);
}
```

### Scripts Cleanup

- 118 momentum analysis scripts → move to `_archive/momentum/scripts/`
- `output/` reports → move to `_archive/momentum/output/`
- Keep: `quick-bt.ts`, `quick-combined-bt.ts` (refactor to use IStrategy)
- New: `test-strategy.ts` — universal strategy tester

## Strategies to Implement & Test

### 1. Grid Trading
- Place buy/sell orders at fixed intervals around current price
- Profit from oscillation within range
- Stop loss: exit all if price breaks range by >X%
- Test symbols: BTC, ETH, SOL, XRP
- Expected: consistent small gains in range, loss in strong trends

### 2. Mean Reversion (Bollinger/Z-score)
- Enter when price deviates >2.5 sigma from mean
- FADE the move (buy dip, sell rip) — opposite of momentum
- Tight stop loss (3% max)
- Test symbols: BTC, ETH, SOL, XRP
- Expected: high WR (70%+), small avg gain, rare large losses

### 3. Funding Rate Arbitrage
- Monitor funding rates across symbols
- Short when funding strongly positive (>0.03%/8h)
- Long when funding strongly negative
- Delta-neutral preferred (short perp + long spot)
- Test symbols: all high-cap with funding data
- Expected: steady yield, low volatility

## Backtest Validation Checklist

Every backtest MUST pass ALL of these before any strategy is considered viable:

- [ ] **Cross-regime:** Test on 2024 AND 2025 separately
- [ ] **Stable symbols first:** BTC, ETH, SOL, XRP before alts
- [ ] **No look-ahead bias:** Only use closed candles (isFinal), no future data
- [ ] **Realistic costs:** Trading fee 0.04% + slippage 0.05% + funding
- [ ] **Sharpe > 1.0** on EACH year individually
- [ ] **Max DD < 30%** on each year
- [ ] **Walk-forward:** Split each year in half, both halves positive
- [ ] **Symbol-agnostic:** Works on 4+ symbols, not just 1-2
- [ ] **N > 100 trades** for statistical significance
- [ ] **Engine backtest only:** Post-filter simulations are NOT valid (proven 5 times)
- [ ] **Self-critique:** For each backtest, document "what could make this wrong?"

## CLAUDE.md New Structure

```markdown
# Remezz — Crypto Trading Platform

## Architecture Overview
(keep existing infra docs, remove momentum-specific)

## Strategy System
- IStrategy interface
- How to add a new strategy
- Backtest validation checklist

## Lessons Learned (Momentum Strategy — Archived)
- 153 versions, curve-fitted to 2025
- Post-filter trap confirmed 5 times
- sma200_skip_zone paralysis in regime transition
- Individual symbol BT ≠ combined BT

## Build & Dev Commands
(keep as-is)

## Database Schema
(keep as-is)
```

## Execution Order

### Phase 1: Archive & Clean (no behavior change)
1. Create `_archive/momentum/` directory
2. Move momentum strategy files (config, signal, exit)
3. Move 118 scripts + output/ to archive
4. Create archive README with momentum summary
5. Create DAILY_LOG.md

### Phase 2: Strategy Interface
6. Create `strategies/types.ts` with IStrategy
7. Create `strategies/registry.ts`
8. Refactor `backtestService.ts` to accept IStrategy
9. Refactor `quick-combined-bt.ts` to use registry

### Phase 3: Backtest Engine Validation
10. Create a "dummy" strategy (always enter/exit) to verify engine works
11. Verify: no momentum imports remain in active code paths

### Phase 4: Implement & Test Strategies
12. Implement GridStrategy
13. Backtest grid on BTC/ETH/SOL/XRP 2024+2025
14. Implement MeanReversionStrategy
15. Backtest mean reversion
16. Implement FundingArbStrategy (if data available)
17. Compare all strategies — apply full checklist

### Phase 5: Documentation
18. Rewrite CLAUDE.md (guide, not changelog)
19. Update frontend backtest page for strategy selection

## Success Criteria

- Backtest engine runs any IStrategy without code changes
- At least 1 strategy passes FULL validation checklist on 2024+2025
- CLAUDE.md is a clean guide, not a 900-line changelog
- Zero imports from `_archive/` in active code
