# Adaptive Cooldown Strategy Implementation

## Overview

This document describes the implementation of adaptive cooldown improvements for strategy regeneration, following the recommendations in `COOLDOWN_STRATEGY_ANALYSIS.md`.

## What Was Implemented

### 1. Minimum Confidence Delta Threshold

**Problem**: Regime shifts with tiny confidence changes (e.g., confidenceDelta=0) were triggering regeneration unnecessarily.

**Solution**: Added `STRATEGY_MIN_CONFIDENCE_DELTA` (default: 0.2) to filter out insignificant regime changes.

```typescript
// Only consider regime changes meaningful if confidence delta >= threshold
const meaningfulRegimeChange = !regimeOnlyShift || 
  (confidenceDelta != null && Math.abs(confidenceDelta) >= minConfidenceDelta);
```

### 2. Volatility-Based Adaptive Cooldown

**Problem**: Fixed 5-minute cooldown didn't adapt to market conditions.

**Solution**: Cooldown now adjusts based on ATR% (Average True Range):

```typescript
function getAdaptiveCooldown(tech: TechnicalSnapshot, baselineCooldownMin: number): number {
  const atrPct = tech.atrPct;
  
  if (atrPct > 3.0) return baselineCooldownMin * 0.5;  // 2.5 min - high volatility
  if (atrPct > 2.0) return baselineCooldownMin;        // 5 min - moderate
  if (atrPct > 1.0) return baselineCooldownMin * 1.5;  // 7.5 min - low
  return baselineCooldownMin * 2.0;                     // 10 min - very low
}
```

**Benefits**:
- High volatility (>3% ATR): Shorter cooldown (2.5 min) to capture opportunities
- Low volatility (<1% ATR): Longer cooldown (10 min) to avoid chop trading

### 3. Composite Regeneration Scoring

**Problem**: Price and regime shifts were evaluated independently.

**Solution**: Composite score weighs multiple factors:

```typescript
function calculateRegenerationScore(shift, confidenceDelta, tech): {
  priceScore: number;      // 0-1 based on % move (2% = max)
  regimeScore: number;     // 0-1 based on confidence delta
  volatilityScore: number; // 0-1 based on ATR context
  composite: number;       // weighted: price(50%) + regime(30%) + vol(20%)
}
```

**Decision logic**:
```typescript
const score = calculateRegenerationScore(shift, confidenceDelta, tech);
const shouldRegenerate = score.composite >= threshold && cooldownPassed && meaningfulRegimeChange;
```

## Configuration

### Environment Variables

Add to your `.env` file:

```bash
# Core settings (existing)
STRATEGY_MIN_INTERVAL_MIN=60              # Min time between regenerations
STRATEGY_REGIME_COOLDOWN_MIN=5            # Base cooldown for regime shifts
STRATEGY_FORCE_PRICE_PCT=0.25             # Price shift % threshold
STRATEGY_FORCE_REGIME_CONF_DELTA=0.15     # Confidence delta threshold

# New adaptive settings
STRATEGY_MIN_CONFIDENCE_DELTA=0.2         # Min confidence change (filters noise)
STRATEGY_VOLATILITY_ADAPTIVE=true         # Enable adaptive cooldown
STRATEGY_USE_COMPOSITE_SCORE=true         # Use composite scoring
STRATEGY_COMPOSITE_THRESHOLD=0.4          # Composite score threshold (0-1)
```

### Default Behavior

If environment variables are not set:
- `STRATEGY_MIN_CONFIDENCE_DELTA=0.2` - Filters out <20% confidence changes
- `STRATEGY_VOLATILITY_ADAPTIVE=true` - Adaptive cooldown enabled by default
- `STRATEGY_USE_COMPOSITE_SCORE=true` - Composite scoring enabled by default
- `STRATEGY_COMPOSITE_THRESHOLD=0.4` - 40% composite score required

### Disabling Features

To revert to legacy behavior:
```bash
STRATEGY_VOLATILITY_ADAPTIVE=false        # Use fixed cooldown
STRATEGY_USE_COMPOSITE_SCORE=false        # Use simple price/regime logic
```

## Enhanced Ops Events

Strategy regeneration events now include additional telemetry:

```json
{
  "source": "strategy_regen",
  "details": {
    "reason": "composite_score:0.52 (price:0.45, regime:0.35, vol:0.80)",
    "adaptiveCooldownMinutes": 2.5,
    "atrPct": 3.2,
    "confidenceDelta": 0.35,
    "minConfidenceDelta": 0.2,
    "useCompositeScore": true
  }
}
```

**New fields**:
- `adaptiveCooldownMinutes` - Actual cooldown applied (adapts to volatility)
- `atrPct` - Current ATR% (volatility metric)
- `minConfidenceDelta` - Configured threshold
- `useCompositeScore` - Whether composite scoring is enabled
- `reason` - Now includes score breakdown for composite mode

## Expected Impact

### Metrics to Monitor

1. **LLM Call Frequency**
   - Before: ~X calls/hour per symbol
   - Target: 20-30% reduction
   - Monitor via ops events: `source: 'strategy_regen'`

2. **Win Rate**
   - Should remain stable or improve slightly
   - Less chop trading = better quality trades

3. **Profitability**
   - Reduced over-trading in ranging markets
   - Better timing in volatile markets
   - Target: 10%+ improvement in avg profit per trade

4. **Response Time**
   - High volatility: Faster response (2.5 min cooldown)
   - Low volatility: Slower, more patient (10 min cooldown)
   - Ensures no critical opportunities missed

### Monitoring Dashboard

Query ops events to track:
```typescript
// Regeneration frequency by reason
SELECT reason, COUNT(*) 
FROM ops_events 
WHERE source = 'strategy_regen'
GROUP BY reason;

// Adaptive cooldown distribution
SELECT 
  CASE 
    WHEN details->>'adaptiveCooldownMinutes' < '3' THEN 'high_vol'
    WHEN details->>'adaptiveCooldownMinutes' < '6' THEN 'moderate_vol'
    ELSE 'low_vol'
  END as volatility_category,
  COUNT(*)
FROM ops_events 
WHERE source = 'strategy_regen'
GROUP BY volatility_category;
```

## Examples

### Example 1: High Volatility Market (BTC)

**Market conditions**:
- ATR% = 3.5% (high volatility)
- Price moved 1.2% outside zone
- Regime confidence delta = 0.05 (insignificant)

**Legacy behavior**:
- Would trigger regeneration (price shift)
- 5-minute cooldown on regime-only shifts

**New behavior**:
```
Composite score:
  priceScore = 1.2 / 2.0 = 0.60
  regimeScore = 0.05 / 1.0 = 0.05
  volatilityScore = 0.80 (ATR > 3%)
  composite = 0.60*0.5 + 0.05*0.3 + 0.80*0.2 = 0.475

Should regenerate: YES (0.475 > 0.4 threshold)
Adaptive cooldown: 2.5 minutes (3.5% ATR * 0.5)
```

### Example 2: Low Volatility Market (stable altcoin)

**Market conditions**:
- ATR% = 0.8% (low volatility)
- Price moved 0.3% (slight movement)
- Regime confidence delta = 0.15

**Legacy behavior**:
- Would trigger regeneration (price shift if outside zone)
- 5-minute cooldown

**New behavior**:
```
Composite score:
  priceScore = 0.3 / 2.0 = 0.15
  regimeScore = 0.15 / 1.0 = 0.15
  volatilityScore = 0.20 (ATR < 1%)
  composite = 0.15*0.5 + 0.15*0.3 + 0.20*0.2 = 0.16

Should regenerate: NO (0.16 < 0.4 threshold)
Adaptive cooldown: 10 minutes (0.8% ATR * 2.0)
Result: Avoided chop trading
```

### Example 3: Regime Change Without Price Move

**Market conditions**:
- ATR% = 2.5%
- Price moved 0.1% (minimal)
- Regime confidence delta = 0.05 (below threshold)

**Legacy behavior**:
- Would wait for 5-minute cooldown
- Then regenerate on regime shift

**New behavior**:
```
Confidence delta check: 0.05 < 0.2 threshold
Result: Regime change filtered out (not meaningful)
No regeneration triggered - saved LLM call
```

## Testing & Validation

### Unit Tests

Tests are in `backend/test/api-data-validation.test.ts`:
- Adaptive cooldown calculation
- Composite score calculation
- Confidence delta filtering
- Ops event structure validation

### Integration Testing

Monitor live for 24-48 hours:
1. Track regeneration frequency per symbol
2. Measure cooldown distribution (2.5-10 min range)
3. Compare win rate and profitability
4. Check for missed opportunities (manual review of high-vol periods)

### Rollback Plan

To disable:
```bash
STRATEGY_VOLATILITY_ADAPTIVE=false
STRATEGY_USE_COMPOSITE_SCORE=false
```

Or set very low thresholds:
```bash
STRATEGY_MIN_CONFIDENCE_DELTA=0.01        # Effectively disable filtering
STRATEGY_COMPOSITE_THRESHOLD=0.1          # Very permissive
```

## Future Enhancements

### Phase 2 (Week 2-3): Learning System

Track regeneration success rates:
```typescript
interface RegenerationHistory {
  symbol: string;
  timestamp: number;
  score: number;
  leadToTrade: boolean;
  tradeProfitable: boolean | null;
}
```

Adjust cooldown per symbol based on historical effectiveness.

### Phase 3 (Week 4): Time-of-Day Adjustment

```typescript
function getTimeOfDayCooldown(baselineCooldown: number): number {
  const hour = new Date().getUTCHours();
  if (hour >= 13 && hour <= 16) return baselineCooldown * 0.75; // US/EU overlap
  if (hour >= 0 && hour <= 6) return baselineCooldown * 1.5;    // Asian night
  return baselineCooldown;
}
```

## Troubleshooting

### Issue: Too many regenerations

**Solution**: Increase thresholds
```bash
STRATEGY_MIN_CONFIDENCE_DELTA=0.3         # More strict
STRATEGY_COMPOSITE_THRESHOLD=0.5          # Higher bar
```

### Issue: Missing opportunities

**Solution**: Lower thresholds or disable composite scoring
```bash
STRATEGY_COMPOSITE_THRESHOLD=0.3          # More permissive
# Or temporarily disable
STRATEGY_USE_COMPOSITE_SCORE=false
```

### Issue: Cooldown too long/short

**Solution**: Adjust base cooldown or disable adaptive
```bash
STRATEGY_REGIME_COOLDOWN_MIN=3            # Shorter base
# Or disable adaptive
STRATEGY_VOLATILITY_ADAPTIVE=false
```

## Conclusion

The adaptive cooldown implementation provides:
1. ✅ Reduced LLM costs through intelligent filtering
2. ✅ Better timing through volatility-aware cooldowns
3. ✅ Improved trade quality through composite scoring
4. ✅ Full backward compatibility with feature flags
5. ✅ Comprehensive monitoring through enhanced ops events

All features are enabled by default but can be individually disabled for A/B testing or rollback.
