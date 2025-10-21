import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { resolveDirectionalIndicators } = await import('../../dist/src/ai/tech.js');

const plusSeries = [NaN, NaN, 32.4123, 35.189, 34.01];
const minusSeries = [NaN, 28.5, NaN, 23.7, 21.002];
const resolved = resolveDirectionalIndicators(plusSeries, minusSeries);

assert.equal(resolved.diPlus, 34.01, 'Should pick the latest finite +DI value');
assert.equal(resolved.diMinus, 21.002, 'Should pick the latest finite -DI value');

const fallback = resolveDirectionalIndicators([NaN, Infinity], [Number.NaN, -Infinity]);

assert.equal(fallback.diPlus, undefined, 'Undefined when no finite +DI values exist');
assert.equal(fallback.diMinus, undefined, 'Undefined when no finite -DI values exist');

console.log('✅ technical-directional-indicators.mjs passed');
