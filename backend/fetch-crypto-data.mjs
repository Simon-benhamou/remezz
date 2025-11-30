/**
 * 📊 FETCH CRYPTO DATA - Télécharge et sauvegarde les données en local
 * 
 * Télécharge 24 mois de données 15m pour 10 cryptos sélectionnées
 * Sauvegarde en JSON pour des backtests rapides et reproductibles
 */

import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

// 10 cryptos à analyser
const SYMBOLS = [
  'BTC/USDT:USDT',   // Reference + trading
  'ETH/USDT:USDT',   // Major
  'XRP/USDT:USDT',   // Current strategy
  'SOL/USDT:USDT',   // High momentum
  'ADA/USDT:USDT',   // Large cap alt
  'LINK/USDT:USDT',  // Oracle leader
  'SUI/USDT:USDT',   // New L1
  'DOGE/USDT:USDT',  // Meme leader
  'AVAX/USDT:USDT',  // L1 competitor
  'DOT/USDT:USDT',   // Interoperability
];

const DATA_DIR = path.join(process.cwd(), 'data', 'candles');
const MONTHS = 24;

async function fetchCandles(symbol, months = 24) {
  const since = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
  const allCandles = [];
  let cursor = since;
  
  console.log(`   Fetching ${symbol}...`);
  
  while (cursor < Date.now()) {
    try {
      const ohlcv = await exchange.fetchOHLCV(symbol, '15m', cursor, 1000);
      if (ohlcv.length === 0) break;
      
      for (const c of ohlcv) {
        allCandles.push({
          timestamp: c[0],
          open: c[1],
          high: c[2],
          low: c[3],
          close: c[4],
          volume: c[5]
        });
      }
      cursor = ohlcv[ohlcv.length - 1][0] + 1;
      await new Promise(r => setTimeout(r, 50));
    } catch (err) {
      console.error(`   Error fetching ${symbol}: ${err.message}`);
      break;
    }
  }
  
  return allCandles;
}

async function main() {
  console.log('═'.repeat(80));
  console.log('📊 FETCH CRYPTO DATA - Téléchargement données locales');
  console.log('═'.repeat(80));
  console.log(`\n📁 Dossier: ${DATA_DIR}`);
  console.log(`📅 Période: ${MONTHS} mois`);
  console.log(`🪙 Cryptos: ${SYMBOLS.length}`);
  
  // Créer le dossier si nécessaire
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`\n✅ Dossier créé: ${DATA_DIR}`);
  }
  
  console.log('\n📥 Téléchargement des données...\n');
  
  const summary = [];
  
  for (const symbol of SYMBOLS) {
    const candles = await fetchCandles(symbol, MONTHS);
    
    if (candles.length === 0) {
      console.log(`   ❌ ${symbol}: Aucune donnée`);
      continue;
    }
    
    // Nom du fichier (ex: btc-usdt.json)
    const filename = symbol.replace('/USDT:USDT', '').toLowerCase() + '-usdt.json';
    const filepath = path.join(DATA_DIR, filename);
    
    // Métadonnées
    const data = {
      symbol,
      timeframe: '15m',
      fetchedAt: new Date().toISOString(),
      startDate: new Date(candles[0].timestamp).toISOString(),
      endDate: new Date(candles[candles.length - 1].timestamp).toISOString(),
      candleCount: candles.length,
      candles
    };
    
    // Sauvegarder
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    
    const sizeMB = (fs.statSync(filepath).size / 1024 / 1024).toFixed(2);
    console.log(`   ✅ ${symbol.padEnd(18)} ${String(candles.length).padStart(6)} candles → ${filename} (${sizeMB} MB)`);
    
    summary.push({
      symbol,
      filename,
      candles: candles.length,
      startDate: data.startDate,
      endDate: data.endDate,
      sizeMB: parseFloat(sizeMB)
    });
  }
  
  // Sauvegarder le résumé
  const summaryPath = path.join(DATA_DIR, '_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    symbols: summary
  }, null, 2));
  
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RÉSUMÉ');
  console.log('═'.repeat(80));
  console.log(`\n   ✅ ${summary.length} fichiers créés`);
  console.log(`   📁 Total: ${summary.reduce((acc, s) => acc + s.sizeMB, 0).toFixed(2)} MB`);
  console.log(`   📅 Période: ${summary[0]?.startDate?.slice(0, 10)} → ${summary[0]?.endDate?.slice(0, 10)}`);
  console.log(`\n   Fichiers dans: ${DATA_DIR}`);
}

main().catch(console.error);
