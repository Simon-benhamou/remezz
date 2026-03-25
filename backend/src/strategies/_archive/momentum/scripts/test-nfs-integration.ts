/**
 * Test NFS Integration
 * ====================
 * Quick test to verify NFS calculator and state machine work correctly.
 */

import {
  NfsCalculator,
  NfsExitStateMachine,
  createNfsExitSystem,
  type NfsConfig,
  type NfsResult,
  type Candle,
} from '../src/services/nfsRealtimeExit.js';

// Test candles - simulate a trailing breach scenario
const testCandles: Candle[] = [];
const basePrice = 100;
const baseTimestamp = Date.now() - 30 * 60 * 1000; // 30 minutes ago

// Generate 25 candles with a downtrend (for long position breach)
for (let i = 0; i < 25; i++) {
  const price = basePrice - i * 0.2; // Slow decline
  const volatility = 0.3;
  testCandles.push({
    timestamp: baseTimestamp + i * 60 * 1000,
    open: price + Math.random() * volatility,
    high: price + volatility,
    low: price - volatility,
    close: price,
    volume: 1000 + Math.random() * 500,
    isFinal: true,
  });
}

// Current candle - significant breach
const currentCandle: Candle = {
  timestamp: Date.now(),
  open: 95.5,
  high: 95.8,
  low: 94.0,  // Strong breach below trailing
  close: 94.2, // Close also below trailing
  volume: 2500, // High volume
  isFinal: true,
};

// Trailing stop at 95.0 (we're below it)
const trailingStopPrice = 95.0;
const side = 'long' as const;

console.log('═══════════════════════════════════════════════════════════════');
console.log('NFS Integration Test');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`\nTest Setup:`);
console.log(`  - Side: ${side}`);
console.log(`  - Trailing Stop: $${trailingStopPrice}`);
console.log(`  - Current Close: $${currentCandle.close}`);
console.log(`  - Breach Depth: $${(trailingStopPrice - currentCandle.close).toFixed(4)} (${((trailingStopPrice - currentCandle.close) / trailingStopPrice * 100).toFixed(2)}%)`);
console.log(`  - Volume: ${currentCandle.volume}`);
console.log(`  - Candle Range: $${(currentCandle.high - currentCandle.low).toFixed(4)}`);

// Test NfsCalculator directly
console.log('\n--- Testing NfsCalculator ---');
const calculator = new NfsCalculator();
const nfsResult = calculator.calculate(
  currentCandle,
  testCandles,
  side,
  trailingStopPrice
);

console.log(`\nNFS Result:`);
console.log(`  - Score: ${nfsResult.score.toFixed(1)}/100`);
console.log(`  - Confidence: ${nfsResult.confidence}`);
console.log(`  - Should Exit Immediately: ${nfsResult.shouldExitImmediately}`);
console.log(`  - Recommendation: ${nfsResult.recommendation}`);

console.log(`\nNFS Components:`);
console.log(`  - Breach/ATR Ratio: ${nfsResult.components.breachATRRatio.toFixed(3)}`);
console.log(`  - Breach Depth: ${nfsResult.components.breachDepthPct.toFixed(3)}%`);
console.log(`  - Volume Ratio: ${nfsResult.components.volumeRatio.toFixed(2)}x`);
console.log(`  - Candle Body Ratio: ${nfsResult.components.candleBodyRatio.toFixed(2)}`);
console.log(`  - Momentum ROC5: ${nfsResult.components.momentumROC5.toFixed(3)}%`);

// Test State Machine
console.log('\n--- Testing NfsExitStateMachine ---');
const { stateMachine } = createNfsExitSystem(
  {},
  (oldState, newState) => {
    console.log(`  State transition: ${oldState} → ${newState}`);
  }
);

console.log(`\nInitial state: ${stateMachine.getCurrentState()}`);

// Simulate price approaching and then breaching
const evalResult = stateMachine.evaluate(
  currentCandle.close, // current price
  currentCandle,       // current candle
  testCandles,         // previous candles
  side,
  trailingStopPrice,
  100,                 // HWM
  90                   // LWM
);

console.log(`\nEvaluation Result:`);
console.log(`  - Action: ${evalResult.action}`);
console.log(`  - Reason: ${evalResult.reason}`);
if (evalResult.nfsResult) {
  console.log(`  - NFS Score: ${evalResult.nfsResult.score.toFixed(1)}`);
}
if (evalResult.targetPrice) {
  console.log(`  - Target Price: $${evalResult.targetPrice.toFixed(4)}`);
}

console.log(`\nFinal state: ${stateMachine.getCurrentState()}`);

// Test LOW confidence scenario
console.log('\n--- Testing LOW Confidence Scenario ---');
const lowConfidenceCandle: Candle = {
  timestamp: Date.now(),
  open: 94.95,
  high: 95.1,
  low: 94.85,  // Barely below trailing (wick)
  close: 94.98, // Close just above breach
  volume: 800,  // Low volume
  isFinal: true,
};

const lowNfsResult = calculator.calculate(
  lowConfidenceCandle,
  testCandles,
  side,
  trailingStopPrice
);

console.log(`\nLow Confidence Result:`);
console.log(`  - Score: ${lowNfsResult.score.toFixed(1)}/100`);
console.log(`  - Confidence: ${lowNfsResult.confidence}`);
console.log(`  - Should Exit Immediately: ${lowNfsResult.shouldExitImmediately}`);
console.log(`  - Recommendation: ${lowNfsResult.recommendation}`);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('✅ NFS Integration Test Complete');
console.log('═══════════════════════════════════════════════════════════════');
