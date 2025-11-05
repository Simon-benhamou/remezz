# Smart Daily Limits & Smart Market Regime

## Overview

This update makes the trading agent smarter by replacing rigid daily trade limits and market regime blocks with intelligent, adaptive systems that avoid missing good opportunities while maintaining risk controls.

## Problem

### 1. Stupid Daily Limits ❌
**Old Behavior:**
- Fixed limit (e.g., 7 trades/day) regardless of performance
- Hit limit → no more trades, even if excellent opportunity
- Same limit whether winning 70% or losing 70%

**Issue:** Missing profitable opportunities due to arbitrary limits

### 2. Regime Standby Blocks Everything ❌
**Old Behavior:**
- High volatility → regime says "standby"
- All trading blocked, even exceptional setups
- No distinction between "dangerous" and "requires caution"

**Issue:** Missing strong momentum moves in volatile markets

## Solution: Smart Adaptive Systems ✅

### 1. Smart Trade Limits (`SmartTradeLimits`)

**Dynamic Limits Based on Performance:**

```typescript
// Base: 7 trades/day
// Win rate 70%+ → increase to ~11 trades/day
// Win rate <40% → decrease to ~5 trades/day
```

**Key Features:**

1. **Performance-Based Scaling**
   - Excellent win rate (≥70%): +60% limit increase
   - Good win rate (≥55%): +30% limit increase  
   - Poor win rate (<40%): -50% limit reduction
   - Requires ≥5 trades sample size

2. **Quality Bonus System**
   - Exceptional opportunities (quality ≥0.8) get bonus slots
   - Only applies when near limit
   - Up to +3 extra trades for top-quality setups
   - Example: At 10/10 limit, 95% quality setup → allowed as 11th trade

3. **Smart Recommendations**
   - Warns when approaching limit
   - Suggests how to increase limit (improve win rate)
   - Tracks remaining capacity

**Usage:**
```typescript
const smartLimits = new SmartTradeLimits();

const result = smartLimits.canTrade({
  currentTradesToday: 8,
  recentWinRate: 0.65,
  recentTradesCount: 10,
  opportunityQuality: 0.85
});

// result.allowed = true (quality bonus)
// result.reason = "good_performance_65pct_winrate_plus_2_quality_bonus"
```

### 2. Smart Market Regime (`SmartRegimeAnalyzer`)

**Trading with Risk Adjustments Instead of Blocking:**

**Old Logic:**
```
if (regime.shouldTrade === false) {
  return; // Block everything
}
```

**New Smart Logic:**
```
Violent spike → Trade at 15% size, need 90% quality
Catastrophic vol → Trade at 25% size, need 85% quality
High vol + momentum → Trade at 60% size, need 70% quality
Standby → Trade at 50% size, need 72% quality
```

**Risk Adjustment Matrix:**

| Regime Condition | Can Trade? | Size | Stop Adj | Min Quality |
|-----------------|------------|------|----------|-------------|
| Violent spike | Yes* | 15% | +20% | 90% |
| Catastrophic vol | Yes* | 25% | +10% | 85% |
| High vol + momentum | Yes | 60% | +15% | 70% |
| High vol defensive | Yes | 40% | +0% | 75% |
| Standby | Yes | 50% | +0% | 72% |
| Normal | Yes | 100% | +0% | None |

*Only for exceptional setups

**Key Benefits:**

1. **Never Miss Exceptional Opportunities**
   - Even in "standby", top 10% setups allowed
   - Size adjusted to regime risk
   - Stops widened for volatility if needed

2. **Nuanced Risk Management**
   - Not binary (trade/no trade)
   - Gradient of caution (15%-100% size)
   - Quality requirements scale with risk

3. **Momentum Capture**
   - High vol + strong momentum → allowed at 60% size
   - Don't miss breakouts due to volatility alone
   - Trend persistence detection

**Usage:**
```typescript
import { smartRegimeAnalyzer } from '../ai/smartRegime.js';

const decision = smartRegimeAnalyzer.evaluateRegime(regime);

if (!decision.canTrade) {
  // Still blocked (very rare now)
  return;
}

// Apply risk adjustments
const adjustedSize = baseSize * decision.riskMultiplier;
const adjustedStop = stopDistance * decision.stopMultiplier;

// Check quality requirement
if (decision.requireHigherQuality) {
  if (setupQuality < decision.minQualityScore) {
    // Quality too low for this regime
    return;
  }
}
```

## Implementation

### Files Created

1. **`/backend/src/quantai/risk/smartTradeLimits.ts`**
   - `SmartTradeLimits` class
   - Performance-based limit calculation
   - Quality bonus system
   - Guidance for approaching limits

2. **`/backend/src/ai/smartRegime.ts`**
   - `SmartRegimeAnalyzer` class
   - Risk adjustment logic
   - Quality requirement scaling
   - Nuanced regime evaluation

### Files Modified

1. **`/backend/src/agent/state/index.ts`**
   - Integrated smart regime checks
   - Added `lastSmartRegimeDecision` tracking
   - Added `smartTradeLimits` instance
   - Logs regime adjustments

2. **`/backend/src/diagnostics/orderRejectionAnalyzer.ts`**
   - Updated to show smart limit status
   - Shows regime restrictions vs blocks
   - Performance-based recommendations

## Examples

### Example 1: Good Performance Allows More Trades

```
Scenario: Day 8 of 10 trades, win rate 68%
Old: "Daily limit reached (8/7)" ❌
New: "Allowed - excellent_performance_68pct_winrate (limit: 10)" ✅
```

### Example 2: Quality Bonus Near Limit

```
Scenario: At 10/10 trades, exceptional 92% quality setup appears
Old: "Daily limit reached" ❌
New: "Allowed - quality_bonus (+2 slots for 92% quality)" ✅
```

### Example 3: High Volatility Breakout

```
Scenario: XRP breakout, volatility high, ADX 45, strong momentum
Old: "Regime standby - no trading" ❌
New: "Allowed at 60% size - high_vol_strong_momentum_allowed" ✅
```

### Example 4: Catastrophic Volatility, Exceptional Setup

```
Scenario: Flash crash, 88% quality reversal setup
Old: "Regime standby - no trading" ❌
New: "Allowed at 25% size - catastrophic_vol_high_quality_only (need 85%+)" ✅
```

## Configuration

### Smart Limits Config

```typescript
const smartLimits = new SmartTradeLimits({
  baseLimit: 7,           // Base daily limit
  minLimit: 3,            // Floor (poor performance)
  maxLimit: 15,           // Ceiling (excellent performance)
  winRateThresholds: {
    excellent: 0.70,      // 70%+ = increase limit
    good: 0.55,           // 55%+ = keep base
    poor: 0.40,           // <40% = decrease limit
  },
  opportunityQualityBonus: {
    enabled: true,
    maxBonus: 3,          // Up to 3 extra for quality
  },
});
```

### Customizing Regime Adjustments

Edit `/backend/src/ai/smartRegime.ts`:

```typescript
// To be more aggressive in high vol:
if (volatility === 'high' && strongMomentum) {
  return {
    riskMultiplier: 0.8,  // Increase from 0.6
    minQualityScore: 0.65, // Lower from 0.70
  };
}
```

## Monitoring

### Check Smart Limit Status

```bash
npm run analyze:rejection XRP/USDT --session-id <id>
```

Output includes:
```
⚠️ WARNINGS:
  Base daily trade limit reached: 8/7
  Details: {
    recentWinRate: "65%",
    recentTrades: 12
  }

💡 RECOMMENDATIONS:
  Excellent win rate (65%) - smart limits may allow additional high-quality trades
```

### Check Regime Adjustments

Agent logs:
```typescript
{
  source: 'smart_regime',
  message: 'regime_risk_adjustments_applied',
  details: {
    explanation: '⚠️ Trading allowed with restrictions | Risk: 60% | Min quality: 70%',
    riskMultiplier: 0.6,
    requireHigherQuality: true
  }
}
```

## Migration

### Existing Agents

Smart systems activate automatically on next agent restart:
1. Smart limits use existing `recentTrades` data
2. Smart regime evaluates on each `onTick()`
3. No configuration changes required

### Backward Compatible

- Falls back to base limits if no performance data
- Treats missing regime as cautious (80% size)
- All existing limits still enforced as minimums

## Benefits

### 1. Never Miss Exceptional Opportunities ✅
- Quality-based overrides
- Regime adjustments instead of blocks
- Intelligent risk scaling

### 2. Better Risk Management ✅
- Performance-based position sizing
- Volatility-aware stops
- Quality-gated entries in difficult conditions

### 3. Adaptive to Market Conditions ✅
- High vol + momentum → trade aggressively
- High vol + chaos → trade defensively
- Normal conditions → trade normally

### 4. Performance-Driven Limits ✅
- Reward good trading (more capacity)
- Constrain poor trading (less capacity)
- Automatic adjustment

## Testing

To test the new systems:

1. **Smart Limits:**
```bash
# Check current limit calculation
# Edit /backend/src/quantai/risk/smartTradeLimits.ts
# Add test at bottom:
const test = new SmartTradeLimits();
console.log(test.calculateLimit({
  recentWinRate: 0.72,
  recentTradesCount: 10,
  currentTradesToday: 8,
  opportunityQuality: 0.9
}));
```

2. **Smart Regime:**
```bash
# Check regime decisions
# Edit /backend/src/ai/smartRegime.ts
# Add test at bottom:
const analyzer = new SmartRegimeAnalyzer();
const regime = { /* your regime data */ };
console.log(analyzer.evaluateRegime(regime));
```

## Future Enhancements

1. **Time-of-Day Awareness**
   - More capacity during high-liquidity hours
   - Reduced during low-liquidity

2. **Symbol-Specific Tuning**
   - BTC: more permissive in vol
   - Meme coins: stricter quality requirements

3. **Multi-Day Performance Tracking**
   - Weekly performance affects daily limits
   - Drawdown considerations

4. **Machine Learning Integration**
   - Learn optimal limit curves from historical data
   - Predict regime transitions

## Questions?

- Smart limits too aggressive? Adjust `maxBonus` or `maxLimit`
- Regime too restrictive? Lower `minQualityScore` thresholds
- Want more logging? Check ops events for `smart_regime` and `smart_trade_limits`
