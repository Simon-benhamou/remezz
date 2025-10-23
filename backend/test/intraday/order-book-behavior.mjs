import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.INTRADAY_DISALLOW_SYNTHETIC = 'true';

const liveModule = await import('../../dist/src/quantai/strategies/intradayDual/live.js');
const market = await import('../../dist/src/data/market.js');
const orderBook = await import('../../dist/src/data/orderBook.js');
const featuresModule = await import('../../dist/src/quantai/strategies/intradayDual/features.js');
const { PaperBroker } = await import('../../dist/src/broker/paper.js');

const { evaluateIntradayStrategy, buildOrderBookSnapshot } = liveModule;
const { FeaturePipeline } = featuresModule;
const { setDepthFetcherOverride } = orderBook;
const { setOhlcvOverride, setTickerOverride } = market;

function makeSyntheticSeries(limit) {
  const now = Date.now();
  const interval = 60_000;
  const data = [];
  for (let i = limit; i > 0; i--) {
    const ts = now - i * interval;
    const price = 100;
    data.push([ts, price, price, price, price, 0]);
  }
  return data;
}

async function testSyntheticGuard() {
  setOhlcvOverride(async () => makeSyntheticSeries(180));
  let caught = false;
  try {
    await evaluateIntradayStrategy({ symbol: 'BTC/USDT' });
  } catch (error) {
    caught = true;
    assert.match(String(error?.message || error), /failed_fetch_candles_1m:unusable_data/);
  }
  assert.ok(caught, 'Expected unusable_data error when only synthetic bars are returned');
  setOhlcvOverride(null);
}

function makeCandles(count, basePrice) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const price = basePrice + Math.sin(i / 5) * 0.5 + i * 0.01;
    out.push({
      timestamp: 1_700_000_000_000 + i * 60_000,
      open: price - 0.1,
      high: price + 0.2,
      low: price - 0.3,
      close: price,
      volume: 120 + (i % 6),
    });
  }
  return out;
}

async function testDepthSnapshot() {
  const bids = Array.from({ length: 5 }, (_, i) => ({ price: 100 - i * 0.1, size: 8 + i }));
  const asks = Array.from({ length: 5 }, (_, i) => ({ price: 100 + i * 0.1, size: 5 + i }));
  setDepthFetcherOverride(async () => ({
    timestamp: Date.now(),
    bids,
    asks,
    source: 'depth',
  }));
  const snapshot = await buildOrderBookSnapshot('BTC/USDT');
  assert(snapshot, 'Expected snapshot from overridden depth fetcher');
  assert.equal(snapshot?.bids.length, 5);
  assert.equal(snapshot?.asks.length, 5);

  const candles = makeCandles(180, 100);
  const pipeline = new FeaturePipeline();
  const latest = candles[candles.length - 1].close;
  const features = pipeline.compute('1m', candles, snapshot, latest, 'BTC/USDT');
  const sumBids = bids.reduce((acc, lvl) => acc + lvl.size, 0);
  const sumAsks = asks.reduce((acc, lvl) => acc + lvl.size, 0);
  const expectedImbalance = (sumBids - sumAsks) / (sumBids + sumAsks);
  assert.ok(Math.abs(features.orderBook.imbalance - expectedImbalance) < 1e-6, 'Order-book imbalance should reflect depth levels');
  setDepthFetcherOverride(null);
}

function computeLiveImpact(levels, desiredQty) {
  let cumQty = 0;
  let best = levels[0]?.price ?? 0;
  let worst = best;
  for (const level of levels) {
    if (!(level?.price > 0) || !(level?.size > 0)) continue;
    if (cumQty === 0 && best <= 0) {
      best = level.price;
    }
    cumQty += level.size;
    worst = level.price;
    if (cumQty >= desiredQty) break;
  }
  if (!(best > 0) || !(worst > 0)) return 0;
  return Math.abs((worst - best) / best) * 100;
}

async function testPaperVsLiveParity() {
  const paper = new PaperBroker();
  setTickerOverride(async () => ({ last: 100, bid: 99.9, ask: 100.1 }));
  setOhlcvOverride(async () => Array.from({ length: 30 }, (_, i) => [
    1_700_000_000_000 + i * 900_000,
    100,
    100.5,
    99.5,
    100,
    2_000,
  ]));

  const asks = Array.from({ length: 6 }, (_, i) => ({ price: 100 + i * 0.2, size: 5 + i * 2 }));
  const bids = Array.from({ length: 6 }, (_, i) => ({ price: 100 - i * 0.2, size: 5 + i * 2 }));
  setDepthFetcherOverride(async () => ({ timestamp: Date.now(), bids, asks, source: 'depth' }));

  const desiredQty = 12;
  const estimate = await paper.estimateFillableQty({ symbol: 'BTC/USDT', side: 'buy', desiredQty, maxImpactPct: 5 });
  const liveImpact = computeLiveImpact(asks, desiredQty);
  assert.ok(Number.isFinite(estimate.impactPct));
  const tolerance = liveImpact === 0 ? 0.1 : Math.abs(liveImpact) * 0.1;
  assert.ok(Math.abs(estimate.impactPct - liveImpact) <= tolerance, `Impact mismatch: paper=${estimate.impactPct} vs live=${liveImpact}`);

  setDepthFetcherOverride(null);
  setTickerOverride(null);
  setOhlcvOverride(null);
}

async function testFallbackLogging() {
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  setDepthFetcherOverride(async () => null);
  const snapshot = await buildOrderBookSnapshot('ETH/USDT');
  console.warn = originalWarn;
  setDepthFetcherOverride(null);
  assert(snapshot, 'Fallback should still return snapshot');
  assert.equal(snapshot?.source, 'fallback_ticker');
  assert(logs.some((entry) => entry.includes('fallback_ticker')), 'Expected fallback log mentioning fallback_ticker');
}

await testSyntheticGuard();
await testDepthSnapshot();
await testPaperVsLiveParity();
await testFallbackLogging();

console.log('✅ intraday order-book behavior tests passed');
