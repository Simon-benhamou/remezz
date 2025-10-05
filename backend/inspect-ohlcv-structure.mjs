#!/usr/bin/env node

/**
 * Test: Structure complète OHLCV de Crypto.com vs Binance
 */

import ccxt from 'ccxt';

console.log('\n🔍 VÉRIFICATION STRUCTURE OHLCV RAW\n');
console.log('═'.repeat(70));

async function inspectOHLCV(exchangeId, symbol) {
  console.log(`\n📊 ${exchangeId.toUpperCase()} - ${symbol}`);
  console.log('─'.repeat(70));
  
  try {
    const ExchangeClass = ccxt[exchangeId];
    const exchange = new ExchangeClass({ enableRateLimit: true });
    
    await exchange.loadMarkets();
    
    // Fetch 2 candles pour voir la structure
    const ohlcv = await exchange.fetchOHLCV(symbol, '15m', undefined, 2);
    
    console.log(`\n✅ Récupéré ${ohlcv.length} bougies\n`);
    
    ohlcv.forEach((candle, idx) => {
      console.log(`\n🕯️  Bougie ${idx + 1}:`);
      console.log('   Structure Array:', candle);
      console.log('   Length:', candle.length);
      console.log('');
      console.log('   Index 0 (timestamp):', candle[0], '→', new Date(candle[0]).toISOString());
      console.log('   Index 1 (open):', candle[1]);
      console.log('   Index 2 (high):', candle[2]);
      console.log('   Index 3 (low):', candle[3]);
      console.log('   Index 4 (close):', candle[4]);
      console.log('   Index 5 (volume):', candle[5]);
      
      if (candle.length > 6) {
        console.log('   ⚠️  EXTRA DATA:');
        for (let i = 6; i < candle.length; i++) {
          console.log(`   Index ${i}:`, candle[i]);
        }
      }
    });
    
    // Vérifier le ticker pour comparaison
    const ticker = await exchange.fetchTicker(symbol);
    console.log('\n📊 Ticker (pour comparaison):');
    console.log('   baseVolume:', ticker.baseVolume, '(volume en', symbol.split('/')[0], ')');
    console.log('   quoteVolume:', ticker.quoteVolume, '(volume en', symbol.split('/')[1], ')');
    
    // Comparaison
    const lastCandle = ohlcv[ohlcv.length - 1];
    const candleVol = lastCandle[5];
    
    console.log('\n🔍 Analyse:');
    console.log(`   row[5] = ${candleVol}`);
    console.log(`   Type: ${typeof candleVol}`);
    
    if (ticker.baseVolume) {
      const ratio = (candleVol / ticker.baseVolume) * 100;
      console.log(`   Ratio vs baseVolume 24h: ${ratio.toFixed(4)}% (devrait être ~0.1% pour 1 bougie 15m)`);
    }
    
    if (ticker.quoteVolume) {
      const ratioQuote = (candleVol / ticker.quoteVolume) * 100;
      console.log(`   Ratio vs quoteVolume 24h: ${ratioQuote.toFixed(4)}%`);
    }
    
    return { ohlcv, ticker, exchange: exchangeId };
    
  } catch (error) {
    console.log(`\n❌ ERREUR: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('\n🎯 Objectif: Vérifier que row[5] contient bien le volume\n');
  
  // Test Crypto.com
  const cryptocomResult = await inspectOHLCV('cryptocom', 'ADA/USDT');
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Test Binance pour comparaison
  const binanceResult = await inspectOHLCV('binance', 'ADA/USDT');
  
  console.log('\n\n🔍 COMPARAISON FINALE');
  console.log('═'.repeat(70));
  
  if (cryptocomResult && binanceResult) {
    const ccVol = cryptocomResult.ohlcv[cryptocomResult.ohlcv.length - 1][5];
    const bnVol = binanceResult.ohlcv[binanceResult.ohlcv.length - 1][5];
    
    console.log(`\nDernière bougie 15m:`);
    console.log(`   Crypto.com row[5]: ${ccVol.toLocaleString()}`);
    console.log(`   Binance row[5]:    ${bnVol.toLocaleString()}`);
    console.log(`   Ratio Binance/Crypto: ${(bnVol / ccVol).toFixed(1)}x`);
    
    console.log(`\n💡 INTERPRÉTATION:`);
    
    if (ccVol < 100) {
      console.log(`   🚨 Crypto.com row[5] = ${ccVol} est ANORMALEMENT BAS`);
      console.log(`   → Possible que row[5] ne soit PAS le volume en tokens`);
      console.log(`   → Ou que l'exchange retourne volume en quote currency`);
    } else if (ccVol < bnVol / 10) {
      console.log(`   ⚠️  Crypto.com a un volume 10x+ plus faible que Binance`);
      console.log(`   → Normal si Crypto.com a moins de liquidité`);
      console.log(`   → MAIS vérifier quand même avec ticker.baseVolume`);
    } else {
      console.log(`   ✅ Les volumes semblent cohérents entre les deux exchanges`);
    }
    
    // Vérifier cohérence avec ticker
    if (cryptocomResult.ticker.baseVolume) {
      const expectedVol15m = cryptocomResult.ticker.baseVolume / 96; // 96 bougies 15m en 24h
      const ratio = (ccVol / expectedVol15m) * 100;
      console.log(`\n🔍 Cohérence Crypto.com:`);
      console.log(`   Volume 24h (ticker): ${cryptocomResult.ticker.baseVolume?.toLocaleString() || 'N/A'} ADA`);
      console.log(`   Attendu par bougie 15m: ${expectedVol15m.toFixed(0)} ADA (24h / 96)`);
      console.log(`   Reçu dans OHLCV: ${ccVol} ADA`);
      console.log(`   Ratio: ${ratio.toFixed(1)}%`);
      
      if (ratio < 10 || ratio > 200) {
        console.log(`   🚨 INCOHÉRENCE DÉTECTÉE !`);
        console.log(`   → row[5] ne représente PAS le volume en tokens ADA`);
        console.log(`   → Possiblement en quote currency (USDT) ou autre unité`);
      } else {
        console.log(`   ✅ Cohérence OK (ratio entre 10% et 200% est acceptable)`);
      }
    }
  }
  
  console.log('\n\n💡 CONCLUSION');
  console.log('═'.repeat(70));
  console.log(`
Si Crypto.com row[5] < 1000 alors que Binance > 300,000:
→ 🚨 BUG CCXT ou API Crypto.com non standard

Si Crypto.com cohérent avec son propre ticker.baseVolume:
→ ✅ Les données sont bonnes, juste volume faible sur cet exchange

Si incohérence avec ticker.baseVolume:
→ 🚨 row[5] n'est PAS le volume en tokens base
  `);
  
  console.log('\n');
}

main().catch(console.error);
