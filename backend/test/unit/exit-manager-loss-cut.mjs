import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';

const { getQuantAIConfig, maybeAdjustOrExit } = await import('../../dist/src/quantai/index.js');

const cfg = getQuantAIConfig();
const exitCfg = cfg.exits;

const directive = maybeAdjustOrExit({
  side: 'long',
  entryPrice: 100,
  stop: 95,
  targets: [120, 130, 140],
  lastPrice: 98,
  atr: 2,
  adx: 10,
  cmf: -0.1,
  cfg: exitCfg,
  alreadyTriggeredTargets: new Set(),
  minutesOpen: 5,
});

assert.equal(directive.action, 'exit', 'Loss beyond cut threshold with weak momentum should trigger exit');

console.log('✅ exit-manager loss cut test passed');
