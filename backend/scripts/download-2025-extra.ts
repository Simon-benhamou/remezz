/**
 * Download 2025 15m candle data for symbols NOT already in main data/ directory.
 * These symbols only exist in data/2024/ which stops at Jan 2025.
 * Saves to backend/data/<SYMBOL>_USDT_15m.json (same format as existing files)
 *
 * Run: npx tsx scripts/download-2025-extra.ts
 */

import * as ccxt from 'ccxt';
import fs from 'node:fs';
import path from 'node:path';

// Symbols that exist in data/2024/ but NOT in main data/
const EXTRA_SYMBOLS = [
  'SOL/USDT:USDT', 'ETH/USDT:USDT', 'XRP/USDT:USDT',
  'SEI/USDT:USDT', 'SUI/USDT:USDT', 'RENDER/USDT:USDT',
  'LINK/USDT:USDT', 'NEAR/USDT:USDT', 'APT/USDT:USDT',
  'ARB/USDT:USDT', 'OP/USDT:USDT', 'ATOM/USDT:USDT',
  'BCH/USDT:USDT', 'LTC/USDT:USDT', 'UNI/USDT:USDT',
  'FTM/USDT:USDT', 'SONIC/USDT:USDT',
];

// Warmup from late 2024 for SMA200
const START = new Date('2024-10-01').getTime();
const END = new Date('2026-02-25').getTime(); // up to today

const DATA_DIR = path.resolve(process.cwd(), 'data');

function symbolToFilename(sym: string): string {
  return sym.toUpperCase().replace(':USDT', '').replace(/\//g, '_');
}

async function main() {
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();

  for (const symbol of EXTRA_SYMBOLS) {
    const fname = `${symbolToFilename(symbol)}_15m.json`;
    const fpath = path.join(DATA_DIR, fname);

    // Skip if already exists with substantial data
    if (fs.existsSync(fpath) && fs.statSync(fpath).size > 500000) {
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
