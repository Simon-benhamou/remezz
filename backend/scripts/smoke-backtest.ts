import { configureLogging, createLogger } from '../src/utils/logger.js';
import type { Candle } from '../src/quantai/intraday/types.js';
import { runIntradayBacktest } from '../src/quantai/intraday/backtest.js';
import { loadIntradayConfig, overrideIntradayConfig } from '../src/quantai/intraday/config/index.js';

const level = configureLogging();
const logger = createLogger('smoke-backtest');
logger.debug('Initialized smoke backtest logger', { level });

const baseConfig = loadIntradayConfig();
overrideIntradayConfig({
  ...baseConfig,
  entry: {
    ...baseConfig.entry,
    bom: {
      ...baseConfig.entry.bom,
      atrMinPct: 0.001,
      volumeZMin: 0.5,
      aggressionMin: 0.5,
      confirmationBars: 0,
      pyramidMaxAdds: 1,
      pyramidPullbackBps: 60,
      pyramidScale: 0.3,
    },
    mr: {
      ...baseConfig.entry.mr,
      atrMaxPct: 0.5,
      priceZScore: 1.2,
      wickMinPct: 0.001,
      obiExtreme: 0.3,
      obiDeltaMin: 0.02,
    },
  },
  stops: {
    ...baseConfig.stops,
    tp: {
      ...baseConfig.stops.tp,
      firstPct: 0.005,
      secondPct: 0.012,
    },
  },
});

function makeFlatCandles(count: number, price: number, volumeStart = 250): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: 1_700_600_000_000 + i * 60_000,
    open: price,
    high: price * 1.005,
    low: price * 0.995,
    close: price,
    volume: volumeStart + i * 2,
  }));
}

function applyBreakout(candles: Candle[], params: { growth: number; window: number; volumeBase: number; volumeStep: number }) {
  const { growth, window, volumeBase, volumeStep } = params;
  let price = candles[candles.length - window - 1].close;
  for (let i = candles.length - window; i < candles.length; i++) {
    price *= growth;
    const progress = i - (candles.length - window);
    candles[i].open = price / 1.02;
    candles[i].close = price;
    candles[i].high = price * 1.01;
    candles[i].low = price * 0.985;
    candles[i].volume += volumeBase + progress * volumeStep;
  }
}

function extendAfterBreakout(candles: Candle[], params: { followBars: number; drift: number; pullback: number }) {
  const { followBars, drift, pullback } = params;
  let price = candles[candles.length - 1].close;
  for (let i = 0; i < followBars; i++) {
    price *= 1 + drift;
    const timestamp = candles[candles.length - 1].timestamp + 60_000;
    candles.push({
      timestamp,
      open: price * 0.996,
      high: price * 1.004,
      low: price * 0.99,
      close: price,
      volume: candles[candles.length - 1].volume * 0.9,
    });
  }
  let pullbackPrice = price;
  for (let j = 0; j < 6; j++) {
    pullbackPrice *= 1 - pullback;
    const timestamp = candles[candles.length - 1].timestamp + 60_000;
    candles.push({
      timestamp,
      open: pullbackPrice * 1.002,
      high: pullbackPrice * 1.004,
      low: pullbackPrice * 0.985,
      close: pullbackPrice,
      volume: candles[candles.length - 1].volume * 1.1,
    });
  }
}

function generateSyntheticCandles(): Candle[] {
  const base = makeFlatCandles(220, 100);
  applyBreakout(base, { growth: 1.055, window: 40, volumeBase: 4_000, volumeStep: 650 });
  extendAfterBreakout(base, { followBars: 30, drift: 0.012, pullback: 0.02 });
  return base;
}

function printTradeLog(result: ReturnType<typeof runIntradayBacktest>): void {
  if (!result.trades.length) {
    logger.warn('No trades generated in smoke scenario');
    if (result.signals.length) {
      const first = result.signals[0];
      logger.info('first_signal', {
        regime: first.regime,
        side: first.side,
        entryPrice: first.triggerPrice.toFixed(2),
        stopLoss: first.stopLossPrice.toFixed(2),
        tp1: first.takeProfit1.toFixed(2),
        tp2: first.takeProfit2.toFixed(2),
        confidence: first.confidence.toFixed(4),
        rationale: first.rationale,
      });
    }
    return;
  }
  for (const trade of result.trades) {
    logger.info('trade', {
      time: new Date(trade.timestamp).toISOString(),
      side: trade.side,
      qty: trade.quantity.toFixed(4),
      price: trade.price.toFixed(2),
      cumulativePnl: trade.cumulativePnl.toFixed(2),
      reason: trade.reason,
    });
  }
}

const candles = generateSyntheticCandles();
const equityUsd = 50_000;
const result = runIntradayBacktest(candles, {
  symbol: 'BTCUSDT',
  equityUsd,
  slippageBps: 4,
});

printTradeLog(result);

const metrics = result.metrics;
logger.info('Intraday dual strategy smoke metrics', {
  trades: result.trades.length,
  totalReturnPct: metrics.totalReturnPct.toFixed(4),
  cagr: metrics.cagr.toFixed(6),
  sharpe: metrics.sharpe.toFixed(6),
  maxDrawdownPct: metrics.maxDrawdownPct.toFixed(4),
  hitRate: metrics.hitRate.toFixed(4),
  profitFactor: metrics.profitFactor.toFixed(4),
  avgWin: metrics.avgWin.toFixed(4),
  avgLoss: metrics.avgLoss.toFixed(4),
});
