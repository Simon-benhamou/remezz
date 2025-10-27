import assert from 'node:assert/strict';

const { detectStrategyShift } = await import('../../dist/src/engine/strategyShift.js');

const base = {
  price: 100,
  lastPrice: 100,
  zone: null,
  priceThresholdPct: 5,
  confidenceThreshold: 0.2,
};

{
  const result = detectStrategyShift({
    ...base,
    regime: null,
    previousRegime: { label: 'trend:bear', confidence: 0.8 },
  });
  assert.equal(result.regimeShift, false, 'missing diagnostics should not force a regime shift');
}

{
  const result = detectStrategyShift({
    ...base,
    regime: { label: 'RANGE:NEUTRAL', confidence: 0.7 },
    previousRegime: { label: null, confidence: null },
  });
  assert.equal(result.regimeShift, true, 'new diagnostics should trigger a regime shift');
}

{
  const result = detectStrategyShift({
    ...base,
    regime: { label: 'TREND:BULL', confidence: 0.8 },
    previousRegime: { label: 'TREND:BEAR', confidence: 0.9 },
  });
  assert.equal(result.regimeShift, true, 'changed labels should still trigger a regime shift');
}

console.log('✅ strategy-shift.mjs passed');
