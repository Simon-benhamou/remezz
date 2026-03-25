#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LIMIT = 1500;
const DELAY_MS = 500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}\nBody: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

function toCandle(raw) {
  return {
    openTime: raw[0],
    open: parseFloat(raw[1]),
    high: parseFloat(raw[2]),
    low: parseFloat(raw[3]),
    close: parseFloat(raw[4]),
    volume: parseFloat(raw[5]),
  };
}

async function fetchCandles(symbol, startTime) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&startTime=${startTime}&limit=${LIMIT}`;
  console.log(`  GET ${url}`);
  const raw = await httpsGet(url);
  if (!Array.isArray(raw)) {
    throw new Error(`Unexpected response: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  return raw.map(toCandle);
}

async function extendSymbol(fileSymbol, binanceSymbol) {
  const filePath = path.join(DATA_DIR, `${fileSymbol}_USDT_15m.json`);
  console.log(`\n=== Processing ${fileSymbol} ===`);

  const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  console.log(`Existing candles: ${existing.length}`);

  const lastOpenTime = existing[existing.length - 1].openTime;
  const lastDate = new Date(lastOpenTime).toISOString();
  console.log(`Last candle openTime: ${lastOpenTime} (${lastDate})`);

  // Start from the candle AFTER the last one (15 min = 900000 ms)
  let startTime = lastOpenTime + 900000;
  const targetEnd = Date.now(); // up to now

  const newCandles = [];
  let page = 0;

  while (startTime < targetEnd) {
    page++;
    console.log(`  Page ${page}: startTime=${startTime} (${new Date(startTime).toISOString()})`);

    const candles = await fetchCandles(binanceSymbol, startTime);
    console.log(`  Received ${candles.length} candles`);

    if (candles.length === 0) break;

    newCandles.push(...candles);

    const lastBatch = candles[candles.length - 1].openTime;
    startTime = lastBatch + 900000;

    if (candles.length < LIMIT) {
      console.log('  Reached end of available data (partial page).');
      break;
    }

    await sleep(DELAY_MS);
  }

  console.log(`Downloaded ${newCandles.length} new candles for ${fileSymbol}`);

  // Merge and deduplicate by openTime
  const merged = [...existing, ...newCandles];
  const seen = new Set();
  const deduped = merged.filter(c => {
    if (seen.has(c.openTime)) return false;
    seen.add(c.openTime);
    return true;
  });
  // Sort by openTime just in case
  deduped.sort((a, b) => a.openTime - b.openTime);

  console.log(`Total after merge+dedup: ${deduped.length} candles`);
  console.log(`New last candle: ${deduped[deduped.length - 1].openTime} (${new Date(deduped[deduped.length - 1].openTime).toISOString()})`);

  fs.writeFileSync(filePath, JSON.stringify(deduped, null, 0));
  console.log(`Written to ${filePath}`);

  return {
    symbol: fileSymbol,
    count: deduped.length,
    first: new Date(deduped[0].openTime).toISOString(),
    last: new Date(deduped[deduped.length - 1].openTime).toISOString(),
  };
}

async function main() {
  const results = [];

  results.push(await extendSymbol('ETH', 'ETHUSDT'));
  results.push(await extendSymbol('SOL', 'SOLUSDT'));

  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    console.log(`${r.symbol}: ${r.count} candles | ${r.first} → ${r.last}`);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
