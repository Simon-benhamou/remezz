import { configureLogging, createLogger } from '../src/utils/logger.js';
import { runMetaAdaptiveBacktest, buildMetaAdaptiveSyntheticCandles } from '../src/quantai/strategies/metaAdaptive/backtest.js';

const level = configureLogging();
const logger = createLogger('meta-adaptive-backtest');
logger.debug('Initialized Meta-Adaptive candle backtest logger', { level });

if (process.env.DISABLE_PYTHON_PREDICTOR !== 'false') {
  process.env.DISABLE_PYTHON_PREDICTOR = 'true';
}

const candles = buildMetaAdaptiveSyntheticCandles();
const equityUsd = 75_000;

const result = await runMetaAdaptiveBacktest(candles, {
  symbol: 'ETH/USDT',
  equityUsd,
  slippageBps: 5,
  makerFeeBps: 1.8,
  takerFeeBps: 4.8,
  fundingAnnualPct: 6,
  latencyMs: 150,
  impactBpsPerMillion: 4,
});

if (!result.trades.length) {
  logger.warn('Meta-Adaptive backtest produced no trades');
} else {
  logger.info('Meta-Adaptive trade log', { trades: result.trades.length });
  for (const trade of result.trades.slice(0, 10)) {
    logger.info('trade', {
      time: new Date(trade.timestamp).toISOString(),
      side: trade.side,
      qty: trade.quantity.toFixed(4),
      price: trade.price.toFixed(2),
      pnl: trade.cumulativePnl.toFixed(2),
      reason: trade.reason,
      holdMinutes: Math.round(trade.holdDurationMs / 60000),
    });
  }
}

const metrics = result.metrics;
logger.info('Meta-Adaptive candle backtest metrics', {
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

if (result.walkForward?.length) {
  for (const segment of result.walkForward) {
    logger.info('walk-forward', {
      start: new Date(segment.start).toISOString(),
      end: new Date(segment.end).toISOString(),
      cagr: segment.metrics.cagr.toFixed(6),
      sharpe: segment.metrics.sharpe.toFixed(6),
      maxDrawdownPct: segment.metrics.maxDrawdownPct.toFixed(4),
    });
  }
}
