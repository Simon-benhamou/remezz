#!/usr/bin/env node
/**
 * 🎯 Script de diagnostic: Affiche le ranking complet des cryptos par l'IA
 * Montre les top 50 cryptos par volume + leur score AI
 */

import { getAIRankedOpportunities } from '../dist/src/ai/cryptoRanking.js';

async function checkAIRanking() {
  console.log('🤖 DIAGNOSTIC: RANKING COMPLET DES CRYPTOS PAR IA');
  console.log('='.repeat(80));
  console.log('');
  
  try {
    console.log('⏳ Récupération du ranking (peut prendre 30-60 secondes)...\n');
    
    const ranked = await getAIRankedOpportunities({ 
      useCache: false, // Force refresh pour voir le ranking actuel
      forceRefresh: true 
    });
    
    if (!ranked || ranked.length === 0) {
      console.log('❌ PROBLÈME: Aucune crypto ranked!');
      console.log('   → Le système va fallback sur BTC/ETH');
      return;
    }
    
    console.log(`✅ ${ranked.length} cryptos ranked par l'IA\n`);
    console.log('📊 TOP 20 CRYPTOS RANKED:');
    console.log('─'.repeat(80));
    
    ranked.slice(0, 20).forEach((crypto, i) => {
      const rank = i + 1;
      const scoreStr = crypto.score.toFixed(2);
      const confStr = (crypto.opportunity.confidence * 100).toFixed(0);
      const directionEmoji = crypto.opportunity.direction === 'long' ? '📈' : '📉';
      const typeEmoji = crypto.opportunity.type === 'momentum' ? '🚀' : 
                        crypto.opportunity.type === 'reversal' ? '🔄' : '📊';
      
      console.log(`${rank.toString().padStart(2)}. ${crypto.symbol.padEnd(12)} ${directionEmoji}${typeEmoji} Score: ${scoreStr.padStart(5)} | Conf: ${confStr}% | ${crypto.opportunity.direction.toUpperCase()}`);
      console.log(`    ${crypto.aiReasoning[0]}`);
      
      if (i < 19) console.log('');
    });
    
    console.log('\n' + '─'.repeat(80));
    console.log('\n📋 STATISTIQUES:');
    
    const longCount = ranked.filter(c => c.opportunity.direction === 'long').length;
    const shortCount = ranked.filter(c => c.opportunity.direction === 'short').length;
    const momentumCount = ranked.filter(c => c.opportunity.type === 'momentum').length;
    const reversalCount = ranked.filter(c => c.opportunity.type === 'reversal').length;
    
    console.log(`   • Long positions:  ${longCount} (${(longCount/ranked.length*100).toFixed(1)}%)`);
    console.log(`   • Short positions: ${shortCount} (${(shortCount/ranked.length*100).toFixed(1)}%)`);
    console.log(`   • Momentum:        ${momentumCount}`);
    console.log(`   • Reversal:        ${reversalCount}`);
    
    console.log('\n💡 INFO:');
    console.log('   • Le ranking est mis en cache pendant 30 minutes');
    console.log('   • Lors de la création d\'agent AUTO, il prend le top crypto disponible');
    console.log('   • Si BTC/ETH apparaissent souvent, c\'est qu\'ils sont bien ranked par l\'IA');
    
    console.log('\n✅ Le système de ranking fonctionne correctement!');
    
  } catch (error) {
    console.error('❌ ERREUR lors du ranking:', error);
    console.error('\nStack:', error.stack);
    
    console.log('\n⚠️  SI LE RANKING ÉCHOUE:');
    console.log('   1. Vérifier que le backend est démarré');
    console.log('   2. Vérifier la connexion à l\'API OpenAI');
    console.log('   3. Le système va fallback sur les majors (BTC, ETH, SOL, BNB)');
    
    process.exit(1);
  }
}

checkAIRanking().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
