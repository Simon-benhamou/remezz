/**
 * Fetch et sauvegarde les données OHLCV en local pour éviter de refetch
 */

import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';

const exchange = new ccxt.binance({ 
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

const DATA_DIR = './data';
const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'];

async function fetchAndSave() {
  // Créer le dossier data s'il n'existe pas
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  
  const since = Date.now() - 365 * 24 * 60 * 60 * 1000; // 1 an
  
  for (const symbol of SYMBOLS) {
    console.log(`\n📥 Fetching ${symbol}...`);
    
    const candles = [];
    let currentSince = since;
    
    while (candles.length < 8760) { // ~1 an de données horaires
      const batch = await exchange.fetchOHLCV(symbol, '1h', currentSince, 500);
      if (batch.length === 0) break;
      candles.push(...batch);
      currentSince = batch[batch.length - 1][0] + 1;
      process.stdout.write(`\r   ${candles.length} candles...`);
      await new Promise(r => setTimeout(r, 100));
    }
    
    // Transformer en format propre
    const data = candles.map(c => ({
      timestamp: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    }));
    
    // Sauvegarder
    const filename = path.join(DATA_DIR, `${symbol.replace('/', '_')}_1h.json`);
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    
    console.log(`\n   ✅ Saved ${data.length} candles to ${filename}`);
    
    // Infos sur la période
    const startDate = new Date(data[0].timestamp).toISOString().slice(0, 10);
    const endDate = new Date(data[data.length - 1].timestamp).toISOString().slice(0, 10);
    console.log(`   📅 Period: ${startDate} → ${endDate}`);
  }
  
  console.log('\n✅ All data saved!\n');
}

fetchAndSave().catch(console.error);
