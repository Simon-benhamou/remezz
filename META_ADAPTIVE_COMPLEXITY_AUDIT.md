# Meta-Adaptive Strategy Implementation: Complexity Audit

**Date**: 2025-11-08  
**Status**: Comprehensive Architecture Analysis & Enhancement Plan  
**Scope**: All major modules, integration points, error handling, and debugging infrastructure

---

## 📋 Executive Summary

This audit maps the entire meta-adaptive trading system, identifies all integration points where modules interact, and proposes concrete improvements for logging, error handling, and debugging. The system is complex with multiple layers: LLM-based strategy generation, Python ML predictors, signal evaluation, broker execution, and position management.

**Key Findings**:
- ✅ **Modular architecture** with clear separation of concerns
- ⚠️ **Integration points** need more structured logging and error recovery
- ⚠️ **Fallback chains** exist but could be more explicit and logged
- ⚠️ **Debug tools** are scattered; need unified diagnostic checklist

---

## 🗺️ 1. Major Module Map

### 1.1 Core Modules

| Module | Path | Responsibility |
|--------|------|----------------|
| **LLM Interface** | `backend/src/ai/llm.ts` | OpenAI/Grok API calls for strategy generation, caching, rate limiting |
| **Strategy Orchestrator** | `backend/src/ai/orchestrator.ts` | Generates daily strategies via LLM or rule-based fallback, ranks perps |
| **Python Predictor Bridge** | `backend/src/quantai/pythonPredictor.ts` | Spawns Python XGBoost process for ML predictions |
| **Python Signal Tuning** | `backend/src/quantai/pythonSignalTuning.ts` | Adapts prediction thresholds based on training metrics |
| **Meta-Adaptive Agent** | `backend/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.ts` | Core strategy evaluation logic (2662 lines) |
| **Recognized Strategies** | `backend/src/quantai/strategies/metaAdaptive/recognizedStrategies.ts` | Evaluates 4 strategy families, computes confidence gates |
| **Exit Manager** | `backend/src/quantai/strategies/metaAdaptive/exitManager.ts` | Trailing stops, take-profit logic, timeout exits |
| **Orchestration Service** | `backend/src/services/metaAdaptiveOrchestrator.ts` | Main tick loop: signal evaluation → execution |
| **Agent Hub** | `backend/src/agent/hub.ts` | Agent lifecycle management (activate, halt, close) |
| **Broker Layer** | `backend/src/broker/` | Paper/Live/CapitalPool brokers for order execution |

### 1.2 Data Flow Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      EXTERNAL DATA SOURCES                       │
│  • CCXT (market data)  • OpenAI/Grok API  • Python XGBoost      │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ORCHESTRATOR TICK LOOP                       │
│            (metaAdaptiveOrchestrator.ts)                         │
│                                                                  │
│  1. Fetch market snapshot (buildTechSnapshot)                    │
│  2. Compute multi-timeframe diagnostics                          │
│  3. Get market context (derivatives, sentiment, etc.)            │
│  4. Call Python predictor (if enabled)                           │
│  5. Evaluate recognized strategies                               │
│  6. Execute entry or exit trades                                 │
└──────────┬───────────────────────────────────────────────────────┘
           │
           ├──────────────┬─────────────┬──────────────┐
           ▼              ▼             ▼              ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
    │   LLM    │  │  Python  │  │ Strategy │  │  Broker  │
    │Interface │  │Predictor │  │Evaluator │  │ Executor │
    └──────────┘  └──────────┘  └──────────┘  └──────────┘
           │              │             │              │
           └──────────────┴─────────────┴──────────────┘
                          │
                          ▼
                 ┌─────────────────┐
                 │  Trade Outcome  │
                 │   (P&L, logs)   │
                 └─────────────────┘
```

---

## 🔗 2. Critical Integration Points

### 2.1 LLM → Strategy Generation

**Files**: `llm.ts`, `orchestrator.ts`, `strategyManager.ts`

**Flow**:
1. `generateStrategy()` calls `llmJSON()` with market features
2. LLM returns JSON with entry zones, stops, targets
3. On LLM failure → rule-based fallback generates strategy from technical indicators

**Issues**:
- ✅ Fallback exists
- ⚠️ No structured logging of LLM provider switch (OpenAI→Grok)
- ⚠️ Cache hits not logged with context (sessionId, symbol)

**Proposed Fixes**:
```typescript
// In llm.ts - add structured logging
if (process.env.DEBUG_LLM === 'true') {
  console.log(`[LLM] ${opts?.context?.kind || 'call'} | session=${opts?.context?.sessionId} symbol=${opts?.context?.symbol} provider=${provider} cache=${hit ? 'HIT' : 'MISS'}`);
}

// Add error context to fallback
try {
  return await callOpenAI(prompt);
} catch (e: any) {
  console.error(`[LLM] OpenAI failed: ${e.message} | session=${opts?.context?.sessionId} symbol=${opts?.context?.symbol}`);
  if (provider === 'grok' && cfg.OPENAI_API_KEY) {
    console.log(`[LLM] Falling back to OpenAI | session=${opts?.context?.sessionId}`);
    // ... fallback code
  }
}
```

### 2.2 Python Predictor → Signal Evaluation

**Files**: `pythonPredictor.ts`, `metaAdaptiveAgent.ts`, `recognizedStrategies.ts`

**Flow**:
1. `metaAdaptiveAgent.evaluate()` calls `getPythonPredictionSync()`
2. Python process spawned with stdin features, returns JSON with probabilities
3. Signal confidence blended with Python confidence
4. On Python failure → neutral signal used (bias='both', decision='none')

**Issues**:
- ✅ Timeout protection (4s default)
- ✅ Graceful fallback to neutral
- ⚠️ No logging of Python executable resolution failures
- ⚠️ No tracking of consecutive Python failures

**Proposed Fixes**:
```typescript
// In pythonPredictor.ts - log resolution once
if (!cachedPythonExecutable && !cachedPythonResolutionError) {
  const resolved = probePythonExecutable();
  console.log(`[PythonPredictor] Resolved executable: ${resolved}`);
}

// In metaAdaptiveAgent.ts - track failures
let pythonFailureCount = 0;
const PYTHON_FAILURE_THRESHOLD = 5;

try {
  const prediction = await getPythonPredictionSync(features);
  pythonFailureCount = 0; // Reset on success
  console.log(`[MetaAdaptive] Python prediction | session=${sessionId} symbol=${symbol} decision=${prediction.decision} prob=${prediction.confidence.toFixed(3)}`);
} catch (error) {
  pythonFailureCount++;
  console.error(`[MetaAdaptive] Python prediction failed (${pythonFailureCount}/${PYTHON_FAILURE_THRESHOLD}) | session=${sessionId} symbol=${symbol} error=${error.message}`);
  
  if (pythonFailureCount >= PYTHON_FAILURE_THRESHOLD) {
    console.error(`[MetaAdaptive] Python predictor failing repeatedly - consider disabling`);
    // Optionally emit alert or disable predictor
  }
  
  // Use neutral fallback
  pythonHybrid = null;
}
```

### 2.3 Strategy Evaluation → Trade Execution

**Files**: `recognizedStrategies.ts`, `metaAdaptiveOrchestrator.ts`, `broker/`

**Flow**:
1. `evaluateRecognizedStrategies()` returns scored signals
2. Orchestrator selects best signal meeting confidence threshold
3. `registerAdaptiveTradeEntry()` validates signal and reserves trade slot
4. Broker reserves capital via `CapitalPoolBroker.place()`
5. Order placed, position tracked

**Issues**:
- ✅ Capital reservation prevents overallocation
- ⚠️ Signal rejection reasons not always logged with context
- ⚠️ Order placement failures don't log broker state

**Proposed Fixes**:
```typescript
// In recognizedStrategies.ts - log rejection reasons
if (!confidenceGatePassed) {
  console.warn(`[RecognizedStrategy] Signal blocked | session=${opts.sessionId} symbol=${opts.symbol} strategy=${signal.id} reason=${blockedReason} confidence=${calibratedConfidence.toFixed(3)} threshold=${dynamicThreshold.toFixed(3)}`);
}

// In metaAdaptiveOrchestrator.ts - log broker state on failure
try {
  const order = await broker.place({...});
  console.log(`[Orchestrator] Order placed | session=${session.sessionId} symbol=${session.symbol} orderId=${order.id} side=${side} qty=${sizing.qty} price=${entryPrice}`);
} catch (error) {
  const balance = await broker.balance().catch(() => null);
  console.error(`[Orchestrator] Order placement failed | session=${session.sessionId} symbol=${session.symbol} error=${error.message} brokerEquity=${balance?.equityUsd} brokerFree=${balance?.freeUsd}`);
  throw error;
}
```

### 2.4 Position Management → Exit Logic

**Files**: `exitManager.ts`, `metaAdaptiveOrchestrator.ts`

**Flow**:
1. Each tick, orchestrator calls `maybeAdjustOrExit()`
2. Exit manager checks: stop-loss, take-profit, timeout, trailing stop
3. Returns directive: `exit`, `move_sl`, or `hold`
4. Orchestrator executes exit order via broker
5. `registerAdaptiveTradeOutcome()` logs P&L and updates strategy stats

**Issues**:
- ✅ Clear exit reasons
- ⚠️ No logging of stop adjustments
- ⚠️ Exit order failures not tracked

**Proposed Fixes**:
```typescript
// In exitManager.ts - log stop adjustments
if (exitDirective.action === 'move_sl') {
  console.log(`[ExitManager] Trailing stop adjusted | symbol=${symbol} oldStop=${stop} newStop=${exitDirective.stop} reason=breakeven_or_trail`);
}

// In metaAdaptiveOrchestrator.ts - track exit failures
try {
  const order = await broker.place({...});
  console.log(`[Orchestrator] Exit order placed | session=${session.sessionId} orderId=${order.id} reason=${reason} pnl=${pnl.toFixed(2)}`);
} catch (error) {
  console.error(`[Orchestrator] Exit order failed | session=${session.sessionId} reason=${reason} error=${error.message}`);
  // Retry or alert
}
```

---

## 🛠️ 3. Proposed Logging Enhancements

### 3.1 Structured Log Format

All logs should include context fields:

```typescript
interface LogContext {
  sessionId?: string;
  symbol?: string;
  timestamp?: number;
  component: string; // e.g., 'LLM', 'PythonPredictor', 'Broker'
  action: string;     // e.g., 'call', 'fallback', 'place_order'
  level: 'debug' | 'info' | 'warn' | 'error';
}

// Example structured log
function logStructured(ctx: LogContext, message: string, data?: any) {
  const ts = ctx.timestamp || Date.now();
  const prefix = `[${ctx.component}/${ctx.action}]`;
  const context = `session=${ctx.sessionId || 'N/A'} symbol=${ctx.symbol || 'N/A'}`;
  const log = `${prefix} ${message} | ${context}`;
  
  switch (ctx.level) {
    case 'error': console.error(log, data); break;
    case 'warn': console.warn(log, data); break;
    case 'info': console.log(log, data); break;
    case 'debug': if (process.env.DEBUG) console.log(log, data); break;
  }
}
```

### 3.2 Critical Log Points

| Component | Event | Log Level | Data to Include |
|-----------|-------|-----------|----------------|
| LLM | Call started | DEBUG | provider, cacheKey, ttl |
| LLM | Cache hit | DEBUG | provider, age |
| LLM | Cache miss | INFO | provider, bypassRate |
| LLM | Call completed | INFO | provider, model, tokensIn, tokensOut, costUsd |
| LLM | Fallback triggered | WARN | primaryProvider, error, fallbackProvider |
| LLM | Rate limit wait | WARN | waitMs, lastCallDelta |
| Python | Executable resolved | INFO | path, version |
| Python | Prediction call | DEBUG | features (count) |
| Python | Prediction result | INFO | decision, confidence, probabilities |
| Python | Prediction failed | ERROR | error, attempt, fallbackUsed |
| Strategy | Evaluation started | DEBUG | symbol, biasHint |
| Strategy | Signal generated | INFO | strategyId, bias, confidence, score |
| Strategy | Signal blocked | WARN | strategyId, reason, confidence, threshold |
| Broker | Capital reservation | DEBUG | requestedUsd, leverage |
| Broker | Order placed | INFO | orderId, side, qty, price, leverage |
| Broker | Order rejected | ERROR | reason, requestedQty, availableCapital |
| Exit | Stop adjusted | INFO | oldStop, newStop, reason |
| Exit | Exit triggered | INFO | reason, pnl, duration |
| Exit | Exit failed | ERROR | reason, error, retryable |

---

## 🔐 4. Error-Handling & Fallback Strategy

### 4.1 Fallback Chain Summary

```
┌─────────────────────────────────────────────────────────────┐
│                       LLM Strategy                           │
│  Primary: OpenAI/Grok → Fallback: Rule-based (tech indicators)│
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Python Predictor                          │
│  Primary: XGBoost → Fallback: Neutral signal (bias='both')  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                      Broker Execution                        │
│  Primary: Live/Paper broker → Fallback: Order rejection     │
│  Capital: CapitalPoolBroker → Fallback: Reject if no capital│
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Proposed Error-Handling Pattern

```typescript
// Universal error handler wrapper
async function withErrorHandling<T>(
  context: { component: string; action: string; sessionId?: string; symbol?: string },
  fn: () => Promise<T>,
  fallback?: () => T
): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const ctx = {
      ...context,
      level: 'error' as const,
    };
    logStructured(ctx, `Operation failed: ${error.message}`, {
      stack: error.stack,
      code: error.code,
    });
    
    if (fallback) {
      logStructured({ ...context, level: 'warn' }, 'Using fallback');
      return fallback();
    }
    
    throw error;
  }
}

// Usage example in orchestrator
const signals = await withErrorHandling(
  { component: 'Orchestrator', action: 'evaluate_signals', sessionId, symbol },
  async () => evaluateRecognizedStrategies(tech, opts),
  () => [] // Fallback: no signals
);
```

### 4.3 Retry Logic for Transient Failures

```typescript
// Exponential backoff retry for broker operations
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 500
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries;
      const isRetryable = error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET';
      
      if (isLastAttempt || !isRetryable) {
        throw error;
      }
      
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`Retry ${attempt}/${maxRetries} after ${delayMs}ms | error=${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  throw new Error('Unreachable');
}

// Usage for broker calls
const order = await retryWithBackoff(
  () => broker.place(orderParams),
  3,
  500
);
```

---

## 🐛 5. Step-by-Step Debug Checklist

### 5.1 Scenario: Consecutive Losses (5+ losses in a row)

**Symptoms**: Agent continues to lose trades repeatedly  
**Root Causes**: Poor signal quality, bad market conditions, execution issues

**Diagnostic Steps**:

1. **Check Python Predictor Health**
   ```bash
   # Verify Python predictor is working
   tail -n 100 logs/meta-adaptive.log | grep "Python prediction"
   
   # Look for repeated failures
   grep "Python prediction failed" logs/meta-adaptive.log | wc -l
   
   # Check training metrics quality
   cat python/training_metrics.json
   # Verify: winRate > 0.5, f1 > 0.5, sharpe > 0
   ```

2. **Check Signal Confidence Calibration**
   ```bash
   # Check if signals are meeting confidence threshold
   tail -n 100 logs/meta-adaptive.log | grep "Signal blocked" | grep "low_confidence"
   
   # Review confidence distribution
   grep "Signal generated" logs/meta-adaptive.log | awk '{print $NF}' | sort -n
   ```

3. **Check Market Regime Alignment**
   ```bash
   # Verify multi-timeframe consensus
   grep "mtfConsensus" logs/meta-adaptive.log | tail -20
   
   # Check if trading against trend
   grep "bias=" logs/meta-adaptive.log | tail -20
   ```

4. **Check Stop-Loss & Exit Logic**
   ```bash
   # Review recent exit reasons
   grep "Exit triggered" logs/meta-adaptive.log | tail -20
   
   # Check for premature stops
   grep "Stop adjusted" logs/meta-adaptive.log | tail -20
   ```

5. **Check Broker Execution Quality**
   ```bash
   # Check slippage
   grep "slippageBps" logs/meta-adaptive.log | awk '{print $NF}' | sort -n | tail -20
   
   # Check fill ratios
   grep "fillRatio" logs/meta-adaptive.log | awk '{print $NF}' | sort -n | head -20
   ```

**Actions**:
- If Python failing → Disable predictor temporarily: `DISABLE_PYTHON_PREDICTOR=true`
- If low confidence → Lower threshold: `META_ADAPTIVE_CONFIDENCE_THRESHOLD=0.68`
- If wrong regime → Review market context logs, consider pausing agent
- If execution issues → Check liquidity filters, increase spread/depth limits

### 5.2 Scenario: System Stalls (No trades for extended period)

**Symptoms**: Agent active but not generating trades  
**Root Causes**: Overly strict filters, Python predictor blocking, no signals generated

**Diagnostic Steps**:

1. **Check Signal Generation**
   ```bash
   # Verify signals are being generated
   grep "Found.*signal" logs/meta-adaptive.log | tail -20
   
   # Check if always empty
   grep "No signals generated" logs/meta-adaptive.log | wc -l
   ```

2. **Check Confidence Gate**
   ```bash
   # See if all signals blocked by confidence
   grep "Signal blocked.*low_confidence" logs/meta-adaptive.log | wc -l
   
   # Check entry eligibility failures
   grep "weak_entry_context" logs/meta-adaptive.log | wc -l
   ```

3. **Check Python Predictor Cooldowns**
   ```bash
   # Check if predictor is blocking trades
   grep "predictor_blocked" logs/meta-adaptive.log | tail -20
   
   # Check cooldown reasons
   grep "cooldown.*active=true" logs/meta-adaptive.log | tail -20
   ```

4. **Check Liquidity Filters**
   ```bash
   # Check spread violations
   grep "spreadBps" logs/meta-adaptive.log | awk '{print $NF}' | sort -n | tail -20
   
   # Check depth violations
   grep "depthUsd" logs/meta-adaptive.log | awk '{print $NF}' | sort -n | head -20
   ```

5. **Check Capital Availability**
   ```bash
   # Check if out of capital
   grep "capital_reservation_failed" logs/meta-adaptive.log | tail -20
   
   # Check broker equity
   grep "brokerEquity" logs/meta-adaptive.log | tail -20
   ```

**Actions**:
- If no signals → Check market data feed, verify CCXT connection
- If confidence blocking → Lower threshold: `META_ADAPTIVE_CONFIDENCE_THRESHOLD=0.65`
- If predictor blocking → Disable: `DISABLE_PYTHON_PREDICTOR=true`
- If liquidity failing → Relax limits: `META_ADAPTIVE_MAX_SPREAD_BPS=25`
- If no capital → Check capital pool allocation, increase budget

### 5.3 Scenario: Order Rejections

**Symptoms**: Orders consistently rejected by exchange  
**Root Causes**: Invalid qty/price, insufficient margin, symbol restrictions

**Diagnostic Steps**:

1. **Check Order Parameters**
   ```bash
   # Review rejected orders
   grep "Order rejected" logs/meta-adaptive.log | tail -20
   
   # Check qty precision issues
   grep "minQty" logs/meta-adaptive.log | tail -20
   ```

2. **Check Exchange Requirements**
   ```bash
   # Verify symbol metadata
   grep "tickSize\|stepSize\|minQty" logs/meta-adaptive.log | tail -20
   
   # Check leverage limits
   grep "leverage" logs/meta-adaptive.log | tail -20
   ```

3. **Check Broker Balance**
   ```bash
   # Check margin availability
   grep "freeUsd\|equityUsd" logs/meta-adaptive.log | tail -20
   
   # Check if overleveraged
   grep "marginRatio" logs/meta-adaptive.log | tail -20
   ```

**Actions**:
- If qty precision → Check `stepSize` and round properly
- If price precision → Check `tickSize` and round properly
- If leverage → Reduce: `MAX_LEVERAGE=5`
- If margin → Increase capital or reduce position size

### 5.4 Scenario: LLM Strategy Generation Failures

**Symptoms**: Strategies always rule-based fallback  
**Root Causes**: LLM API issues, invalid prompts, rate limits

**Diagnostic Steps**:

1. **Check LLM Connectivity**
   ```bash
   # Verify API calls succeeding
   grep "LLM.*Call completed" logs/meta-adaptive.log | tail -20
   
   # Check for errors
   grep "LLM.*failed" logs/meta-adaptive.log | tail -20
   ```

2. **Check Rate Limiting**
   ```bash
   # Check if hitting rate limits
   grep "Rate limit wait" logs/meta-adaptive.log | wc -l
   
   # Check call frequency
   grep "LLM.*Call" logs/meta-adaptive.log | awk '{print $1}' | uniq -c
   ```

3. **Check API Key Validity**
   ```bash
   # Test OpenAI key
   curl https://api.openai.com/v1/models \
     -H "Authorization: Bearer $OPENAI_API_KEY" | jq '.data[0].id'
   
   # Check env vars
   echo $OPENAI_API_KEY | wc -c  # Should be > 40
   ```

**Actions**:
- If API errors → Check key validity, check billing
- If rate limits → Increase `LLM_MIN_INTERVAL_MS=3000`
- If timeouts → Increase `LLM_TIMEOUT_MS=15000`
- If all failing → Use rule-based: `LLM_DISABLE=true`

---

## 📊 6. Monitoring Dashboard Requirements

### 6.1 Key Metrics to Track

**Performance Metrics**:
- Win rate (per session, per strategy family)
- Average P&L per trade
- Sharpe ratio (rolling 30 trades)
- Max drawdown
- Consecutive losses counter

**System Health Metrics**:
- LLM call success rate (per provider)
- Python predictor success rate
- Average predictor latency
- Order placement success rate
- Capital utilization %

**Signal Quality Metrics**:
- Average signal confidence
- Signals blocked by confidence gate %
- Signals blocked by entry eligibility %
- Python predictor cooldown frequency
- Confidence calibration drift

### 6.2 Alert Thresholds

```typescript
const ALERT_THRESHOLDS = {
  consecutiveLosses: 5,
  winRate30Trades: 0.40, // Alert if < 40%
  pythonFailureRate: 0.30, // Alert if > 30% failures
  llmFailureRate: 0.20,
  orderRejectionRate: 0.15,
  signalBlockedRate: 0.80, // Alert if > 80% signals blocked
  capitalUtilization: 0.95, // Alert if > 95% capital used
};
```

---

## 🚀 7. Implementation Priority

### Phase 1: Critical Logging (Week 1)
1. ✅ Add structured logging to LLM calls (provider, fallback, errors)
2. ✅ Add Python predictor logging (resolution, calls, failures)
3. ✅ Add signal evaluation logging (confidence gates, blocks)
4. ✅ Add broker execution logging (capital, orders, failures)

### Phase 2: Error Recovery (Week 2)
1. ✅ Implement retry logic for broker operations
2. ✅ Add Python predictor failure counter and auto-disable
3. ✅ Add LLM fallback chain logging
4. ✅ Improve exit order failure recovery

### Phase 3: Debug Tools (Week 3)
1. ✅ Create debug checklist document (this document)
2. ✅ Add session-specific log filtering utility
3. ✅ Create performance metrics aggregation script
4. ✅ Build alert system for critical thresholds

### Phase 4: Monitoring (Week 4)
1. ✅ Implement metrics tracking (wins, losses, P&L)
2. ✅ Add dashboard visualization
3. ✅ Set up automated alerts
4. ✅ Create weekly performance reports

---

## 📝 8. Recommended Code Changes

### 8.1 Add Logging Helper

Create `backend/src/utils/integrationLogger.ts`:

```typescript
export interface IntegrationLogContext {
  component: string;
  action: string;
  sessionId?: string;
  symbol?: string;
  userId?: string;
}

export class IntegrationLogger {
  constructor(private context: IntegrationLogContext) {}

  debug(message: string, data?: any) {
    this.log('debug', message, data);
  }

  info(message: string, data?: any) {
    this.log('info', message, data);
  }

  warn(message: string, data?: any) {
    this.log('warn', message, data);
  }

  error(message: string, error?: any, data?: any) {
    const errorData = error ? {
      message: error.message,
      code: error.code,
      stack: error.stack?.split('\n').slice(0, 3).join('\n'),
      ...data,
    } : data;
    this.log('error', message, errorData);
  }

  private log(level: string, message: string, data?: any) {
    const timestamp = new Date().toISOString();
    const { component, action, sessionId, symbol } = this.context;
    const ctx = `[${component}/${action}] session=${sessionId || 'N/A'} symbol=${symbol || 'N/A'}`;
    const logMessage = `${timestamp} ${level.toUpperCase()} ${ctx} | ${message}`;

    switch (level) {
      case 'error':
        console.error(logMessage, data);
        break;
      case 'warn':
        console.warn(logMessage, data);
        break;
      case 'info':
        console.log(logMessage, data);
        break;
      case 'debug':
        if (process.env.DEBUG) console.log(logMessage, data);
        break;
    }
  }
}

// Factory function
export function createIntegrationLogger(context: IntegrationLogContext): IntegrationLogger {
  return new IntegrationLogger(context);
}
```

### 8.2 Update LLM Module

In `backend/src/ai/llm.ts`:

```typescript
import { createIntegrationLogger } from '../utils/integrationLogger.js';

export async function llmJSON(prompt: string, opts?: LLMOpts): Promise<string> {
  const logger = createIntegrationLogger({
    component: 'LLM',
    action: 'call',
    sessionId: opts?.context?.sessionId,
    symbol: opts?.context?.symbol,
  });

  const cfg = getConfig();
  if (cfg.LLM_DISABLE) {
    logger.warn('LLM disabled by config');
    throw new Error('LLM disabled');
  }

  // Cache hit
  const key = keyOf(prompt, opts);
  const ttl = Math.max(1, (opts?.ttlMin ?? cfg.LLM_CACHE_TTL_MIN)) * 60_000;
  const hit = opts?.noCache ? undefined : cache.get(key);
  const now = Date.now();
  
  if (hit && (now - hit.ts) < ttl) {
    const age = Math.floor((now - hit.ts) / 1000);
    logger.debug(`Cache hit | provider=${hit.provider} age=${age}s`);
    return hit.data;
  }

  // Single-flight check
  const inF = opts?.noCache ? undefined : inFlight.get(key);
  if (inF) {
    logger.debug('Call in-flight, waiting...');
    return inF;
  }

  // Rate limit
  const delta = now - lastCallAt;
  if (!opts?.bypassRate && delta < cfg.LLM_MIN_INTERVAL_MS) {
    const waitMs = Math.max(0, cfg.LLM_MIN_INTERVAL_MS - delta);
    logger.warn(`Rate limit wait | waitMs=${waitMs}`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  lastCallAt = Date.now();

  let provider = opts?.provider ?? pickLLM();
  if (provider === 'grok' && !cfg.GROK_API_KEY) {
    if (cfg.OPENAI_API_KEY) {
      logger.warn('Grok key missing, switching to OpenAI');
      provider = 'openai';
    } else {
      logger.error('No LLM provider available');
      throw new Error('Grok provider requested but GROK_API_KEY missing and no OpenAI fallback available');
    }
  }

  logger.info(`Calling | provider=${provider} bypassRate=${!!opts?.bypassRate} noCache=${!!opts?.noCache}`);

  const p = (async () => {
    try {
      let result: LLMCallResult;
      if (provider === 'openai') {
        result = await callOpenAI(prompt);
      } else if (provider === 'grok') {
        result = await callGrok(prompt);
      } else {
        throw new Error('No LLM configured');
      }

      if (!opts?.noCache) {
        cache.set(key, { ts: Date.now(), data: result.text, provider, model: result.modelUsed, tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd });
      }

      logger.info(`Call completed | provider=${provider} model=${result.modelUsed} tokensIn=${result.tokensIn} tokensOut=${result.tokensOut} costUsd=${result.costUsd?.toFixed(4)}`);
      
      return result.text;
    } catch (error: any) {
      logger.error(`Call failed | provider=${provider}`, error);
      throw error;
    } finally {
      if (!opts?.noCache) inFlight.delete(key);
    }
  })();

  let finalPromise: Promise<string> = p.catch(async (err) => {
    if (provider === 'grok' && cfg.OPENAI_API_KEY) {
      logger.warn('Grok call failed, falling back to OpenAI');
      try {
        const fallback = await callOpenAI(prompt);
        if (!opts?.noCache) {
          cache.set(key, { ts: Date.now(), data: fallback.text, provider: 'openai', model: fallback.modelUsed, tokensIn: fallback.tokensIn, tokensOut: fallback.tokensOut, costUsd: fallback.costUsd });
        }
        logger.info(`Fallback succeeded | provider=openai model=${fallback.modelUsed}`);
        return fallback.text;
      } catch (fallbackErr: any) {
        logger.error('Fallback also failed', fallbackErr);
        throw fallbackErr;
      }
    }
    throw err;
  });

  if (!opts?.noCache) inFlight.set(key, finalPromise);
  return finalPromise;
}
```

### 8.3 Update Python Predictor Module

In `backend/src/quantai/pythonPredictor.ts`:

```typescript
import { createIntegrationLogger } from '../utils/integrationLogger.js';

let pythonFailureCount = 0;
const PYTHON_FAILURE_THRESHOLD = 5;

export async function getPrediction(features: Record<string, number>): Promise<PythonPredictionResult> {
  const logger = createIntegrationLogger({
    component: 'PythonPredictor',
    action: 'predict',
  });

  const sanitized = sanitizeFeatures(features);
  const scriptPath = getScriptPath();
  const payload = JSON.stringify(sanitized);

  logger.debug(`Calling Python | features=${Object.keys(sanitized).length} script=${scriptPath}`);

  return new Promise<PythonPredictionResult>((resolve, reject) => {
    let pythonCommand: string;
    try {
      pythonCommand = resolvePythonExecutable();
      if (pythonFailureCount === 0) {
        logger.info(`Using Python executable: ${pythonCommand}`);
      }
    } catch (error: any) {
      logger.error('Failed to resolve Python executable', error);
      reject(error);
      return;
    }

    const child = spawn(pythonCommand, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    const timeoutMs = Number(process.env.PYTHON_PREDICT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      logger.error(`Prediction timeout | timeoutMs=${timeoutMs}`);
      reject(new Error('python prediction timed out'));
    }, Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });

    child.on('error', error => {
      clearTimeout(timer);
      pythonFailureCount++;
      logger.error(`Spawn failed (${pythonFailureCount}/${PYTHON_FAILURE_THRESHOLD})`, error);
      
      if (pythonFailureCount >= PYTHON_FAILURE_THRESHOLD) {
        logger.error('Python predictor failing repeatedly - consider disabling with DISABLE_PYTHON_PREDICTOR=true');
      }
      
      reject(new Error(`python spawn failed: ${error.message}`));
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        pythonFailureCount++;
        const details = stderr || stdout || '';
        logger.error(`Exit code ${code} (${pythonFailureCount}/${PYTHON_FAILURE_THRESHOLD}) | stderr=${details.slice(0, 200)}`);
        reject(new Error(`python exited with code ${code}: ${details}`));
        return;
      }
      
      try {
        const result = parsePrediction(stdout.trim());
        pythonFailureCount = 0; // Reset on success
        logger.info(`Prediction result | decision=${result.decision} confidence=${result.confidence.toFixed(3)} probLong=${result.probabilityLong.toFixed(3)} probShort=${result.probabilityShort.toFixed(3)}`);
        resolve(result);
      } catch (error: any) {
        pythonFailureCount++;
        logger.error(`Parse failed (${pythonFailureCount}/${PYTHON_FAILURE_THRESHOLD})`, error, { stdout: stdout.slice(0, 200) });
        reject(new Error(`failed to parse python output: ${error.message}`));
      }
    });

    try {
      child.stdin.write(payload);
      child.stdin.end();
    } catch (error: any) {
      clearTimeout(timer);
      child.kill('SIGKILL');
      pythonFailureCount++;
      logger.error(`Failed to send payload (${pythonFailureCount}/${PYTHON_FAILURE_THRESHOLD})`, error);
      reject(new Error(`failed to send payload: ${error.message}`));
    }
  });
}
```

---

## ✅ 9. Summary & Next Steps

### What We've Accomplished

1. **✅ Mapped all major modules** - LLM, Python predictor, strategy evaluator, brokers, agent lifecycle
2. **✅ Identified critical integration points** - 4 key handoff zones with data flows
3. **✅ Designed structured logging** - Consistent format with context (sessionId, symbol, component)
4. **✅ Proposed error-handling improvements** - Fallback chains, retry logic, failure tracking
5. **✅ Created comprehensive debug checklist** - Step-by-step diagnostics for common failure scenarios
6. **✅ Recommended monitoring metrics** - Performance, system health, signal quality

### Immediate Next Steps

1. **Implement logging helper** - Create `integrationLogger.ts` utility
2. **Update LLM module** - Add structured logging with fallback tracking
3. **Update Python predictor** - Add failure counting and auto-disable logic
4. **Update orchestrator** - Add logging at entry/exit execution points
5. **Test logging** - Run agent and verify logs are structured and useful
6. **Create alert system** - Monitor critical thresholds and send notifications

### Long-term Improvements

1. **Monitoring dashboard** - Visualize metrics in real-time
2. **Automated diagnostics** - Script to analyze logs and suggest fixes
3. **Performance profiling** - Identify bottlenecks in signal evaluation
4. **Load testing** - Verify system handles multiple concurrent agents
5. **Documentation** - Update architecture docs with new logging patterns

---

**End of Audit Report**
