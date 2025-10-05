#!/usr/bin/env node

/**
 * Vérification: Volume marché réel vs ce que le bot voit
 */

import ccxt from 'ccxt';

console.log('\n🔍 VÉRIFICATION VOLUME MARCHÉ RÉEL\n');
console.log('═'.repeat(70));

const exchanges = [
  { name: 'Crypto.com', id: 'cryptocom', symbol: 'ADA/USDT' },
  { name: 'Binance', id: 'binance', symbol: 'ADA/USDT' },
  { name: 'Kraken', id: 'kraken', symbol: 'ADA/USD' },
];

async function checkExchange(config) {
  try {
    const exchange = new ccxt[config.id]();
    
    // Fetch ticker (volume 24h)
    const ticker = await exchange.fetchTicker(config.symbol);
    
    // Fetch last 5 candles 15m
    const ohlcv = await exchange.fetchOHLCV(config.symbol, '15m', undefined, 5);
    
    const volumes = ohlcv.map(c => ({
      ts: new Date(c[0]).toISOString(),
      vol: c[5]
    }));
    
    const lastVol = volumes[volumes.length - 1].vol;
    const avgVol = volumes.slice(0, -1).reduce((sum, v) => sum + v.vol, 0) / 4;
    const ratio = (lastVol / avgVol) * 100;
    
    console.log(`\n📊 ${config.name} - ${config.symbol}`);
    console.log('─'.repeat(70));
    console.log(`Volume 24h:        ${ticker.quoteVolume?.toLocaleString() || 'N/A'} USD`);
    console.log(`Dernière bougie:   ${lastVol.toLocaleString()} ${config.symbol.split('/')[0]}`);
    console.log(`Moyenne 4 prev:    ${avgVol.toLocaleString()} ${config.symbol.split('/')[0]}`);
    console.log(`Ratio:             ${ratio.toFixed(1)}%`);
    
    if (ratio < 20) {
      console.log(`⚠️  ALERTE: Volume très bas (${ratio.toFixed(1)}%)`);
    } else {
      console.log(`✅ Volume normal`);
    }
    
    console.log(`\nDernières 5 bougies:`);
    volumes.forEach(v => {
      console.log(`  ${v.ts} → ${v.vol.toLocaleString()} tokens`);
    });
    
    return { success: true, ratio, lastVol, avgVol };
    
  } catch (error) {
    console.log(`\n❌ ${config.name} - ERREUR`);
    console.log(`   ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function main() {
  console.log('\n🎯 Objectif: Déterminer si volume bas est global ou spécifique\n');
  
  const results = [];
  
  for (const config of exchanges) {
    const result = await checkExchange(config);
    results.push({ ...config, ...result });
    await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit
  }
  
  console.log('\n\n📊 RÉSUMÉ');
  console.log('═'.repeat(70));
  
  const lowVolumeCount = results.filter(r => r.success && r.ratio < 20).length;
  const successCount = results.filter(r => r.success).length;
  
  if (lowVolumeCount === successCount && successCount > 0) {
    console.log('\n🌍 MARCHÉ GLOBAL: Tous les exchanges montrent volume bas');
    console.log('   → C\'est une consolidation réelle du marché crypto');
    console.log('   → Ton système PROTÈGE correctement en évitant ce moment');
  } else if (lowVolumeCount > 0 && lowVolumeCount < successCount) {
    console.log('\n⚠️  MIXTE: Certains exchanges ont volume bas, d\'autres normal');
    console.log('   → Possiblement un problème API spécifique à Crypto.com');
  } else if (lowVolumeCount === 0 && successCount > 0) {
    console.log('\n🚨 PROBLÈME ISOLÉ: Autres exchanges ont volume NORMAL');
    console.log('   → Ton bot ne voit PAS les vraies données');
    console.log('   → Bug potentiel dans getOHLCV() ou API Crypto.com');
  } else {
    console.log('\n❓ Impossible de déterminer (erreurs API)');
  }
  
  console.log('\n\n💡 DIAGNOSTIC');
  console.log('═'.repeat(70));
  
  results.forEach(r => {
    if (r.success) {
      const status = r.ratio < 20 ? '❌' : '✅';
      console.log(`${status} ${r.name.padEnd(15)} ${r.ratio.toFixed(1)}%`);
    } else {
      console.log(`⚠️  ${r.name.padEnd(15)} Erreur API`);
    }
  });
  
  console.log('\n');
}

main().catch(console.error);
