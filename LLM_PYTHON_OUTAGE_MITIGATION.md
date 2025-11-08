# LLM and Python Predictor Outage Mitigation

This document describes the system's resilience mechanisms for handling outages of external AI services (LLM and Python predictor).

## Overview

The trading system now includes comprehensive fallback mechanisms to ensure continuous operation even when external AI services become unavailable. This reduces the negative impact of service outages on trading performance.

## Architecture

### Service Health Monitoring

Located in `backend/src/infra/serviceHealth.ts`, this module implements:

1. **Circuit Breaker Pattern**: Automatically opens after 5 consecutive failures to prevent cascading failures
2. **Service States**:
   - `available`: Service operating normally
   - `degraded`: 2+ consecutive failures, still attempting calls
   - `unavailable`: Circuit breaker open, blocking calls
3. **Metrics Tracking**:
   - Success/failure rates
   - Consecutive failure count
   - Average response times
   - Fallback trigger frequency

### Configuration

Circuit breaker thresholds (in `serviceHealth.ts`):
```typescript
CIRCUIT_BREAKER_THRESHOLD = 5        // Open after N failures
CIRCUIT_BREAKER_TIMEOUT = 60_000     // Retry after 60 seconds
```

## LLM Fallback Strategy

### Primary: LLM Services
- OpenAI (GPT models)
- Grok (X.AI)

### Fallback: Rule-Based Analysis

When LLM is unavailable, the system uses:

**Sentiment Analysis Fallback** (`backend/src/ai/analysis.ts`):
- RSI-based momentum detection
- EMA trend analysis
- Technical indicator scoring
- Returns structured sentiment with reasoning

**Usage:**
```typescript
import { llmJSONSafe } from './ai/llm.js';

// Safe wrapper - returns null on failure instead of throwing
const result = await llmJSONSafe(prompt, {
  cacheKey: 'analysis:BTC',
  ttlMin: 60,
  context: { symbol: 'BTC/USDT', kind: 'analysis' }
});

if (result === null) {
  // LLM unavailable, use fallback logic
}
```

## Python Predictor Fallback Strategy

### Primary: ML Model Predictions
- XGBoost-based predictions
- Multi-class classification (long/short/none)
- Confidence scoring

### Fallback: Rule-Based Predictions

When Python predictor is unavailable (`backend/src/quantai/pythonPredictor.ts`):

**Decision Logic:**
1. **Oversold + Volume** (RSI < 30, volume > 1.5x) → Long bias
2. **Overbought + Volume** (RSI > 70, volume > 1.5x) → Short bias
3. **Bullish Momentum** (MACD > 0, price up, volume > 1.2x) → Long bias
4. **Bearish Momentum** (MACD < 0, price down, volume > 1.2x) → Short bias
5. **Default** → Neutral (33/33/34 probabilities)

**Usage:**
```typescript
import { getPredictionSafe, getRuleBasedPrediction } from './quantai/pythonPredictor.js';

// Async with automatic fallback
const prediction = await getPredictionSafe(features, { 
  allowFallback: true 
});

// Or use rule-based directly
const fallbackPrediction = getRuleBasedPrediction(features);

console.log(prediction.decision);        // 'long' | 'short' | 'none'
console.log(prediction.confidence);      // 0-1
console.log(prediction.meta?.source);    // 'rule_based_fallback' if used
```

## Monitoring

### API Endpoint

Access service health metrics:

```bash
GET /api/monitor/service-health
```

**Response:**
```json
{
  "services": {
    "llm": {
      "status": "available",
      "consecutiveFailures": 0,
      "lastSuccess": 1699564800000,
      "totalCalls": 150,
      "successfulCalls": 148,
      "failedCalls": 2,
      "avgResponseTime": 250,
      "circuitBreakerOpen": false
    },
    "python_predictor": {
      "status": "degraded",
      "consecutiveFailures": 2,
      "lastSuccess": 1699564700000,
      "totalCalls": 100,
      "successfulCalls": 95,
      "failedCalls": 5,
      "avgResponseTime": 120,
      "circuitBreakerOpen": false
    }
  },
  "fallbacks": {
    "llm": {
      "triggered": 5,
      "lastTriggeredAt": 1699564750000,
      "byReason": {
        "circuit_breaker_open": 3,
        "timeout": 2
      }
    },
    "python_predictor": {
      "triggered": 10,
      "lastTriggeredAt": 1699564780000,
      "byReason": {
        "rule_based_fallback": 8,
        "circuit_breaker_open": 2
      }
    }
  },
  "timestamp": 1699564800000
}
```

### Alerting

The system automatically creates alerts for:

1. **Critical**: Circuit breaker opened (5+ consecutive failures)
2. **Warning**: Service degraded (2+ consecutive failures)
3. **Warning**: Frequent fallback usage (every 10 triggers)
4. **Info**: Circuit breaker closed (service recovered)

Alerts are logged and can be accessed via `/api/monitor/alerts`.

## Integration Points

### Files Modified

1. **`backend/src/infra/serviceHealth.ts`** (NEW)
   - Core health monitoring and circuit breaker

2. **`backend/src/ai/llm.ts`**
   - Added health tracking to all LLM calls
   - Added `llmJSONSafe()` wrapper

3. **`backend/src/quantai/pythonPredictor.ts`**
   - Added health tracking to all Python predictor calls
   - Added `getRuleBasedPrediction()` fallback
   - Added `getPredictionSafe()` wrappers

4. **`backend/src/ai/analysis.ts`**
   - Updated to use `llmJSONSafe()`
   - Fallback to rule-based sentiment

5. **`backend/src/ai/planOrchestrator.ts`**
   - Added fallback tracking for plan generation

6. **`backend/src/routes/monitor.ts`**
   - Added `/service-health` endpoint

## Testing

### Unit Tests

Located in `backend/test/unit/infra/serviceHealth.test.ts`:
- Circuit breaker behavior
- Service state transitions
- Fallback metrics tracking
- Response time averaging

### Integration Test

Located in `backend/test/integration/service-outage-handling.mjs`:
- Tests LLM fallback with circuit breaker
- Tests Python predictor rule-based fallback
- Validates different market conditions

**Run tests:**
```bash
npm run test:unit
npm run test:integration
```

## Performance Impact

### Baseline (All Services Available)
- LLM: ~200-500ms per call (cached: <10ms)
- Python Predictor: ~100-200ms per call

### Degraded Mode (Fallbacks Active)
- Rule-based sentiment: <1ms
- Rule-based predictions: <1ms
- **Impact**: Near-zero performance degradation when using fallbacks

### Recovery
- Circuit breaker automatically closes after successful call
- Half-open state allows test calls after timeout
- No manual intervention required

## Best Practices

1. **Monitor Fallback Frequency**: High fallback usage indicates service issues
2. **Review Alert Patterns**: Circuit breaker alerts signal infrastructure problems
3. **Tune Thresholds**: Adjust based on observed failure patterns
4. **Cache Aggressively**: LLM caching reduces dependency on external services
5. **Test Fallbacks Regularly**: Ensure rule-based logic remains effective

## Future Enhancements

Potential improvements:
- [ ] Multiple LLM provider fallback chain
- [ ] Adaptive threshold tuning based on historical patterns
- [ ] Pre-emptive fallback during known degraded periods
- [ ] Fallback quality scoring and optimization
- [ ] Dashboard visualization of service health
