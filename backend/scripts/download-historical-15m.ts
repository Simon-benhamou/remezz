/**
 * Download 12+ months of 15m candle data for all symbols.
 * Saves to backend/data/<SYMBOL>_15m.json
 *
 * Run: npx tsx scripts/download-historical-15m.ts
 */

import * as ccxt from 'ccxt';
import fs from 'node:fs';
import path from 'node:path';

// Default 10 symbols (backtest defaults)
const SYMBOLS = [
  'AVAX/USDT:USDT', 'FET/USDT:USDT', 'WIF/USDT:USDT', 'DOT/USDT:USDT',
  'TIA/USDT:USDT', 'IMX/USDT:USDT', 'STX/USDT:USDT', 'DOGE/USDT:USDT',
  'ADA/USDT:USDT', 'BTC/USDT:USDT',
];

// ~14 months back (extra warmup for SMA200)
const END = Date.now();
const START = END - 14 * 30 * 24 * 60 * 60 * 1000;

const TIMEFRAMES = ['15m', '1h'] as const;

const DATA_DIR = path.resolve(process.cwd(), 'data');

function symbolToFilename(sym: string): string {
  return sym.toUpperCase().replace(':USDT', '').replace(/\//g, '_');
}

async function main() {
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();

  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      const fname = `${symbolToFilename(symbol)}_${tf}.json`;
      const fpath = path.join(DATA_DIR, fname);

      console.log(`\n📥 ${symbol} ${tf} → ${fname}`);

      const allCandles: any[] = [];
      let since = START;
      const increment = tf === '15m' ? 15 * 60 * 1000 : 60 * 60 * 1000;

      while (since < END) {
        try {
          const ohlcv = await exchange.fetchOHLCV(symbol, tf, since, 1000);
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

          since = (ohlcv[ohlcv.length - 1][0] as number) + increment;
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
  }

  console.log('\nDone!');
}

main().catch(err => { console.error(err); process.exit(1); });
