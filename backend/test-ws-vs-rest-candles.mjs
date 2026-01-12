#!/usr/bin/env node
/**
 * 🔬 Test WebSocket vs REST Candles
 * 
 * Compare candle data from WebSocket stream vs REST API to identify discrepancies.
 * This helps debug parity issues between live trading and backtest.
 */

import ccxt from 'ccxt';

const SYMBOLS = ['ADAUSDT', 'SOLUSDT', 'XRPUSDT', 'BTCUSDT'];
const TIMEFRAME = '15m';

async function fetchRestCandles(exchange, symbol, limit = 60) {
  const ccxtSymbol = symbol.replace('USDT', '/USDT:USDT');
  const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, TIMEFRAME, undefined, limit);
  return ohlcv.map(c => ({
    timestamp: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5],
  }));
}

function formatTime(ts) {
  return new Date(ts).toISOString().slice(11, 19);
}

async function main() {
  console.log('🔬 WebSocket vs REST Candle Comparison\n');
  console.log('=' .repeat(80));
  
  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  
  for (const symbol of SYMBOLS) {
    console.log(`\n📊 ${symbol}:`);
    
    const restCandles = await fetchRestCandles(exchange, symbol);
    console.log(`   Fetched ${restCandles.length} candles from REST API`);
    
    // Show last 5 candles
    console.log('\n   Last 5 candles from REST:');
    const last5 = restCandles.slice(-5);
    for (const c of last5) {
      const time = formatTime(c.timestamp);
      const closeTime = formatTime(c.timestamp + 15 * 60 * 1000);
      console.log(`   ${time}-${closeTime} | O:${c.open.toFixed(4)} H:${c.high.toFixed(4)} L:${c.low.toFixed(4)} C:${c.close.toFixed(4)} V:${c.volume.toFixed(0)}`);
    }
    
    // Calculate BB on last 20 candles
    const closes = restCandles.slice(-20).map(c => c.close);
    const sma20 = closes.reduce((a, b) => a + b, 0) / 20;
    const variance = closes.reduce((sum, c) => sum + Math.pow(c - sma20, 2), 0) / 20;
    const stdDev = Math.sqrt(variance);
    const bbLower = sma20 - 2 * stdDev;
    const bbUpper = sma20 + 2 * stdDev;
    
    const lastClose = restCandles[restCandles.length - 1].close;
    const isBelowBBLower = lastClose < bbLower;
    
    console.log(`\n   Bollinger Bands (20,2):`);
    console.log(`   Upper:  ${bbUpper.toFixed(6)}`);
    console.log(`   Middle: ${sma20.toFixed(6)}`);
    console.log(`   Lower:  ${bbLower.toFixed(6)}`);
    console.log(`   Last Close: ${lastClose.toFixed(6)} ${isBelowBBLower ? '✅ BELOW BB Lower' : '❌ ABOVE BB Lower'}`);
    
    await new Promise(r => setTimeout(r, 500)); // Rate limit
  }
  
  console.log('\n' + '='.repeat(80));
  console.log('\n✅ Done! Compare these values with what the live agent sees.');
}

main().catch(console.error);
