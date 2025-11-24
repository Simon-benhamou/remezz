# 🧠 Adaptive Learning System

## Overview

The Adaptive Learning System replaces rigid, static trading rules with **dynamic, performance-based thresholds** that learn from actual market outcomes. Instead of blocking trades based on predetermined rules (like "low volatility = no trade"), the system tracks which conditions actually produce profitable trades and adjusts entry criteria accordingly.

## Key Problem Solved

### Before (Static Rules)
```
Low volatility (0.76%) → BLOCKED ❌
Choppy market conditions → BLOCKED ❌
Compatibility score 0.57 < 0.60 → BLOCKED ❌
```

**Result**: Predictor shows 90% confidence LONG signals, but no trades execute due to rigid filters.

### After (Adaptive Learning)
```
Low volatility (0.76%) + High predictor confidence (90%) 
  → Check historical performance
  → Found 65% win rate in similar conditions (15 trades)
  → OVERRIDE: Allow trade ✅
```

**Result**: System learns that high predictor confidence overcomes low volatility concerns when historical data proves profitability.

## How It Works

### 1. Market Condition Bucketing

The system categorizes each trade opportunity by:
- **Volatility**: very_low, low, medium, high, very_high (based on ATR%)
- **Liquidity**: excellent, good, acceptable, poor (volume ratio + USD volume)
- **Trend Quality**: excellent, good, acceptable, poor, choppy
- **Predictor Confidence**: 0-100%
- **Compatibility Score**: 0-1.0

### 2. Historical Performance Tracking

For each bucket, the system tracks:
```typescript
{
  totalTrades: 25,
  wins: 16,
  losses: 7,
  neutrals: 2,
  winRate: 0.64,        // 64% win rate
  avgPnl: 0.42,         // Average 0.42% gain
  sharpeRatio: 1.23,    // Risk-adjusted returns
  confidence: 'medium'  // Based on sample size
}
```

### 3. Dynamic Threshold Adjustment

Based on proven performance, thresholds adapt:

| Historical Win Rate | Compatibility Adjustment | Predictor Confidence Adjustment | Result |
|---------------------|--------------------------|--------------------------------|--------|
| ≥ 60% + Sharpe > 0.5 | -0.15 (relax) | -0.10 (relax) | 🚀 Trade aggressively |
| ≥ 50% + Positive PnL | -0.08 | -0.05 | ✅ Trade normally |
| ≥ 40% | 0 (keep default) | 0 | ⚠️ Standard criteria |
| < 40% | +0.10 (tighten) | +0.10 (tighten) | ❌ Avoid |

### 4. Special Override Rules

**Override 1: High Confidence + Proven Track Record**
- Predictor confidence ≥ 88%
- Historical win rate ≥ 60%
- Sample size ≥ 10 trades
- **Action**: Allow trade regardless of other factors

**Override 2: Low Volatility Exception**
- ATR < 0.8% (normally blocked)
- BUT predictor confidence ≥ 80%
- AND historical win rate ≥ 55% in similar conditions
- **Action**: Override volatility filter

## Configuration

Add to `.env`:
```bash
# Adaptive Learning System
ADAPTIVE_LEARNING_ENABLED="true"
ADAPTIVE_LOOKBACK_DAYS="30"              # Days of history to analyze
ADAPTIVE_MIN_SAMPLE_SIZE="10"            # Minimum trades needed for confidence
ADAPTIVE_BASE_COMPATIBILITY_THRESHOLD="0.55"  # Lowered from 0.60
ADAPTIVE_BASE_PREDICTOR_THRESHOLD="0.65"      # Can be adjusted based on performance
```

## API Endpoints

### 1. Market Health Check (Enhanced)
```bash
POST /api/market-health
{
  "symbol": "SUI/USDT:USDT"
}
```

Response now includes:
```json
{
  "adaptiveLearning": {
    "allowed": true,
    "recommendedMinCompatibility": 0.52,
    "recommendedMinPredictorConf": 0.62,
    "reasoning": "🚀 Strong performance (68% WR, Sharpe 1.34) - relaxed thresholds",
    "override": "🎯 High-confidence override: 90% predictor + 68% historical WR",
    "historicalPerformance": {
      "trades": 18,
      "winRate": "68.2%",
      "avgPnl": "0.523",
      "sharpe": "1.34",
      "confidence": "medium"
    }
  }
}
```

### 2. Adaptive Summary for Symbol
```bash
POST /api/market-health/adaptive-summary
{
  "symbol": "SUI/USDT:USDT",
  "lookbackDays": 30
}
```

Response:
```json
{
  "symbol": "SUI/USDT:USDT",
  "volatilityBuckets": {
    "high_conf": {
      "trades": 15,
      "winRate": 0.73,
      "avgCompatibility": 0.81
    },
    "medium_conf": {
      "trades": 22,
      "winRate": 0.54,
      "avgCompatibility": 0.68
    },
    "low_conf": {
      "trades": 8,
      "winRate": 0.25,
      "avgCompatibility": 0.42
    }
  },
  "overallRecommendation": "✅ Strong edge on SUI/USDT:USDT - can trade aggressively with high predictor confidence"
}
```

## Real-World Example: SUI Trade

### Scenario
```
Symbol: SUI/USDT:USDT
Predictor Decision: LONG (confidence: 93%)
ATR: 0.76% (low volatility)
Compatibility Score: 0.57 (below 0.60 threshold)
```

### Traditional System Response
```
❌ BLOCKED
Reasons:
- Compatibility score 0.57 < 0.60
- Volatility too low (0.76%) for ATR-based stops
- Choppy market conditions
```

### Adaptive System Response
```
✅ ALLOWED
Reasoning:
1. Queried historical performance for SUI with 90%+ predictor confidence
2. Found 18 similar trades in last 30 days
3. Win rate: 68.2%, Sharpe: 1.34, Avg PnL: +0.52%
4. Applied "High-confidence override" rule
5. Lowered compatibility threshold from 0.60 → 0.52
6. Trade meets adaptive criteria ✅
```

## Integration Points

### 1. Market Health Route
File: `backend/src/routes/marketHealth.ts`
- Evaluates adaptive thresholds for each request
- Shows reasoning and overrides in response

### 2. Meta Orchestrator
File: `backend/src/services/metaAdaptiveOrchestrator.ts`
- Calls `evaluateAdaptiveEntry()` before placing orders
- Overrides capital/confidence checks when adaptive learning allows
- Logs adaptive decisions for future learning

### 3. Learning Module
File: `backend/src/learning/adaptiveThresholds.ts`
- Core logic for performance tracking
- Threshold calculation algorithms
- Override rule evaluation

## Benefits

### 1. Captures More Opportunities
- Doesn't miss trades due to overly strict filters
- Learns which "edge cases" actually work

### 2. Self-Improving
- Performance improves over time as more data accumulates
- Adapts to changing market conditions

### 3. Risk-Managed
- Still applies safety checks (capital limits, risk governor)
- Tightens thresholds when performance degrades
- Requires minimum sample size before overriding

### 4. Transparent
- All decisions logged with reasoning
- Can audit why trades were allowed/blocked
- Performance data visible via API

## Monitoring

### Check System Status
```javascript
// Frontend usage
import { api } from '@/api';

// Get adaptive recommendations for active symbols
const btcSummary = await api.getAdaptiveSummary('BTC/USDT:USDT', 30);
const ethSummary = await api.getAdaptiveSummary('ETH/USDT:USDT', 30);
const suiSummary = await api.getAdaptiveSummary('SUI/USDT:USDT', 30);

// Get market health with adaptive learning data
const health = await api.getMarketHealth('SUI/USDT:USDT');
console.log(health.adaptiveLearning);
```

### Review Logs
Look for these log messages:
```
🧠 Adaptive eval | allowed=true reasoning="Strong performance..."
🎯 High-confidence override: 90% predictor + 68% historical WR
✨ Low-vol override: Proven 65% WR in similar conditions
```

## Future Enhancements

1. **Multi-dimensional learning**: Track correlations between multiple factors
2. **Regime-aware adaptation**: Different thresholds for trending vs ranging markets
3. **Symbol-specific calibration**: Learn optimal thresholds per crypto
4. **Bayesian updates**: Continuously refine confidence estimates
5. **Feature importance**: Identify which factors matter most for each symbol

## Summary

The Adaptive Learning System transforms the trading bot from a **rules-based automaton** into a **learning system** that gets smarter with every trade. It doesn't replace human judgment—it augments it with data-driven insights from actual performance.

**Before**: "The rules say we can't trade this setup."  
**After**: "The data shows we've won 68% of similar setups—let's take the trade."
