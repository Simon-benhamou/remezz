---
name: pattern-researcher
description: Discovers and tests new trading patterns in historical data. Analyzes volume profiles, multi-timeframe confluence, order flow imbalances, momentum divergences, and custom patterns. Automatically implements pattern detection code, runs backtests for validation, documents results with V5.XX versioning style, and recommends enabling or disabling patterns based on performance. Use when exploring new trading opportunities, investigating market behavior, testing pattern hypotheses, or systematically improving strategy edge.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(python:*), Bash(node:*), Bash(npm:*)
---

# Pattern Researcher

Systematically discovers, tests, and validates new trading patterns to improve strategy performance. Automates the pattern discovery process used to evolve QuantAI from V5.0 → V5.34.

## Purpose

This skill replicates and enhances your proven pattern research workflow:

**Historical Evolution** (from your codebase):
- V5.32: BB Squeeze + Anticipatory Entry → Tested → Underperformed 27x → **DISABLED**
- V5.33: Breakout Confirmation Filter → Tested → 60% WR but -49% trades → **DISABLED**
- V5.34: Smart Stagnant Exit → Tested → +31% improvement → **ENABLED**
- V5.13: Regime Change + Momentum Reversal → Tested → +8% exits → **ENABLED**

**This skill systematizes**:
1. Pattern hypothesis formation
2. Code implementation
3. Backtest validation (12-24 months)
4. Performance comparison vs baseline
5. Enable/disable decision with documentation

## Core Philosophy

**"Test everything, trust data, disable what doesn't work"**

- Every pattern must prove itself with > 100 trades
- Improvements must be > 10% to justify complexity
- Backtest on 12-24 months (your preference from earlier)
- Document results in code comments (V5.XX style)
- Disable ruthlessly if counterproductive

---

## Instructions

When researching patterns:

### Phase 1: Pattern Discovery

#### Step 1: Identify Pattern Hypothesis

**Common sources**:
1. **User request**: "I think volume accumulation predicts breakouts"
2. **Backtest anomalies**: "Why do some trades last 5 min and others 3 hours?"
3. **Live trading observations**: "Losses cluster around BTC regime changes"
4. **Literature/research**: "Multi-timeframe confluence improves win rate"

**Formulate testable hypothesis**:
```
HYPOTHESIS: [Clear statement]
EXPECTED IMPACT: [Quantitative prediction]
TEST METHOD: [How to validate]

Example:
HYPOTHESIS: Trades with 3+ consecutive volume increases have higher win rates
EXPECTED IMPACT: +5-10% win rate improvement, -20% trades (more selective)
TEST METHOD: Backtest with volume accumulation filter, compare with V5.34 baseline
```

---

#### Step 2: Analyze Historical Data for Evidence

**Load historical data**:
```python
# Use existing backtest data or run new backtest
import json

# Load recent backtest results
with open('results/backtest_v5_34.json') as f:
    results = json.load(f)

trades = results['trades']
```

**Perform exploratory analysis**:

**Example 1: Volume Pattern Analysis**
```python
# Group trades by volume pattern
volume_rising = []
volume_other = []

for trade in trades:
    # Check if entry had rising volume (3+ candles)
    if 'volumePattern' in trade and trade['volumePattern'] == 'rising':
        volume_rising.append(trade)
    else:
        volume_other.append(trade)

# Compare win rates
wr_rising = len([t for t in volume_rising if t['pnl'] > 0]) / len(volume_rising)
wr_other = len([t for t in volume_other if t['pnl'] > 0]) / len(volume_other)

print(f"Rising volume WR: {wr_rising:.1%}")
print(f"Other WR: {wr_other:.1%}")
print(f"Improvement: {(wr_rising - wr_other) * 100:.1f}pp")
```

**Example 2: Time-of-Day Pattern**
```python
from datetime import datetime

# Group by hour
hourly_stats = {}
for trade in trades:
    hour = datetime.fromtimestamp(trade['entryTime'] / 1000).hour
    if hour not in hourly_stats:
        hourly_stats[hour] = {'wins': 0, 'total': 0}

    hourly_stats[hour]['total'] += 1
    if trade['pnl'] > 0:
        hourly_stats[hour]['wins'] += 1

# Find worst hours (< 45% WR)
bad_hours = [h for h, s in hourly_stats.items()
             if s['wins'] / s['total'] < 0.45 and s['total'] > 20]

print(f"Avoid trading hours: {bad_hours}")
```

**Example 3: Multi-Timeframe Confluence**
```python
# Check if higher timeframe alignment improves WR
aligned_trades = [t for t in trades if t.get('htfAligned') == True]
unaligned_trades = [t for t in trades if t.get('htfAligned') == False]

wr_aligned = len([t for t in aligned_trades if t['pnl'] > 0]) / len(aligned_trades)
wr_unaligned = len([t for t in unaligned_trades if t['pnl'] > 0]) / len(unaligned_trades)

print(f"Aligned WR: {wr_aligned:.1%}")
print(f"Unaligned WR: {wr_unaligned:.1%}")
```

**Report preliminary findings**:
```markdown
## Preliminary Pattern Analysis

**Pattern**: Volume Accumulation (3+ rising candles)

**Data Sample**: 2,103 trades from V5.34 backtest

**Findings**:
- Trades with rising volume: 547 (26% of total)
- Win Rate with pattern: 68.2%
- Win Rate without pattern: 56.4%
- **Improvement**: +11.8pp win rate

**Trade-off**:
- 26% fewer trades (more selective)
- Average PnL same: +1.28% vs +1.31%

**Recommendation**: PROMISING - Implement and backtest
```

---

### Phase 2: Pattern Implementation

#### Step 3: Implement Pattern Detection Code

**Location**: Add to `backend/src/strategies/momentumSimple.ts`

**Follow existing pattern** (like V5.32 anticipatory entry):

```typescript
// ============================================================================
// V5.35: VOLUME ACCUMULATION PATTERN (EXPERIMENTAL)
// ============================================================================
// HYPOTHESIS: Trades preceded by 3+ rising volume candles have higher WR
// EXPECTED: +10-15% WR improvement, -20-30% trade count
// STATUS: TESTING
// ============================================================================

export const VOLUME_ACCUMULATION = {
  ENABLED: false, // Set to true for testing
  MIN_RISING_CANDLES: 3,
  MIN_VOLUME_INCREASE: 0.05, // 5% increase per candle
  LOOKBACK: 5, // Check last 5 candles
};

/**
 * Detects volume accumulation pattern
 * Returns true if last N candles show rising volume
 */
export function detectVolumeAccumulation(
  candles: any[],
  config = VOLUME_ACCUMULATION
): boolean {
  if (!config.ENABLED) return true; // Pass-through if disabled

  const lookback = config.LOOKBACK;
  const recentCandles = candles.slice(-lookback);

  let risingCount = 0;
  for (let i = 1; i < recentCandles.length; i++) {
    const prevVol = recentCandles[i - 1].volume;
    const currVol = recentCandles[i].volume;

    const increase = (currVol - prevVol) / prevVol;

    if (increase >= config.MIN_VOLUME_INCREASE) {
      risingCount++;
    } else {
      risingCount = 0; // Reset if sequence breaks
    }
  }

  return risingCount >= config.MIN_RISING_CANDLES;
}

/**
 * Modified entry check with volume accumulation filter
 */
export function checkMomentumSignalWithVolumePattern(
  candles: any[],
  btcCandles: any[],
  config: any,
  side: 'LONG' | 'SHORT'
): SignalResult {
  // Step 1: Check standard momentum signal
  const baseSignal = checkMomentumSignal(candles, btcCandles, config, side);

  if (!baseSignal.signal) {
    return baseSignal; // No signal, no need to check pattern
  }

  // Step 2: Check volume accumulation pattern
  const hasVolumePattern = detectVolumeAccumulation(candles);

  if (!hasVolumePattern) {
    return {
      signal: false,
      reason: 'Volume accumulation pattern not detected',
      side,
    };
  }

  // Pattern confirmed
  return {
    ...baseSignal,
    reason: `${baseSignal.reason} + Volume accumulation`,
  };
}
```

**Integrate into backtest**:

Edit `backend/src/services/backtestService.ts`:

```typescript
// Import the new pattern function
import {
  checkMomentumSignal,
  checkMomentumSignalWithVolumePattern, // New
  VOLUME_ACCUMULATION // New
} from '../strategies/momentumSimple.js';

// In runBacktest() function:
const signal = VOLUME_ACCUMULATION.ENABLED
  ? checkMomentumSignalWithVolumePattern(candles, btcCandles, config, 'LONG')
  : checkMomentumSignal(candles, btcCandles, config, 'LONG');
```

**Important**: Keep pattern detection **separate and toggleable**
- Use feature flag (`ENABLED: false`)
- Don't modify existing functions
- Allow easy enable/disable for testing

---

#### Step 4: Add Pattern Metadata Tracking

**Track pattern usage in trades**:

```typescript
// In backtestService.ts, when creating trade object:
const trade = {
  symbol,
  side,
  entryTime,
  entryPrice,
  // ... other fields ...

  // NEW: Pattern metadata
  patterns: {
    volumeAccumulation: VOLUME_ACCUMULATION.ENABLED,
    multiTimeframe: false, // For future patterns
    orderFlowImbalance: false,
  },

  // Store entry conditions for analysis
  entryConditions: {
    roc10: currentROC,
    volumeRatio: currentVolRatio,
    bbPosition: currentBBPosition,
    // Pattern-specific
    volumeRisingCandles: hasVolumePattern ? risingCount : 0,
  },
};
```

This allows post-analysis: "How many trades used the pattern? What was their WR?"

---

### Phase 3: Backtest Validation

#### Step 5: Run Comparative Backtests

**Test 1: Baseline (Pattern Disabled)**
```bash
# Edit momentumSimple.ts: VOLUME_ACCUMULATION.ENABLED = false
npm run analyze:performance
# Save results as: results/backtest_v5_34_baseline.json
```

**Test 2: With Pattern (Pattern Enabled)**
```bash
# Edit momentumSimple.ts: VOLUME_ACCUMULATION.ENABLED = true
npm run analyze:performance
# Save results as: results/backtest_v5_35_volume_pattern.json
```

**Test 3: Parameter Sensitivity (Optional)**
```bash
# Test different thresholds:
MIN_RISING_CANDLES: 2, 3, 4, 5
MIN_VOLUME_INCREASE: 0.03, 0.05, 0.10

# Run backtest for each combination
# Identify optimal parameters
```

---

#### Step 6: Analyze Results and Compare

**Load both backtest results**:
```python
import json

with open('results/backtest_v5_34_baseline.json') as f:
    baseline = json.load(f)

with open('results/backtest_v5_35_volume_pattern.json') as f:
    pattern = json.load(f)

# Extract metrics
baseline_metrics = baseline['summary']
pattern_metrics = pattern['summary']
```

**Create comparison table**:
```python
metrics = ['totalTrades', 'winRate', 'totalPnLPct', 'sharpeRatio', 'maxDrawdown', 'profitFactor']

print("| Metric | Baseline V5.34 | Pattern V5.35 | Change | Winner |")
print("|--------|----------------|---------------|--------|--------|")

for metric in metrics:
    base_val = baseline_metrics[metric]
    patt_val = pattern_metrics[metric]

    change = ((patt_val - base_val) / base_val * 100) if base_val != 0 else 0
    winner = "✓ Pattern" if patt_val > base_val else "✓ Baseline"

    print(f"| {metric} | {base_val:.2f} | {patt_val:.2f} | {change:+.1f}% | {winner} |")
```

**Statistical significance check**:
```python
from scipy import stats

# Compare win rates
baseline_wins = baseline_metrics['winningTrades']
baseline_total = baseline_metrics['totalTrades']

pattern_wins = pattern_metrics['winningTrades']
pattern_total = pattern_metrics['totalTrades']

# Chi-square test
contingency = [[baseline_wins, baseline_total - baseline_wins],
               [pattern_wins, pattern_total - pattern_wins]]

chi2, p_value = stats.chi2_contingency(contingency)[:2]

print(f"P-value: {p_value:.4f}")
if p_value < 0.05:
    print("✓ Statistically significant improvement")
else:
    print("⚠ Not statistically significant (may be random)")
```

**Detailed analysis**:
```python
# Analyze trades that were filtered out by pattern
baseline_trades = set((t['symbol'], t['entryTime']) for t in baseline['trades'])
pattern_trades = set((t['symbol'], t['entryTime']) for t in pattern['trades'])

filtered_trades = baseline_trades - pattern_trades
print(f"Trades filtered by pattern: {len(filtered_trades)}")

# Were filtered trades mostly losers?
baseline_by_key = {(t['symbol'], t['entryTime']): t for t in baseline['trades']}
filtered_pnls = [baseline_by_key[key]['pnl'] for key in filtered_trades]

filtered_losers = len([p for p in filtered_pnls if p < 0])
print(f"Filtered trades that were losers: {filtered_losers} ({filtered_losers/len(filtered_pnls)*100:.1f}%)")

# Good pattern if filtering mostly losers!
```

---

### Phase 4: Decision Making

#### Step 7: Evaluate Pattern Performance

**Use this decision framework**:

```
DECISION CRITERIA:

1. ENABLE pattern if ALL of:
   ✓ Win rate improvement ≥ +5pp (e.g., 55% → 60%)
   ✓ Total ROI improvement ≥ +10% (e.g., 500% → 550%)
   ✓ Sharpe ratio improvement ≥ +0.2 (e.g., 1.5 → 1.7)
   ✓ Max drawdown not worse by > 5pp
   ✓ Minimum 100 trades in test (statistical validity)
   ✓ P-value < 0.05 (statistically significant)

2. CONSIDER pattern if SOME of:
   ✓ Win rate improvement 2-5pp
   ✓ Total ROI improvement 5-10%
   ✓ Reduces max drawdown by > 3pp
   ✓ Trade count reduction < 40% (not too selective)

3. DISABLE pattern if ANY of:
   ✗ Win rate worse or < +2pp improvement
   ✗ Total ROI worse or < +5% improvement
   ✗ Max drawdown increases by > 5pp
   ✗ Trade count < 50 (overfitting risk)
   ✗ P-value > 0.10 (likely random)
```

**Example evaluation**:
```
PATTERN: Volume Accumulation V5.35

METRICS COMPARISON:
| Metric | Baseline | Pattern | Change | Threshold | Status |
|--------|----------|---------|--------|-----------|--------|
| Win Rate | 59.9% | 68.2% | +8.3pp | +5pp | ✓ PASS |
| Total ROI | +501% | +623% | +24.4% | +10% | ✓ PASS |
| Sharpe | 1.52 | 1.81 | +0.29 | +0.2 | ✓ PASS |
| Max DD | 29.1% | 26.8% | -2.3pp | < +5pp | ✓ PASS |
| Trades | 1,089 | 734 | -32.6% | > 100 | ✓ PASS |
| P-value | N/A | 0.002 | N/A | < 0.05 | ✓ PASS |

DECISION: ✓ ENABLE - All criteria met
CONFIDENCE: HIGH (strong statistical significance, all metrics improved)
```

---

#### Step 8: Document and Deploy

**Update code with decision**:

```typescript
// In momentumSimple.ts

// ============================================================================
// V5.35: VOLUME ACCUMULATION PATTERN ✓ ENABLED
// ============================================================================
// BACKTEST RESULTS (vs V5.34 baseline):
//   Trades: 1,089 → 734 (-32.6%)
//   Win Rate: 59.9% → 68.2% (+8.3pp)
//   Total ROI: +501% → +623% (+24.4%)
//   Sharpe Ratio: 1.52 → 1.81 (+0.29)
//   Max Drawdown: 29.1% → 26.8% (-2.3pp)
//   P-value: 0.002 (statistically significant)
//
// CONCLUSION: Pattern filters 33% of trades but dramatically improves quality
// IMPACT: +24% ROI improvement, +8pp WR, lower drawdown
// DEPLOYED: 2026-01-01
// ============================================================================

export const VOLUME_ACCUMULATION = {
  ENABLED: true, // ✓ Enabled after validation
  MIN_RISING_CANDLES: 3,
  MIN_VOLUME_INCREASE: 0.05,
  LOOKBACK: 5,
};
```

**Create version commit**:
```bash
git add backend/src/strategies/momentumSimple.ts
git commit -m "feat: Enable volume accumulation pattern (V5.35)

- Filters trades requiring 3+ consecutive rising volume candles
- Backtest shows +8.3pp WR improvement (59.9% → 68.2%)
- Total ROI improvement +24.4% (+501% → +623%)
- Reduces trade count by 33% (more selective)
- Statistically significant (p=0.002)

Test period: 12 months, 734 trades
Baseline: V5.34
Status: ENABLED for production deployment"

git push
```

**If pattern FAILS, document and disable**:

```typescript
// ============================================================================
// V5.36: ORDER FLOW IMBALANCE PATTERN ✗ DISABLED
// ============================================================================
// BACKTEST RESULTS (vs V5.34 baseline):
//   Trades: 1,089 → 312 (-71.3%)
//   Win Rate: 59.9% → 61.2% (+1.3pp)
//   Total ROI: +501% → +287% (-42.7%)
//   Sharpe Ratio: 1.52 → 1.31 (-0.21)
//
// CONCLUSION: Pattern too selective, ROI decreased despite slight WR improvement
// REASON FOR FAILURE: 71% trade reduction not justified by +1.3pp WR gain
// DECISION: DISABLED - Baseline V5.34 superior
// ============================================================================

export const ORDER_FLOW_IMBALANCE = {
  ENABLED: false, // ✗ Disabled after testing
  // ... config ...
};
```

---

## Advanced Pattern Research

### Multi-Pattern Testing

**Test multiple patterns simultaneously**:

```typescript
// Combine patterns to find synergies
const patterns = {
  volumeAccumulation: detectVolumeAccumulation(candles),
  multiTimeframe: checkMultiTimeframeAlignment(candles, candles1h, candles4h),
  orderFlowImbalance: detectOrderFlowImbalance(orderbook),
};

// Test combinations:
// 1. Volume only
// 2. Multi-timeframe only
// 3. Volume + Multi-timeframe
// 4. All three

// Find which combination maximizes Sharpe ratio
```

---

### Walk-Forward Validation

**Prevent overfitting with out-of-sample testing**:

```python
# Split data into training and test periods
# Train: 2023-01-01 to 2023-12-31 (12 months)
# Test: 2024-01-01 to 2024-06-30 (6 months)

# 1. Optimize pattern parameters on training data
# 2. Apply optimal parameters to test data
# 3. If test performance ≥ 80% of training performance → Valid pattern
# 4. If test performance < 80% → Overfitted, reject pattern
```

**Example**:
```
PATTERN: Volume Accumulation
PARAMETER: MIN_RISING_CANDLES

TRAINING PERIOD (12 months):
  MIN_RISING_CANDLES=2: +456% ROI, 62.1% WR
  MIN_RISING_CANDLES=3: +523% ROI, 64.8% WR ← OPTIMAL
  MIN_RISING_CANDLES=4: +489% ROI, 67.2% WR

TEST PERIOD (6 months, using optimal=3):
  Predicted ROI: +523% (annualized: +261.5% for 6mo)
  Actual ROI: +234% (90% of predicted) ✓ VALID

CONCLUSION: Pattern generalizes well (test = 90% of training)
```

---

### Pattern Library

**Maintain tested patterns catalog**:

```typescript
// backend/src/strategies/patternLibrary.ts

export const PATTERN_CATALOG = {
  // ENABLED PATTERNS
  volumeAccumulation: {
    version: 'V5.35',
    status: 'ENABLED',
    improvement: { wr: +8.3, roi: +24.4 },
    deployedDate: '2026-01-01',
  },

  multiTimeframeConfluence: {
    version: 'V5.37',
    status: 'ENABLED',
    improvement: { wr: +12.1, roi: +31.2 },
    deployedDate: '2026-02-15',
  },

  // DISABLED PATTERNS (kept for reference)
  bbSqueeze: {
    version: 'V5.32',
    status: 'DISABLED',
    reason: 'Underperformed baseline by 27x per trade',
    improvement: { wr: -6.3, roi: -81.3 },
    disabledDate: '2025-11-20',
  },

  breakoutConfirmation: {
    version: 'V5.33',
    status: 'DISABLED',
    reason: 'Trade reduction not justified by WR improvement',
    improvement: { wr: +24.0, roi: -18.2 },
    disabledDate: '2025-12-05',
  },
};
```

---

## Pattern Ideas to Research

Based on the initial codebase analysis, here are promising patterns:

### 1. Multi-Timeframe Confluence (HIGH PRIORITY)
```
HYPOTHESIS: Entries aligned with 1h and 4h trends have higher WR
IMPLEMENTATION:
  - Fetch 1h and 4h candles
  - Check alignment: 15m LONG + 1h bullish + 4h bullish
  - Require all three to agree
EXPECTED: +15-20% WR, -30% trades
```

### 2. Volume Profile Zones (MEDIUM PRIORITY)
```
HYPOTHESIS: Entries near high-volume zones (support/resistance) perform better
IMPLEMENTATION:
  - Calculate volume profile over last 100 candles
  - Identify high-volume nodes
  - Enter only if price near high-volume zone (± 1%)
EXPECTED: +10% WR, -20% trades
```

### 3. Order Flow Imbalance (MEDIUM PRIORITY)
```
HYPOTHESIS: Bid/ask imbalance > 2:1 predicts direction
IMPLEMENTATION:
  - Use existing depth.ts and bookWalkSlippage.ts
  - Calculate bid/ask ratio
  - Enter LONG only if bid > 2× ask
EXPECTED: +8% WR, -25% trades
```

### 4. Momentum Divergence (LOW PRIORITY)
```
HYPOTHESIS: Price making new highs while RSI declining = topping
IMPLEMENTATION:
  - Track price highs and RSI
  - Skip LONG if divergence detected
  - Enter SHORT if divergence confirmed
EXPECTED: +5% WR by avoiding false breakouts
```

### 5. Correlation Filter (LOW PRIORITY)
```
HYPOTHESIS: Avoid correlated positions to reduce portfolio risk
IMPLEMENTATION:
  - Use correlationManager.ts
  - If holding BTC LONG, penalize ETH/SOL signals (0.9+ correlation)
  - Prefer uncorrelated symbols
EXPECTED: -10% max drawdown, similar ROI
```

---

## Output Format

When researching a pattern, provide:

```markdown
# Pattern Research Report: [PATTERN NAME]

**Version**: V5.XX
**Date**: YYYY-MM-DD
**Status**: [TESTING / ENABLED / DISABLED]

---

## Hypothesis

**Pattern**: [Clear description]
**Expected Impact**: [Quantitative prediction]
**Rationale**: [Why this should work]

---

## Preliminary Analysis

**Data Sample**: [Number of trades, time period]

**Findings**:
- [Key finding 1 with numbers]
- [Key finding 2 with numbers]
- [Key finding 3 with numbers]

**Recommendation**: [PROMISING / UNLIKELY / REJECT]

---

## Implementation

**Code Location**: `backend/src/strategies/momentumSimple.ts`

**Key Functions**:
```typescript
export function detect[PatternName](candles: any[]): boolean {
  // Implementation
}
```

**Integration Point**: [Where in signal flow]

---

## Backtest Results

### Baseline (V5.34)
- Trades: 1,089
- Win Rate: 59.9%
- ROI: +501%
- Sharpe: 1.52
- Max DD: 29.1%

### With Pattern (V5.35)
- Trades: 734 (-32.6%)
- Win Rate: 68.2% (+8.3pp)
- ROI: +623% (+24.4%)
- Sharpe: 1.81 (+0.29)
- Max DD: 26.8% (-2.3pp)

### Statistical Validation
- P-value: 0.002 (significant)
- Confidence: 99.8%

---

## Decision

**Status**: ✓ ENABLED

**Criteria Met**:
- ✓ Win rate improvement ≥ +5pp
- ✓ ROI improvement ≥ +10%
- ✓ Sharpe improvement ≥ +0.2
- ✓ Max drawdown not worse
- ✓ Minimum 100 trades
- ✓ Statistically significant

**Deployment Plan**:
1. Update momentumSimple.ts: ENABLED = true
2. Commit with V5.35 tag
3. Deploy to paper trading for 1 week
4. Monitor live vs backtest alignment
5. If validated, deploy to production

---

## Code Documentation

```typescript
// ============================================================================
// V5.35: VOLUME ACCUMULATION PATTERN ✓ ENABLED
// ============================================================================
// [Full documentation block as shown above]
```

---

## Next Steps

1. Monitor live performance for 2 weeks
2. Compare live vs backtest metrics
3. If live matches backtest (±10%), consider permanent
4. Research next pattern: Multi-Timeframe Confluence
```

---

## Integration with Other Skills

After pattern research:

```
📋 RECOMMENDED WORKFLOW:

1. Research pattern with pattern-researcher:
   "Research volume accumulation pattern and test on historical data"

2. If promising, optimize parameters with strategy-optimizer:
   "Optimize MIN_RISING_CANDLES parameter for volume accumulation"

3. Validate implementation with code-consistency-checker:
   "Check if volume pattern is implemented consistently in backtest and production"

4. Analyze final results with backtest-analyzer:
   "Analyze V5.35 volume pattern backtest and compare with V5.34 baseline"

5. If successful, document and deploy
```

---

## Remember

- **Be systematic**: Follow the same process for every pattern
- **Be ruthless**: Disable patterns that don't significantly improve metrics
- **Be conservative**: Require strong statistical evidence (p < 0.05)
- **Be documented**: Future you (and your team) will thank you
- **Be realistic**: Not every pattern will work, that's why you test

Your goal is to systematically improve strategy edge through data-driven pattern discovery, just like you've done evolving from V5.0 → V5.34.
