#!/usr/bin/env node
/**
 * 🧪 Test: Simuler la sélection AI avec les nouveaux thresholds
 * Vérifie si le code actuel accepterait des opportunités avec score 0.5-0.6
 */

import { getBestAIOpportunity, getAIRankedOpportunities } from './dist/src/ai/cryptoRanking.js';

console.log('\n🧪 TEST: Simulation sélection AI avec nouveaux thresholds\n');
console.log('='.repeat(80));

async function testAISelection() {
  try {
    console.log('\n🔍 Demande de classement AI pour les cryptos top volume...\n');
    
    const result = await getAIRankedOpportunities({
      topN: 20,
      includeReasoning: true,
      minScore: 0  // On veut voir TOUS les scores pour comparer
    });

    if (!result || !result.rankings || result.rankings.length === 0) {
      console.log('❌ Aucun résultat du ranking AI\n');
      return;
    }

    console.log(`📊 Résultats du ranking AI (${result.rankings.length} cryptos analysées):\n`);
    
    for (const crypto of result.rankings) {
      const score = crypto.score || 0;
      const symbol = crypto.symbol || 'N/A';
      
      // Déterminer si accepté avec nouveau threshold (0.5)
      const acceptedOld = score >= 0.6;  // Ancien threshold
      const acceptedNew = score >= 0.5;  // Nouveau threshold
      
      let status = '';
      if (acceptedNew && acceptedOld) {
        status = '✅ ACCEPTÉ (ancien & nouveau)';
      } else if (acceptedNew && !acceptedOld) {
        status = '🆕 ACCEPTÉ (nouveau threshold uniquement)';
      } else {
        status = '❌ REJETÉ (score trop bas)';
      }
      
      console.log(`${status.padEnd(50)} | ${symbol.padEnd(15)} | Score: ${(score * 100).toFixed(1)}%`);
      
      if (crypto.reasoning) {
        console.log(`   └─ ${crypto.reasoning}`);
      }
    }

    // Compter les opportunités
    const acceptedOld = result.rankings.filter(r => (r.score || 0) >= 0.6).length;
    const acceptedNew = result.rankings.filter(r => (r.score || 0) >= 0.5).length;
    const gain = acceptedNew - acceptedOld;

    console.log('\n' + '='.repeat(80));
    console.log('\n📈 Impact du changement de threshold:\n');
    console.log(`   Ancien threshold (0.6): ${acceptedOld} opportunités acceptées`);
    console.log(`   Nouveau threshold (0.5): ${acceptedNew} opportunités acceptées`);
    console.log(`   Gain: +${gain} opportunités supplémentaires (+${Math.round((gain/Math.max(acceptedOld, 1))*100)}%)\n`);

    if (acceptedNew === 0) {
      console.log('⚠️  PROBLÈME: Même avec threshold 0.5, aucune opportunité n\'est acceptée!');
      console.log('   Causes possibles:');
      console.log('   - Marché en consolidation/range (pas de breakouts)');
      console.log('   - Volatilité trop faible');
      console.log('   - Sentiment négatif généralisé');
      console.log('   - Tous les scores AI < 0.5 (aucune confiance)');
      console.log('\n💡 Solution: Attendre un mouvement de marché ou réduire encore le threshold à 0.4\n');
    } else if (gain > 0) {
      console.log(`✅ Le nouveau threshold fonctionne! +${gain} opportunités disponibles.\n`);
      console.log('💡 Si les agents ne tradent toujours pas, vérifier:');
      console.log('   1. Les agents ont-ils rescanné depuis le changement?');
      console.log('   2. Le backend Railway a-t-il été redéployé?');
      console.log('   3. Les agents sont-ils en sleepMode?\n');
    }

  } catch (error) {
    console.error('❌ Erreur lors du test:', error);
    console.log('\nVérifier que:');
    console.log('1. Le backend est compilé (npm run build)');
    console.log('2. Les variables d\'environnement sont configurées');
    console.log('3. Les API keys OpenAI/Grok sont valides\n');
  }
}

// Exécution
testAISelection().catch(console.error);
