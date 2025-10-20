import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { createBinanceRestLimiter } = await import('../../dist/src/services/binanceWebSocket.js');

const limiter = createBinanceRestLimiter({ minIntervalMs: 30 });
const start = Date.now();
const observations = [];

await Promise.all(
  Array.from({ length: 3 }).map(() =>
    limiter.run(async () => {
      observations.push(Date.now() - start);
    }),
  ),
);

assert.equal(observations.length, 3, 'expected three scheduled executions');
assert(
  observations[1] - observations[0] >= 25,
  `calls should be spaced by ~30ms: ${observations.join(', ')}`,
);
assert(
  observations[2] - observations[1] >= 25,
  `calls should be spaced by ~30ms: ${observations.join(', ')}`,
);

limiter.backoff(80);
await limiter.run(async () => {
  observations.push(Date.now() - start);
});

assert(
  observations[3] - observations[2] >= 70,
  `backoff should delay execution by ~80ms: ${observations.join(', ')}`,
);

console.log('✅ Binance REST limiter enforces pacing and backoff');
