#!/usr/bin/env node

/**
 * Test direct de getOHLCV avec ton code vs API directe
 */

import ccxt from 'ccxt';

console.log('\n🔍 DEBUG: Comparaison getOHLCV Bot vs API Directe\n');
console.log('═'.repeat(70));

const symbol = 'ADA/USDT';

async function testDirectAPI() {
  console.log('\n📡 TEST 1: API CCXT Directe (Sans ton code)');
  console.log('─'.repeat(70));
  
  const ex = new ccxt.cryptocom();
  await ex.loadMarkets();
  
  const ohlcv = await ex.fetchOHLCV(symbol, '15m', undefined, 5);
  
  console.log(`\nSymbol: ${symbol}`);
  console.log(`Dernières 5 bougies 15m:\n`);
  
  ohlcv.forEach((row, i) => {
    const [ts, o, h, l, c, v] = row;
    const date = new Date(ts).toISOString();
    console.log(`${i+1}. ${date}`);
    console.log(`   Volume: ${v.toLocaleString()} ADA`);
    console.log(`   Prix: $${c.toFixed(4)}`);
  });
  
  const lastVol = ohlcv[ohlcv.length - 1][5];
  const prevVols = ohlcv.slice(0, -1).map(r => r[5]);
  const avgPrev = prevVols.reduce((sum, v) => sum + v, 0) / prevVols.length;
  const ratio = (lastVol / avgPrev) * 100;
  
  console.log(`\n📊 Analyse:`);
  console.log(`   Dernière bougie: ${lastVol.toLocaleString()} ADA`);
  console.log(`   Moyenne 4 prev:  ${avgPrev.toLocaleString()} ADA`);
  console.log(`   Ratio:           ${ratio.toFixed(1)}%`);
  
  return { lastVol, avgPrev, ratio, ohlcv };
}

async function testBotCode() {
  console.log('\n\n🤖 TEST 2: Avec ton code backend (Si dispo)');
  console.log('─'.repeat(70));
  
  try {
    // Simulate ton code
    const { getOHLCV } = await import('../dist/data/market.js');
    
    const o15 = await getOHLCV(symbol, '15m', 5);
    
    console.log(`\nSymbol: ${symbol}`);
    console.log(`Dernières 5 bougies 15m (via ton code):\n`);
    
    o15.forEach((row, i) => {
      const [ts, o, h, l, c, v] = row;
      const date = new Date(ts).toISOString();
      console.log(`${i+1}. ${date}`);
      console.log(`   Volume: ${v.toLocaleString()} ADA`);
      console.log(`   Prix: $${c.toFixed(4)}`);
    });
    
    const lastVol = o15[o15.length - 1][5];
    const prevVols = o15.slice(0, -1).map(r => r[5]);
    const avgPrev = prevVols.reduce((sum, v) => sum + v, 0) / prevVols.length;
    const ratio = (lastVol / avgPrev) * 100;
    
    console.log(`\n📊 Analyse:`);
    console.log(`   Dernière bougie: ${lastVol.toLocaleString()} ADA`);
    console.log(`   Moyenne 4 prev:  ${avgPrev.toLocaleString()} ADA`);
    console.log(`   Ratio:           ${ratio.toFixed(1)}%`);
    
    return { lastVol, avgPrev, ratio, ohlcv: o15 };
    
  } catch (error) {
    console.log(`\n❌ Impossible de charger ton code backend`);
    console.log(`   ${error.message}`);
    console.log(`\n💡 Build le backend avec: npm -w backend run build`);
    return null;
  }
}

async function main() {
  const directResult = await testDirectAPI();
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const botResult = await testBotCode();
  
  console.log('\n\n🔍 COMPARAISON FINALE');
  console.log('═'.repeat(70));
  
  if (botResult) {
    console.log(`\nAPI Directe: ${directResult.lastVol.toLocaleString()} ADA (${directResult.ratio.toFixed(1)}%)`);
    console.log(`Ton Code:    ${botResult.lastVol.toLocaleString()} ADA (${botResult.ratio.toFixed(1)}%)`);
    
    const diff = Math.abs(directResult.lastVol - botResult.lastVol);
    const diffPct = (diff / directResult.lastVol) * 100;
    
    if (diffPct < 1) {
      console.log(`\n✅ IDENTIQUE: Les deux sources retournent les mêmes données`);
      console.log(`   → Le problème n'est PAS dans getOHLCV()`);
      console.log(`   → C'est vraiment un volume bas sur Crypto.com`);
    } else {
      console.log(`\n🚨 DIFFÉRENCE DÉTECTÉE: ${diffPct.toFixed(1)}%`);
      console.log(`   → Ton code voit des données différentes !`);
      console.log(`   → Possiblement cache ou rate limiting`);
    }
  } else {
    console.log(`\n⚠️  Impossible de comparer (backend non compilé)`);
  }
  
  console.log('\n\n💡 DIAGNOSTIC');
  console.log('═'.repeat(70));
  
  console.log(`
Tes logs backend montrent: 414 → 3,963 ADA (1% → 9.7%)
L'API publique montre:     9,243 ADA (28.2%)

🎯 Hypothèses:
1. Cache/staleness: Les données ne sont pas refresh assez vite
2. Rate limiting: Crypto.com retourne données partielles
3. Timestamp décalé: Les bougies ne sont pas alignées
4. Lecture de mauvaise colonne: row[4] au lieu de row[5]

🔍 Prochaine étape:
   → Ajoute des logs dans tech.ts pour voir les raw OHLCV
   → Compare timestamps des bougies
   → Vérifie si row[5] est bien le volume
  `);
  
  console.log('\n');
}

main().catch(console.error);
