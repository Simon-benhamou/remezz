# Confidence-Based Dynamic Leverage Implementation

## Overview

This implementation introduces **confidence-based leverage scaling** that adjusts position leverage based on the probability of trade success. The agent now dynamically scales leverage from a minimum of 2x to the configured maximum (e.g., 10x) based on trade confidence.

## Problem Statement

Previously, the system used a fixed maximum leverage (e.g., 10x) set at agent creation, which didn't account for varying trade confidence levels. This led to:
- Over-leveraging on low-confidence trades
- Under-leveraging on high-confidence trades
- Inefficient capital utilization
- Increased risk on uncertain setups

## Solution

### Confidence-to-Leverage Mapping

The system now scales leverage based on confidence score (0.0 - 1.0):

| Confidence Range | Leverage Factor | Example (10x max) | Use Case |
|-----------------|-----------------|-------------------|----------|
| 0.0 - 0.5 (Low) | 20% - 50% | 2x - 5x | Uncertain setups, experimental trades |
| 0.5 - 0.75 (Medium) | 50% - 85% | 5x - 8.5x | Moderate confidence, standard trades |
| 0.75 - 0.9 (High) | 85% - 100% | 8.5x - 10x | Strong setups, favorable conditions |
| 0.9 - 1.0 (Very High) | 100% | 10x | Maximum confidence, ideal conditions |

### Implementation Details

**Location**: `/backend/src/agent/state/index.ts` (lines 3226-3273)

The confidence factor is calculated within the dynamic leverage section:

```typescript
const confidenceFactor = (() => {
  const conf = Math.max(0, Math.min(1, confidenceScore));
  if (conf < 0.5) {
    // Low confidence: 0.2 to 0.5 (20% to 50% of base leverage)
    return 0.2 + (conf / 0.5) * 0.3;
  } else if (conf < 0.75) {
    // Medium confidence: 0.5 to 0.85
    return 0.5 + ((conf - 0.5) / 0.25) * 0.35;
  } else if (conf < 0.9) {
    // High confidence: 0.85 to 1.0
    return 0.85 + ((conf - 0.75) / 0.15) * 0.15;
  } else {
    // Very high confidence: full leverage
    return 1.0;
  }
})();
```

### Key Features

1. **Minimum Leverage Floor**: Enforces a minimum of 2x leverage even for very low confidence trades to ensure the agent can still participate in the market.

2. **Progressive Scaling**: Uses non-linear scaling to be conservative at low confidence and aggressive at high confidence.

3. **Observability**: Logs leverage adjustments when confidence factor differs significantly from 1.0, providing visibility into decision-making.

4. **Integration with Existing Factors**: Works alongside existing factors like:
   - Quality multiplier
   - Stop loss width
   - Risk percentage
   - Volatility guards
   - Leverage caps

## Confidence Score Calculation

The confidence score is computed by `resolveEntryConfidence()` (lines 13211-13290) and considers:

- **Model confidence**: AI prediction confidence
- **Pattern recognition**: Historical pattern match confidence
- **Risk/Reward ratio**: Higher R:R increases confidence
- **Market conditions**: ADX, momentum, trend strength
- **Quality indicators**: Entry quality and market regime

## Examples

### Example 1: Low Confidence Trade (30% confidence, 10x max leverage)
- Confidence factor: 0.38
- Effective leverage: ~3.8x
- Result: Conservative position sizing on uncertain setup

### Example 2: Medium Confidence Trade (60% confidence, 10x max leverage)
- Confidence factor: 0.64
- Effective leverage: ~6.4x
- Result: Moderate leverage on standard trade

### Example 3: High Confidence Trade (85% confidence, 10x max leverage)
- Confidence factor: 0.95
- Effective leverage: ~9.5x
- Result: Near-maximum leverage on strong setup

### Example 4: Very High Confidence Trade (95% confidence, 10x max leverage)
- Confidence factor: 1.0
- Effective leverage: 10x
- Result: Full leverage on ideal conditions

## Benefits

1. **Risk Management**: Automatically reduces leverage on uncertain trades
2. **Capital Efficiency**: Uses full leverage when conditions are favorable
3. **Realistic Sizing**: Matches position size to trade conviction
4. **Improved Performance**: Better risk-adjusted returns by avoiding over-leverage on weak setups

## Testing

Unit tests validate the confidence-to-leverage mapping across different scenarios:
- Location: `/backend/test/unit/confidence-leverage.ts`
- Tests: 12 test cases covering low, medium, high, and very high confidence ranges
- Result: All tests passing ✅

## Configuration

The feature works with existing configuration:
- `profile.maxLeverage`: Sets the maximum leverage cap (e.g., 10)
- `profile.minLeverage`: Sets the minimum leverage floor (default 2)
- `profile.dynamicLeverage`: Must be enabled (default: true)

## Monitoring

The system logs leverage adjustments via the ops event system:

```json
{
  "level": "info",
  "source": "leverage_confidence",
  "message": "confidence_based_leverage_scaling",
  "details": {
    "confidenceScore": 0.6,
    "confidenceFactor": 0.64,
    "baseLeverage": 10,
    "scaledLeverage": 6.4,
    "effectiveLeverage": 6.4,
    "leverageFloor": 2
  }
}
```

## Future Enhancements

Potential improvements:
1. Add user-configurable confidence-to-leverage curves
2. Implement confidence-based leverage learning from historical performance
3. Add leverage adjustment based on recent win/loss streaks
4. Create confidence calibration based on backtesting results
