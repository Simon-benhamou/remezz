import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';

const { getQuantAIConfig, maybeAdjustOrExit } = await import('../../dist/src/quantai/index.js');

const cfg = getQuantAIConfig();
const exitCfg = {
  ...cfg.exits,
  earlyExit: { ...cfg.exits.earlyExit },
  maxHoldingMin: 5,
};

exitCfg.earlyExit.minHoldMinutes = 3;

const baseParams = {
  side: 'long',
  entryPrice: 100,
  stop: 95,
  targets: [110],
  atr: 2,
  adx: 25,
  cmf: 0.2,
  cfg: exitCfg,
  alreadyTriggeredTargets: new Set(),
  minutesOpen: 6,
};

const holdDirective = maybeAdjustOrExit({
  ...baseParams,
  lastPrice: 99,
});

assert.equal(holdDirective.action, 'hold', 'Should keep holding when drawdown is within tolerance after time stop');

const exitDirective = maybeAdjustOrExit({
  ...baseParams,
  lastPrice: 98,
});

assert.equal(exitDirective.action, 'exit', 'Should exit when drawdown exceeds tolerance after time stop');

console.log('✅ exit-manager time stop test passed');
