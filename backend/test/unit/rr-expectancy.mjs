import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';

const {
  rrMinFromWinrate,
  blendRR,
  applyHysteresis,
  resolveRrExpectancyConfig,
} = await import('../../dist/src/risk/rrExpectancy.js');

const baseCfg = resolveRrExpectancyConfig();

// rrMinFromWinrate baseline cases
assert.equal(rrMinFromWinrate(0.5, baseCfg), 1.0, 'p=0.5 should yield RR=1.0');
const cfg130 = resolveRrExpectancyConfig({ rrBaseMin: 1.3, rrFloor: 1.0, rrCeil: 2.0 });
const rr435 = rrMinFromWinrate(0.435, cfg130);
assert(Math.abs(rr435 - 1.3) < 0.01, `p=0.435 should be close to 1.3 (got ${rr435})`);
const cfgLowFloor = resolveRrExpectancyConfig({ rrFloor: 1.0, rrCeil: 2.0 });
const rr60 = rrMinFromWinrate(0.6, cfgLowFloor);
assert.equal(rr60, 1.0, 'p=0.6 should clamp to floor 1.0');

// safety multiplier effect
const cfgSafe = resolveRrExpectancyConfig({
  rrFloor: 1.0,
  rrCeil: 2.0,
  rrExpectancy: { safetyMult: 1.05 },
});
const rrSafe = rrMinFromWinrate(0.5, cfgSafe);
assert(rrSafe > 1.0, 'safety multiplier should increase RR minimum');

// blendRR tests
assert.equal(blendRR(1.3, 1.0, 0.5), 1.15, 'Blend 50% should average base and dynamic');
assert.equal(blendRR(1.3, 1.0, 0), 1.3, 'Blend 0 keeps base');

// applyHysteresis tests
assert.equal(applyHysteresis(1.25, 1.23, 0.05), 1.25, 'Hysteresis should hold previous when within delta');
assert.equal(applyHysteresis(1.25, 1.1, 0.05), 1.1, 'Hysteresis should allow change when beyond delta');

// resolveRrExpectancyConfig clamps
const clamped = resolveRrExpectancyConfig({ rrFloor: 0.1, rrCeil: 10, rrBaseMin: 0.2, rrExpectancy: { blend: 1.5 } });
assert.equal(clamped.rrFloor, 0.5, 'Floor should clamp to minimum 0.5');
assert.equal(clamped.rrCeil, 5, 'Ceil should clamp to maximum 5');
assert.equal(clamped.blend, 1, 'Blend should clamp to 1');

console.log('✅ rr-expectancy unit tests passed');
