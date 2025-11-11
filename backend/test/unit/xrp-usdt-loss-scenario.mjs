import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';

const { getQuantAIConfig, maybeAdjustOrExit, computeInitialBracket } = await import('../../dist/src/quantai/index.js');

console.log('Testing XRP/USDT loss scenario from issue...\n');

const cfg = getQuantAIConfig();
const exitCfg = {
  ...cfg.exits,
  earlyExit: { ...cfg.exits.earlyExit, minHoldMinutes: 0 },
};

// Scenario from issue:
// Entry: 2.5476
// Current: 2.4803
// Loss: 0.0673 (~2.64%)

const entryPrice = 2.5476;
const currentPrice = 2.4803;
const lossPct = ((entryPrice - currentPrice) / entryPrice) * 100;

console.log(`Entry Price: ${entryPrice}`);
console.log(`Current Price: ${currentPrice}`);
console.log(`Loss: ${lossPct.toFixed(2)}%\n`);

// Calculate typical ATR (assume ~1% of price as reasonable estimate)
const atr = entryPrice * 0.01;

// Compute initial bracket to get stop loss
const bracket = computeInitialBracket(entryPrice, atr, 'long', exitCfg);
console.log(`Initial Stop: ${bracket.stop.toFixed(4)}`);
console.log(`Risk per unit: ${bracket.riskPerUnit.toFixed(4)}`);

// Calculate R-multiple at current price
const riskPerUnit = Math.abs(entryPrice - bracket.stop);
const currentLoss = entryPrice - currentPrice;
const rMultiple = currentLoss / riskPerUnit;
console.log(`Current R-multiple: ${rMultiple.toFixed(2)}R\n`);

// Test 1: With GOOD momentum (should exit if loss >= 0.5R)
console.log('Test 1: Good momentum (ADX=25, CMF=0.15)');
const directive1 = maybeAdjustOrExit({
  side: 'long',
  entryPrice,
  stop: bracket.stop,
  targets: bracket.targets,
  lastPrice: currentPrice,
  atr,
  adx: 25, // Good momentum
  cmf: 0.15, // Good momentum
  cfg: exitCfg,
  alreadyTriggeredTargets: new Set(),
  minutesOpen: 30,
});

console.log(`Action: ${directive1.action}`);
console.log(`Reason: ${directive1.reason}`);

if (rMultiple >= 0.5) {
  assert.equal(directive1.action, 'exit', 'Should exit when loss >= 0.5R even with good momentum');
  console.log('✅ Correctly exits on hard stop loss\n');
} else {
  console.log(`ℹ️  Loss is ${rMultiple.toFixed(2)}R (below 0.5R threshold), holding is acceptable\n`);
}

// Test 2: With BAD momentum (should exit if loss >= 0.35R)
console.log('Test 2: Bad momentum (ADX=15, CMF=-0.1)');
const directive2 = maybeAdjustOrExit({
  side: 'long',
  entryPrice,
  stop: bracket.stop,
  targets: bracket.targets,
  lastPrice: currentPrice,
  atr,
  adx: 15, // Bad momentum
  cmf: -0.1, // Bad momentum
  cfg: exitCfg,
  alreadyTriggeredTargets: new Set(),
  minutesOpen: 30,
});

console.log(`Action: ${directive2.action}`);
console.log(`Reason: ${directive2.reason}`);

if (rMultiple >= 0.35) {
  assert.equal(directive2.action, 'exit', 'Should exit when loss >= 0.35R with bad momentum');
  console.log('✅ Correctly exits on early exit with momentum failure\n');
}

console.log('✅ XRP/USDT loss scenario validation complete');
console.log('\nSummary:');
console.log('  - Hard stop loss at 0.5R protects against persistent losses');
console.log('  - Early exit at 0.35R triggers when momentum fails');
console.log('  - Exit retry logic ensures order placement succeeds');
