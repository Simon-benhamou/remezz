import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const {
  computeQualityScore,
  computeRiskScaleFromQS,
  chooseEV,
} = await import('../../dist/src/quantai/qs/qualityScore.js');
const { IntradayDualStrategy } = await import('../../dist/src/quantai/strategies/intradayDual/strategy.js');
const { overrideIntradayConfig, loadIntradayConfig } = await import('../../dist/src/quantai/strategies/intradayDual/config/index.js');
const { PreciseDecimal } = await import('../../dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
const { setIntradayRuntimeOverride } = await import('../../dist/src/config/intraday.js');

const baseRuntime = {
  qs: {
    enabled: true,
    baseRiskPct: 0.007,
    minRiskScale: 0.55,
    maxRiskScale: 1.45,
    qsToScaleSlope: 0.8,
  },
  ev: {
    enabled: false,
    slMinBps: 40,
    slMaxBps: 160,
    tpGridBps: [70, 100, 140],
    feesBps: 6,
  },
};

const baseConfig = loadIntradayConfig();
const tunedConfig = JSON.parse(JSON.stringify(baseConfig));
tunedConfig.entry.bom.volumeZMin = -1;
tunedConfig.entry.bom.aggressionMin = 0.3;
tunedConfig.entry.bom.atrMinPct = 0.0005;
tunedConfig.entry.bom.rsiMin = 50;
tunedConfig.entry.bom.confirmationBars = 0;
tunedConfig.stops.tp.firstPct = 0.006;
tunedConfig.stops.tp.secondPct = 0.015;
overrideIntradayConfig(tunedConfig);
setIntradayRuntimeOverride(baseRuntime);

function makeFlatCandles(count, price) {
  return Array.from({ length: count }, (_, idx) => ({
    timestamp: 1_701_000_000_000 + idx * 60_000,
    open: price,
    high: price * 1.01,
    low: price * 0.99,
    close: price,
    volume: 800 + idx,
  }));
}

function aggregate(candles, size) {
  const buckets = [];
  for (let i = 0; i < candles.length; i += size) {
    const slice = candles.slice(i, i + size);
    const last = slice[slice.length - 1];
    buckets.push({
      timestamp: last.timestamp,
      open: slice[0].open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: last.close,
      volume: slice.reduce((acc, c) => acc + c.volume, 0),
    });
  }
  return buckets;
}

function applyBreakout(candles, { growth = 1.06, window = 25, volumeBase = 5_000, volumeStep = 600 }) {
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

function runBreakoutScenario(aggressionRatio) {
  const strategy = new IntradayDualStrategy();
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
      bids: [{ price: 99.9, size: 5_000 }],
      asks: [{ price: 100.1, size: 5_000 }],
      takerBuyVolume: 500,
      takerSellVolume: 500,
    },
    aggression: { timestamp: warmCandles[warmCandles.length - 1].timestamp, takerBuy: 500, takerSell: 500 },
    newsSpike: false,
  };

  const equity = new PreciseDecimal(100_000);
  strategy.evaluateTick(warmTick, {
    equityUsd: equity,
    maxLevInstrument: 3,
    maxLevGlobal: 3,
    exposureBudget: 3,
    slippageBps: 3,
  });

  const scenarioCandles = warmCandles.map((candle) => ({ ...candle }));
  applyBreakout(scenarioCandles, { growth: 1.1, window: 24, volumeBase: 8_000, volumeStep: 1_000 });

  const takerBuy = 10_000 * aggressionRatio;
  const takerSell = 10_000 * (1 - aggressionRatio);
  const last = scenarioCandles[scenarioCandles.length - 1];
  const tick = {
    symbol: 'BTCUSDT',
    timestamp: last.timestamp,
    price: last.close,
    candles: {
      '1m': scenarioCandles,
      '5m': aggregate(scenarioCandles, 5),
      '15m': aggregate(scenarioCandles, 15),
    },
    orderBook: {
      timestamp: last.timestamp,
      bids: [
        { price: last.close * 0.9995, size: 12_000 },
        { price: last.close * 0.999, size: 8_000 },
      ],
      asks: [
        { price: last.close * 1.0005, size: 3_000 },
        { price: last.close * 1.001, size: 2_000 },
      ],
      takerBuyVolume: takerBuy,
      takerSellVolume: takerSell,
    },
    aggression: { timestamp: last.timestamp, takerBuy, takerSell },
    newsSpike: false,
  };

  const result = strategy.evaluateTick(tick, {
    equityUsd: equity,
    maxLevInstrument: 3,
    maxLevGlobal: 3,
    exposureBudget: 3,
    slippageBps: 2,
  });
  return result.entries[0] ?? null;
}

try {
  // Monotonic risk scale vs quality
  const qsCfg = { enabled: true, baseRiskPct: 0.01, minRiskScale: 0.4, maxRiskScale: 1.6, qsToScaleSlope: 0.9 };
  const lowScale = computeRiskScaleFromQS(-0.6, qsCfg);
  const highScale = computeRiskScaleFromQS(0.85, qsCfg);
  assert.ok(highScale > lowScale, 'Risk scale should increase with quality score');

  // EV chooser behavior
  const evParams = {
    predictedSlippageBps: 5,
    feesBps: 6,
    tpGridBps: [60, 90, 130, 160],
    slMinBps: 30,
    slMaxBps: 140,
  };
  const lowWin = chooseEV(0.35, evParams);
  const highWin = chooseEV(0.72, evParams);
  assert.ok(lowWin.stopBps <= highWin.stopBps, 'Lower win probability should keep tighter stops');
  assert.ok(highWin.takeProfitBps >= lowWin.takeProfitBps, 'Higher win probability should allow larger targets');

  // Integration: trade proceeds and risk varies
  const entryHigh = runBreakoutScenario(0.88);
  const entryLow = runBreakoutScenario(0.56);
  assert.ok(entryHigh, 'High quality scenario should produce an entry');
  assert.ok(entryLow, 'Low quality scenario should produce an entry');
  assert.ok(entryHigh.telemetry && entryLow.telemetry, 'Telemetry should be attached to entries');
  assert.ok(entryHigh.telemetry.riskScale > entryLow.telemetry.riskScale, 'Risk scale should expand for higher quality');
  assert.ok(entryHigh.riskUsd.toNumber() > entryLow.riskUsd.toNumber(), 'Risk sizing should scale with risk factor');

  console.log('✅ intraday-qs-ev.mjs passed');
} finally {
  setIntradayRuntimeOverride(null);
  overrideIntradayConfig(baseConfig);
}
