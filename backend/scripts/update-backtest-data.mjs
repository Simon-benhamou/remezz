#!/usr/bin/env node
/**
 * Update Backtest Data - Fetch missing candles and update local JSON files
 * 
 * This script:
 * 1. Checks existing data files in backend/data/
 * 2. Fetches missing data from Binance (with rate limiting)
 * 3. Updates or creates JSON files for backtest
 * 
 * Usage: node backend/scripts/update-backtest-data.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const DATA_DIR = path.join(__dirname, '../data');
const TARGET_DATE = new Date(); // Dynamically use current date
const START_DATE = new Date('2024-01-01T00:00:00Z'); // Début 2024

// Symbols to fetch (all symbols from backtest dropdown)
// Note: FTM was rebranded to SONIC on Binance in late 2024
const SYMBOLS = [
  'BTC/USDT:USDT',
  'ETH/USDT:USDT',
  'SOL/USDT:USDT',
  'XRP/USDT:USDT',
  'DOGE/USDT:USDT',
  'DOT/USDT:USDT',
  'LINK/USDT:USDT',
  'AVAX/USDT:USDT',
  'ATOM/USDT:USDT',
  'ADA/USDT:USDT',
  'IMX/USDT:USDT',
  'SEI/USDT:USDT',
  'SUI/USDT:USDT',
  'UNI/USDT:USDT',
  'LTC/USDT:USDT',
  'SONIC/USDT:USDT',  // Formerly FTM
  'BCH/USDT:USDT',
  'APT/USDT:USDT',
];

const TIMEFRAMES = ['15m', '1h'];

// Rate limiting
const DELAY_BETWEEN_REQUESTS = 1000; // 1 second between requests
const DELAY_BETWEEN_SYMBOLS = 3000; // 3 seconds between symbols

// Helper: Sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: Format symbol for filename
function symbolToFilename(symbol, timeframe) {
  return symbol.replace('/USDT:USDT', '').replace('/', '_') + '_USDT_' + timeframe + '.json';
}

// Helper: Read existing data file
async function readExistingData(filename) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null; // File doesn't exist
    }
    throw error;
  }
}

// Helper: Write data file
async function writeDataFile(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`✅ Saved: ${filename}`);
}

// Helper: Fetch candles from Binance
async function fetchCandlesFromBinance(exchange, symbol, timeframe, since, until) {
  const candles = [];
  let cursor = since;
  
  console.log(`  Fetching ${symbol} ${timeframe} from ${new Date(since).toISOString()} to ${new Date(until).toISOString()}`);
  
  while (cursor < until) {
    try {
      const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, cursor, 1000);
      
      if (!ohlcv || ohlcv.length === 0) {
        break;
      }
      
      let progressed = false;
      for (const bar of ohlcv) {
        const timestamp = bar[0];
        if (timestamp > until) break;
        if (candles.length > 0 && timestamp <= candles[candles.length - 1][0]) continue;
        
        candles.push(bar);
        progressed = true;
      }
      
      if (!progressed) break;
      
      cursor = ohlcv[ohlcv.length - 1][0] + 1;
      
      // Rate limiting
      await sleep(DELAY_BETWEEN_REQUESTS);
      
      // Progress update
      const progress = Math.round(((cursor - since) / (until - since)) * 100);
      process.stdout.write(`\r  Progress: ${progress}% (${candles.length} candles)`);
      
    } catch (error) {
      console.error(`\n  ❌ Error fetching ${symbol}: ${error.message}`);
      
      // Check for rate limit or ban
      if (error.message?.includes('429') || error.message?.includes('418') || error.message?.includes('banned')) {
        console.log('  ⏳ Rate limited, waiting 60 seconds...');
        await sleep(60000);
        continue;
      }
      
      break;
    }
  }
  
  console.log(); // New line after progress
  return candles;
}

// Helper: Merge and deduplicate candles
function mergeCandles(existing, newCandles) {
  const allCandles = [...existing, ...newCandles];
  
  // Sort by timestamp
  allCandles.sort((a, b) => a[0] - b[0]);
  
  // Deduplicate
  const unique = [];
  const seen = new Set();
  
  for (const candle of allCandles) {
    const ts = candle[0];
    if (!seen.has(ts)) {
      seen.add(ts);
      unique.push(candle);
    }
  }
  
  return unique;
}

// Main function
async function updateBacktestData() {
  console.log('🚀 Updating Backtest Data...');
  console.log(`Target date: ${TARGET_DATE.toISOString()}`);
  console.log(`Symbols: ${SYMBOLS.length}`);
  console.log();
  
  // Initialize exchange
  const exchange = new ccxt.binanceusdm({
    enableRateLimit: true,
    rateLimit: 500,
  });
  
  try {
    // Load markets
    console.log('📡 Loading markets...');
    await exchange.loadMarkets();
    console.log('✅ Markets loaded');
    console.log();
    
    // Process each symbol
    for (let i = 0; i < SYMBOLS.length; i++) {
      const symbol = SYMBOLS[i];
      console.log(`[${i + 1}/${SYMBOLS.length}] Processing ${symbol}...`);
      
      for (const timeframe of TIMEFRAMES) {
        const filename = symbolToFilename(symbol, timeframe);
        console.log(`  📊 Timeframe: ${timeframe}`);
        
        // Read existing data
        const existingData = await readExistingData(filename);
        
        let candles = [];
        let needsFetch = false;
        let fetchSince = START_DATE.getTime();
        let fetchUntil = TARGET_DATE.getTime();
        
        if (existingData && existingData.candles) {
          console.log(`  📂 Found existing data: ${existingData.candles.length} candles`);
          console.log(`  📅 Data range: ${new Date(existingData.startTs).toISOString()} to ${new Date(existingData.endTs).toISOString()}`);
          
          candles = existingData.candles;
          
          // Check if we need to fetch new data
          if (existingData.endTs < TARGET_DATE.getTime()) {
            needsFetch = true;
            fetchSince = existingData.endTs + 1;
            console.log(`  ⚠️  Data is outdated, fetching from ${new Date(fetchSince).toISOString()}`);
          } else {
            console.log(`  ✅ Data is up to date`);
          }
        } else {
          console.log(`  ⚠️  No existing data found, fetching all data`);
          needsFetch = true;
        }
        
        // Fetch missing data
        if (needsFetch) {
          const newCandles = await fetchCandlesFromBinance(
            exchange,
            symbol,
            timeframe,
            fetchSince,
            fetchUntil
          );
          
          if (newCandles.length > 0) {
            console.log(`  ✅ Fetched ${newCandles.length} new candles`);
            candles = mergeCandles(candles, newCandles);
            console.log(`  📊 Total candles: ${candles.length}`);
            
            // Update metadata
            const startTs = candles[0][0];
            const endTs = candles[candles.length - 1][0];
            
            const dataToSave = {
              symbol: symbol.replace('/USDT:USDT', ''),
              timeframe,
              candles,
              startTs,
              endTs,
              count: candles.length,
              updatedAt: new Date().toISOString(),
            };
            
            await writeDataFile(filename, dataToSave);
          } else {
            console.log(`  ⚠️  No new candles fetched`);
          }
        }
        
        console.log();
      }
      
      // Delay between symbols to avoid rate limiting
      if (i < SYMBOLS.length - 1) {
        console.log(`⏳ Waiting ${DELAY_BETWEEN_SYMBOLS / 1000}s before next symbol...`);
        await sleep(DELAY_BETWEEN_SYMBOLS);
        console.log();
      }
    }
    
    console.log();
    console.log('✅ Update complete!');
    console.log();
    console.log('📊 Summary:');
    
    // List all data files
    const files = await fs.readdir(DATA_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    
    for (const file of jsonFiles.sort()) {
      const data = await readExistingData(file);
      if (data && data.candles) {
        const startDate = new Date(data.startTs).toISOString().slice(0, 10);
        const endDate = new Date(data.endTs).toISOString().slice(0, 10);
        console.log(`  ${file.padEnd(25)} ${data.candles.length.toString().padStart(6)} candles  ${startDate} → ${endDate}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

// Run
updateBacktestData().catch(console.error);
