/**
 * Update Candle Data
 * ==================
 * Fetches latest candles from Binance and updates local JSON files.
 * Run this periodically (e.g., daily) to keep data fresh for parity verification.
 */

import * as fs from 'fs';
import * as path from 'path';
import ccxt, { Exchange } from 'ccxt';

const DATA_DIR = path.join(process.cwd(), 'data');

// Symbols to update
const SYMBOLS = [
  'BTC/USDT:USDT',
  'ETH/USDT:USDT',
  'SOL/USDT:USDT',
  'XRP/USDT:USDT',
  'ADA/USDT:USDT',
  'DOGE/USDT:USDT',
  'AVAX/USDT:USDT',
  'DOT/USDT:USDT',
  'LINK/USDT:USDT',
  'UNI/USDT:USDT',
  'ATOM/USDT:USDT',
  'BCH/USDT:USDT',
  'APT/USDT:USDT',
  'SUI/USDT:USDT',
  'SEI/USDT:USDT',
  'SONIC/USDT:USDT',
];

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function symbolToFilename(symbol: string, timeframe: string): string {
  // BTC/USDT:USDT -> BTC_USDT_15m.json
  const base = symbol.split('/')[0];
  return `${base}_USDT_${timeframe}.json`;
}

async function loadExistingCandles(filename: string): Promise<{ candles: Candle[]; lastTs: number }> {
  const filepath = path.join(DATA_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return { candles: [], lastTs: 0 };
  }

  try {
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const candles = data.candles || data;

    if (!Array.isArray(candles) || candles.length === 0) {
      return { candles: [], lastTs: 0 };
    }

    // Handle both object and array format
    const lastCandle = candles[candles.length - 1];
    const lastTs = Array.isArray(lastCandle) ? lastCandle[0] : lastCandle.timestamp;

    // Convert to object format if needed
    const normalizedCandles: Candle[] = candles.map((c: any) => {
      if (Array.isArray(c)) {
        return {
          timestamp: c[0],
          open: c[1],
          high: c[2],
          low: c[3],
          close: c[4],
          volume: c[5],
        };
      }
      return c;
    });

    return { candles: normalizedCandles, lastTs };
  } catch (e) {
    console.error(`Error loading ${filename}:`, e);
    return { candles: [], lastTs: 0 };
  }
}

async function fetchNewCandles(
  exchange: Exchange,
  symbol: string,
  timeframe: string,
  since: number,
  until: number
): Promise<Candle[]> {
  const candles: Candle[] = [];
  let cursor = since;

  while (cursor < until) {
    try {
      const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, cursor, 1000);

      if (!ohlcv || ohlcv.length === 0) {
        break;
      }

      for (const c of ohlcv) {
        const ts = c[0] as number;
        if (ts > until) break;
        if (candles.length && ts <= candles[candles.length - 1].timestamp) continue;

        candles.push({
          timestamp: ts,
          open: c[1] as number,
          high: c[2] as number,
          low: c[3] as number,
          close: c[4] as number,
          volume: c[5] as number,
        });
      }

      const lastTs = ohlcv[ohlcv.length - 1][0] as number;
      if (lastTs <= cursor) break;
      cursor = lastTs + 1;

      // Rate limiting
      await new Promise(r => setTimeout(r, 200));
    } catch (e: any) {
      console.error(`Error fetching ${symbol}:`, e.message);
      break;
    }
  }

  return candles;
}

function saveCandles(filename: string, candles: Candle[]): void {
  const filepath = path.join(DATA_DIR, filename);

  // Convert to array format for compatibility
  const arrayFormat = candles.map(c => [
    c.timestamp,
    c.open,
    c.high,
    c.low,
    c.close,
    c.volume,
  ]);

  fs.writeFileSync(filepath, JSON.stringify({ candles: arrayFormat }, null, 0));
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('CANDLE DATA UPDATE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const exchange = new ccxt.binance({
    enableRateLimit: true,
    options: {
      defaultType: 'future',
    },
  });

  const now = Date.now();
  const results: { symbol: string; status: string; added: number }[] = [];

  for (const symbol of SYMBOLS) {
    const filename15m = symbolToFilename(symbol, '15m');
    const filename1h = symbolToFilename(symbol, '1h');

    console.log(`\nUpdating ${symbol}...`);

    // Update 15m data
    try {
      const { candles: existing15m, lastTs: lastTs15m } = await loadExistingCandles(filename15m);
      const gapHours = (now - lastTs15m) / (60 * 60 * 1000);

      console.log(`  15m: ${existing15m.length} candles, last at ${new Date(lastTs15m).toISOString()} (${gapHours.toFixed(1)}h ago)`);

      if (gapHours > 0.5) {
        const newCandles = await fetchNewCandles(exchange, symbol, '15m', lastTs15m + 1, now);

        if (newCandles.length > 0) {
          const merged = [...existing15m, ...newCandles];
          saveCandles(filename15m, merged);
          console.log(`  ✓ Added ${newCandles.length} new 15m candles`);
          results.push({ symbol, status: 'updated', added: newCandles.length });
        } else {
          console.log(`  - No new 15m candles available`);
          results.push({ symbol, status: 'no_data', added: 0 });
        }
      } else {
        console.log(`  ✓ 15m data is fresh`);
        results.push({ symbol, status: 'fresh', added: 0 });
      }
    } catch (e: any) {
      console.log(`  ✗ Error updating 15m: ${e.message}`);
      results.push({ symbol, status: 'error', added: 0 });
    }

    // Update 1h data
    try {
      const { candles: existing1h, lastTs: lastTs1h } = await loadExistingCandles(filename1h);
      const gapHours1h = (now - lastTs1h) / (60 * 60 * 1000);

      if (gapHours1h > 2) {
        const newCandles = await fetchNewCandles(exchange, symbol, '1h', lastTs1h + 1, now);

        if (newCandles.length > 0) {
          const merged = [...existing1h, ...newCandles];
          saveCandles(filename1h, merged);
          console.log(`  ✓ Added ${newCandles.length} new 1h candles`);
        }
      }
    } catch (e: any) {
      console.log(`  ✗ Error updating 1h: ${e.message}`);
    }
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const updated = results.filter(r => r.status === 'updated');
  const fresh = results.filter(r => r.status === 'fresh');
  const noData = results.filter(r => r.status === 'no_data');
  const errors = results.filter(r => r.status === 'error');

  console.log(`Updated:  ${updated.length} (${updated.reduce((s, r) => s + r.added, 0)} new candles)`);
  console.log(`Fresh:    ${fresh.length}`);
  console.log(`No data:  ${noData.length}`);
  console.log(`Errors:   ${errors.length}`);

  if (noData.length > 0) {
    console.log('\nSymbols with no new data:');
    for (const r of noData) {
      console.log(`  - ${r.symbol}`);
    }
  }

  if (errors.length > 0) {
    console.log('\nSymbols with errors:');
    for (const r of errors) {
      console.log(`  - ${r.symbol}`);
    }
  }

  console.log('\n✓ Data update complete');
}

main().catch(console.error);
