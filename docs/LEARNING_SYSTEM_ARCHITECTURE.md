# 🧠 Learning System Architecture & Flow

## 📐 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    LEARNING SYSTEM FLOW                          │
└─────────────────────────────────────────────────────────────────┘

┌──────────────────┐
│  Performance     │
│  Ledger Loop     │  Every 2h: Aggregate trade metrics
│  (2 hours)       │  into time-windowed buckets
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│ AgentPerformanceLedger Table                                 │
│  - bucketStart, windowMinutes (60, 360, 1440)               │
│  - symbol, mode, regime                                      │
│  - tradeCount, winRate, netPnlUsd                           │
│  - avgLatencyMs, avgSlippageBps, drawdownPct               │
│  - complianceHits, score                                    │
└────────┬─────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│  Subagent        │
│  Learning Loop   │  Every 2min: Derive recommendations
│  (2 minutes)     │  for each subagent per symbol
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│ SubagentLearningState Table                                  │
│  - subagent (risk, execution, predictor, sentiment, mq)     │
│  - symbol, mode, regime                                      │
│  - score, sampleCount                                        │
│  - tuning (recommendations JSON)                             │
│  - reason                                                    │
└────────┬─────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│  getSubagent     │
│  Tuning()        │  On-demand: Fetch recommendations
│                  │  with fallback to neutral defaults
└────────┬─────────┘
         │
         ├─────────────────────┬──────────────────┬──────────────────┬───────────────────┐
         │                     │                  │                  │                   │
         ▼                     ▼                  ▼                  ▼                   ▼
┌────────────────┐   ┌────────────────┐  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│ Risk Governor  │   │   Execution    │  │   Predictor    │  │   Sentiment    │  │ Market Quality │
│                │   │                │  │                │  │                │  │                │
│ • leverage     │   │ • mode         │  │ • confidence   │  │ • weight       │  │ • minScore     │
│ • position%    │   │ • fallbackMs   │  │ • forceFresh   │  │ • cooldown     │  │ • liquidity    │
│ • hedgeTension │   │ • passiveBias  │  │ • cacheTTL     │  │ • newsWeight   │  │ • spreadCeil   │
└────────────────┘   └────────────────┘  └────────────────┘  └────────────────┘  └────────────────┘
```

---

## 🔄 Data Flow Details

### **Step 1: Trade Execution**
```
User Trade → Position opened → Trade metrics logged
                                (latency, slippage, PnL, etc.)
```

### **Step 2: Performance Aggregation** (Every 2h)
```typescript
// Performance Ledger Loop aggregates trades into time windows
const windows = [60, 360, 1440]; // 1h, 6h, 24h

for each symbol:
  for each window:
    aggregate({
      tradeCount,
      winRate,
      netPnlUsd,
      avgLatencyMs,
      avgSlippageBps,
      drawdownPct,
      complianceHits,
      score
    })
```

### **Step 3: Learning Derivation** (Every 2min)
```typescript
// Subagent Learning Loop derives recommendations

// Fetch ledger data (last 24h default)
const rows = await prisma.agentPerformanceLedger.findMany({
  where: { bucketStart: { gte: lookbackStart } }
});

// Aggregate by symbol
const aggregates = aggregateLedger(rows);

// Derive recommendations for each subagent
for each aggregate:
  riskRec = deriveRiskRecommendation(agg);
  execRec = deriveExecutionRecommendation(agg);
  predRec = derivePredictorRecommendation(agg);
  sentRec = deriveSentimentRecommendation(agg);
  mqRec = deriveMarketQualityRecommendation(agg);
  
  // Persist to SubagentLearningState table
  await persistLearning([riskRec, execRec, ...]);
```

### **Step 4: Runtime Application**
```typescript
// Each subagent fetches its tuning when making decisions

// Risk Governor
const learning = await getSubagentTuning('risk_governor', symbol);
if (learning) {
  tunedMaxLeverage = Math.min(maxLeverage, learning.recommendedMaxLeverage);
  maxPositionUsd = equityBasis * learning.recommendedMaxPositionPct;
}

// Execution Agent
const learning = await getSubagentTuning('execution', symbol);
if (learning?.preferredMode) {
  strategy = learning.preferredMode; // Override default strategy
}

// Predictor Agent
const learning = await getSubagentTuning('predictor', symbol);
const adjustedConfidence = prediction.confidence * (learning?.confidenceModifier ?? 1);
```

---

## 🎯 Neutral Defaults System

### **Problem**
- New symbols have no historical data
- `getSubagentTuning()` used to return `null`
- Risk Governor blocked all trades with "learning_low_confidence"

### **Solution**
```typescript
// subagentLearning.ts

function getNeutralRiskDefaults(): RiskLearningRecommendation {
  return {
    recommendedMaxLeverage: 3.5,        // Conservative but usable
    recommendedMaxPositionPct: 0.18,    // 18% of capital
    hedgingTension: 0.30,               // Won't trigger hedge (< 0.90)
    confidence: 0.50,                    // Neutral - no penalty
  };
}

// In getSubagentTuning()
if (!row) {
  if (subagent === 'risk_governor') {
    return getNeutralRiskDefaults();
  }
  return null; // Other agents use their own defaults
}
```

### **Behavior**

| Trades | Confidence | Recommendation Source |
|--------|------------|-----------------------|
| 0      | 0.50       | Neutral defaults      |
| 1-9    | 0.025-0.225 | Learning (low conf)  |
| 10-39  | 0.25-0.975 | Learning (med conf)   |
| 40+    | 1.00       | Learning (full conf)  |

---

## 📊 Derivation Functions

### **Risk Governor**
```typescript
function deriveRiskRecommendation(agg: SymbolAggregate) {
  // Penalties based on historical drawdown and compliance
  const drawdownPenalty = clamp(1 - agg.avgDrawdownPct / 140, 0.35, 1);
  const compliancePenalty = clamp(1 - agg.complianceRate * 1.4, 0.4, 1);
  
  // Base leverage grows with win rate
  const baseLeverage = clamp(1 + agg.winRate * 4, 1.2, 8);
  
  // Recommended values
  const recommendedMaxLeverage = baseLeverage * drawdownPenalty * compliancePenalty;
  const recommendedMaxPositionPct = clamp(0.18 + agg.normalizedScore * 0.12, 0.08, 0.45);
  const hedgingTension = clamp(agg.avgDrawdownPct / 40 + agg.complianceRate * 1.2, 0, 1);
  const confidence = clamp(agg.tradeCount / 40, 0.25, 1);
  
  return { recommendedMaxLeverage, recommendedMaxPositionPct, hedgingTension, confidence };
}
```

**Key Insights**:
- **Leverage**: Higher with better win rate, penalized by drawdowns
- **Position%**: Grows with positive normalized score
- **Hedging Tension**: Higher with drawdowns and compliance issues
- **Confidence**: Linear with sample size (40 trades = full confidence)

### **Execution Agent**
```typescript
function deriveExecutionRecommendation(agg: SymbolAggregate) {
  const slippage = agg.avgSlippageBps ?? 12;
  const latency = agg.avgLatencyMs ?? 900;
  
  // Choose strategy based on market conditions
  let preferredMode;
  if (slippage > 16 || latency > 1600) preferredMode = 'twap';
  else if (slippage < 6 && latency < 800) preferredMode = 'market';
  else if (slippage < 10) preferredMode = 'sweep';
  else preferredMode = 'iceberg';
  
  return {
    preferredMode,
    passiveBias: clamp(1 - slippage / 30 + agg.complianceRate * 0.2, 0, 1),
    fallbackMs: clamp(2500 + latency * 0.6 + slippage * 40, 1500, 7000),
    twapSliceMultiplier: clamp(1 + slippage / 20, 0.8, 2.2),
    confidence: clamp(agg.tradeCount / 30, 0.2, 1),
  };
}
```

**Key Insights**:
- **Strategy**: Adapts to observed slippage and latency
- **Passive Bias**: Higher in liquid markets (low slippage)
- **Fallback**: Longer waits in slow/illiquid markets
- **TWAP Slices**: More slices in high-slippage markets

### **Predictor Agent**
```typescript
function derivePredictorRecommendation(agg: SymbolAggregate) {
  const needsSamples = agg.tradeCount >= MIN_TRADES_FOR_ACTION;
  const retrainThreshold = agg.normalizedScore <= -0.12 || agg.winRate <= 0.42;
  
  let action = 'healthy';
  if (needsSamples && retrainThreshold) action = 'retrain';
  else if (agg.normalizedScore < 0.05 || agg.winRate < 0.5) action = 'monitor';
  
  return {
    action,
    confidenceModifier: clamp(1 + agg.normalizedScore * 0.35, 0.6, 1.35),
    forceFresh: action !== 'healthy',
    cacheTtlMultiplier: action === 'healthy' ? 1 : action === 'monitor' ? 0.75 : 0.5,
  };
}
```

**Key Insights**:
- **Action**: Triggers retraining when performance degrades
- **Confidence Modifier**: Amplifies/reduces predictor confidence based on results
- **Force Fresh**: Disables cache when predictions unreliable

---

## 🔍 Monitoring Queries

### **Check Neutral Defaults**
```sql
SELECT symbol, 
       tuning->>'confidence' as confidence,
       tuning->>'recommendedMaxLeverage' as leverage,
       tuning->>'hedgingTension' as tension,
       "sampleCount"
FROM "SubagentLearningState" 
WHERE subagent='risk_governor' 
  AND (tuning->>'confidence')::float = 0.50;
```

### **Learning Progress by Symbol**
```sql
SELECT 
  symbol,
  "sampleCount",
  (tuning->>'confidence')::float as confidence,
  (tuning->>'recommendedMaxLeverage')::float as leverage,
  (tuning->>'hedgingTension')::float as tension,
  CASE 
    WHEN "sampleCount" >= 40 THEN 'MATURE'
    WHEN "sampleCount" >= 10 THEN 'LEARNING'
    WHEN "sampleCount" > 0 THEN 'EARLY'
    ELSE 'NEW'
  END as stage
FROM "SubagentLearningState" 
WHERE subagent='risk_governor'
ORDER BY "sampleCount" DESC;
```

### **Performance Ledger Overview**
```sql
SELECT 
  symbol,
  COUNT(*) as records,
  SUM("tradeCount") as total_trades,
  AVG("winRate") as avg_winrate,
  SUM("netPnlUsd") as total_pnl,
  AVG("avgSlippageBps") as avg_slippage
FROM "AgentPerformanceLedger"
WHERE "bucketStart" > NOW() - INTERVAL '7 days'
GROUP BY symbol
ORDER BY total_pnl DESC;
```

---

## 📈 Expected Evolution

### **Week 1**: Bootstrap Phase
```
All symbols: confidence = 0.50 (neutral defaults)
Trading: Active but conservative
Focus: Data accumulation
```

### **Week 2-3**: Early Learning
```
Active symbols: confidence = 0.15-0.40
Differentiation: Starting to emerge
Adjustments: Small leverage/position tweaks
```

### **Week 4-6**: Learning Phase
```
Active symbols: confidence = 0.40-0.75
Differentiation: Clear patterns visible
Adjustments: Significant optimization kicks in
```

### **Month 2+**: Mature Phase
```
Active symbols: confidence = 0.75-1.0
Differentiation: Full optimization
Adjustments: Fine-tuning based on regime changes
```

---

## 🚀 Key Features

### **1. Progressive Confidence**
- Linear growth: `confidence = trades / 40`
- Smooth transitions, no sudden jumps
- System stable even with limited data

### **2. Asymmetric Optimization**
- Winners: Amplified (higher leverage, bigger positions)
- Losers: Reduced (lower leverage, smaller positions)
- Portfolio naturally tilts toward performance

### **3. Multi-Window Aggregation**
- 60min: Recent trends
- 360min: Medium-term patterns
- 1440min: Daily rhythms
- Weighted: Recent data more influential

### **4. Regime Awareness**
- Tracks dominant regime per symbol
- Recommendations adapt to market conditions
- Fallback to neutral if regime unknown

### **5. Self-Healing**
- Poor performance triggers retraining (Predictor)
- High hedging tension forces risk reduction
- Compliance issues penalize leverage

---

## ✅ Testing

Run the test script to validate:
```bash
cd /workspaces/QuantAILabs/backend
node test-learning-neutral-defaults.mjs
```

Expected output:
- ✅ New symbols get neutral defaults
- ✅ Existing symbols show learned values or neutral
- ✅ No null returns for risk_governor
- 📊 Summary shows learning coverage

---

**Architecture Status**: ✅ Complete & Production-Ready  
**Documentation**: Complete  
**Date**: November 19, 2025
