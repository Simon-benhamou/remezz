#!/usr/bin/env node
/**
 * Fetch 15-minute candle data from Binance for backtesting
 * Production uses 15m candles, so we need the same for accurate backtest
 */

import fs from 'fs';

const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'ATOMUSDT'];
const interval = '15m';
const dataDir = './data';

// Binance API limit is 1000 candles per request
// 15m candles: 4 per hour × 24 hours × 365 days × 2 years = ~70,080 candles
// We need ~70 requests per symbol

async function fetchCandles(symbol, startTime, endTime) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=1000`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${symbol}: ${response.status}`);
  }
  
  const data = await response.json();
  return data.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
  }));
}

async function fetchAllCandles(symbol) {
  const allCandles = [];
  
  // Start from 2 years ago
  const endTime = Date.now();
  const startTime = endTime - (2 * 365 * 24 * 60 * 60 * 1000); // 2 years
  
  let currentStart = startTime;
  let requestCount = 0;
  
  console.log(`\n📥 Fetching ${symbol} 15m candles...`);
  
  while (currentStart < endTime) {
    const candles = await fetchCandles(symbol, currentStart, endTime);
    
    if (candles.length === 0) break;
    
    allCandles.push(...candles);
    requestCount++;
    
    // Move to next batch
    currentStart = candles[candles.length - 1].closeTime + 1;
    
    // Progress indicator
    process.stdout.write(`\r   Fetched ${allCandles.length} candles (${requestCount} requests)...`);
    
    // Rate limit: 1200 requests/min, be conservative
    await new Promise(r => setTimeout(r, 100));
  }
  
  console.log(`\n   ✅ Total: ${allCandles.length} candles`);
  return allCandles;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('📊 FETCHING 15-MINUTE CANDLE DATA FROM BINANCE FUTURES');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Symbols: ${symbols.join(', ')}`);
  console.log(`Period: Last 2 years`);
  console.log(`Expected: ~70,000 candles per symbol`);
  
  for (const symbol of symbols) {
    try {
      const candles = await fetchAllCandles(symbol);
      
      // Save to file
      const filename = `${dataDir}/${symbol.replace('USDT', '_USDT')}_15m.json`;
      fs.writeFileSync(filename, JSON.stringify(candles, null, 2));
      console.log(`   💾 Saved to ${filename}`);
      
    } catch (error) {
      console.error(`   ❌ Error fetching ${symbol}: ${error.message}`);
    }
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('✅ DONE - 15m data ready for backtesting');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch(console.error);
