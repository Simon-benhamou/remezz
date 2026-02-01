/**
 * Download 12+ months of 15m candle data for all symbols.
 * Saves to backend/data/<SYMBOL>_15m.json
 *
 * Run: npx tsx scripts/download-historical-15m.ts
 */

import * as ccxt from 'ccxt';
import fs from 'node:fs';
import path from 'node:path';

const SYMBOLS = [
  'BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT',
  'XRP/USDT:USDT', 'SUI/USDT:USDT', 'SEI/USDT:USDT', 'IMX/USDT:USDT',
  'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'ADA/USDT:USDT', 'DOT/USDT:USDT',
  'LTC/USDT:USDT', 'UNI/USDT:USDT', 'FTM/USDT:USDT', 'SONIC/USDT:USDT',
  'APT/USDT:USDT', 'ATOM/USDT:USDT', 'BCH/USDT:USDT', 'OP/USDT:USDT',
  'NEAR/USDT:USDT', 'ARB/USDT:USDT',
];

// 12 months back
const END = Date.now();
const START = END - 12 * 30 * 24 * 60 * 60 * 1000;

const DATA_DIR = path.resolve(process.cwd(), 'data');

function symbolToFilename(sym: string): string {
  return sym.toUpperCase().replace(':USDT', '').replace(/\//g, '_');
}

async function main() {
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();

  for (const symbol of SYMBOLS) {
    const fname = `${symbolToFilename(symbol)}_15m.json`;
    const fpath = path.join(DATA_DIR, fname);

    console.log(`\n📥 ${symbol} → ${fname}`);

    const allCandles: any[] = [];
    let since = START;

    while (since < END) {
      try {
        const ohlcv = await exchange.fetchOHLCV(symbol, '15m', since, 1000);
        if (!ohlcv || ohlcv.length === 0) break;

        for (const c of ohlcv) {
          allCandles.push({
            openTime: c[0],
            open: c[1],
            high: c[2],
            low: c[3],
            close: c[4],
            volume: c[5],
          });
        }

        since = (ohlcv[ohlcv.length - 1][0] as number) + 15 * 60 * 1000;
        process.stdout.write(`  ${allCandles.length} candles (${new Date(since).toISOString().slice(0, 10)})...\r`);

        // Small delay to respect rate limits
        await new Promise(r => setTimeout(r, 200));
      } catch (err: any) {
        console.warn(`  ⚠ Error: ${err.message}, retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    // Deduplicate by openTime
    const seen = new Set<number>();
    const deduped = allCandles.filter(c => {
      if (seen.has(c.openTime)) return false;
      seen.add(c.openTime);
      return true;
    });

    fs.writeFileSync(fpath, JSON.stringify(deduped));
    console.log(`  ✅ ${deduped.length} candles saved (${(fs.statSync(fpath).size / 1024 / 1024).toFixed(1)}MB)`);
  }

  console.log('\nDone!');
}

main().catch(err => { console.error(err); process.exit(1); });
