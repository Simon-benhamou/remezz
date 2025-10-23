import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { IntradayDualStrategy } = await import('../../dist/src/quantai/strategies/intradayDual/strategy.js');
const { PreciseDecimal } = await import('../../dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
const { overrideIntradayConfig, loadIntradayConfig } = await import('../../dist/src/quantai/strategies/intradayDual/config/index.js');

function cloneConfig(cfg) {
  return JSON.parse(JSON.stringify(cfg));
}

const baseCfg = cloneConfig(loadIntradayConfig());
baseCfg.management.microTrigger.enabled = false;
overrideIntradayConfig(baseCfg);

const strategy = new IntradayDualStrategy();
const symbol = 'BTCUSDT';
const entryTime = 1_700_000_000_000;
const entryPrice = new PreciseDecimal('100');
const size = new PreciseDecimal('1000');
const riskUsd = new PreciseDecimal('100');
const takeProfit1 = new PreciseDecimal('101');
const takeProfit2 = new PreciseDecimal('102');
const stopLoss = new PreciseDecimal('99');
const baseStop = new PreciseDecimal('99');

const longPosition = {
  symbol,
  side: 'long',
  sizeNotional: size,
  remainingNotional: size,
  entryPrice,
  stopLoss,
  takeProfit1,
  takeProfit2,
  runnerTrailMult: 1.2,
  entryTime,
  regime: 'BOM',
  entryType: 'breakout',
  riskUsd,
  tp1Executed: false,
  tp2Executed: false,
  rationale: [],
  equityAtEntry: new PreciseDecimal('100000'),
  entryAtrPct: 0.003,
  pyramidAdd: false,
  baseStopLoss: baseStop,
  stopGraceUntil: undefined,
  stopGracePrice: undefined,
  entryExecutionMode: 'taker',
  tp1Fraction: 0.5,
  tp2Fraction: 0.5,
  timeStopExpiry: entryTime + 30 * 60_000,
  telemetry: { scratchTriggered: false, microNudgeBps: 0 },
  scratchTriggered: false,
};

strategy.positions.set(symbol, [longPosition]);

const tick = {
  symbol,
  timestamp: entryTime + 2 * 60_000,
  price: 100,
  candles: {
    '1m': [
      { timestamp: entryTime, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
      { timestamp: entryTime + 60_000, open: 100, high: 101, low: 99.5, close: 100, volume: 900 },
    ],
    '5m': [],
    '15m': [],
  },
  orderBook: null,
  aggression: null,
  newsSpike: false,
};

const features = {
  '1m': {
    timeframe: '1m',
    timestamp: tick.timestamp,
    price: tick.price,
    volatility: {
      atrPct: 0.002,
      trueRangePct: 0,
      bollingerWidthPct: 0,
      bollingerPercentB: 0.5,
      bollingerUpper: 0,
      bollingerLower: 0,
      bollingerMiddle: 0,
      bandZScore: 0,
      keltnerWidthPct: 0,
      squeezeRatio: 0,
      squeezeState: 'neutral',
    },
    momentum: { roc: {}, emaSlope: {}, emaValue: {}, rsi: {}, rsiSlope: {}, macdHistogram: 0 },
    volume: { zScore: 0, obvDelta: 0, spike95: false, spike99: false },
    orderBook: { imbalance: 0, imbalanceDelta: -0.3, aggressionRatio: 0.2 },
  },
  '5m': null,
  '15m': null,
};

features['5m'] = features['1m'];
features['15m'] = features['1m'];

strategy.evaluateExits(tick, features);

const feeDecimal = new PreciseDecimal(strategy.runtimeCfg.ev.feesBps).dividedBy(new PreciseDecimal(10_000));
const expectedScratchStop = entryPrice.times(new PreciseDecimal(1).plus(feeDecimal));
assert.ok(
  longPosition.stopLoss.equals(expectedScratchStop) || longPosition.stopLoss.gt(expectedScratchStop),
  'Scratch should move stop to breakeven plus fees',
);
assert.equal(longPosition.scratchTriggered, true, 'Scratch flag should be recorded');
assert.equal(longPosition.telemetry?.scratchTriggered, true, 'Telemetry should record scratch');

strategy.positions.delete(symbol);

const timeSymbol = 'ETHUSDT';
const timePosition = {
  symbol: timeSymbol,
  side: 'long',
  sizeNotional: size,
  remainingNotional: size,
  entryPrice,
  stopLoss,
  takeProfit1,
  takeProfit2,
  runnerTrailMult: 1,
  entryTime,
  regime: 'BOM',
  entryType: 'breakout',
  riskUsd,
  tp1Executed: false,
  tp2Executed: false,
  rationale: [],
  equityAtEntry: new PreciseDecimal('100000'),
  entryAtrPct: 0.003,
  pyramidAdd: false,
  baseStopLoss: baseStop,
  stopGraceUntil: undefined,
  stopGracePrice: undefined,
  entryExecutionMode: 'taker',
  tp1Fraction: 1,
  tp2Fraction: 0,
  timeStopExpiry: entryTime + 30_000,
  telemetry: { scratchTriggered: false, microNudgeBps: 0 },
  scratchTriggered: false,
};

strategy.positions.set(timeSymbol, [timePosition]);

const timeTick = {
  symbol: timeSymbol,
  timestamp: entryTime + 120_000,
  price: 100,
  candles: {
    '1m': tick.candles['1m'],
    '5m': [],
    '15m': [],
  },
  orderBook: null,
  aggression: null,
  newsSpike: false,
};

const neutralFeatures = {
  '1m': {
    ...features['1m'],
    orderBook: { imbalance: 0, imbalanceDelta: 0, aggressionRatio: 0.5 },
  },
  '5m': features['1m'],
  '15m': features['1m'],
};

const exits = strategy.evaluateExits(timeTick, neutralFeatures);
assert.ok(exits.some((exit) => exit.reason === 'time'), 'Time stop should trigger a full exit');

console.log('✅ intraday-dual-management.mjs passed');
