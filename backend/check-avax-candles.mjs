/**
 * Regarder les candles AVAX brutes et voir quand les signaux apparaissent
 */

import ccxt from 'ccxt';

const exchange = new ccxt.binanceusdm({
  options: { defaultType: 'swap' }
});

await exchange.loadMarkets();

const symbol = 'AVAX/USDT:USDT';
const since = new Date('2025-12-22T00:00:00Z').getTime();
const until = new Date('2025-12-24T00:00:00Z').getTime();

console.log('Fetching AVAX candles from 22-12 to 24-12...\n');

const candles = await exchange.fetchOHLCV(symbol, '15m', since, Math.floor((until - since) / (15 * 60 * 1000)) + 10);

console.log(`Total candles: ${candles.length}\n`);

// Afficher les candles autour de 15:00 le 23-12
const targetTime = new Date('2025-12-23T15:00:00Z').getTime();

console.log('=== Candles around 23-12-2025 15:00 UTC ===\n');

candles.forEach(c => {
  const [ts, open, high, low, close, volume] = c;
  const date = new Date(ts);
  
  // Show candles from 12:00 to 18:00 on 23-12
  if (ts >= targetTime - 3 * 60 * 60 * 1000 && ts <= targetTime + 3 * 60 * 60 * 1000) {
    const timeStr = date.toISOString().slice(11, 16);
    const priceChange = ((close - open) / open * 100).toFixed(2);
    console.log(`${date.toISOString()} | O:${open.toFixed(4)} H:${high.toFixed(4)} L:${low.toFixed(4)} C:${close.toFixed(4)} | Chg:${priceChange}% | Vol:${volume.toFixed(0)}`);
  }
});

console.log('\n\n=== Candles around 22-12-2025 00:00 UTC (early signal) ===\n');

const earlyTargetTime = new Date('2025-12-22T00:00:00Z').getTime();

candles.forEach(c => {
  const [ts, open, high, low, close, volume] = c;
  const date = new Date(ts);
  
  // Show candles from 21:00 on 21-12 to 03:00 on 22-12
  if (ts >= earlyTargetTime - 3 * 60 * 60 * 1000 && ts <= earlyTargetTime + 3 * 60 * 60 * 1000) {
    const timeStr = date.toISOString().slice(11, 16);
    const priceChange = ((close - open) / open * 100).toFixed(2);
    console.log(`${date.toISOString()} | O:${open.toFixed(4)} H:${high.toFixed(4)} L:${low.toFixed(4)} C:${close.toFixed(4)} | Chg:${priceChange}% | Vol:${volume.toFixed(0)}`);
  }
});

await exchange.close();
