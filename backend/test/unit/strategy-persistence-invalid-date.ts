import assert from 'node:assert/strict';

const { buildStrategyPersistenceData } = await import('../../src/ai/strategyManager.ts');

const baseStrategy = {
  strategyId: 'demo-strat',
  symbol: 'BTCUSDT',
  bias: 'long',
  confidence: 0.42,
  entry: { type: 'market', price: 100 },
  risk: {},
  validity: { from: '2024-07-01T00:00:00.000Z', to: 'Invalid Date' },
  rationale: 'demo',
};

const requestContext = { sessionId: 'session-1', trigger: 'unit-test' };

const payloadWithInvalid = buildStrategyPersistenceData(baseStrategy, requestContext);

assert.equal(payloadWithInvalid.validityTo, undefined, 'invalid date should be dropped');

const validIso = '2024-07-01T12:34:56.000Z';
const payloadWithValid = buildStrategyPersistenceData(
  { ...baseStrategy, validity: { ...baseStrategy.validity, to: validIso } },
  requestContext,
);

assert(payloadWithValid.validityTo instanceof Date, 'valid ISO string should convert to Date');
assert.equal(
  payloadWithValid.validityTo?.toISOString(),
  validIso,
  'valid ISO string should retain the same instant',
);

console.log('✅ strategy-persistence-invalid-date.ts passed');
