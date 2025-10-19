import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const { ensureRecentVolumeIntegrity } = await import('../../dist/src/ai/tech.js');
const { UnusableMarketDataError } = await import('../../dist/src/data/errors.js');

function makeSeries(length, volumeFactory) {
  const rows = [];
  const now = Date.now();
  for (let i = 0; i < length; i++) {
    const ts = now - (length - i) * 60_000;
    const volume = volumeFactory(i);
    rows.push([ts, 0, 0, 0, 0, volume]);
  }
  return rows;
}

// Successful refetch when anomaly detected
{
  const initial = makeSeries(40, () => 0);
  let refetchCalls = 0;
  const recovered = makeSeries(42, () => 15);
  const result = await ensureRecentVolumeIntegrity({
    symbol: 'TEST/USDT',
    timeframe: '15m',
    ohlcv: initial,
    minWindow: 30,
    threshold: 0.2,
    backfillAttempts: 2,
    async refetch(limit, attempt) {
      refetchCalls += 1;
      assert.equal(attempt, 1);
      assert(limit >= initial.length + 10);
      return recovered;
    },
  });
  assert.equal(refetchCalls, 1, 'should refetch exactly once');
  assert.equal(result.length, recovered.length, 'should return refetched data when it passes validation');
}

// No refetch when invalid ratio below threshold
{
  const initial = makeSeries(40, (i) => (i % 10 === 0 ? 0 : 25));
  let refetchCalls = 0;
  const result = await ensureRecentVolumeIntegrity({
    symbol: 'STABLE/USDT',
    timeframe: '15m',
    ohlcv: initial,
    minWindow: 30,
    threshold: 0.5,
    backfillAttempts: 2,
    async refetch() {
      refetchCalls += 1;
      return makeSeries(40, () => 40);
    },
  });
  assert.equal(refetchCalls, 0, 'should not refetch when anomaly ratio is below threshold');
  assert.equal(result, initial, 'should return original series when validation passes');
}

// Failure after exhausting retries
{
  const initial = makeSeries(35, () => 0);
  let attempts = 0;
  await assert.rejects(
    () =>
      ensureRecentVolumeIntegrity({
        symbol: 'FAIL/USDT',
        timeframe: '15m',
        ohlcv: initial,
        minWindow: 30,
        threshold: 0.2,
        backfillAttempts: 1,
        async refetch(limit, attempt) {
          attempts += 1;
          assert(limit >= initial.length + 10);
          assert.equal(attempt, attempts);
          return makeSeries(40, () => 0);
        },
      }),
    (error) => {
      assert(error instanceof UnusableMarketDataError, 'should throw UnusableMarketDataError');
      assert.equal(error.meta?.symbol, 'FAIL/USDT');
      return true;
    },
  );
  assert.equal(attempts, 1, 'should only attempt the configured number of retries');
}

console.log('✅ technical-volume-integrity tests passed');
