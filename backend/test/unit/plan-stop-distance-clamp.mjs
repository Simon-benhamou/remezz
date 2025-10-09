import assert from 'node:assert/strict';
import { normalizeStopDistance } from '../../dist/src/agent/validator.js';

function approxEqual(a, b, tol = 1e-9) {
  assert.ok(Math.abs(a - b) <= tol, `Expected ${a} ≈ ${b}`);
}

// Case 1: raw stop wildly above price should be clamped to 25% of mid
{
  const mid = 0.52;
  const minStopAbs = mid * 0.004; // 0.4%
  const rawStop = 5; // unrealistic ATR output
  const stop = normalizeStopDistance(mid, rawStop, minStopAbs);
  const expected = mid * 0.25;
  approxEqual(stop, expected);
}

// Case 2: invalid raw stop falls back to minStopAbs
{
  const mid = 0.6;
  const minStopAbs = mid * 0.005;
  const stop = normalizeStopDistance(mid, Number.NaN, minStopAbs);
  approxEqual(stop, minStopAbs);
}

// Case 3: zero/negative mid still produces positive distance via fallback
{
  const mid = 0;
  const minStopAbs = 0.002;
  const stop = normalizeStopDistance(mid, -10, minStopAbs);
  approxEqual(stop, minStopAbs);
}

console.log('✅ plan-stop-distance-clamp: all assertions passed');
