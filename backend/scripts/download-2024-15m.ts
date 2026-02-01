/**
 * Download full year 2024 15m candle data for all symbols.
 * Saves to backend/data/2024/<SYMBOL>_15m.json (separate dir to not overwrite)
 *
 * Run: npx tsx scripts/download-2024-15m.ts
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

// Full 2024 + a bit of warmup from late 2023
const START = new Date('2023-11-01').getTime(); // warmup for SMA200
const END = new Date('2025-01-01').getTime();

const DATA_DIR = path.resolve(process.cwd(), 'data', '2024');

function symbolToFilename(sym: string): string {
  return sym.toUpperCase().replace(':USDT', '').replace(/\//g, '_');
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();

  for (const symbol of SYMBOLS) {
    const fname = `${symbolToFilename(symbol)}_15m.json`;
    const fpath = path.join(DATA_DIR, fname);

    // Skip if already downloaded
    if (fs.existsSync(fpath) && fs.statSync(fpath).size > 1000000) {
      console.log(`⏭ ${symbol} already exists (${(fs.statSync(fpath).size/1024/1024).toFixed(1)}MB)`);
      continue;
    }

    console.log(`\n📥 ${symbol} → ${fname}`);
    const allCandles: any[] = [];
    let since = START;

    while (since < END) {
      try {
        const ohlcv = await exchange.fetchOHLCV(symbol, '15m', since, 1000);
        if (!ohlcv || ohlcv.length === 0) break;
        for (const c of ohlcv) {
          if ((c[0] as number) >= END) break;
          allCandles.push({ openTime: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] });
        }
        since = (ohlcv[ohlcv.length - 1][0] as number) + 15 * 60 * 1000;
        process.stdout.write(`  ${allCandles.length} candles (${new Date(since).toISOString().slice(0, 10)})...\r`);
        await new Promise(r => setTimeout(r, 200));
      } catch (err: any) {
        console.warn(`  ⚠ ${err.message}, retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    const seen = new Set<number>();
    const deduped = allCandles.filter(c => { if (seen.has(c.openTime)) return false; seen.add(c.openTime); return true; });
    fs.writeFileSync(fpath, JSON.stringify(deduped));
    console.log(`  ✅ ${deduped.length} candles saved (${(fs.statSync(fpath).size/1024/1024).toFixed(1)}MB)`);
  }
  console.log('\nDone!');
}

main().catch(err => { console.error(err); process.exit(1); });
