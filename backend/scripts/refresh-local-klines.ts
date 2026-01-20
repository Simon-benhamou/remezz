/**
 * Refresh local kline data files
 * Run this from your LOCAL machine to update data/*.json files
 * Then commit and deploy - server will use fresh data without REST calls
 *
 * Usage: npx tsx scripts/refresh-local-klines.ts
 */

import ccxt from 'ccxt';
import fs from 'node:fs/promises';
import path from 'node:path';

const SYMBOLS = [
  'BTC/USDT:USDT',
  'ETH/USDT:USDT',
  'SOL/USDT:USDT',
  'DOGE/USDT:USDT',
  'AVAX/USDT:USDT',
  'SUI/USDT:USDT',
  'SEI/USDT:USDT',
  'IMX/USDT:USDT',
  'APT/USDT:USDT',
  'ARB/USDT:USDT',
  'OP/USDT:USDT',
  'NEAR/USDT:USDT',
  'FTM/USDT:USDT',
  'ATOM/USDT:USDT',
  'DOT/USDT:USDT',
  'ADA/USDT:USDT',
  'XRP/USDT:USDT',
  'LINK/USDT:USDT',
  'UNI/USDT:USDT',
  'BCH/USDT:USDT',
  'LTC/USDT:USDT',
];

const DATA_DIR = path.resolve(process.cwd(), 'data');

async function refreshKlines() {
  console.log('🔄 Refreshing local kline data files...\n');

  const exchange = new ccxt.binance({
    enableRateLimit: true,
    rateLimit: 200, // Be gentle with rate limits
    options: { defaultType: 'swap' }
  });

  await exchange.loadMarkets();
  console.log('✅ Markets loaded\n');

  // Ensure data directory exists
  await fs.mkdir(DATA_DIR, { recursive: true });

  let success = 0;
  let failed = 0;

  for (const symbol of SYMBOLS) {
    const filename = symbol.replace('/', '_').replace(':USDT', '') + '_15m.json';
    const filepath = path.join(DATA_DIR, filename);

    try {
      console.log(`📥 Fetching ${symbol} 15m candles...`);

      // Fetch 500 candles (enough for SMA200 + buffer)
      const ohlcv = await exchange.fetchOHLCV(symbol, '15m', undefined, 500);

      if (!ohlcv || ohlcv.length === 0) {
        console.log(`⚠️  No data for ${symbol}`);
        failed++;
        continue;
      }

      // Convert to JSON format
      const candles = ohlcv.map(c => ({
        openTime: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
      }));

      await fs.writeFile(filepath, JSON.stringify(candles, null, 2));
      console.log(`✅ ${filename}: ${candles.length} candles saved`);
      success++;

      // Small delay between symbols
      await new Promise(r => setTimeout(r, 300));

    } catch (err: any) {
      console.log(`❌ Failed ${symbol}: ${err.message}`);
      failed++;
    }
  }

  // Also fetch BTC 1h candles for MTF filter
  try {
    console.log(`\n📥 Fetching BTC/USDT 1h candles...`);
    const btc1h = await exchange.fetchOHLCV('BTC/USDT:USDT', '1h', undefined, 100);
    const btc1hCandles = btc1h.map(c => ({
      openTime: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    }));
    await fs.writeFile(path.join(DATA_DIR, 'BTC_USDT_1h.json'), JSON.stringify(btc1hCandles, null, 2));
    console.log(`✅ BTC_USDT_1h.json: ${btc1hCandles.length} candles saved`);
  } catch (err: any) {
    console.log(`❌ Failed BTC 1h: ${err.message}`);
  }

  console.log(`\n========================================`);
  console.log(`✅ Success: ${success}/${SYMBOLS.length} symbols`);
  console.log(`❌ Failed: ${failed}/${SYMBOLS.length} symbols`);
  console.log(`========================================\n`);
  console.log('Next steps:');
  console.log('1. git add data/*.json');
  console.log('2. git commit -m "chore: refresh local kline data"');
  console.log('3. git push');
  console.log('4. Railway will deploy with fresh data - NO REST API calls needed!');
}

refreshKlines().catch(console.error);
