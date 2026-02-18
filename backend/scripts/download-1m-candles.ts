/**
 * Download 1m candle data for exhaustion detector backtesting.
 *
 * 1m data is needed to properly simulate the exhaustion detector, which
 * in live trading runs on closed 1m candles within each 15m bar.
 *
 * Data size: ~525K candles/symbol/year → ~50MB per symbol JSON
 * Time: ~70s per symbol (350 requests × 200ms delay)
 * Total: ~12 minutes for 10 symbols, ~500MB disk
 *
 * Run: npx tsx scripts/download-1m-candles.ts
 *
 * Optional args:
 *   --start 2025-06-01   Start date (default: 2025-01-01)
 *   --end   2025-12-31   End date (default: 2025-12-31)
 *   --symbol BTC         Download only one symbol
 */

import * as ccxt from 'ccxt';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SYMBOLS = [
  'DOGE/USDT:USDT', 'DOT/USDT:USDT', 'WIF/USDT:USDT', 'IMX/USDT:USDT',
  'FET/USDT:USDT', 'AVAX/USDT:USDT', 'ADA/USDT:USDT', 'TIA/USDT:USDT',
  'STX/USDT:USDT', 'BTC/USDT:USDT',
];

const CANDLE_1M_MS = 60 * 1000;
const DATA_DIR = path.resolve(process.cwd(), 'data');

function parseArgs() {
  const args = process.argv.slice(2);
  let startDate = '2025-01-01';
  let endDate = '2025-12-31';
  let symbolFilter: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) startDate = args[i + 1];
    if (args[i] === '--end' && args[i + 1]) endDate = args[i + 1];
    if (args[i] === '--symbol' && args[i + 1]) symbolFilter = args[i + 1].toUpperCase();
  }

  return { startDate, endDate, symbolFilter };
}

function symbolToFilename(sym: string): string {
  return sym.toUpperCase().replace(':USDT', '').replace(/\//g, '_');
}

async function main() {
  const { startDate, endDate, symbolFilter } = parseArgs();

  // Add extra warmup: 200 candles × 1min = ~3.3 hours before start
  const warmupMs = 200 * CANDLE_1M_MS;
  const START = new Date(startDate + 'T00:00:00.000Z').getTime() - warmupMs;
  const END = new Date(endDate + 'T23:59:59.999Z').getTime();

  let symbols = DEFAULT_SYMBOLS;
  if (symbolFilter) {
    symbols = DEFAULT_SYMBOLS.filter(s => s.includes(symbolFilter!));
    if (symbols.length === 0) {
      console.error(`No symbol matches filter: ${symbolFilter}`);
      process.exit(1);
    }
  }

  console.log(`Downloading 1m candles for ${symbols.length} symbol(s)`);
  console.log(`  Period: ${new Date(START).toISOString().slice(0, 10)} → ${new Date(END).toISOString().slice(0, 10)}`);
  console.log(`  Output: ${DATA_DIR}\n`);

  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();

  for (const symbol of symbols) {
    const fname = `${symbolToFilename(symbol)}_1m.json`;
    const fpath = path.join(DATA_DIR, fname);

    // Check for existing data to resume
    let allCandles: any[] = [];
    let since = START;

    if (fs.existsSync(fpath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(fpath, 'utf8'));
        const candles = existing.candles || existing;
        if (Array.isArray(candles) && candles.length > 0) {
          allCandles = candles;
          const lastTs = Array.isArray(candles[candles.length - 1])
            ? candles[candles.length - 1][0]
            : candles[candles.length - 1].openTime || candles[candles.length - 1].timestamp;
          if (lastTs >= since) {
            since = lastTs + CANDLE_1M_MS;
            console.log(`  Resuming ${symbol} from ${new Date(since).toISOString()} (${allCandles.length} existing)`);
          }
        }
      } catch {
        // Corrupted file, start fresh
      }
    }

    if (since >= END) {
      console.log(`  ${symbol} already complete (${allCandles.length} candles)`);
      continue;
    }

    console.log(`\nDownloading ${symbol} 1m → ${fname}`);
    const startTime = Date.now();
    let requests = 0;

    while (since < END) {
      try {
        const ohlcv = await exchange.fetchOHLCV(symbol, '1m', since, 1500);
        requests++;

        if (!ohlcv || ohlcv.length === 0) break;

        for (const c of ohlcv) {
          const ts = c[0] as number;
          if (ts > END) break;
          allCandles.push([ts, c[1], c[2], c[3], c[4], c[5]]);
        }

        since = (ohlcv[ohlcv.length - 1][0] as number) + CANDLE_1M_MS;
        const pct = ((since - START) / (END - START) * 100).toFixed(1);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        process.stdout.write(
          `  ${allCandles.length.toLocaleString()} candles | ${pct}% | ${elapsed}s | ${requests} requests\r`
        );

        await new Promise(r => setTimeout(r, 200));

        // Save checkpoint every 50 requests
        if (requests % 50 === 0) {
          // Deduplicate before saving
          const deduped = deduplicateCandles(allCandles);
          fs.writeFileSync(fpath, JSON.stringify({ candles: deduped }));
        }
      } catch (err: any) {
        if (err.message?.includes('429') || err.message?.includes('rate')) {
          console.warn(`\n  Rate limited, waiting 30s...`);
          await new Promise(r => setTimeout(r, 30000));
        } else {
          console.warn(`\n  Error: ${err.message}, retrying in 5s...`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }

    // Final save with deduplication
    const deduped = deduplicateCandles(allCandles);
    fs.writeFileSync(fpath, JSON.stringify({ candles: deduped }));
    const sizeMB = (fs.statSync(fpath).size / 1024 / 1024).toFixed(1);
    const elapsedTotal = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`\n  Done: ${deduped.length.toLocaleString()} candles | ${sizeMB}MB | ${elapsedTotal}s | ${requests} requests`);
  }

  console.log('\nAll downloads complete!');
}

function deduplicateCandles(candles: any[]): number[][] {
  const seen = new Set<number>();
  const deduped: number[][] = [];
  for (const c of candles) {
    const ts = Array.isArray(c) ? c[0] : (c.openTime || c.timestamp);
    if (seen.has(ts)) continue;
    seen.add(ts);
    if (Array.isArray(c)) {
      deduped.push(c);
    } else {
      deduped.push([c.openTime || c.timestamp, c.open, c.high, c.low, c.close, c.volume]);
    }
  }
  return deduped.sort((a, b) => a[0] - b[0]);
}

main().catch(e => { console.error(e); process.exit(1); });
