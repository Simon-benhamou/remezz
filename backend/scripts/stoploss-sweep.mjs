#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadQuickTest() {
  try {
    const module = await import('../dist/src/sim/quicktest.js');
    if (!module?.runQuickTest) {
      throw new Error('runQuickTest not exported from dist/src/sim/quicktest.js');
    }
    return module.runQuickTest;
  } catch (err) {
    throw new Error(`Failed to load quicktest from dist. Run \`npm run build\` first. (${err?.message || err})`);
  }
}

function parseList(argValue, mapper = Number) {
  return argValue
    .split(',')
    .map(v => mapper(v.trim()))
    .filter(v => v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v)));
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

async function main() {
  const runQuickTest = await loadQuickTest();
  const args = process.argv.slice(2);
  const symbolsArg = args.find(arg => arg.startsWith('--symbols='));
  const hoursArg = args.find(arg => arg.startsWith('--hours='));
  const sweepArg = args.find(arg => arg.startsWith('--sweep='));
  const outfileArg = args.find(arg => arg.startsWith('--out='));
  const tfArg = args.find(arg => arg.startsWith('--tf='));

  const symbols = symbolsArg
    ? parseList(symbolsArg.split('=')[1], (v) => v)
    : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const hours = hoursArg ? Number(hoursArg.split('=')[1]) : 240;
  const sweep = sweepArg
    ? parseList(sweepArg.split('=')[1])
    : [0.75, 0.9, 1, 1.1, 1.25];
  const tf = tfArg ? tfArg.split('=')[1] : '15m';

  const outRows = [];

  for (const symbol of symbols) {
    console.log(`\n=== ${symbol} (${hours}h, multipliers: ${sweep.join(', ')}) ===`);
    let result;
    try {
      result = await runQuickTest(symbol, hours, undefined, {
        tf: tf === '5m' || tf === '15m' || tf === '1h' ? tf : '15m',
        stopDistanceSweep: sweep,
      });
    } catch (err) {
      console.error(`  ❌ Quicktest failed for ${symbol}:`, err?.message || err);
      continue;
    }

    const mid = result.validated.zone.mid || 1;
    const runs = result.runs.map((run) => {
      const stopPct = mid > 0 ? (run.stopDistance / mid) * 100 : 0;
      const expectancy = run.stats.expectancyR;
      const row = {
        symbol,
        multiplier: run.multiplier,
        stopDistance: run.stopDistance,
        stopPct,
        expectancy,
        winrate: run.stats.winrate,
        trades: run.stats.count,
      };
      outRows.push(row);
      console.log(
        `  mult=${formatNumber(run.multiplier, 2)} | stop=${formatNumber(stopPct, 2)}% | expectancy=${formatNumber(expectancy, 4)}R | winrate=${formatNumber(run.stats.winrate, 2)}% | trades=${run.stats.count}`
      );
      return row;
    });

    const best = runs
      .slice()
      .sort((a, b) => (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity))[0];
    if (best) {
      console.log(
        `  → Best multiplier: ${formatNumber(best.multiplier, 2)} (expectancy ${formatNumber(best.expectancy, 4)}R, stop ${formatNumber(best.stopPct, 2)}%)`
      );
    }
  }

  if (outfileArg) {
    const outputPath = path.resolve(process.cwd(), outfileArg.split('=')[1]);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(outRows, null, 2));
    console.log(`\nResults written to ${outputPath}`);
  }
}

main().catch((err) => {
  console.error('Stop-loss sweep failed:', err);
  process.exit(1);
});
