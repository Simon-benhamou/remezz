# 🎯 Integration Guide: Entry & Exit Subagents

## Overview

This guide explains how to integrate the **Entry Timing Agent** and **Exit Strategy Agent** into the Meta-Adaptive Orchestrator for production use.

## Current Status

✅ **COMPLETED**:
- Entry Timing Agent (`entryTimingAgent.ts`) - Analyzes optimal entry timing
- Exit Strategy Agent (`exitStrategyAgent.ts`) - Manages partial exits and trailing stops
- Learning system integration (`subagentLearning.ts`) - Derives recommendations from performance
- Correlation Manager (`correlationManager.ts`) - Prevents over-concentration

🔄 **PENDING**:
- Integration into orchestrator entry flow
- Integration into orchestrator exit flow
- Testing with real trading scenarios

---

## 1️⃣ Entry Timing Integration

### Where to Integrate

**File**: `/backend/src/services/metaAdaptiveOrchestrator.ts`  
**Function**: `executeEntryTrade()` (around line 850-1100)

### Step 1: Import the Agent

```typescript
import { getEntryTimingAgent } from '../agent/subagents/entryTimingAgent.js';
import { getSubagentTuning } from './subagentLearning.js';
```

### Step 2: Get Entry Timing Recommendation (BEFORE Entry Execution)

Add this code **AFTER** the support scale calculation and **BEFORE** the actual trade execution:

```typescript
// Location: Around line 1025, after correlation constraints
// IMPROVEMENT: Apply entry timing learning
const entryTimingAgent = getEntryTimingAgent();

// Get learned preferences if available
const entryTimingLearning = await getSubagentTuning(
  'entry_timing',
  session.symbol,
  { mode: session.mode }
).catch(() => null);

// Evaluate current market conditions
const entryTiming = await entryTimingAgent.evaluateEntryTiming(
  session.symbol,
  tech,
  signal.confidence,
  entryTimingLearning
);

integrationLogger.info(
  `Entry timing evaluation | action=${entryTiming.action} aggr=${entryTiming.aggressiveness.toFixed(2)}x confidence=${entryTiming.confidence.toFixed(2)} offset=${entryTiming.optimalEntryOffset}bps`,
  { symbol: session.symbol, action: entryTiming.action }
);

// Handle wait actions
if (entryTiming.action === 'wait_pullback') {
  integrationLogger.info(
    `Waiting for pullback of ${entryTiming.optimalEntryOffset}bps before entry`,
    { symbol: session.symbol, currentPrice: tech.last }
  );
  // Store intent to enter after pullback
  agentMemoryStore.update('pendingEntryTiming', session.sessionId, {
    action: 'wait_pullback',
    targetOffset: entryTiming.optimalEntryOffset,
    originalPrice: tech.last,
    expiresAt: Date.now() + 300_000, // 5 minutes
  });
  return; // Don't enter yet
}

if (entryTiming.action === 'wait_confirmation') {
  integrationLogger.info(
    'Waiting for confirmation bars before entry',
    { symbol: session.symbol, barsNeeded: 2 }
  );
  // Store intent to enter after confirmation
  agentMemoryStore.update('pendingEntryTiming', session.sessionId, {
    action: 'wait_confirmation',
    confirmationBarsNeeded: 2,
    currentBars: 0,
    expiresAt: Date.now() + 600_000, // 10 minutes
  });
  return; // Don't enter yet
}

// Apply aggressiveness multiplier to position size
maxPositionMargin = maxPositionMargin * entryTiming.aggressiveness;

integrationLogger.info(
  `Entry timing: immediate entry with aggressiveness=${entryTiming.aggressiveness.toFixed(2)}x | adjusted_margin=$${maxPositionMargin.toFixed(0)}`,
  { symbol: session.symbol }
);
```

### Step 3: Handle Pending Entry Timing (in Decision Loop)

Add to the main orchestrator loop to check for pending entry timing:

```typescript
// Location: In the main loop, before executeEntryTrade call
const pendingTiming = agentMemoryStore.get<any>('pendingEntryTiming', session.sessionId)?.data;

if (pendingTiming) {
  const now = Date.now();
  
  // Check expiration
  if (now > pendingTiming.expiresAt) {
    agentMemoryStore.delete('pendingEntryTiming', session.sessionId);
    integrationLogger.info('Entry timing intent expired', { symbol: session.symbol });
  } else if (pendingTiming.action === 'wait_pullback') {
    // Check if we got the pullback
    const currentPrice = tech.last;
    const priceDiffBps = ((currentPrice - pendingTiming.originalPrice) / pendingTiming.originalPrice) * 10000;
    
    if (Math.abs(priceDiffBps) >= Math.abs(pendingTiming.targetOffset)) {
      integrationLogger.info(
        `Pullback achieved: ${priceDiffBps.toFixed(1)}bps >= ${pendingTiming.targetOffset}bps - proceeding with entry`,
        { symbol: session.symbol }
      );
      agentMemoryStore.delete('pendingEntryTiming', session.sessionId);
      // Continue to entry execution...
    } else {
      // Still waiting
      return;
    }
  } else if (pendingTiming.action === 'wait_confirmation') {
    // Check for confirmation bars (simplified - needs proper implementation)
    // TODO: Track bar closes and count confirmations
    pendingTiming.currentBars += 1;
    agentMemoryStore.update('pendingEntryTiming', session.sessionId, pendingTiming);
    
    if (pendingTiming.currentBars >= pendingTiming.confirmationBarsNeeded) {
      integrationLogger.info(
        'Confirmation bars complete - proceeding with entry',
        { symbol: session.symbol, bars: pendingTiming.currentBars }
      );
      agentMemoryStore.delete('pendingEntryTiming', session.sessionId);
      // Continue to entry execution...
    } else {
      // Still waiting
      return;
    }
  }
}
```

---

## 2️⃣ Exit Strategy Integration

### Where to Integrate

**File**: `/backend/src/services/metaAdaptiveOrchestrator.ts`  
**Function**: `checkAndExecuteExit()` (around line 1200-1400)

### Step 1: Import the Agent

```typescript
import { getExitStrategyAgent } from '../agent/subagents/exitStrategyAgent.js';
```

### Step 2: Generate Exit Strategy (At Position Open)

Add this when opening a position:

```typescript
// Location: After successful entry execution
const exitStrategyAgent = getExitStrategyAgent();

// Get learned preferences
const exitStrategyLearning = await getSubagentTuning(
  'exit_strategy',
  session.symbol,
  { mode: session.mode }
).catch(() => null);

const volatility = (tech.atr14 / tech.last) * 100;

// Generate exit strategy for this position
const exitStrategy = await exitStrategyAgent.generateExitStrategy(
  session.symbol,
  tech,
  0, // Initial R-multiple
  0, // Just opened
  volatility,
  exitStrategyLearning
);

// Store strategy with position
agentMemoryStore.update('exitStrategy', session.sessionId, {
  strategy: exitStrategy,
  entryPrice: position.entryPrice,
  initialStop: position.stopPrice,
  rMultipleAtEntry: 0,
  exitedPct: 0,
});

integrationLogger.info(
  `Exit strategy set | first_exit=${exitStrategy.scaleOutPlan[0].rMultiple}R/${(exitStrategy.scaleOutPlan[0].exitPct * 100).toFixed(0)}% trail=${exitStrategy.trailingStopAtrMultiplier}xATR max_hold=${exitStrategy.maxHoldTimeMs / 3600000}h`,
  { symbol: session.symbol }
);
```

### Step 3: Apply Exit Strategy (During Position Monitoring)

Add to the position monitoring loop:

```typescript
// Location: In checkAndExecuteExit(), before standard exit checks
const exitStrategyData = agentMemoryStore.get<any>('exitStrategy', session.sessionId)?.data;

if (!exitStrategyData) {
  // No strategy stored, use standard exits
  return;
}

const exitStrategyAgent = getExitStrategyAgent();
const exitStrategy = exitStrategyData.strategy;
const entryPrice = exitStrategyData.entryPrice;
const initialStop = exitStrategyData.initialStop;
const currentPrice = tech.last;
const timeInPosition = Date.now() - (position.openedAt?.getTime() ?? Date.now());

// Calculate current R-multiple
const riskPerUnit = Math.abs(entryPrice - initialStop);
const currentR = position.side === 'long'
  ? (currentPrice - entryPrice) / riskPerUnit
  : (entryPrice - currentPrice) / riskPerUnit;

// Check for partial exits
const partialExit = exitStrategyAgent.shouldTakePartialProfit(
  currentR,
  exitStrategy,
  exitStrategyData.exitedPct
);

if (partialExit.shouldExit) {
  integrationLogger.info(
    `🎯 Partial exit triggered | R=${currentR.toFixed(2)} exit=${(partialExit.exitPct * 100).toFixed(0)}% reason=${partialExit.reason}`,
    { symbol: session.symbol }
  );
  
  // Execute partial exit
  const exitQty = Math.abs(position.qty ?? 0) * partialExit.exitPct;
  
  try {
    await agentServices.execution.closePosition({
      session,
      reason: partialExit.reason,
      exitStrategy: executionPlan.strategy,
      qty: exitQty, // Partial quantity
    });
    
    // Update exited percentage
    exitStrategyData.exitedPct += partialExit.exitPct;
    agentMemoryStore.update('exitStrategy', session.sessionId, exitStrategyData);
    
    integrationLogger.info(
      `✅ Partial exit executed | qty=${exitQty.toFixed(4)} total_exited=${(exitStrategyData.exitedPct * 100).toFixed(0)}%`,
      { symbol: session.symbol }
    );
    
    return; // Exit processed
  } catch (error) {
    integrationLogger.error('Failed to execute partial exit', { error, symbol: session.symbol });
  }
}

// Check for profit locking (tighten stop)
const lockProfit = exitStrategyAgent.shouldLockProfits(
  currentR,
  exitStrategy,
  position.stopPrice ? Math.abs(currentPrice - position.stopPrice) : null
);

if (lockProfit.shouldTighten) {
  const newStop = position.side === 'long'
    ? currentPrice - lockProfit.newStopDistance
    : currentPrice + lockProfit.newStopDistance;
  
  integrationLogger.info(
    `🔒 Locking profits | R=${currentR.toFixed(2)} old_stop=${position.stopPrice?.toFixed(4)} new_stop=${newStop.toFixed(4)} reason=${lockProfit.reason}`,
    { symbol: session.symbol }
  );
  
  try {
    // Update stop loss order
    await updateProtectiveStop(session, position, newStop);
    
    integrationLogger.info(
      `✅ Stop tightened to lock profits`,
      { symbol: session.symbol, newStop }
    );
  } catch (error) {
    integrationLogger.error('Failed to tighten stop', { error, symbol: session.symbol });
  }
}

// Check max hold time
if (timeInPosition > exitStrategy.maxHoldTimeMs) {
  integrationLogger.info(
    `⏰ Max hold time exceeded | held=${(timeInPosition / 3600000).toFixed(1)}h max=${(exitStrategy.maxHoldTimeMs / 3600000).toFixed(1)}h - closing position`,
    { symbol: session.symbol }
  );
  
  await agentServices.execution.closePosition({
    session,
    reason: 'max_hold_time_exceeded',
    exitStrategy: executionPlan.strategy,
  });
  
  return;
}

// Apply adaptive trailing stop
if (currentR >= exitStrategy.trailingStopActivationR) {
  const trailingStop = position.side === 'long'
    ? currentPrice - (tech.atr14 * exitStrategy.trailingStopAtrMultiplier)
    : currentPrice + (tech.atr14 * exitStrategy.trailingStopAtrMultiplier);
  
  // Only update if new trailing stop is better than current stop
  const shouldUpdate = position.side === 'long'
    ? trailingStop > (position.stopPrice ?? -Infinity)
    : trailingStop < (position.stopPrice ?? Infinity);
  
  if (shouldUpdate) {
    integrationLogger.info(
      `📈 Trailing stop update | R=${currentR.toFixed(2)} new_stop=${trailingStop.toFixed(4)} ATR_mult=${exitStrategy.trailingStopAtrMultiplier}`,
      { symbol: session.symbol }
    );
    
    try {
      await updateProtectiveStop(session, position, trailingStop);
    } catch (error) {
      integrationLogger.error('Failed to update trailing stop', { error, symbol: session.symbol });
    }
  }
}
```

---

## 3️⃣ Testing Plan

### Phase 1: Unit Testing (1 week)

Test individual components in isolation:

```bash
# Test entry timing evaluation
node backend/test-entry-timing.mjs

# Test exit strategy generation
node backend/test-exit-strategy.mjs

# Test learning derivation
node backend/test-learning-derivation.mjs
```

### Phase 2: Integration Testing (1-2 weeks)

Run in paper trading mode:

```bash
# Enable paper trading for specific symbols
curl -X POST http://localhost:5000/api/agent/session/start \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "BTCUSDT",
    "mode": "paper",
    "profileJson": {
      "maxLeverage": 5,
      "useEntryTiming": true,
      "useExitStrategy": true
    }
  }'
```

Monitor metrics:
- Entry timing actions distribution (immediate/pullback/confirmation)
- Partial exit execution rate
- Average R-multiple at exits
- Trailing stop effectiveness

### Phase 3: A/B Testing (2-3 weeks)

Compare performance with/without new subagents:

| Metric | Without Subagents | With Subagents | Improvement |
|--------|------------------|----------------|-------------|
| Win Rate | 54-58% | Target: 58-63% | +4-5% |
| Avg R-Multiple | 1.8-2.2 | Target: 2.5-3.5 | +35-59% |
| Max Drawdown | -8% | Target: -6% | -25% |
| Monthly Return | +8-12% | Target: +13-20% | +50-67% |

---

## 4️⃣ Configuration Options

Add to session `profileJson`:

```typescript
{
  "maxLeverage": 8,
  "maxPositionPct": 0.25,
  
  // Entry Timing
  "useEntryTiming": true,
  "entryTimingPreference": "learned", // "learned" | "immediate" | "cautious"
  
  // Exit Strategy
  "useExitStrategy": true,
  "partialExitsEnabled": true,
  "scaleOutPlan": "learned", // "learned" | "aggressive" | "conservative"
  "trailingStopEnabled": true,
  
  // Override learned values (optional)
  "forceAggressiveness": null, // 0.5-1.5 or null for learned
  "forceFirstExitR": null,     // R-multiple or null for learned
}
```

---

## 5️⃣ Monitoring & Observability

### Logs to Watch

```bash
# Entry timing decisions
grep "Entry timing evaluation" logs/integration.log

# Partial exits
grep "Partial exit triggered" logs/integration.log

# Profit locking
grep "Locking profits" logs/integration.log

# Trailing stops
grep "Trailing stop update" logs/integration.log
```

### Metrics to Track

1. **Entry Timing Performance**:
   - Immediate vs waited entries
   - Average entry price improvement
   - Win rate by entry timing action

2. **Exit Strategy Performance**:
   - Partial exit R-multiples achieved
   - % of positions exiting in profit
   - Average holding time
   - Trailing stop captures

3. **Learning System**:
   - Confidence scores over time
   - Learning recommendation stability
   - Sample size per symbol

---

## 6️⃣ Rollback Plan

If issues occur:

```typescript
// Disable in profileJson
{
  "useEntryTiming": false,
  "useExitStrategy": false
}

// Or add feature flag
if (process.env.ENTRY_TIMING_ENABLED !== 'true') {
  // Skip entry timing logic
}

if (process.env.EXIT_STRATEGY_ENABLED !== 'true') {
  // Skip exit strategy logic
}
```

---

## 7️⃣ Expected Timeline

- **Week 1**: Integration code complete + unit tests
- **Week 2-3**: Paper trading validation
- **Week 4-5**: A/B testing with live data
- **Week 6**: Full production rollout if metrics hit targets

**Success Criteria**:
- ✅ Win rate improvement +3% or more
- ✅ Average R-multiple improvement +0.5 or more
- ✅ Max drawdown reduction -1% or more
- ✅ No increase in execution errors
- ✅ Learning confidence > 0.7 for top symbols

---

## 📊 Current Implementation Status

```
✅ Backend Logic:
   ✅ entryTimingAgent.ts       - Complete
   ✅ exitStrategyAgent.ts       - Complete
   ✅ correlationManager.ts      - Complete
   ✅ subagentLearning.ts        - Integrated

🔄 Orchestrator Integration:
   ⏳ Entry timing flow          - Pending
   ⏳ Exit strategy flow          - Pending
   ⏳ Pending entry handling      - Pending
   ⏳ Partial exit execution      - Pending

⏳ Testing:
   ⏳ Unit tests                  - Pending
   ⏳ Integration tests            - Pending
   ⏳ A/B testing                  - Pending

⏳ Production:
   ⏳ Feature flags                - Pending
   ⏳ Monitoring dashboards        - Pending
   ⏳ Rollout plan                 - Pending
```

---

**Next Steps**: Implement orchestrator integration following this guide, then proceed to testing phase.

**Estimated Impact**: +50-67% return improvement, -25% drawdown reduction after full rollout and learning phase.

**Date**: November 19, 2025  
**Version**: v2.0 Integration Guide
