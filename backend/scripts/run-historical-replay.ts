#!/usr/bin/env tsx

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { runHistoricalReplay } from '../src/sim/historicalReplay.js';
import { loadCandlesFromFile } from '../src/sim/historicalFeed.js';

type CliArgs = {
  symbol: string;
  dataset: string;
  startBalance?: number;
  warmup?: number;
  maxBars?: number;
  logEvery?: number;
  cleanup?: boolean;
  jsonOut?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = { symbol: '', dataset: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=');
    const key = rawKey.toLowerCase();
    const nextValue = inlineValue ?? argv[i + 1];
    const consumeNext = inlineValue == null;
    switch (key) {
      case 'symbol':
        result.symbol = String(nextValue ?? '').toUpperCase();
        break;
      case 'dataset':
        result.dataset = String(nextValue ?? '');
        break;
      case 'start-balance':
        result.startBalance = Number(nextValue);
        break;
      case 'warmup':
        result.warmup = Number(nextValue);
        break;
      case 'max-bars':
        result.maxBars = Number(nextValue);
        break;
      case 'log-every':
        result.logEvery = Number(nextValue);
        break;
      case 'cleanup':
        result.cleanup = true;
        continue;
      case 'json-out':
        result.jsonOut = String(nextValue ?? '');
        break;
      default:
        console.warn(`Unknown flag --${rawKey} (ignored)`);
    }
    if (consumeNext && inlineValue == null) {
      i += 1;
    }
  }
  if (!result.symbol) {
    throw new Error('Missing required --symbol');
  }
  if (!result.dataset) {
    throw new Error('Missing required --dataset');
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = path.resolve(args.dataset);
  console.log(`📥 Loading candles from ${datasetPath}...`);
  const candles = await loadCandlesFromFile(datasetPath);
  console.log(`📚 Loaded ${candles.length} candles.`);

  const summary = await runHistoricalReplay({
    symbol: args.symbol,
    candles,
    startBalanceUsd: args.startBalance,
    warmupBars: args.warmup,
    maxBars: args.maxBars,
    logEvery: args.logEvery,
    cleanup: args.cleanup,
  });

  const payload = JSON.stringify(summary, null, 2);
  console.log('\n✅ Historical replay complete! Summary:\n');
  console.log(payload);

  if (args.jsonOut) {
    const outPath = path.resolve(args.jsonOut);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, payload, 'utf8');
    console.log(`\n💾 Summary written to ${outPath}`);
  }
}

main().catch((error) => {
  console.error('\n❌ Historical replay failed:', error);
  process.exitCode = 1;
});
