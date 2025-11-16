#!/usr/bin/env tsx

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { loadHistoricalOhlcv } from '../src/infra/market/loadHistoricalOhlcv.js';

interface CliArgs {
  symbol: string;
  timeframe: string;
  days: number;
  exchange?: string;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=');
    const key = rawKey.toLowerCase();
    const value = inlineValue ?? argv[i + 1];
    const consumeNext = inlineValue == null;
    switch (key) {
      case 'symbol':
        args.symbol = String(value ?? '').toUpperCase();
        break;
      case 'timeframe':
        args.timeframe = String(value ?? '').toLowerCase();
        break;
      case 'days':
        args.days = Number(value);
        break;
      case 'exchange':
        args.exchange = String(value ?? '').toLowerCase();
        break;
      case 'out':
        args.out = String(value ?? '');
        break;
      default:
        console.warn(`Unknown flag --${rawKey} (ignored)`);
    }
    if (consumeNext && inlineValue == null) {
      i += 1;
    }
  }
  if (!args.symbol) {
    throw new Error('Missing required --symbol');
  }
  if (!args.timeframe) {
    throw new Error('Missing required --timeframe');
  }
  if (!(Number.isFinite(args.days) && (args.days ?? 0) > 0)) {
    throw new Error('Missing required --days');
  }
  return args as CliArgs;
}

function normalizeCandlesForExport(candles: { timestamp: number; open: number; high: number; low: number; close: number; volume: number; }[]) {
  return candles.map((candle) => [
    candle.timestamp,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
  ]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = Math.ceil(args.days);
  console.log(`📡 Fetching ${days} days of ${args.timeframe} candles for ${args.symbol}...`);
  const { candles, metadata } = await loadHistoricalOhlcv({
    symbol: args.symbol,
    timeframe: args.timeframe,
    days,
    exchangeId: args.exchange,
  });
  console.log(`✅ Retrieved ${candles.length} candles from ${metadata.exchange ?? metadata.datasource}.`);

  const payload = {
    symbol: args.symbol,
    timeframe: args.timeframe,
    days,
    fetchedAt: new Date().toISOString(),
    exchange: metadata.exchange,
    candles: normalizeCandlesForExport(candles),
  };

  const outPath = path.resolve(args.out || path.join('logs', `${args.symbol.toLowerCase()}-${args.timeframe}.json`));
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`💾 Saved dataset to ${outPath}`);
}

main().catch((error) => {
  console.error('❌ Failed to fetch OHLCV dataset:', error);
  process.exitCode = 1;
});
