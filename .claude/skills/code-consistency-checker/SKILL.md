---
name: code-consistency-checker
description: Validates that backtest code and production trading code implement identical strategy logic to prevent look-ahead bias and deployment errors. Compares entry conditions, exit conditions, position sizing, risk management, indicator calculations, and signal scoring between backtest and live trading implementations. Use when deploying strategies to production, verifying backtest-production parity, debugging discrepancies between backtest and live results, or validating strategy changes affect both implementations equally.
allowed-tools: Read, Grep, Glob
---

# Code Consistency Checker

Ensures backtest and production code implement identical trading strategy logic to prevent costly deployment errors and ensure backtest results accurately predict live performance.

## Purpose

Prevents critical trading system issues:
- **Look-ahead bias**: Backtest using future data not available in production
- **Logic divergence**: Different entry/exit conditions in backtest vs production
- **Parameter drift**: Indicator periods, thresholds, or calculations differing
- **Missing risk controls**: Production lacks safety features tested in backtest
- **Order execution assumptions**: Unrealistic fill assumptions in backtest

## Critical Philosophy

**ZERO tolerance for divergence** in these areas:
1. Entry signal calculation
2. Exit signal calculation
3. Position sizing logic
4. Stop loss placement
5. Indicator formulas and parameters

Even small differences (e.g., SMA20 vs SMA21) can cause significant performance divergence over thousands of trades.

## Instructions

When checking backtest-production code parity:

### 1. Identify Code Locations

**Remezz Trading System Structure:**

**Backtest Code:**
- Main engine: `backend/src/services/backtestService.ts` (~1,613 lines)
- Strategy config: `backend/src/strategies/momentumSimple.ts` (entry/exit conditions)
- Signal ranking: `backend/src/services/signalRanker.ts` (scoring algorithm)

**Production Code:**
- Execution engine: `backend/src/strategies/simpleAgent.ts` (~3,858 lines)
- Strategy config: `backend/src/strategies/momentumSimple.ts` (SAME FILE - good!)
- Signal ranking: `backend/src/services/signalRanker.ts` (SAME FILE - good!)
- Capital management: `backend/src/services/capitalPool.ts`

**Key Insight**: This system uses **shared strategy files** (`momentumSimple.ts`, `signalRanker.ts`) imported by both backtest and production. This is EXCELLENT design - changes automatically propagate.

**Your job**: Verify this shared architecture is maintained and no divergence crept in.

### 2. Systematic Comparison Process

Follow this checklist in order:

#### Step 1: Verify Shared Imports

**Check that both backtest and production import the SAME strategy logic:**

```bash
# In backtestService.ts, look for:
grep "import.*momentumSimple" backend/src/services/backtestService.ts

# In simpleAgent.ts, look for:
grep "import.*momentumSimple" backend/src/strategies/simpleAgent.ts

# Should both import from same file, e.g.:
# import { checkMomentumSignal, checkMomentumExit } from './momentumSimple.js'
```

**GOOD:**
```typescript
// backtestService.ts
import { checkMomentumSignal } from '../strategies/momentumSimple.js';

// simpleAgent.ts
import { checkMomentumSignal } from './momentumSimple.js';
// ✓ Same function from same source file
```

**BAD:**
```typescript
// backtestService.ts
import { checkMomentumSignal } from '../strategies/momentumSimple.js';

// simpleAgent.ts
// Inline implementation instead of import ✗
private checkSignal(candles: any[]) {
  const roc = this.calculateROC(candles, 10);
  return roc > 1.75; // Hardcoded logic - can drift!
}
```

**Report:**
```
✓ PASS: Both implementations import checkMomentumSignal from momentumSimple.ts
✓ PASS: Both implementations import calculateSignalScore from signalRanker.ts
```

#### Step 2: Compare Entry Logic

**Extract entry condition code from both implementations:**

**In Backtest (`backtestService.ts`):**
```typescript
// Search for where signals are generated
grep -A 20 "checkMomentumSignal" backend/src/services/backtestService.ts
```

**In Production (`simpleAgent.ts`):**
```typescript
// Search for where signals are generated
grep -A 20 "checkMomentumSignal" backend/src/strategies/simpleAgent.ts
```

**Compare line-by-line:**

1. **Are they calling the same function?**
   - Both should call `checkMomentumSignal(candles, btcCandles, config, side)`
   - Same parameters in same order

2. **Are they using the same configuration?**
   ```typescript
   // Backtest
   const config = MomentumConfig; // From momentumSimple.ts

   // Production
   const config = MomentumConfig; // Should be identical
   ```

3. **Are entry filters applied consistently?**
   ```typescript
   // Check both use:
   // - BTC regime filter (SMA200)
   // - ROC threshold
   // - Volume multiplier
   // - BB breakout check
   // - Consecutive candles filter
   ```

**Example Divergence Detection:**

```typescript
// ❌ CRITICAL DIVERGENCE FOUND

BACKTEST (backtestService.ts:456):
const signal = checkMomentumSignal(candles, btcCandles, MomentumConfig, 'LONG');
// Uses MomentumConfig.LONG.ROC_MIN = 1.75%

PRODUCTION (simpleAgent.ts:892):
const signal = checkMomentumSignal(candles, btcCandles, {
  ...MomentumConfig,
  LONG: { ...MomentumConfig.LONG, ROC_MIN: 2.0 } // OVERRIDE!
}, 'LONG');
// Uses overridden ROC_MIN = 2.0%

IMPACT: Production requires higher momentum, will generate fewer signals than backtest predicts
FIX: Remove override in simpleAgent.ts line 892, use default MomentumConfig
```

#### Step 3: Compare Exit Logic

**Critical exit conditions to verify:**

1. **Trailing Stop Implementation**

**Backtest:**
```typescript
// In backtestService.ts, find trailing stop logic
grep -A 30 "TRAILING_STOP" backend/src/services/backtestService.ts
```

**Production:**
```typescript
// In simpleAgent.ts, find trailing stop logic
grep -A 30 "updateTrailingStop\|checkTrailingStop" backend/src/strategies/simpleAgent.ts
```

**Verify identical:**
- Activation threshold (e.g., +0.8% profit)
- Distance from peak (e.g., 0.5%)
- Confirmation candles (e.g., 2 consecutive 1m closes)
- Adaptive distance logic (low vol vs high vol)

**Example Check:**
```typescript
// Both should have:
TRAILING_STOP: {
  ACTIVATION_THRESHOLD: 0.008,      // Same?
  DISTANCE: 0.005,                  // Same?
  CONFIRMATION_CANDLES: 2,          // Same?
  LOW_VOL_DISTANCE: 0.003,          // Same?
  HIGH_VOL_DISTANCE: 0.008,         // Same?
}
```

2. **Stop Loss**

```typescript
// Verify both use:
STOP_LOSS_PCT: 0.025  // 2.5% fixed

// Check for divergence:
// Backtest: 2.5% from entry
// Production: 2.5% × 2.5 multiplier for exchange SL = 6.25%
// This is OK if intentional (tighter app-side, wider exchange-side)
```

3. **Regime Change Exit**

```typescript
// Both must check:
if (btcPrice crosses SMA200 against position) {
  if (volumeRatio >= 1.5) {  // Volume confirmation
    exit();
  }
}

// Verify volume confirmation threshold is same: 1.5x
```

4. **Momentum Reversal Exit**

```typescript
// LONG exit:
if (ROC5 < -1.5%) exit();

// SHORT exit:
if (ROC5 > +1.5%) exit();

// Verify thresholds: ±1.5% in both implementations
```

5. **Stagnant Trade Exit (V5.34)**

```typescript
// Complex state machine - verify all parameters match:
STAGNANT_EXIT: {
  TRIGGER_TIME: 45,           // Minutes
  MAX_PNL_THRESHOLD: 0.008,   // 0.8%
  OBSERVATION_WINDOW: 60,     // Minutes
  CANCEL_PEAK_THRESHOLD: 0.006, // 0.6%
  TIGHTEN_SL_TO: 0.008,       // 0.8%
}
```

**Report any differences:**
```
❌ CRITICAL: Stagnant exit divergence found

BACKTEST: TRIGGER_TIME = 45 minutes
PRODUCTION: TRIGGER_TIME = 60 minutes

IMPACT: Production waits 33% longer before detecting stagnant trades
RESULT: Backtest overestimates performance (exits earlier = saves capital)
FIX: Set simpleAgent.ts TRIGGER_TIME to 45 (match backtest)
```

#### Step 4: Verify Indicator Calculations

**Check these indicators are calculated identically:**

1. **Bollinger Bands**

```typescript
// Find implementation
grep -A 10 "calcBollingerBands\|calculateBB" backend/src/

// Verify:
// - Period: 20
// - Standard deviations: 2
// - Uses SMA (not EMA)
// - Same price array (close prices)
```

**Example divergence:**
```typescript
// ❌ DIVERGENCE

BACKTEST: calcBollingerBands(closes, 20, 2)
PRODUCTION: calcBollingerBands(closes, 20, 2.5)  // Different stddev!

IMPACT: Production bands are 25% wider, fewer breakout signals
```

2. **Rate of Change (ROC)**

```typescript
// Verify formula:
ROC10 = (close[0] - close[10]) / close[10] * 100

// Check:
// - ROC5 lookback: 5 candles
// - ROC10 lookback: 10 candles
// - ROC20 lookback: 20 candles (if used)
```

3. **Volume Ratio**

```typescript
// Verify:
volumeRatio = currentVolume / SMA(volume, 20)

// Check period is same: 20
```

4. **ATR (Average True Range)**

```typescript
// Verify:
// - Period: 14
// - Smoothing: EMA or SMA? (must match)
```

5. **StochRSI**

```typescript
// Verify:
// - RSI period: 14
// - Stoch period: 14
// - K period: 3
// - D period: 3
```

6. **SMA200 (BTC Regime Detection)**

```typescript
// CRITICAL: This determines LONG vs SHORT
// Verify:
// - Period: 200
// - Timeframe: 15m
// - Applied to BTC (not other symbols)

// Calculate candles needed:
// 200 candles × 15 min = 3,000 min = 50 hours
// Both should fetch 220 BTC candles (buffer for calculation)
```

**Report:**
```
✓ PASS: Bollinger Bands use (20, 2) in both implementations
✓ PASS: ROC calculations use correct lookbacks (5, 10)
✓ PASS: Volume ratio uses SMA(20)
⚠️ WARNING: ATR found in code but not actively used in strategy
✓ PASS: BTC SMA200 uses 220 candles in both (200 + 20 buffer)
```

#### Step 5: Verify Signal Scoring (V5.22+ Critical)

**Since V5.22, signal ranking determines which trades execute when capital is limited.**

```typescript
// Find shared scoring function
grep -A 50 "calculateSignalScore" backend/src/services/signalRanker.ts
```

**Verify backtest and production both:**

1. Import the SAME function:
   ```typescript
   import { calculateSignalScore } from '../services/signalRanker.js';
   ```

2. Pass the SAME parameters:
   ```typescript
   const score = calculateSignalScore({
     roc5,
     volumeRatio,
     bbPosition,      // Distance from BB band
     atrPct,
     trendStrength,   // SMA20 slope
     side             // LONG or SHORT
   });
   ```

3. Use the SAME weights:
   ```typescript
   // In signalRanker.ts
   const weights = {
     roc: 0.25,
     volume: 0.20,
     bbPosition: 0.25,
     atr: 0.15,
     trend: 0.15
   };
   ```

**Example divergence:**
```typescript
// ❌ CRITICAL DIVERGENCE

BACKTEST (backtestService.ts):
const score = calculateSignalScore({ roc5, volumeRatio, bbPosition, atrPct, trendStrength, side });
// Uses all 5 factors

PRODUCTION (simpleAgent.ts):
const score = roc5 * 0.6 + volumeRatio * 0.4;
// Only uses 2 factors! Completely different scoring!

IMPACT: Production will select different trades than backtest when ranking
RESULT: Backtest results are INVALID for predicting live performance
FIX: Replace line in simpleAgent.ts with:
  const score = calculateSignalScore({ roc5, volumeRatio, bbPosition, atrPct, trendStrength, side });
```

#### Step 6: Verify Position Sizing

**Check position size calculations match:**

```typescript
// Find position sizing logic
grep -A 15 "calculatePositionSize\|positionSize" backend/src/
```

**Verify both use:**

1. **Base percentage**:
   ```typescript
   const baseSize = 0.40; // 40% of available capital
   ```

2. **Scaling with capital**:
   ```typescript
   const bonus = (totalCapital / 5000) * 0.03; // +3% per $5k
   const size = Math.min(baseSize + bonus, 0.55); // Cap at 55%
   ```

3. **Leverage**:
   ```typescript
   const leverage = 5; // 5x uniform leverage
   ```

4. **Liquidity caps**:
   ```typescript
   const maxNotional = LIQUIDITY_CAPS[symbol]; // e.g., $500k for BTC
   const positionSize = Math.min(calculated, maxNotional);
   ```

**Report:**
```
✓ PASS: Base position size is 40% in both
✓ PASS: Scaling logic identical (bonus per $5k)
✓ PASS: Leverage is 5x in both
✓ PASS: Liquidity caps applied in both
```

#### Step 7: Verify Data Sources

**Critical: Backtest and production must use consistent data**

**Backtest Data:**
```typescript
// Check data source
grep -A 5 "loadHistoricalData\|fetchOHLCV" backend/src/services/backtestService.ts

// Should load from:
// - Local JSON files in backend/data/*.json (15m candles)
// - Fallback to CCXT REST API
```

**Production Data:**
```typescript
// Check data source
grep -A 5 "getKlinesOhlcvFromWebSocket\|fetchCandles" backend/src/strategies/simpleAgent.ts

// Should use:
// - WebSocket cache (primary, real-time)
// - CCXT REST API (fallback)
```

**Verify:**
1. **Same timeframe**: Both use 15m candles
2. **Same symbol format**: Both use Binance futures format (e.g., `BTC/USDT:USDT`)
3. **Same candle count**: Both fetch 100+ candles for indicator calculation
4. **Same exchange**: Both use Binance Futures (not Spot, not other exchanges)

**Potential divergence:**
```typescript
// ❌ DIVERGENCE RISK

BACKTEST: Uses historical JSON files (closed candles only)
PRODUCTION: Uses WebSocket (includes current forming candle)

IMPACT: Production might generate signals mid-candle that backtest only sees at close
FIX: Verify production filters out incomplete candles:
  const completedCandles = candles.filter(c => c.timestamp < now - 15*60*1000);
```

#### Step 8: Check for Timing Differences

**Backtest runs on closed candles; production runs real-time. Verify:**

1. **Signal generation timing**:
   ```typescript
   // Production should only check signals AFTER candle closes
   // Not mid-candle (would cause look-ahead bias)

   const currentTime = Date.now();
   const lastCandleClose = candles[candles.length - 1].timestamp;
   const timeSinceClose = currentTime - lastCandleClose;

   if (timeSinceClose < 60000) { // < 1 minute
     return; // Wait for candle to close
   }
   ```

2. **Exit checking timing**:
   ```typescript
   // Trailing stops: Can check every 1m (real-time klines)
   // Regime change: Should check every 15m (after candle close)
   ```

**Report:**
```
✓ PASS: Production waits for candle close before generating entry signals
✓ PASS: Production checks trailing stops on 1m klines (more frequent, acceptable)
⚠️ REVIEW: Production checks regime change on every tick (backtests checks every 15m)
   → Not a bug if using latest BTC price, but verify in code
```

#### Step 9: Verify Cost Models

**Backtest should model realistic trading costs:**

```typescript
// In backtestService.ts
const COSTS = {
  TRADING_FEE_PCT: 0.04,    // 0.04% taker fee (Binance)
  SLIPPAGE_PCT: 0.05,       // 0.05% slippage
  FUNDING_RATE_PCT: 0.01,   // 0.01% per 8h (average)
  FUNDING_INTERVAL_BARS: 32 // 32 bars × 15min = 8 hours
};
```

**Verify production has equivalent costs:**

```typescript
// Production uses real exchange fees (no need to model)
// But check if slippage estimation is enabled

grep -A 10 "slippage\|executionModel" backend/src/
```

**Common issue:**
```
⚠️ WARNING: Backtest models 0.05% slippage, but no slippage tracking found in production

RECOMMENDATION: Add execution quality tracking to compare:
  - Backtest assumes 0.05% slippage
  - Production logs actual slippage (order price vs fill price)
  - Compare monthly to validate backtest assumptions
```

### 3. Advanced Checks

#### Look-Ahead Bias Detection

**Search for these red flags:**

```bash
# Dangerous: Using current candle close price for entry
# (in real-time, close isn't known until candle completes)
grep -n "close\[0\]" backend/src/strategies/*.ts

# Dangerous: Calculating indicators on incomplete data
grep -n "calculateIndicator.*candles\)" backend/src/strategies/*.ts
```

**Validate:**
```typescript
// ✓ GOOD (backtest and production)
const signal = checkSignal(candles.slice(0, -1)); // Use completed candles only

// ❌ BAD (look-ahead bias)
const signal = checkSignal(candles); // Includes current forming candle!
```

#### Parameter Hardcoding Detection

**Find all numeric thresholds and verify they're consistent:**

```bash
# Extract all numbers that look like thresholds
grep -Eo "[0-9]+\.[0-9]+%" backend/src/strategies/*.ts | sort | uniq

# Common values to check:
# 1.75% (ROC threshold)
# 0.008 (0.8% trailing activation)
# 0.025 (2.5% stop loss)
# 200 (SMA period)
```

**Report any hardcoded values:**
```
⚠️ HARDCODED VALUE DETECTED

File: simpleAgent.ts:1243
Code: if (roc > 1.75) { ... }

ISSUE: Hardcoded threshold instead of using MomentumConfig.LONG.ROC_MIN
RISK: Value can drift from config, causing divergence
FIX: Replace with:
  if (roc > MomentumConfig.LONG.ROC_MIN) { ... }
```

#### State Management Differences

**Backtest is stateless (replays history); production maintains state.**

**Verify state doesn't cause divergence:**

1. **Position tracking**:
   ```typescript
   // Both should track:
   // - Entry price
   // - Entry time
   // - Max PnL (for trailing stop)
   // - Consecutive breach candles
   // - Stagnant state machine (triggered, confirmed, etc.)
   ```

2. **Capital pool**:
   ```typescript
   // Backtest: Simulates capital pool
   // Production: Uses real capital pool service

   // Verify both reserve → commit → release flow
   ```

3. **Position restart handling**:
   ```typescript
   // Production may restart mid-position (server crash)
   // Check if position state is persisted:
   grep -A 10 "loadPositionFromDB\|restorePosition" backend/src/

   // Verify restored state includes:
   // - entryTime (for stagnant exit)
   // - maxPnlPct (for trailing stop)
   ```

**Example issue:**
```
❌ CRITICAL: Production loses maxPnlPct on restart

BACKTEST: Tracks maxPnlPct in memory (works because single run)
PRODUCTION: Loses maxPnlPct on restart → trailing stop resets to current PnL

IMPACT: After restart, trailing stop may trigger prematurely
FIX: Persist maxPnlPct to database in position table
```

## Output Format

### Summary Report

```markdown
# Code Consistency Check Report

**Date**: [Current Date]
**Backtest File**: backend/src/services/backtestService.ts
**Production File**: backend/src/strategies/simpleAgent.ts
**Strategy Version**: V5.34

---

## Overall Assessment

**Status**: [✓ PASS / ⚠️ WARNING / ❌ CRITICAL ISSUES]

**Issues Found**: [Count by severity]
- CRITICAL: [N] (must fix before production deployment)
- WARNING: [N] (should fix, may impact performance)
- INFO: [N] (cosmetic, no impact)

---

## Detailed Findings

### Entry Logic
[✓ PASS / ❌ FAIL with details]

### Exit Logic
[✓ PASS / ❌ FAIL with details]

### Indicator Calculations
[✓ PASS / ❌ FAIL with details]

### Signal Scoring
[✓ PASS / ❌ FAIL with details]

### Position Sizing
[✓ PASS / ❌ FAIL with details]

### Data Sources
[✓ PASS / ❌ FAIL with details]

### Cost Models
[✓ PASS / ❌ FAIL with details]

---

## Issues Requiring Action

### 🔴 CRITICAL (Fix Immediately)

**Issue 1: [Title]**
- **Location**: [File:Line]
- **Divergence**: [Description]
- **Impact**: [How this affects trading]
- **Fix**: [Exact code change needed]

### 🟡 WARNING (Fix Before Next Deployment)

**Issue 1: [Title]**
[Same structure]

### ℹ️ INFO (Optional Improvements)

**Issue 1: [Title]**
[Same structure]

---

## Validation Checklist

- [✓] Entry conditions identical
- [✓] Exit conditions identical
- [✓] Indicator calculations identical
- [✓] Signal scoring identical
- [✓] Position sizing identical
- [✓] Data sources consistent
- [✓] No look-ahead bias detected
- [✓] Cost models realistic
- [✓] State management consistent

---

## Recommendations

1. [Priority 1 action]
2. [Priority 2 action]
3. [Priority 3 action]

---

## Code Snippets

### Divergence Example 1
```typescript
// BACKTEST (backtestService.ts:456)
const roc = calculateROC(closes, 10);

// PRODUCTION (simpleAgent.ts:892)
const roc = calculateROC(closes, 12); // ← DIFFERENT PERIOD!
```

**Fix**:
```typescript
// Change simpleAgent.ts:892 to:
const roc = calculateROC(closes, 10); // Match backtest
```

---

## Next Steps

1. **Immediate**: Fix all CRITICAL issues
2. **This week**: Fix all WARNING issues
3. **Optional**: Address INFO issues
4. **After fixes**: Re-run backtest-analyzer to verify changes
5. **Before deployment**: Re-run this checker to confirm parity
```

## Special Patterns for Remezz System

### Shared Strategy File Validation

**The system's KEY STRENGTH is shared files. Protect this architecture:**

```typescript
// ✓ EXCELLENT PATTERN (preserve this!)
// momentumSimple.ts exports functions
export function checkMomentumSignal(...) { }

// backtestService.ts imports
import { checkMomentumSignal } from '../strategies/momentumSimple.js';

// simpleAgent.ts imports
import { checkMomentumSignal } from './momentumSimple.js';

// ANY changes to momentumSimple.ts affect both automatically!
```

**Red flag to watch for:**
```typescript
// ❌ BAD PATTERN (someone copied logic instead of importing)
// simpleAgent.ts
private checkSignalLocal(candles: any[]) {
  // Duplicate implementation of checkMomentumSignal
  // This will drift over time!
}
```

**If you find duplicated logic, report:**
```
🔴 CRITICAL: Duplicated strategy logic found

LOCATION: simpleAgent.ts:checkSignalLocal() (lines 1423-1456)
ISSUE: Reimplements checkMomentumSignal instead of importing
RISK: Changes to momentumSimple.ts won't affect production
IMPACT: Backtest and production WILL diverge over time

FIX:
1. Delete checkSignalLocal() function
2. Replace calls with:
   import { checkMomentumSignal } from './momentumSimple.js';
   const signal = checkMomentumSignal(candles, btcCandles, MomentumConfig, side);
```

### Version Comment Validation

**The codebase uses version comments (V5.XX). Validate they match:**

```bash
# Find all version references
grep -n "// V5\." backend/src/strategies/*.ts backend/src/services/backtestService.ts
```

**Check:**
- Both backtest and production reference the same latest version
- No conflicting version comments (e.g., backtest says V5.34, production says V5.13)

**Example issue:**
```
⚠️ VERSION MISMATCH DETECTED

BACKTEST (backtestService.ts:234):
  // V5.34: Smart stagnant exit with observation window

PRODUCTION (simpleAgent.ts:1567):
  // V5.31: Immediate stagnant exit (no observation)

ISSUE: Production is running older version of stagnant exit logic
IMPACT: Backtest expects observation window behavior; production exits immediately
FIX: Update simpleAgent.ts to V5.34 logic or downgrade backtest to V5.31 for testing
```

### Configuration Override Detection

**Watch for config overrides that break parity:**

```bash
# Find potential config overrides
grep -n "MomentumConfig\." backend/src/strategies/simpleAgent.ts | grep -v "import"
```

**Look for:**
```typescript
// ❌ DANGEROUS PATTERN
const config = {
  ...MomentumConfig,
  LONG: {
    ...MomentumConfig.LONG,
    ROC_MIN: 2.0  // Override!
  }
};
```

**Should be:**
```typescript
// ✓ SAFE PATTERN
const config = MomentumConfig; // Use as-is
```

## Integration with Backtest Analyzer

**After finding issues, recommend validation:**

```
📋 RECOMMENDED NEXT STEPS:

1. Fix all CRITICAL issues listed above

2. Re-run backtest with corrected code:
   "Run backtest on V5.34 to validate fixes"

3. Compare results before/after:
   "Compare backtest results before and after consistency fixes"

4. If results change significantly (>5% ROI difference):
   - Previous backtest was invalid (had look-ahead bias or divergence)
   - New backtest is accurate
   - Do NOT deploy to production until new backtest validates strategy

5. Set up automated consistency checks:
   - Add pre-commit hook to run this checker
   - Block commits that introduce divergence
```

## Troubleshooting

### Can't Find Strategy Files

```bash
# Search entire codebase for strategy keywords
grep -r "checkMomentumSignal\|entry.*signal\|exit.*signal" backend/src/

# Look for class definitions
grep -r "class.*Agent\|class.*Strategy" backend/src/
```

### Too Many Differences Found

**If you find > 10 divergences, the architecture may have broken down.**

**Report:**
```
🔴 CRITICAL ARCHITECTURE FAILURE

FOUND: 27 divergences between backtest and production
ROOT CAUSE: Shared strategy files are not being used consistently

EVIDENCE:
- simpleAgent.ts has 1,234 lines of duplicate indicator code
- backtestService.ts has different entry logic
- No shared imports found

IMPACT: Backtest results are completely unreliable
RECOMMENDATION:
1. PAUSE all trading immediately
2. Refactor to restore shared architecture
3. Re-run full 24-month backtest to validate
4. Do NOT resume trading until parity is confirmed
```

### Backtest Results Don't Match Live

**If user reports "backtest shows +200% but live is -10%", use this skill to investigate:**

```
User: "My backtest predicted +200% but I'm down 10% after 2 weeks live. What's wrong?"

Claude (code-consistency-checker):
1. Compares backtest and production code
2. Finds divergences (e.g., different stop loss, missing regime filter)
3. Explains which divergence caused the performance gap
4. Provides fix to align code
5. Recommends re-running backtest with corrected code
```

## Remember

- **Zero tolerance for divergence**: Even 0.1% difference in thresholds matters over 2,000 trades
- **Shared code is sacred**: Protect the shared architecture (momentumSimple.ts, signalRanker.ts)
- **Version comments are documentation**: Use them to validate both implementations are on same version
- **State persistence matters**: Production restarts must not lose critical state (maxPnlPct, entryTime)
- **Be paranoid**: If backtest shows exceptional results (>500% ROI), double-check for look-ahead bias

Your goal is to ensure traders can trust their backtest results to predict live performance accurately.
