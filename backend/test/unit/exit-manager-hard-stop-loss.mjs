import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';

const { getQuantAIConfig, maybeAdjustOrExit } = await import('../../dist/src/quantai/index.js');

const cfg = getQuantAIConfig();
const exitCfg = {
  ...cfg.exits,
  earlyExit: { ...cfg.exits.earlyExit, minHoldMinutes: 0 },
};

console.log('Testing hard stop loss at 0.5R without momentum failure...');

// Test 1: Loss of 0.5R with GOOD momentum should still trigger exit
const directive1 = maybeAdjustOrExit({
  side: 'long',
  entryPrice: 100,
  stop: 95,
  targets: [120, 130, 140],
  lastPrice: 97.5, // 0.5R loss
  atr: 2,
  adx: 25, // GOOD momentum (>18)
  cmf: 0.15, // GOOD momentum (>0)
  cfg: exitCfg,
  alreadyTriggeredTargets: new Set(),
  minutesOpen: 5,
});

assert.equal(directive1.action, 'exit', 'Loss of 0.5R should trigger exit even with good momentum');
assert.match(directive1.reason, /hard stop loss/i, 'Reason should mention hard stop loss');
console.log('✅ Test 1 passed: 0.5R loss exits with good momentum');

// Test 2: Loss of 0.6R with GOOD momentum should also trigger exit
const directive2 = maybeAdjustOrExit({
  side: 'long',
  entryPrice: 100,
  stop: 95,
  targets: [120, 130, 140],
  lastPrice: 97, // 0.6R loss
  atr: 2,
  adx: 30, // STRONG momentum
  cmf: 0.25, // STRONG momentum
  cfg: exitCfg,
  alreadyTriggeredTargets: new Set(),
  minutesOpen: 10,
});

assert.equal(directive2.action, 'exit', 'Loss of 0.6R should trigger exit even with strong momentum');
assert.match(directive2.reason, /hard stop loss/i, 'Reason should mention hard stop loss');
console.log('✅ Test 2 passed: 0.6R loss exits with strong momentum');

// Test 3: Loss of 0.4R with GOOD momentum should NOT trigger hard stop (below 0.5R threshold)
const directive3 = maybeAdjustOrExit({
  side: 'long',
  entryPrice: 100,
  stop: 95,
  targets: [120, 130, 140],
  lastPrice: 98, // 0.4R loss
  atr: 2,
  adx: 25, // GOOD momentum
  cmf: 0.15, // GOOD momentum
  cfg: exitCfg,
  alreadyTriggeredTargets: new Set(),
  minutesOpen: 5,
});

assert.equal(directive3.action, 'hold', 'Loss of 0.4R with good momentum should hold (below 0.5R threshold)');
console.log('✅ Test 3 passed: 0.4R loss holds with good momentum');

// Test 4: Loss of 0.35R with BAD momentum should trigger early exit (existing behavior)
const directive4 = maybeAdjustOrExit({
  side: 'long',
  entryPrice: 100,
  stop: 95,
  targets: [120, 130, 140],
  lastPrice: 98.25, // 0.35R loss
  atr: 2,
  adx: 10, // BAD momentum (<18)
  cmf: -0.1, // BAD momentum (<0)
  cfg: exitCfg,
  alreadyTriggeredTargets: new Set(),
  minutesOpen: 5,
});

assert.equal(directive4.action, 'exit', 'Loss of 0.35R with bad momentum should trigger early exit');
assert.match(directive4.reason, /early exit/i, 'Reason should mention early exit');
console.log('✅ Test 4 passed: 0.35R loss with bad momentum exits (early exit)');

// Test 5: SHORT position with 0.5R loss and good momentum should exit
const directive5 = maybeAdjustOrExit({
  side: 'short',
  entryPrice: 100,
  stop: 105,
  targets: [80, 70, 60],
  lastPrice: 102.5, // 0.5R loss for short
  atr: 2,
  adx: 25, // GOOD momentum
  cmf: 0.15, // GOOD momentum
  cfg: exitCfg,
  alreadyTriggeredTargets: new Set(),
  minutesOpen: 5,
});

assert.equal(directive5.action, 'exit', 'SHORT: 0.5R loss should trigger exit even with good momentum');
assert.match(directive5.reason, /hard stop loss/i, 'Reason should mention hard stop loss');
console.log('✅ Test 5 passed: SHORT position 0.5R loss exits with good momentum');

console.log('\n✅ All hard stop loss tests passed');
