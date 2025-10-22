import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { IntradayDualStrategy } = await import('../../dist/src/quantai/strategies/intradayDual/strategy.js');
const { PreciseDecimal } = await import('../../dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
const { overrideIntradayConfig, loadIntradayConfig } = await import('../../dist/src/quantai/strategies/intradayDual/config/index.js');
const { DirectionalPressure, computeSidePenalty } = await import('../../dist/src/quantai/strategies/intradayDual/risk.js');

const baseCfg = loadIntradayConfig();
const cfg = JSON.parse(JSON.stringify(baseCfg));
cfg.entry.bom.volumeZMin = 1.5;
cfg.entry.bom.aggressionMin = 0.58;
cfg.entry.bom.confirmationBars = 0;
cfg.entry.bom.atrMinPct = 0.001;
cfg.entry.mr.cooldownMs = 0;
overrideIntradayConfig(cfg);

function buildFeatures({
  direction,
  volumeZ,
  aggression,
  price,
}) {
  const bollingerPercentB = direction === 'long' ? 1.05 : -0.05;
  const emaFast = direction === 'long' ? price * 1.001 : price * 0.999;
  const emaSlow = price;
  const imbalance = direction === 'long' ? 0.2 : -0.2;
  const imbalanceDelta = direction === 'long' ? 0.06 : -0.06;
  return {
    '1m': {
      timeframe: '1m',
      timestamp: 1_700_010_000_000,
      price,
      volatility: {
        atrPct: 0.006,
        trueRangePct: 0.004,
        bollingerWidthPct: 0.012,
        bollingerPercentB,
        bollingerUpper: price * 1.01,
        bollingerLower: price * 0.99,
        bollingerMiddle: price,
        bandZScore: direction === 'long' ? 1.3 : -1.3,
        keltnerWidthPct: 0.01,
        squeezeRatio: 1.5,
        squeezeState: 'expansion',
      },
      momentum: {
        roc: { '1': direction === 'long' ? 0.02 : -0.02, '3': direction === 'long' ? 0.03 : -0.03 },
        emaSlope: {},
        emaValue: { '9': emaFast, '20': emaSlow },
        rsi: { '7': direction === 'long' ? 62 : 38 },
        rsiSlope: {},
        macdHistogram: direction === 'long' ? 0.4 : -0.4,
      },
      volume: { zScore: volumeZ, obvDelta: 0.2, spike95: false, spike99: false },
      orderBook: { imbalance, imbalanceDelta, aggressionRatio: aggression },
    },
    '5m': {
      timeframe: '5m',
      timestamp: 1_700_010_000_000,
      price,
      volatility: {
        atrPct: 0.005,
        trueRangePct: 0.003,
        bollingerWidthPct: 0.01,
        bollingerPercentB,
        bollingerUpper: price * 1.008,
        bollingerLower: price * 0.992,
        bollingerMiddle: price,
        bandZScore: direction === 'long' ? 1.1 : -1.1,
        keltnerWidthPct: 0.01,
        squeezeRatio: 1.3,
        squeezeState: 'expansion',
      },
      momentum: {
        roc: { '3': direction === 'long' ? 0.02 : -0.02 },
        emaSlope: {},
        emaValue: { '9': emaFast, '20': emaSlow },
        rsi: { '7': direction === 'long' ? 60 : 40 },
        rsiSlope: {},
        macdHistogram: direction === 'long' ? 0.3 : -0.3,
      },
      volume: { zScore: volumeZ, obvDelta: 0.1, spike95: false, spike99: false },
      orderBook: { imbalance, imbalanceDelta, aggressionRatio: aggression },
    },
    '15m': {
      timeframe: '15m',
      timestamp: 1_700_010_000_000,
      price,
      volatility: {
        atrPct: 0.004,
        trueRangePct: 0.002,
        bollingerWidthPct: 0.008,
        bollingerPercentB,
        bollingerUpper: price * 1.006,
        bollingerLower: price * 0.994,
        bollingerMiddle: price,
        bandZScore: direction === 'long' ? 0.9 : -0.9,
        keltnerWidthPct: 0.009,
        squeezeRatio: 1.2,
        squeezeState: 'neutral',
      },
      momentum: {
        roc: { '3': direction === 'long' ? 0.015 : -0.015 },
        emaSlope: {},
        emaValue: { '9': emaFast, '20': emaSlow },
        rsi: { '7': direction === 'long' ? 58 : 42 },
        rsiSlope: {},
        macdHistogram: direction === 'long' ? 0.2 : -0.2,
      },
      volume: { zScore: volumeZ, obvDelta: 0.05, spike95: false, spike99: false },
      orderBook: { imbalance, imbalanceDelta, aggressionRatio: aggression },
    },
  };
}

function makeTick(price) {
  const baseCandle = { timestamp: 1_700_010_000_000, open: price * 0.999, high: price * 1.002, low: price * 0.998, close: price, volume: 2_500 };
  return {
    symbol: 'BTCUSDT',
    timestamp: 1_700_010_000_000,
    price,
    candles: {
      '1m': [baseCandle],
      '5m': [baseCandle],
      '15m': [baseCandle],
    },
    orderBook: {
      timestamp: 1_700_010_000_000,
      bids: [{ price: price * 0.999, size: 5_000 }],
      asks: [{ price: price * 1.001, size: 5_000 }],
      takerBuyVolume: 5_000,
      takerSellVolume: 4_000,
    },
  };
}

const ctx = {
  equityUsd: new PreciseDecimal(100_000),
  maxLevInstrument: 3,
  maxLevGlobal: 3,
  exposureBudget: 3,
  slippageBps: 3,
};

// DirectionalPressure aggregation
{
  const dp = new DirectionalPressure();
  const now = Date.now();
  dp.recordStop('BTC', 'BOM', 'long', now - 25 * 60_000);
  dp.recordStop('BTC', 'BOM', 'long', now - 55 * 60_000);
  const pressure = dp.recentPressure('BTC', 'BOM', 'long', now);
  assert(pressure > 0.7 && pressure < 0.95, `pressure should be mid-range, got ${pressure}`);
  const penalty = computeSidePenalty(pressure);
  assert(penalty < 0.85 && penalty >= 0.6, `penalty should reflect pressure, got ${penalty}`);
}

function prepareStrategy(strategy, featuresRef) {
  strategy.computeFeatures = () => featuresRef;
  strategy.router.classify = () => ({ label: 'BOM', confidence: 0.65, reason: 'test', biasAgeMs: 5 * 60_000 });
}

// Baseline entry for comparison
const baseStrategy = new IntradayDualStrategy();
let features = buildFeatures({ direction: 'long', volumeZ: 1.8, aggression: 0.72, price: 100 });
prepareStrategy(baseStrategy, features);
const baseEval = baseStrategy.evaluateTick(makeTick(100), ctx);
assert.equal(baseEval.entries.length, 1, 'baseline should produce entry');
const baseRiskUsd = baseEval.entries[0].riskUsd.toNumber();

// Recheck with directional pressure reduces risk but still allows entry
const pressureStrategy = new IntradayDualStrategy();
features = buildFeatures({ direction: 'long', volumeZ: 1.8, aggression: 0.72, price: 100 });
prepareStrategy(pressureStrategy, features);
pressureStrategy.postStopRecheck.set('BTCUSDT', 1_700_010_000_000 + 5 * 60_000);
pressureStrategy.lastStopContext.set('BTCUSDT', { regime: 'BOM', side: 'long' });
pressureStrategy.dirPressure.recordStop('BTCUSDT', 'BOM', 'long', 1_700_009_850_000);
pressureStrategy.dirPressure.recordStop('BTCUSDT', 'BOM', 'long', 1_700_009_500_000);
const reducedEval = pressureStrategy.evaluateTick(makeTick(100), ctx);
assert.equal(reducedEval.entries.length, 1, 'pressure case should still allow entry');
const reducedRiskUsd = reducedEval.entries[0].riskUsd.toNumber();
assert(reducedRiskUsd < baseRiskUsd, 'risk should be reduced under pressure');

// Tightened thresholds suppress same-side borderline entry, opposite side relaxed
const tightenStrategy = new IntradayDualStrategy();
let featuresRef = buildFeatures({ direction: 'long', volumeZ: 1.55, aggression: 0.6, price: 100 });
prepareStrategy(tightenStrategy, featuresRef);
tightenStrategy.postStopRecheck.set('BTCUSDT', 1_700_010_000_000 + 5 * 60_000);
tightenStrategy.lastStopContext.set('BTCUSDT', { regime: 'BOM', side: 'long' });
const longSuppressed = tightenStrategy.evaluateTick(makeTick(100), ctx);
assert.equal(longSuppressed.entries.length, 0, 'tightened thresholds should block marginal same-side entry');

featuresRef = buildFeatures({ direction: 'short', volumeZ: 1.45, aggression: 0.555, price: 100 });
prepareStrategy(tightenStrategy, featuresRef);
const shortRelaxed = tightenStrategy.evaluateTick(makeTick(100), ctx);
assert.equal(shortRelaxed.entries.length, 1, 'opposite side should be slightly relaxed');

overrideIntradayConfig(baseCfg);

console.log('✅ intraday-dual-directional.mjs passed');
