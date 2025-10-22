import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const moduleUrl = new URL('../../dist/src/monitor/marketMetrics.js', import.meta.url);
const metricsModule = await import(`${moduleUrl}?t=${Date.now()}`);

const { recordMarketFrame, getMarketMetrics } = metricsModule;

const baseTs = 1_700_800_000_000;

recordMarketFrame({
  symbol: 'FILUSDT',
  source: 'WS',
  status: 'stale',
  ruleId: 'stale_frame',
  receivedTs: baseTs,
  eventTs: baseTs,
  dataAgeMs: 6_200,
  extra: { recoveredFrom: 'previous_bid_ask' },
});

recordMarketFrame({
  symbol: 'ADAUSDT',
  source: 'REST',
  status: 'stale',
  ruleId: 'stale_frame',
  receivedTs: baseTs + 5,
  eventTs: baseTs + 5,
  dataAgeMs: 5_500,
});

const snapshot = getMarketMetrics();

assert.equal(snapshot.totals.marketFramesStale, 2, 'Total stale frame counter should aggregate events');
assert.equal(
  snapshot.totals.marketFramesStaleBySource.WS,
  1,
  'WS stale counter should reflect stale frames from WebSocket',
);
assert.equal(
  snapshot.totals.marketFramesStaleBySource.REST,
  1,
  'REST stale counter should track fallback staleness',
);

console.log('✅ market-frame-stale-counter.mjs confirmed aggregate stale frame metrics');
