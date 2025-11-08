# Meta-Adaptive System Architecture Diagram

## High-Level System Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL SYSTEMS                                 │
│                                                                              │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────────────────┐   │
│  │   CCXT      │    │  OpenAI/Grok │    │  Python XGBoost Process     │   │
│  │ (Market     │    │  (LLM API)   │    │  (ML Predictions)           │   │
│  │  Data)      │    │              │    │                             │   │
│  └──────┬──────┘    └──────┬───────┘    └──────────┬──────────────────┘   │
└─────────┼──────────────────┼────────────────────────┼──────────────────────┘
          │                  │                        │
          │                  │                        │
          ▼                  ▼                        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         META-ADAPTIVE CORE SYSTEM                            │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                     ORCHESTRATOR TICK LOOP                             │ │
│  │              (metaAdaptiveOrchestrator.ts)                             │ │
│  │                                                                        │ │
│  │  1. Fetch Market Data   →  buildTechSnapshot()                        │ │
│  │  2. MTF Diagnostics     →  computeMultiTimeframeDiagnostics()         │ │
│  │  3. Market Context      →  getMarketContext()                         │ │
│  │  4. Python Prediction   →  getPredictionSync()                        │ │
│  │  5. Evaluate Signals    →  evaluateRecognizedStrategies()             │ │
│  │  6. Execute Trade       →  executeEntryTrade() / checkAndExecuteExit()│ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────────┬─────────────────┬─────────────────┬──────────────────┐ │
│  │                 │                 │                 │                  │ │
│  ▼                 ▼                 ▼                 ▼                  │ │
│  ┌───────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐ │ │
│  │    LLM    │  │   Python     │  │  Strategy    │  │    Broker      │ │ │
│  │ Interface │  │  Predictor   │  │  Evaluator   │  │   Executor     │ │ │
│  │           │  │              │  │              │  │                │ │ │
│  │ llm.ts    │  │ pythonPred-  │  │ recognized-  │  │ capitalPool-   │ │ │
│  │           │  │ ictor.ts     │  │ Strategies.ts│  │ Broker.ts      │ │ │
│  └───────────┘  └──────────────┘  └──────────────┘  └────────────────┘ │ │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Detailed Integration Flow

### 1. Signal Generation Pipeline

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          SIGNAL GENERATION                               │
└─────────────────────────────────────────────────────────────────────────┘

Step 1: Technical Analysis
┌──────────────────────┐
│  buildTechSnapshot() │  ← CCXT Market Data
│                      │
│  • OHLCV data        │
│  • RSI, EMA, ATR     │
│  • Support/Resistance│
│  • Volume analysis   │
└──────────┬───────────┘
           │
           ▼
Step 2: Multi-Timeframe Analysis
┌──────────────────────────────────┐
│ computeMultiTimeframeDiagnostics()│
│                                   │
│ • 15m, 1h, 4h consensus           │
│ • Trend alignment score           │
│ • Bias: bullish/bearish/mixed     │
└──────────┬────────────────────────┘
           │
           ▼
Step 3: Python ML Prediction (Optional)
┌──────────────────────────┐       ┌────────────────────────┐
│  getPredictionSync()     │──────▶│  Python XGBoost        │
│                          │       │  predict_service.py    │
│  Features:               │       │                        │
│  • RSI, ATR, EMA         │       │  Returns:              │
│  • Trend, volume         │       │  • Decision (L/S/None) │
│  • Support/resistance    │       │  • Probabilities       │
│                          │◀──────│  • Confidence [0-1]    │
└──────────┬───────────────┘       └────────────────────────┘
           │
           ▼
Step 4: Strategy Evaluation
┌────────────────────────────────────┐
│ evaluateRecognizedStrategies()     │
│                                    │
│ Evaluates 4 strategy families:     │
│ • Classic Trend Following          │
│ • Breakout Retest                  │
│ • Bollinger Mean Reversion         │
│ • Momentum Scanner Focus           │
│                                    │
│ For each strategy:                 │
│ 1. Compute base score [0-1]        │
│ 2. Blend with Python confidence    │
│ 3. Apply penalties/guardrails      │
│ 4. Check confidence gate (≥0.72)   │
│ 5. Check entry eligibility (≥0.58) │
└────────────┬───────────────────────┘
             │
             ▼
┌────────────────────────────────────┐
│  Signals Ranked by Confidence      │
│                                    │
│  1. breakout_retest (0.85)         │
│  2. trend_following (0.78)         │
│  3. mean_reversion (0.65) [BLOCKED]│
└────────────────────────────────────┘
```

---

### 2. Trade Execution Pipeline

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         TRADE EXECUTION                                  │
└─────────────────────────────────────────────────────────────────────────┘

Step 1: Signal Selection
┌──────────────────────────┐
│ Select Best Signal       │
│ (highest confidence)     │
│                          │
│ Filter:                  │
│ • confidenceGatePassed   │
│ • entryEligibilityPassed │
│ • No position exists     │
└──────────┬───────────────┘
           │
           ▼
Step 2: Position Sizing
┌────────────────────────────────┐
│  PositionSizer.computeSize()   │
│                                │
│  Inputs:                       │
│  • Equity USD                  │
│  • Entry price                 │
│  • Stop distance (ATR-based)   │
│                                │
│  Output:                       │
│  • Quantity to trade           │
│  • Risk USD                    │
│  • R:R ratio                   │
└──────────┬─────────────────────┘
           │
           ▼
Step 3: Capital Reservation
┌────────────────────────────────────┐
│  CapitalPoolBroker.reserve()       │
│                                    │
│  • Check available capital         │
│  • Reserve margin (notional/lev)   │
│  • Atomically commit if successful │
│                                    │
│  If fails → reject order           │
└──────────┬─────────────────────────┘
           │
           ▼
Step 4: Order Placement
┌────────────────────────────────────┐
│  broker.place()                    │
│                                    │
│  • Type: market/limit              │
│  • Side: buy/sell                  │
│  • Qty: from sizing                │
│  • Stop-loss: entry ± ATR*mult     │
│  • Take-profit: multiple targets   │
│                                    │
│  With retry logic (3 attempts)     │
└──────────┬─────────────────────────┘
           │
           ▼
Step 5: Position Tracking
┌────────────────────────────────────┐
│  agent.pos = { ... }               │
│                                    │
│  • Entry price                     │
│  • Quantity                        │
│  • Stop-loss level                 │
│  • Target levels                   │
│  • Signal metadata                 │
│  • Open timestamp                  │
└────────────────────────────────────┘
```

---

### 3. Exit Management Pipeline

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           EXIT MANAGEMENT                                │
└─────────────────────────────────────────────────────────────────────────┘

Every Tick (for positions):
┌──────────────────────────────┐
│  maybeAdjustOrExit()         │
│                              │
│  Checks:                     │
│  1. Price vs stop-loss       │
│  2. Price vs take-profit     │
│  3. Time in position         │
│  4. Trailing stop conditions │
│  5. Breakeven conditions     │
└──────────┬───────────────────┘
           │
           ├──────────────┬──────────────┐
           │              │              │
           ▼              ▼              ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐
    │   EXIT   │   │ MOVE_SL  │   │   HOLD   │
    └────┬─────┘   └────┬─────┘   └──────────┘
         │              │
         │              │
         ▼              ▼
  ┌──────────────┐   ┌──────────────────────┐
  │ Execute Exit │   │ Update Stop Level    │
  │              │   │                      │
  │ • Market     │   │ • Trailing stop      │
  │   order      │   │ • Breakeven stop     │
  │ • ReduceOnly │   │                      │
  │ • Log P&L    │   └──────────────────────┘
  └──────────────┘

Exit Reasons:
• tp          - Take-profit hit
• sl          - Stop-loss hit
• trailing    - Trailing stop triggered
• timeout     - Max hold time exceeded
• predictor_blocked - Python predictor blocked continuation
```

---

## Error Flow & Fallback Chains

### LLM Strategy Generation

```
┌─────────────────────────────────────────────────────────────┐
│                    LLM FALLBACK CHAIN                        │
└─────────────────────────────────────────────────────────────┘

Primary Attempt:
┌──────────────────┐
│ OpenAI/Grok API  │
│ Call with prompt │
└────────┬─────────┘
         │
         ├────── Success ──────▶ Parse JSON ──▶ Return Strategy
         │
         ├────── Failure (timeout, API error, invalid JSON)
         │
         ▼
Fallback 1: Provider Switch
┌──────────────────────────┐
│ If Grok failed:          │
│   Try OpenAI             │
│ If OpenAI failed & Grok: │
│   Try Grok               │
└────────┬─────────────────┘
         │
         ├────── Success ──────▶ Parse JSON ──▶ Return Strategy
         │
         ├────── Failure (both providers failed)
         │
         ▼
Fallback 2: Rule-Based Strategy
┌────────────────────────────────────┐
│ generateStrategy() - orchestrator  │
│                                    │
│ Derives bias from technicals:      │
│ • Trend direction                  │
│ • RSI oversold/overbought          │
│ • SR bias (support/resistance)     │
│                                    │
│ Computes entry zone, stop, target  │
│ using ATR-based calculations       │
└────────────────────────────────────┘
         │
         ▼
    Always Returns Valid Strategy
```

### Python Predictor

```
┌─────────────────────────────────────────────────────────────┐
│               PYTHON PREDICTOR FALLBACK                      │
└─────────────────────────────────────────────────────────────┘

Primary Attempt:
┌──────────────────────────┐
│ Spawn Python process     │
│ Send features via stdin  │
│ Wait for JSON response   │
└────────┬─────────────────┘
         │
         ├────── Success ──────▶ Parse prediction ──▶ Return signal
         │
         ├────── Failure (timeout, spawn error, parse error)
         │
         ▼
Increment Failure Counter
┌────────────────────────────────────┐
│ pythonFailureCount++               │
│                                    │
│ If count >= 5:                     │
│   Log: "Python predictor failing   │
│         repeatedly - consider      │
│         disabling"                 │
└────────┬───────────────────────────┘
         │
         ▼
Fallback: Neutral Signal
┌────────────────────────────────────┐
│ Return:                            │
│ • decision: 'none'                 │
│ • bias: 'both'                     │
│ • probabilities: {                 │
│     long: 0.33,                    │
│     short: 0.33,                   │
│     none: 0.34                     │
│   }                                │
│ • confidence: 0.5                  │
└────────────────────────────────────┘
         │
         ▼
    Strategy evaluator proceeds
    (without ML bias)
```

### Broker Order Placement

```
┌─────────────────────────────────────────────────────────────┐
│                 BROKER EXECUTION RETRY                       │
└─────────────────────────────────────────────────────────────┘

Attempt 1:
┌──────────────────────────┐
│ broker.place(order)      │
└────────┬─────────────────┘
         │
         ├────── Success ──────▶ Order placed ──▶ Track position
         │
         ├────── Retryable Error (ETIMEDOUT, ECONNRESET)
         │
         ▼
Wait 500ms
┌──────────────────────────┐
│ Exponential backoff      │
└────────┬─────────────────┘
         │
         ▼
Attempt 2:
┌──────────────────────────┐
│ broker.place(order)      │
└────────┬─────────────────┘
         │
         ├────── Success ──────▶ Order placed ──▶ Track position
         │
         ├────── Retryable Error
         │
         ▼
Wait 1000ms
         │
         ▼
Attempt 3 (Final):
┌──────────────────────────┐
│ broker.place(order)      │
└────────┬─────────────────┘
         │
         ├────── Success ──────▶ Order placed ──▶ Track position
         │
         ├────── Any Error
         │
         ▼
Reject Order
┌────────────────────────────────────┐
│ • Log error with context           │
│ • Release capital reservation      │
│ • Alert if pattern detected        │
└────────────────────────────────────┘
```

---

## Logging Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      STRUCTURED LOGGING LAYERS                            │
└──────────────────────────────────────────────────────────────────────────┘

All Logs Include Context:
┌────────────────────────────────────────────────┐
│ [Component/Action] session=X symbol=Y | msg   │
│                                                │
│ Example:                                       │
│ [LLM/call] session=abc symbol=BTC | Calling   │
└────────────────────────────────────────────────┘

Integration Points:
┌─────────────────┬────────────────────────────────────────────┐
│ Component       │ Logged Events                              │
├─────────────────┼────────────────────────────────────────────┤
│ LLM             │ • Cache hit/miss                           │
│                 │ • Provider selection                       │
│                 │ • Call duration, tokens, cost              │
│                 │ • Fallback attempts                        │
│                 │ • Rate limit waits                         │
├─────────────────┼────────────────────────────────────────────┤
│ PythonPredictor │ • Executable resolution                    │
│                 │ • Prediction calls                         │
│                 │ • Results (decision, probabilities)        │
│                 │ • Failures with counter                    │
│                 │ • Timeouts                                 │
├─────────────────┼────────────────────────────────────────────┤
│ Orchestrator    │ • Tick start                               │
│                 │ • Signal evaluation                        │
│                 │ • Entry trades                             │
│                 │ • Exit trades                              │
│                 │ • Position sizing                          │
│                 │ • Broker balance                           │
├─────────────────┼────────────────────────────────────────────┤
│ Broker          │ • Capital reservation                      │
│                 │ • Order placement                          │
│                 │ • Order fills                              │
│                 │ • Rejections with reason                   │
│                 │ • Retries                                  │
└─────────────────┴────────────────────────────────────────────┘

Log Levels:
DEBUG  - Detailed trace (only if DEBUG=true)
INFO   - Normal operations, success
WARN   - Non-fatal issues, fallbacks
ERROR  - Failures, exceptions

Filtering:
# By session
grep "session=X" logs/

# By component
grep "\[LLM/" logs/

# By level
grep "ERROR" logs/
```

---

**This diagram provides a complete visual reference for understanding the meta-adaptive system architecture, data flows, error handling, and logging structure.**
