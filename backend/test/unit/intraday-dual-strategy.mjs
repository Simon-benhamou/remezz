import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { IntradayDualStrategy } = await import('../../dist/src/quantai/intraday/strategy.js');
const { overrideIntradayConfig, loadIntradayConfig } = await import('../../dist/src/quantai/intraday/config/index.js');
const { PreciseDecimal } = await import('../../dist/src/quantai/strategy/metaAdaptiveAgent.js');

function cloneConfig(cfg) {
  return JSON.parse(JSON.stringify(cfg));
}

function makeFlatCandles(count, price, volumeStart = 200) {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: 1_700_000_000_000 + i * 60_000,
    open: price,
    high: price * 1.01,
    low: price * 0.99,
    close: price,
    volume: volumeStart + i,
  }));
}

function aggregate(candles, size) {
  const out = [];
  for (let i = 0; i < candles.length; i += size) {
    const slice = candles.slice(i, i + size);
    const last = slice[slice.length - 1];
    out.push({
      timestamp: last.timestamp,
      open: slice[0].open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: last.close,
      volume: slice.reduce((acc, c) => acc + c.volume, 0),
    });
  }
  return out;
}

function applyBreakout(candles, { growth = 1.08, window = 30, volumeBase = 5000, volumeStep = 800 }) {
  let price = candles[candles.length - window - 1].close;
  for (let i = candles.length - window; i < candles.length; i++) {
    price *= growth;
    candles[i].open = price / 1.02;
    candles[i].close = price;
    candles[i].high = price * 1.01;
    candles[i].low = price * 0.99;
    candles[i].volume += volumeBase + (i - (candles.length - window)) * volumeStep;
  }
}

function applyMeanReversionSetup(candles, { dropPct = 0.4, window = 25, volumeBase = 4000, volumeStep = 600 }) {
  const startIdx = candles.length - window;
  const startPrice = candles[startIdx - 1].close;
  const bottomPrice = startPrice * (1 - dropPct);
  for (let i = startIdx; i < candles.length; i++) {
    const progress = (i - startIdx + 1) / window;
    const target = startPrice - (startPrice - bottomPrice) * Math.min(progress, 1);
    candles[i].open = target * 1.001;
    candles[i].close = target;
    candles[i].high = target * 1.002;
    candles[i].low = target * 0.995;
    candles[i].volume += volumeBase + (i - startIdx) * volumeStep;
  }
  const bounceBase = bottomPrice * 1.02;
  for (let j = 0; j < 3; j++) {
    const idx = candles.length - 3 + j;
    const prevClose = candles[idx - 1].close;
    const bounce = bounceBase * (1 + 0.003 * j);
    candles[idx].open = prevClose * 0.997;
    candles[idx].close = bounce;
    candles[idx].high = bounce * 1.003;
    candles[idx].low = bounce * 0.97;
    candles[idx].volume += volumeStep * (2 + j);
  }
}

const baseCfg = cloneConfig(loadIntradayConfig());
const testCfg = cloneConfig(baseCfg);
testCfg.entry.bom.volumeZMin = 0.5;
testCfg.entry.bom.aggressionMin = 0.5;
testCfg.entry.bom.atrMinPct = 0.001;
testCfg.entry.bom.pyramidMaxAdds = 2;
testCfg.entry.bom.pyramidPullbackBps = 60;
testCfg.entry.bom.pyramidScale = 0.3;
testCfg.entry.bom.stopGraceMinutes = 4;
testCfg.entry.bom.stopGraceBps = 15;
testCfg.entry.mr.atrMaxPct = 0.5;
testCfg.entry.mr.priceZScore = 1.2;
testCfg.entry.mr.obiExtreme = 0.3;
testCfg.entry.mr.obiDeltaMin = 0.02;
testCfg.stops.tp.firstPct = 0.005;
testCfg.stops.tp.secondPct = 0.012;
overrideIntradayConfig(testCfg);

const equity = new PreciseDecimal(100_000);

// Breakout scenario
const breakoutStrategy = new IntradayDualStrategy();
const warmCandles = makeFlatCandles(200, 100);
const warmTick = {
  symbol: 'BTCUSDT',
  timestamp: warmCandles[warmCandles.length - 1].timestamp,
  price: 100,
  candles: {
    '1m': warmCandles,
    '5m': aggregate(warmCandles, 5),
    '15m': aggregate(warmCandles, 15),
  },
  orderBook: {
    timestamp: warmCandles[warmCandles.length - 1].timestamp,
    bids: [{ price: 99.9, size: 2000 }],
    asks: [{ price: 100.1, size: 2000 }],
    takerBuyVolume: 400,
    takerSellVolume: 400,
  },
  aggression: { timestamp: warmCandles[warmCandles.length - 1].timestamp, takerBuy: 400, takerSell: 400 },
  newsSpike: false,
};

breakoutStrategy.evaluateTick(warmTick, {
  equityUsd: equity,
  maxLevInstrument: 3,
  maxLevGlobal: 3,
  exposureBudget: 3,
  slippageBps: 3,
});

const breakoutCandles = warmCandles.map((c) => ({ ...c }));
applyBreakout(breakoutCandles, { growth: 1.08, window: 30 });

const breakoutEval = breakoutStrategy.evaluateTick({
  symbol: 'BTCUSDT',
  timestamp: breakoutCandles[breakoutCandles.length - 1].timestamp,
  price: breakoutCandles[breakoutCandles.length - 1].close,
  candles: {
    '1m': breakoutCandles,
    '5m': aggregate(breakoutCandles, 5),
    '15m': aggregate(breakoutCandles, 15),
  },
  orderBook: {
    timestamp: breakoutCandles[breakoutCandles.length - 1].timestamp,
    bids: [{ price: breakoutCandles[breakoutCandles.length - 1].close * 0.999, size: 10_000 }],
    asks: [{ price: breakoutCandles[breakoutCandles.length - 1].close * 1.001, size: 1_000 }],
    takerBuyVolume: 9_000,
    takerSellVolume: 1_000,
  },
  aggression: { timestamp: breakoutCandles[breakoutCandles.length - 1].timestamp, takerBuy: 9_000, takerSell: 1_000 },
  newsSpike: false,
}, {
  equityUsd: equity,
  maxLevInstrument: 3,
  maxLevGlobal: 3,
  exposureBudget: 3,
  slippageBps: 2,
});

assert.ok(breakoutEval.entries.length >= 1, 'Expected breakout entry');
const bomEntry = breakoutEval.entries[0];
assert.equal(bomEntry.entryType, 'breakout');
assert.equal(bomEntry.regime, 'BOM');
assert.ok(bomEntry.size.raw > 0n, 'Size should be positive');
assert.equal(bomEntry.pyramidAdd, false, 'First BOM entry should not be pyramid add');
assert.ok(bomEntry.entryAtrPct > 0, 'ATR snapshot should be positive');

// Mean-reversion scenario
const mrStrategy = new IntradayDualStrategy();
const mrCandles = makeFlatCandles(200, 200, 400);
applyMeanReversionSetup(mrCandles, { dropPct: 0.4, window: 25 });

const mrWarmCandles = mrCandles.slice(0, -1);
const mrWarmTick = {
  symbol: 'ETHUSDT',
  timestamp: mrWarmCandles[mrWarmCandles.length - 1].timestamp,
  price: mrWarmCandles[mrWarmCandles.length - 1].close,
  candles: {
    '1m': mrWarmCandles,
    '5m': aggregate(mrWarmCandles, 5),
    '15m': aggregate(mrWarmCandles, 15),
  },
  orderBook: {
    timestamp: mrWarmCandles[mrWarmCandles.length - 1].timestamp,
    bids: [{ price: mrWarmCandles[mrWarmCandles.length - 1].close * 0.998, size: 1_000 }],
    asks: [{ price: mrWarmCandles[mrWarmCandles.length - 1].close * 1.003, size: 9_500 }],
    takerBuyVolume: 800,
    takerSellVolume: 4_800,
  },
  aggression: { timestamp: mrWarmCandles[mrWarmCandles.length - 1].timestamp, takerBuy: 800, takerSell: 4_800 },
  newsSpike: true,
};

mrStrategy.evaluateTick(mrWarmTick, {
  equityUsd: equity,
  maxLevInstrument: 3,
  maxLevGlobal: 3,
  exposureBudget: 3,
  slippageBps: 2,
});

const mrEval = mrStrategy.evaluateTick({
  symbol: 'ETHUSDT',
  timestamp: mrCandles[mrCandles.length - 1].timestamp,
  price: mrCandles[mrCandles.length - 1].close,
  candles: {
    '1m': mrCandles,
    '5m': aggregate(mrCandles, 5),
    '15m': aggregate(mrCandles, 15),
  },
  orderBook: {
    timestamp: mrCandles[mrCandles.length - 1].timestamp,
    bids: [{ price: mrCandles[mrCandles.length - 1].close * 0.999, size: 2_000 }],
    asks: [{ price: mrCandles[mrCandles.length - 1].close * 1.002, size: 9_000 }],
    takerBuyVolume: 1_000,
    takerSellVolume: 4_000,
  },
  aggression: { timestamp: mrCandles[mrCandles.length - 1].timestamp, takerBuy: 1_000, takerSell: 4_000 },
  newsSpike: false,
}, {
  equityUsd: equity,
  maxLevInstrument: 3,
  maxLevGlobal: 3,
  exposureBudget: 3,
  slippageBps: 2,
});

assert.ok(mrEval.entries.length >= 1, 'Expected MR entry');
const mrEntry = mrEval.entries[0];
assert.equal(mrEntry.entryType, 'mean-reversion');
assert.equal(mrEntry.regime, 'MR');
assert.ok(mrEntry.size.raw > 0n, 'MR size positive');
assert.equal(mrEntry.pyramidAdd, false, 'MR entry never pyramids');
assert.ok(mrEntry.entryAtrPct > 0, 'MR ATR snapshot should be positive');

// Grace stop behaviour
const graceStrategy = new IntradayDualStrategy();
const graceWarm = warmCandles.map((c) => ({ ...c }));
const graceWarmTick = {
  symbol: 'SOLUSDT',
  timestamp: graceWarm[graceWarm.length - 1].timestamp,
  price: graceWarm[graceWarm.length - 1].close,
  candles: {
    '1m': graceWarm,
    '5m': aggregate(graceWarm, 5),
    '15m': aggregate(graceWarm, 15),
  },
  orderBook: {
    timestamp: graceWarm[graceWarm.length - 1].timestamp,
    bids: [{ price: graceWarm[graceWarm.length - 1].close * 0.999, size: 4_000 }],
    asks: [{ price: graceWarm[graceWarm.length - 1].close * 1.001, size: 4_500 }],
    takerBuyVolume: 2_000,
    takerSellVolume: 2_000,
  },
  aggression: { timestamp: graceWarm[graceWarm.length - 1].timestamp, takerBuy: 2_000, takerSell: 2_000 },
  newsSpike: false,
};

graceStrategy.evaluateTick(graceWarmTick, {
  equityUsd: equity,
  maxLevInstrument: 3,
  maxLevGlobal: 3,
  exposureBudget: 3,
  slippageBps: 2,
});

const graceBreakout = breakoutCandles.map((c) => ({ ...c }));
const graceEntryEval = graceStrategy.evaluateTick({
  symbol: 'SOLUSDT',
  timestamp: graceBreakout[graceBreakout.length - 1].timestamp,
  price: graceBreakout[graceBreakout.length - 1].close,
  candles: {
    '1m': graceBreakout,
    '5m': aggregate(graceBreakout, 5),
    '15m': aggregate(graceBreakout, 15),
  },
  orderBook: {
    timestamp: graceBreakout[graceBreakout.length - 1].timestamp,
    bids: [{ price: graceBreakout[graceBreakout.length - 1].close * 0.999, size: 12_000 }],
    asks: [{ price: graceBreakout[graceBreakout.length - 1].close * 1.001, size: 2_000 }],
    takerBuyVolume: 10_000,
    takerSellVolume: 1_200,
  },
  aggression: { timestamp: graceBreakout[graceBreakout.length - 1].timestamp, takerBuy: 10_000, takerSell: 1_200 },
  newsSpike: false,
}, {
  equityUsd: equity,
  maxLevInstrument: 3,
  maxLevGlobal: 3,
  exposureBudget: 3,
  slippageBps: 2,
});

assert.ok(graceEntryEval.entries.length >= 1, 'Expected grace BOM entry');
const graceEntry = graceEntryEval.entries[0];
assert.ok(graceEntry.stopGrace, 'Grace stop should be attached');
const baseStop = graceEntry.stopLossPrice.toNumber();
const graceStop = graceEntry.stopGrace.price.toNumber();
assert.ok(graceStop < baseStop, 'Grace stop should be looser');

const dipPrice = (baseStop + graceStop) / 2;
const graceMs = testCfg.entry.bom.stopGraceMinutes * 60_000;

const dipCandle = {
  timestamp: graceBreakout[graceBreakout.length - 1].timestamp + 60_000,
  open: graceEntry.triggerPrice.toNumber(),
  high: graceEntry.triggerPrice.toNumber() * 1.001,
  low: dipPrice * 0.999,
  close: dipPrice,
  volume: graceBreakout[graceBreakout.length - 1].volume + 2_000,
};
const dipSeries = [...graceBreakout.slice(1), dipCandle];

const dipEval = graceStrategy.evaluateTick({
  symbol: 'SOLUSDT',
  timestamp: dipCandle.timestamp,
  price: dipPrice,
  candles: {
    '1m': dipSeries,
    '5m': aggregate(dipSeries, 5),
    '15m': aggregate(dipSeries, 15),
  },
  orderBook: {
    timestamp: dipCandle.timestamp,
    bids: [{ price: dipPrice * 0.999, size: 8_000 }],
    asks: [{ price: dipPrice * 1.001, size: 8_500 }],
    takerBuyVolume: 3_000,
    takerSellVolume: 3_500,
  },
  aggression: { timestamp: dipCandle.timestamp, takerBuy: 3_000, takerSell: 3_500 },
  newsSpike: false,
}, {
  equityUsd: equity,
  maxLevInstrument: 3,
  maxLevGlobal: 3,
  exposureBudget: 3,
  slippageBps: 2,
});

assert.equal(dipEval.exits.length, 0, 'Grace period should prevent stop-out');

const postGraceCandle = {
  timestamp: dipCandle.timestamp + graceMs + 60_000,
  open: dipPrice,
  high: dipPrice * 1.0005,
  low: dipPrice * 0.999,
  close: dipPrice,
  volume: dipCandle.volume + 1_000,
};
const postGraceSeries = [...dipSeries.slice(1), postGraceCandle];

const postGraceEval = graceStrategy.evaluateTick({
  symbol: 'SOLUSDT',
  timestamp: postGraceCandle.timestamp,
  price: dipPrice,
  candles: {
    '1m': postGraceSeries,
    '5m': aggregate(postGraceSeries, 5),
    '15m': aggregate(postGraceSeries, 15),
  },
  orderBook: {
    timestamp: postGraceCandle.timestamp,
    bids: [{ price: dipPrice * 0.999, size: 7_500 }],
    asks: [{ price: dipPrice * 1.001, size: 7_800 }],
    takerBuyVolume: 2_800,
    takerSellVolume: 3_200,
  },
  aggression: { timestamp: postGraceCandle.timestamp, takerBuy: 2_800, takerSell: 3_200 },
  newsSpike: false,
}, {
  equityUsd: equity,
  maxLevInstrument: 3,
  maxLevGlobal: 3,
  exposureBudget: 3,
  slippageBps: 2,
});

assert.ok(postGraceEval.exits.some((e) => e.reason === 'stop'), 'Stop should trigger after grace expires');

overrideIntradayConfig(baseCfg);

console.log('✅ intraday-dual-strategy.mjs passed');
