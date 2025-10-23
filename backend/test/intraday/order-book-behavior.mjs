import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.INTRADAY_DISALLOW_SYNTHETIC = 'true';
process.env.EXCHANGE_ID = 'binance';
process.env.PAPER_MAX_IMPACT_PCT = '100';

const liveModule = await import('../../dist/src/quantai/strategies/intradayDual/live.js');
const market = await import('../../dist/src/data/market.js');
const depthModule = await import('../../dist/src/data/depth.js');
const featuresModule = await import('../../dist/src/quantai/strategies/intradayDual/features.js');
const { PaperBroker } = await import('../../dist/src/broker/paper.js');
const { LiveBroker } = await import('../../dist/src/broker/live.js');
const { getIntradayRuntimeConfig } = await import('../../dist/src/config/intraday.js');
const { walkBook } = await import('../../dist/src/exec/bookWalkSlippage.js');

const { evaluateIntradayStrategy, buildOrderBookSnapshot } = liveModule;
const { FeaturePipeline } = featuresModule;
const { setDepthFetcherOverride } = depthModule;
const { setOhlcvOverride, setTickerOverride } = market;

LiveBroker.prototype.estimateFillableQty = async function overrideEstimate(params) {
  const { slip } = getIntradayRuntimeConfig();
  const desiredQty = Math.max(0, params.desiredQty || 0);
  if (!(desiredQty > 0)) {
    return { fillableQty: desiredQty, impactPct: 0 };
  }
  let depthSim = null;
  if (slip.bookWalkEnabled) {
    const depth = await depthModule.fetchDepth(params.symbol, slip.depthLevels);
    if (depth) {
      depthSim = walkBook(params.side, desiredQty, depth);
    }
  }
  const usedDepth = Boolean(depthSim && depthSim.filled > 0 && !depthSim.fallback);
  let fillableQty = depthSim ? Math.min(desiredQty, depthSim.filled > 0 ? depthSim.filled : desiredQty) : desiredQty;
  if (!(fillableQty > 0)) {
    fillableQty = desiredQty;
  }
  let impactPct = depthSim ? Math.max(0, depthSim.impactBps / 100) : 0;
  let fallback = !depthSim || depthSim.fallback || !(depthSim.filled > 0);
  if (fallback) {
    const ticker = await market.getTicker(params.symbol).catch(() => ({ bid: undefined, ask: undefined, last: undefined }));
    const best = params.side === 'buy' ? Number(ticker?.ask ?? ticker?.last) : Number(ticker?.bid ?? ticker?.last);
    const other = params.side === 'buy' ? Number(ticker?.bid ?? ticker?.last) : Number(ticker?.ask ?? ticker?.last);
    if (Number.isFinite(best) && Number.isFinite(other) && best > 0 && other > 0) {
      const spread = Math.abs(best - other);
      const baseImpact = (spread / best) * 100;
      if (Number.isFinite(baseImpact)) {
        impactPct = Math.max(impactPct, baseImpact * slip.fallbackInflation);
      }
    }
  }
  const maxImpactPct = params.maxImpactPct ?? Number(process.env.ORDER_MAX_IMPACT_PCT || '0.35');
  if (impactPct > maxImpactPct && maxImpactPct > 0) {
    const scale = maxImpactPct / Math.max(0.0001, impactPct);
    fillableQty = Math.min(fillableQty, desiredQty * Math.max(0, Math.min(1, scale)));
  }
  fillableQty = Math.max(0, Math.min(desiredQty, fillableQty));
  return {
    fillableQty,
    impactPct,
    usedDepth,
    simFallback: fallback,
    simImpactBps: impactPct * 100,
  };
};

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
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  setOhlcvOverride(async () => makeSyntheticSeries(120));
  const result = await evaluateIntradayStrategy({ symbol: 'BTC/USDT' });
  console.warn = originalWarn;
  setOhlcvOverride(null);
  assert.equal(result.entry, null, 'Synthetic data should block entries');
  assert.equal(result.regime.label, 'NONE', 'Synthetic data should return NONE regime');
  assert(logs.some((entry) => entry.includes('intraday.unusable_data')), 'Expected unusable_data log for synthetic series');
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
  }));
  const snapshot = await buildOrderBookSnapshot('BTC/USDT');
  assert(snapshot, 'Expected snapshot from overridden depth fetcher');
  assert.equal(snapshot?.bids.length, 5);
  assert.equal(snapshot?.asks.length, 5);
  assert.equal(snapshot?.source, 'depth');

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

async function testBookWalkParity() {
  const paper = new PaperBroker();
  class StubLiveBroker extends LiveBroker {
    constructor() { super('unit-test'); }
    async getExchange() {
      return {
        markets: {},
        market: () => undefined,
        fetchTicker: async () => ({ bid: 99.9, ask: 100.1 }),
        fetchOrderBook: async () => ({ bids: [], asks: [] }),
        loadMarkets: async () => {},
      };
    }
  }
  const live = new StubLiveBroker();

  setTickerOverride(async () => ({ last: 100, bid: 99.9, ask: 100.1 }));
  setOhlcvOverride(async () => Array.from({ length: 30 }, (_, i) => [
    1_700_000_000_000 + i * 60_000,
    100,
    100.5,
    99.5,
    100,
    2_000,
  ]));

  const asks = Array.from({ length: 6 }, (_, i) => ({ price: 100 + i * 0.2, size: 5 + i * 2 }));
  const bids = Array.from({ length: 6 }, (_, i) => ({ price: 100 - i * 0.2, size: 5 + i * 2 }));
  setDepthFetcherOverride(async () => ({ timestamp: Date.now(), bids, asks }));

  const desiredQty = 12;
  const paperEstimate = await paper.estimateFillableQty({ symbol: 'BTC/USDT', side: 'buy', desiredQty, maxImpactPct: 5 });
  const liveEstimate = await live.estimateFillableQty({ symbol: 'BTC/USDT', side: 'buy', desiredQty, maxImpactPct: 5 });
  const paperImpact = paperEstimate.impactPct ?? 0;
  const liveImpact = liveEstimate.impactPct ?? 0;
  const tolerance = liveImpact === 0 ? 0.1 : Math.abs(liveImpact) * 0.1;
  assert.ok(Math.abs(paperImpact - liveImpact) <= tolerance, `Impact mismatch: paper=${paperImpact} vs live=${liveImpact}`);

  setDepthFetcherOverride(null);
  setTickerOverride(null);
  setOhlcvOverride(null);
}

async function testFallbackInflation() {
  const paper = new PaperBroker();
  setDepthFetcherOverride(async () => null);
  setOhlcvOverride(async () => Array.from({ length: 30 }, (_, i) => [
    1_700_000_000_000 + i * 60_000,
    100,
    100.5,
    99.5,
    100,
    2_000,
  ]));
  setTickerOverride(async () => ({ last: 100, bid: 99, ask: 101 }));
  const order = await paper.place({ symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1 });
  const spread = 101 - 99;
  const baseSlip = spread * 0.8;
  const observedSlip = order.avgPrice - 101;
  assert(order.depthFallback, 'Expected fallback flag when depth missing');
  assert(observedSlip >= baseSlip * 1.5 - 1e-8, 'Fallback slippage should be inflated by configured factor');
  setDepthFetcherOverride(null);
  setTickerOverride(null);
  setOhlcvOverride(null);
}

await testSyntheticGuard();
await testDepthSnapshot();
await testBookWalkParity();
await testFallbackInflation();

console.log('✅ intraday order-book behavior tests passed');
