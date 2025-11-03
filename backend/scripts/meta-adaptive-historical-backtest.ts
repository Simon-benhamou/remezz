import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '../src/quantai/strategies/intradayDual/types.js';
import { runMetaAdaptiveBacktest } from '../src/quantai/strategies/metaAdaptive/backtest.js';

type CliOptions = {
  symbol: string;
  days: number;
  timeframe: string;
  equityUsd: number;
  makerFeeBps?: number;
  takerFeeBps?: number;
  slippageBps?: number;
  fundingAnnualPct?: number;
  latencyMs?: number;
  impactBpsPerMillion?: number;
  outputPath?: string | null;
};

type HistoricalCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function parseCliOptions(): CliOptions {
  const defaults: CliOptions = {
    symbol: process.env.META_BT_SYMBOL ?? process.env.SMOKE_SYMBOL ?? 'ETH/USDT',
    days: Number.parseFloat(process.env.META_BT_DAYS ?? process.env.SMOKE_DAYS ?? '10') || 10,
    timeframe: process.env.META_BT_TIMEFRAME ?? process.env.SMOKE_TIMEFRAME ?? '1m',
    equityUsd: Number.parseFloat(process.env.META_BT_EQUITY ?? '60000') || 60_000,
    makerFeeBps: process.env.META_BT_MAKER_FEE ? Number.parseFloat(process.env.META_BT_MAKER_FEE) : undefined,
    takerFeeBps: process.env.META_BT_TAKER_FEE ? Number.parseFloat(process.env.META_BT_TAKER_FEE) : undefined,
    slippageBps: process.env.META_BT_SLIPPAGE ? Number.parseFloat(process.env.META_BT_SLIPPAGE) : undefined,
    fundingAnnualPct: process.env.META_BT_FUNDING ? Number.parseFloat(process.env.META_BT_FUNDING) : undefined,
    latencyMs: process.env.META_BT_LATENCY ? Number.parseInt(process.env.META_BT_LATENCY, 10) : undefined,
    impactBpsPerMillion: process.env.META_BT_IMPACT ? Number.parseFloat(process.env.META_BT_IMPACT) : undefined,
    outputPath: process.env.META_BT_OUTPUT ?? null,
  };

  const args = process.argv.slice(2);
  for (const arg of args) {
    const [rawKey, rawValue] = arg.split('=');
    if (!rawKey || rawValue === undefined) continue;
    const key = rawKey.replace(/^--/, '').toLowerCase();
    const value = rawValue.trim();
    switch (key) {
      case 'symbol':
        defaults.symbol = value.toUpperCase();
        break;
      case 'days':
        defaults.days = Number.parseFloat(value) || defaults.days;
        break;
      case 'timeframe':
        defaults.timeframe = value;
        break;
      case 'equity':
      case 'equityusd':
        defaults.equityUsd = Number.parseFloat(value) || defaults.equityUsd;
        break;
      case 'makerfeebps':
        defaults.makerFeeBps = Number.parseFloat(value);
        break;
      case 'takerfeebps':
        defaults.takerFeeBps = Number.parseFloat(value);
        break;
      case 'slippagebps':
        defaults.slippageBps = Number.parseFloat(value);
        break;
      case 'fundingannualpct':
        defaults.fundingAnnualPct = Number.parseFloat(value);
        break;
      case 'latencyms':
        defaults.latencyMs = Number.parseInt(value, 10);
        break;
      case 'impactbpspermillion':
        defaults.impactBpsPerMillion = Number.parseFloat(value);
        break;
      case 'output':
      case 'outputpath':
        defaults.outputPath = value.length ? value : null;
        break;
      default:
        break;
    }
  }

  return defaults;
}

function toCandle(candle: HistoricalCandle): Candle {
  return {
    timestamp: Number(candle.timestamp),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume ?? 0),
  };
}

function formatPercent(value: number, alreadyScaled = false): string {
  const scaled = alreadyScaled ? value : value * 100;
  return `${scaled.toFixed(2)}%`;
}

function summarizeByFamily(trades: ReturnType<typeof runMetaAdaptiveBacktest>['trades']) {
  const stats = new Map<string, { trades: number; wins: number; pnl: number }>();
  for (const trade of trades) {
    const family = typeof trade.meta?.family === 'string' ? trade.meta.family : 'unknown';
    const existing = stats.get(family) ?? { trades: 0, wins: 0, pnl: 0 };
    existing.trades += 1;
    const tradePnl = typeof trade.cumulativePnl.toNumber === 'function'
      ? trade.cumulativePnl.toNumber()
      : Number(trade.cumulativePnl);
    existing.pnl += tradePnl;
    if (tradePnl >= 0) existing.wins += 1;
    stats.set(family, existing);
  }
  return Array.from(stats.entries()).map(([family, { trades, wins, pnl }]) => ({
    family,
    trades,
    wins,
    losses: trades - wins,
    winRate: trades > 0 ? wins / trades : 0,
    pnl,
  }));
}

async function main() {
  const options = parseCliOptions();
  if (!options.symbol) {
    throw new Error('Symbol is required for historical backtest');
  }
  const normalizedTimeframe = options.timeframe || '1m';
  const normalizedDays = Math.max(1, Math.floor(options.days));

  const { loadHistoricalOhlcv } = await import('../src/infra/market/loadHistoricalOhlcv.js');
  const { candles, metadata } = await loadHistoricalOhlcv({
    symbol: options.symbol,
    timeframe: normalizedTimeframe,
    days: normalizedDays,
    exchangeId: process.env.META_BT_EXCHANGE ?? process.env.SMOKE_EXCHANGE ?? undefined,
  });

  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error(`No OHLCV data returned for ${options.symbol} (${normalizedTimeframe}, ${normalizedDays}d)`);
  }

  const typedCandles: Candle[] = candles.map(toCandle);
  const backtest = runMetaAdaptiveBacktest(typedCandles, {
    symbol: options.symbol,
    equityUsd: options.equityUsd,
    makerFeeBps: options.makerFeeBps,
    takerFeeBps: options.takerFeeBps,
    slippageBps: options.slippageBps,
    fundingAnnualPct: options.fundingAnnualPct,
    latencyMs: options.latencyMs,
    impactBpsPerMillion: options.impactBpsPerMillion,
    strategyHealthWarmupTrades: 8,
    disableStrategyHealthRisk: true,
  });

  const { metrics, trades, walkForward } = backtest;
  const familySummary = summarizeByFamily(trades);

  console.log('--- Meta Adaptive Historical Backtest ---');
  console.log(`Symbol: ${options.symbol}`);
  console.log(`Window: ${normalizedDays} days | timeframe: ${normalizedTimeframe}`);
  if (metadata?.startTimestamp && metadata?.endTimestamp) {
    console.log(`Data span: ${new Date(metadata.startTimestamp).toISOString()} → ${new Date(metadata.endTimestamp).toISOString()}`);
  }
  console.log(`Candles: ${typedCandles.length}`);
  console.log('');
  console.log('Performance Metrics');
  console.log(`- Total Return: ${formatPercent(metrics.totalReturnPct, true)}`);
  console.log(`- CAGR: ${formatPercent(metrics.cagr)}`);
  console.log(`- Sharpe-like: ${metrics.sharpe.toFixed(2)}`);
  console.log(`- Max Drawdown: ${formatPercent(metrics.maxDrawdownPct, true)}`);
  console.log(`- Hit Rate: ${(metrics.hitRate * 100).toFixed(2)}%`);
  console.log(`- Profit Factor: ${metrics.profitFactor.toFixed(2)}`);
  console.log(`- Avg Win: ${metrics.avgWin.toFixed(2)} | Avg Loss: ${metrics.avgLoss.toFixed(2)}`);
  console.log('');
  console.log(`Trades: ${trades.length}`);
  console.table(familySummary.map((entry) => ({
    family: entry.family,
    trades: entry.trades,
    winRate: `${(entry.winRate * 100).toFixed(1)}%`,
    pnlUsd: entry.pnl.toFixed(2),
  })));

  if (Array.isArray(walkForward) && walkForward.length) {
    console.log('');
    console.log('Walk-forward segments:');
    for (const segment of walkForward) {
      const startIso = new Date(segment.start).toISOString();
      const endIso = new Date(segment.end).toISOString();
      const dd = formatPercent(segment.metrics.maxDrawdownPct, true);
      console.log(`- ${startIso} → ${endIso} | PF=${segment.metrics.profitFactor.toFixed(2)} | DD=${dd} | Sharpe=${segment.metrics.sharpe.toFixed(2)}`);
    }
  }

  if (options.outputPath) {
    const resolved = path.resolve(options.outputPath);
    const payload = {
      options,
      metadata,
      metrics,
      trades: trades.map((trade) => ({
        ...trade,
        quantity: trade.quantity.toNumber?.() ?? Number(trade.quantity),
        price: trade.price.toNumber?.() ?? Number(trade.price),
        cumulativePnl: trade.cumulativePnl.toNumber?.() ?? Number(trade.cumulativePnl),
      })),
      walkForward,
    };
    fs.writeFileSync(resolved, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`\nBacktest payload written to ${resolved}`);
  }
}

main().catch((error) => {
  console.error('[meta-adaptive-historical-backtest] failed:', error);
  process.exitCode = 1;
});
