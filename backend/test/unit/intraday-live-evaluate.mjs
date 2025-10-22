import assert from 'node:assert/strict';

const { IntradayDualStrategy } = await import('../../dist/src/quantai/strategies/intradayDual/strategy.js');
const { PreciseDecimal } = await import('../../dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
const { loadIntradayConfig, overrideIntradayConfig } = await import('../../dist/src/quantai/strategies/intradayDual/config/index.js');

function buildSeries({ count, startPrice, drift, timeframeMinutes, volume }) {
  const candles = [];
  const baseTs = Date.now() - count * timeframeMinutes * 60_000;
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const ts = baseTs + i * timeframeMinutes * 60_000;
    const open = price;
    const close = price * (1 + drift);
    const high = Math.max(open, close) * 1.001;
    const low = Math.min(open, close) * 0.999;
    candles.push({ timestamp: ts, open, high, low, close, volume });
    price = close;
  }
  return candles;
}

const base1m = buildSeries({ count: 240, startPrice: 100, drift: 0.0005, timeframeMinutes: 1, volume: 900 });
const base5m = buildSeries({ count: 180, startPrice: 100, drift: 0.0003, timeframeMinutes: 5, volume: 4500 });
const base15m = buildSeries({ count: 180, startPrice: 100, drift: 0.0002, timeframeMinutes: 15, volume: 12000 });

const breakout1m = base1m.map((c, idx) => {
  if (idx < base1m.length - 8) return { ...c };
  const boost = idx >= base1m.length - 2 ? 1.04 : 1.02;
  return {
    timestamp: c.timestamp,
    open: c.open * boost,
    high: c.high * boost * 1.002,
    low: c.low * boost * 0.999,
    close: c.close * boost,
    volume: 20000,
  };
});

const breakout5m = base5m.map((c, idx) => {
  if (idx < base5m.length - 4) return { ...c };
  const boost = 1.015;
  return { ...c, open: c.open * boost, high: c.high * boost * 1.002, low: c.low * boost * 0.999, close: c.close * boost, volume: 18000 };
});

const breakout15m = base15m.map((c, idx) => {
  if (idx < base15m.length - 2) return { ...c };
  const boost = 1.01;
  return { ...c, open: c.open * boost, high: c.high * boost * 1.001, low: c.low * boost * 0.999, close: c.close * boost, volume: 15000 };
});

const orderBook = {
  timestamp: Date.now(),
  bids: [{ price: breakout1m[breakout1m.length - 1].close * 0.999, size: 400 }],
  asks: [{ price: breakout1m[breakout1m.length - 1].close * 1.001, size: 120 }],
};

const baselineConfig = loadIntradayConfig();
const relaxedConfig = JSON.parse(JSON.stringify(baselineConfig));
relaxedConfig.entry.bom.atrMinPct = 0.0001;
relaxedConfig.entry.bom.volumeZMin = 0;
relaxedConfig.entry.bom.aggressionMin = 0.45;
relaxedConfig.entry.bom.confirmationBars = 0;
overrideIntradayConfig(relaxedConfig);

const strategy = new IntradayDualStrategy();
const ctx = {
  equityUsd: new PreciseDecimal(10000),
  maxLevInstrument: 5,
  maxLevGlobal: 5,
  exposureBudget: 1,
  slippageBps: 5,
};

strategy.evaluateTick({
  symbol: 'TEST/USDT',
  timestamp: Date.now() - 60_000,
  price: base1m[base1m.length - 1].close,
  candles: { '1m': base1m, '5m': base5m, '15m': base15m },
  orderBook,
  aggression: { timestamp: Date.now() - 60_000, takerBuy: 800, takerSell: 700 },
}, ctx);

const evaluation = strategy.evaluateTick({
  symbol: 'TEST/USDT',
  timestamp: Date.now(),
  price: breakout1m[breakout1m.length - 1].close,
  candles: { '1m': breakout1m, '5m': breakout5m, '15m': breakout15m },
  orderBook,
  aggression: { timestamp: Date.now(), takerBuy: 3500, takerSell: 400 },
}, ctx);

overrideIntradayConfig(baselineConfig);

const entry = evaluation.entries[0];
assert.ok(entry, 'expected breakout entry to trigger');
assert.equal(entry.entryType, 'breakout', 'entry should be breakout');
assert.equal(entry.side, 'long', 'breakout should favor long side');
assert.ok(entry.takeProfit1.toNumber() > entry.triggerPrice.toNumber(), 'tp1 should exceed entry price');
assert.ok(entry.takeProfit2.toNumber() > entry.takeProfit1.toNumber(), 'tp2 should exceed tp1');
assert.ok(entry.stopLossPrice.toNumber() < entry.triggerPrice.toNumber(), 'stop should be below entry');

console.log('✓ intraday dual strategy triggers breakout entry');
