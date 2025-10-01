#!/usr/bin/env node
import { getTopCryptosByVolume, rankCryptosWithAI } from './dist/services/intelligentAgent.js';

console.log('🚀 Testing AI Crypto Selection Pipeline\n');
console.log('=' .repeat(80));

async function testPipeline() {
  try {
    // ÉTAPE 1: Filtrage par volume (Top 50)
    console.log('\n📊 ÉTAPE 1: Filtrage par Volume (Top 50 cryptos)\n');
    console.log('-'.repeat(80));
    
    const topCryptos = await getTopCryptosByVolume(50);
    
    if (topCryptos.length === 0) {
      console.error('❌ Aucune crypto trouvée !');
      return;
    }
    
    console.log(`✅ ${topCryptos.length} cryptos filtrées par volume:\n`);
    
    // Afficher le top 20 avec détails
    console.log('Rank | Symbol          | Volume 24h    | Change 24h | Price');
    console.log('-'.repeat(80));
    
    topCryptos.slice(0, 20).forEach((crypto, i) => {
      const rank = String(i + 1).padStart(4, ' ');
      const symbol = crypto.symbol.padEnd(15, ' ');
      const volume = `$${(crypto.volumeUsd / 1000000).toFixed(2)}M`.padStart(13, ' ');
      const change = `${crypto.change24h > 0 ? '+' : ''}${crypto.change24h.toFixed(2)}%`.padStart(10, ' ');
      const price = `$${crypto.price.toFixed(crypto.price < 1 ? 6 : 2)}`.padStart(12, ' ');
      
      console.log(`${rank} | ${symbol} | ${volume} | ${change} | ${price}`);
    });
    
    if (topCryptos.length > 20) {
      console.log(`\n... et ${topCryptos.length - 20} autres cryptos\n`);
    }
    
    // Statistiques
    const totalVolume = topCryptos.reduce((sum, c) => sum + c.volumeUsd, 0);
    const avgChange = topCryptos.reduce((sum, c) => sum + Math.abs(c.change24h), 0) / topCryptos.length;
    const positives = topCryptos.filter(c => c.change24h > 0).length;
    const negatives = topCryptos.filter(c => c.change24h < 0).length;
    
    console.log('\n📈 Statistiques:');
    console.log(`   Volume total: $${(totalVolume / 1000000000).toFixed(2)}B`);
    console.log(`   Changement moyen (abs): ${avgChange.toFixed(2)}%`);
    console.log(`   Positifs: ${positives} | Négatifs: ${negatives} | Ratio: ${(positives/topCryptos.length*100).toFixed(0)}%`);
    
    // Catégoriser par mouvement
    const strong = topCryptos.filter(c => Math.abs(c.change24h) > 5);
    const moderate = topCryptos.filter(c => Math.abs(c.change24h) > 2 && Math.abs(c.change24h) <= 5);
    const weak = topCryptos.filter(c => Math.abs(c.change24h) <= 2);
    
    console.log(`\n📊 Répartition par mouvement:`);
    console.log(`   Fort (>5%): ${strong.length} cryptos`);
    console.log(`   Modéré (2-5%): ${moderate.length} cryptos`);
    console.log(`   Faible (<2%): ${weak.length} cryptos`);
    
    // ÉTAPE 2: Analyse IA (Top 10 du classement)
    console.log('\n\n🤖 ÉTAPE 2: Analyse IA pour Classement (Top 10 opportunités 24h)\n');
    console.log('-'.repeat(80));
    console.log('⏳ Envoi à l\'IA pour analyse approfondie...\n');
    
    const rankedCryptos = await rankCryptosWithAI(topCryptos);
    
    if (rankedCryptos.length === 0) {
      console.warn('⚠️ L\'IA n\'a renvoyé aucun classement');
      return;
    }
    
    console.log(`\n✅ IA a classé ${rankedCryptos.length} opportunités:\n`);
    console.log('Rank | Symbol          | Score IA | Opportunité         | Raison');
    console.log('-'.repeat(120));
    
    rankedCryptos.forEach((crypto, i) => {
      const rank = String(i + 1).padStart(4, ' ');
      const symbol = crypto.symbol.padEnd(15, ' ');
      const score = String(crypto.aiScore || 0).padStart(8, ' ');
      const opportunity = (crypto.opportunity || 'N/A').padEnd(19, ' ');
      const reason = (crypto.reasoning || 'N/A').substring(0, 50);
      
      console.log(`${rank} | ${symbol} | ${score} | ${opportunity} | ${reason}`);
    });
    
    // Afficher le top 3 en détail
    console.log('\n\n🏆 TOP 3 OPPORTUNITÉS DÉTAILLÉES\n');
    console.log('='.repeat(80));
    
    rankedCryptos.slice(0, 3).forEach((crypto, i) => {
      console.log(`\n${i + 1}. ${crypto.symbol} - Score IA: ${crypto.aiScore || 'N/A'}`);
      console.log(`   📊 Données: $${(crypto.volumeUsd / 1000000).toFixed(2)}M volume, ${crypto.change24h > 0 ? '+' : ''}${crypto.change24h.toFixed(2)}% (24h)`);
      console.log(`   🎯 Opportunité: ${crypto.opportunity || 'N/A'}`);
      console.log(`   💡 Raison: ${crypto.reasoning || 'N/A'}`);
      console.log(`   ⚠️  Risque: ${crypto.risk || 'N/A'}`);
    });
    
    // Comparaison avant/après classement
    console.log('\n\n📊 COMPARAISON: Volume vs IA Ranking\n');
    console.log('-'.repeat(80));
    console.log('Top 5 par Volume        →    Top 5 par IA');
    console.log('-'.repeat(80));
    
    for (let i = 0; i < Math.min(5, rankedCryptos.length); i++) {
      const byVolume = topCryptos[i].symbol.padEnd(22, ' ');
      const byAI = rankedCryptos[i].symbol.padEnd(22, ' ');
      const arrow = topCryptos[i].symbol === rankedCryptos[i].symbol ? '✓ Même' : '→ Changé';
      console.log(`${i + 1}. ${byVolume} ${arrow.padEnd(10, ' ')} ${byAI}`);
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ Test terminé avec succès !\n');
    
  } catch (error) {
    console.error('\n❌ Erreur pendant le test:', error.message);
    console.error(error.stack);
  }
}

testPipeline();
