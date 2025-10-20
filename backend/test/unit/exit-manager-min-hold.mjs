import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';

const { getQuantAIConfig, maybeAdjustOrExit } = await import('../../dist/src/quantai/index.js');

const cfg = getQuantAIConfig();
const exitCfg = {
  ...cfg.exits,
  earlyExit: { ...cfg.exits.earlyExit, minHoldMinutes: 10 },
};

const baseParams = {
  side: 'long',
  entryPrice: 100,
  stop: 95,
  targets: [120],
  atr: 2,
  adx: 10,
  cmf: -0.2,
  cfg: exitCfg,
  alreadyTriggeredTargets: new Set(),
};

const earlyHold = maybeAdjustOrExit({
  ...baseParams,
  lastPrice: 98,
  minutesOpen: 5,
});

assert.equal(
  earlyHold.action,
  'hold',
  'Should keep holding while min hold time not satisfied even if momentum fails',
);

const lateExit = maybeAdjustOrExit({
  ...baseParams,
  lastPrice: 97.5,
  minutesOpen: 12,
});

assert.equal(lateExit.action, 'exit', 'Should exit once min hold window passed and loss threshold breached');

console.log('✅ exit-manager min hold test passed');
