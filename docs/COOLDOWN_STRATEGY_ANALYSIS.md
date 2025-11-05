# Cooldown Strategy Analysis and Recommendations

## Current Implementation

### Overview
The current cooldown strategy applies a 5-minute cooldown (`STRATEGY_REGIME_COOLDOWN_MIN`) to regime-only shifts to prevent excessive LLM calls when only the market regime changes without significant price movement.

### Current Behavior (from logs analysis)

Looking at the logs provided:
```json
{
  "reason": "price",
  "price": 86.06,
  "lastPrice": 79.45404670087306,
  "regime": "range:neutral",
  "previousRegime": "range:neutral",
  "regimeCooldownMinutes": null
}
```

**Key observations:**
1. Price shifted from ~79.45 to 86.06 (≈8.3% move)
2. Regime stayed the same (range:neutral)
3. Cooldown is `null` because this was a price shift, not a regime-only shift
4. Strategy regeneration was triggered by price movement

### How Current Cooldown Works

```typescript
// From engine/events.ts
const regimeCooldownMin = Number(process.env.STRATEGY_REGIME_COOLDOWN_MIN || 5);
const regimeCooldownPassed = !regimeOnlyShift || !lastRegime || 
  (now - lastRegime) > regimeCooldownMin * 60 * 1000;

const significantChange = shift.priceShift || (shift.regimeShift && regimeCooldownPassed);
```

**Logic:**
- **Price shifts**: No cooldown, immediate regeneration
- **Regime-only shifts**: 5-minute cooldown before regeneration
- **Combined shifts**: Treated as price shift (no cooldown)

## Problems with Current Approach

### 1. **Indiscriminate Price Sensitivity**
- **Issue**: Even small price movements outside the zone trigger regeneration
- **Impact**: Can lead to over-trading in choppy/ranging markets
- **Example**: Price oscillating around zone boundaries

### 2. **Fixed Cooldown Period**
- **Issue**: 5-minute cooldown is static regardless of market conditions
- **Impact**: 
  - Too short in low-volatility markets (over-trading)
  - Too long in high-volatility markets (missed opportunities)

### 3. **No Confidence Delta Threshold**
- **Issue**: Regime shifts with tiny confidence changes trigger regeneration
- **Impact**: Wasted LLM calls on insignificant regime adjustments
- **Evidence**: `confidenceDelta: 0` in logs

### 4. **Independent Price and Regime Checks**
- **Issue**: Price and regime shifts are evaluated separately
- **Impact**: Doesn't account for situations where both are changing slightly

## Recommended Improvements

### 1. **Adaptive Cooldown Based on Volatility**

```typescript
function getAdaptiveCooldown(symbol: string, tech: TechnicalSnapshot): number {
  const atrPct = tech.atrPct || 1.0;
  const baselineCooldown = 5; // minutes
  
  // Higher volatility = shorter cooldown (more opportunities)
  // Lower volatility = longer cooldown (avoid chop)
  if (atrPct > 3.0) {
    return baselineCooldown * 0.5; // 2.5 min for high volatility
  } else if (atrPct > 2.0) {
    return baselineCooldown; // 5 min for moderate volatility
  } else if (atrPct > 1.0) {
    return baselineCooldown * 1.5; // 7.5 min for low volatility
  } else {
    return baselineCooldown * 2.0; // 10 min for very low volatility
  }
}
```

**Benefits:**
- Adapts to market conditions
- Reduces over-trading in quiet markets
- Captures more opportunities in volatile markets

### 2. **Confidence Delta Threshold**

```typescript
const MIN_CONFIDENCE_DELTA = 0.2; // Only regenerate if confidence changes meaningfully

const meaningfulRegimeChange = shift.regimeShift && 
  Math.abs(confidenceDelta) >= MIN_CONFIDENCE_DELTA;

const significantChange = shift.priceShift || 
  (meaningfulRegimeChange && regimeCooldownPassed);
```

**Benefits:**
- Avoids regeneration for insignificant regime changes
- Reduces LLM costs
- Focuses on meaningful market shifts

### 3. **Composite Score for Regeneration Decision**

```typescript
interface RegenerationScore {
  priceScore: number;      // 0-1 based on % move
  regimeScore: number;     // 0-1 based on confidence delta
  volatilityScore: number; // 0-1 based on ATR change
  composite: number;       // weighted combination
}

function calculateRegenerationScore(
  shift: StrategyShift,
  tech: TechnicalSnapshot,
  confidenceDelta: number
): RegenerationScore {
  // Price score: larger moves = higher score
  const priceMovePct = Math.abs(shift.priceShiftPct || 0);
  const priceScore = Math.min(1.0, priceMovePct / 2.0); // 2% = max score
  
  // Regime score: based on confidence change
  const regimeScore = Math.min(1.0, Math.abs(confidenceDelta));
  
  // Volatility score: significant ATR changes
  const volatilityScore = tech.atrPct > 3.0 ? 0.8 : tech.atrPct > 2.0 ? 0.5 : 0.2;
  
  // Composite: weighted combination
  const composite = (
    priceScore * 0.5 +
    regimeScore * 0.3 +
    volatilityScore * 0.2
  );
  
  return { priceScore, regimeScore, volatilityScore, composite };
}

// Regenerate if composite score > threshold
const REGENERATION_THRESHOLD = 0.4;
const score = calculateRegenerationScore(shift, tech, confidenceDelta);
const shouldRegenerate = score.composite > REGENERATION_THRESHOLD && cooldownPassed;
```

**Benefits:**
- Holistic evaluation of market changes
- Balances multiple factors
- More nuanced decision-making
- Configurable threshold

### 4. **Time-of-Day Adaptive Cooldown**

```typescript
function getTimeOfDayCooldown(baselineCooldown: number): number {
  const hour = new Date().getUTCHours();
  
  // High-activity periods (US/EU overlap): shorter cooldown
  if (hour >= 13 && hour <= 16) {
    return baselineCooldown * 0.75;
  }
  
  // Low-activity periods (Asian night): longer cooldown
  if (hour >= 0 && hour <= 6) {
    return baselineCooldown * 1.5;
  }
  
  return baselineCooldown;
}
```

**Benefits:**
- Adapts to market activity cycles
- Reduces regeneration during quiet periods
- Increases responsiveness during active trading hours

### 5. **Symbol-Specific Cooldown History**

```typescript
interface CooldownHistory {
  lastRegenerationTs: number;
  recentRegenerationCount: number;
  successRate: number; // % of regenerations that led to profitable trades
}

const symbolCooldownHistory = new Map<string, CooldownHistory>();

function getHistoryAdjustedCooldown(
  symbol: string,
  baselineCooldown: number
): number {
  const history = symbolCooldownHistory.get(symbol);
  
  if (!history) return baselineCooldown;
  
  // If recent regenerations didn't help (low success rate), increase cooldown
  if (history.successRate < 0.3 && history.recentRegenerationCount > 5) {
    return baselineCooldown * 2.0;
  }
  
  // If regenerations are working well, keep responsive
  if (history.successRate > 0.7) {
    return baselineCooldown * 0.8;
  }
  
  return baselineCooldown;
}
```

**Benefits:**
- Learns from past regeneration effectiveness
- Reduces unnecessary regenerations for symbols where they don't help
- Optimizes per-symbol behavior

## Recommended Implementation Plan

### Phase 1: Quick Wins (Immediate)
1. Add confidence delta threshold (MIN_CONFIDENCE_DELTA = 0.2)
2. Log regeneration decisions with scores for analysis
3. Add environment variables for tuning

```typescript
// Add to .env
STRATEGY_MIN_CONFIDENCE_DELTA=0.2
STRATEGY_COOLDOWN_VOLATILITY_ADAPTIVE=true
```

### Phase 2: Adaptive Cooldown (Week 1)
1. Implement volatility-based adaptive cooldown
2. Add telemetry to track cooldown effectiveness
3. Monitor regeneration frequency and success rates

### Phase 3: Composite Scoring (Week 2)
1. Implement composite regeneration score
2. A/B test threshold values
3. Fine-tune weights based on backtest results

### Phase 4: Learning System (Week 3-4)
1. Track regeneration success rates per symbol
2. Implement history-adjusted cooldowns
3. Add dashboard for monitoring effectiveness

## Environment Variables for Configuration

```bash
# Current
STRATEGY_MIN_INTERVAL_MIN=60           # Min time between any strategy regenerations
STRATEGY_REGIME_COOLDOWN_MIN=5         # Cooldown for regime-only shifts
STRATEGY_FORCE_PRICE_PCT=0.25          # Price shift % to force regeneration
STRATEGY_FORCE_REGIME_CONF_DELTA=0.15  # Confidence delta to force regeneration

# Recommended additions
STRATEGY_MIN_CONFIDENCE_DELTA=0.2       # Min confidence change to consider
STRATEGY_VOLATILITY_ADAPTIVE=true       # Enable volatility-based cooldown
STRATEGY_COMPOSITE_THRESHOLD=0.4        # Composite score threshold
STRATEGY_USE_TIME_OF_DAY=true          # Enable time-of-day adjustment
STRATEGY_LEARN_FROM_HISTORY=true       # Enable history-based adjustment
```

## Testing Strategy

### 1. Unit Tests
- Test cooldown calculation logic
- Test composite score calculation
- Test threshold comparisons

### 2. Integration Tests
- Simulate various market conditions
- Verify regeneration decisions
- Test cooldown state management

### 3. Backtesting
- Compare current vs. proposed strategies
- Measure:
  - LLM call frequency
  - Win rate improvement
  - Profitability impact
  - Slippage from delayed regenerations

### 4. Live Testing
- Roll out to subset of agents
- Monitor for 1 week
- Compare metrics to control group

## Expected Outcomes

### Metrics to Track
1. **LLM Call Reduction**: Target 20-30% reduction
2. **Win Rate**: Should remain stable or improve slightly
3. **Profitability**: Should improve due to reduced over-trading
4. **Response Time**: Ensure no critical opportunities missed

### Success Criteria
- ✅ Reduce LLM costs by 20%+
- ✅ Maintain or improve win rate
- ✅ Reduce chop trading (trades with <0.5% moves)
- ✅ Improve avg profit per trade by 10%+

## Conclusion

The current cooldown strategy is functional but has room for significant improvement. The recommended approach:

1. **Short-term**: Add confidence delta threshold
2. **Medium-term**: Implement adaptive cooldown based on volatility
3. **Long-term**: Build learning system that adjusts per symbol

This will result in:
- Reduced LLM costs (fewer unnecessary calls)
- Better trade timing (responsive when needed, patient when not)
- Improved profitability (less chop trading)
- More intelligent system (learns from results)

The key insight: **Not all market changes are equal. The cooldown should reflect the significance of the change and the likelihood it will lead to a profitable trade.**
