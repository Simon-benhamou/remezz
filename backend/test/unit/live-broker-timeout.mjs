import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';

const { resolveOrderFillTimeoutSec } = await import('../../dist/src/broker/live.js');

const cfgLimitLonger = {
  ORDER_FILL_TIMEOUT_SEC: 10,
  ORDER_FILL_TIMEOUT_LIMIT_SEC: 180,
};

assert.equal(
  resolveOrderFillTimeoutSec(cfgLimitLonger, 'market'),
  10,
  'market orders should use the base timeout',
);
assert.equal(
  resolveOrderFillTimeoutSec(cfgLimitLonger, 'limit'),
  180,
  'limit orders should use the extended timeout when provided',
);

const cfgLimitShorter = {
  ORDER_FILL_TIMEOUT_SEC: 25,
  ORDER_FILL_TIMEOUT_LIMIT_SEC: 5,
};

assert.equal(
  resolveOrderFillTimeoutSec(cfgLimitShorter, 'limit'),
  25,
  'limit timeout should never be shorter than base timeout',
);

console.log('✅ live broker fill timeout safeguards passed');
