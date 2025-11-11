#!/usr/bin/env node
/**
 * Test rapide: Utilise le cache du ranking (pas de nouveau call IA)
 */

import { getAIRankedOpportunities } from '../dist/src/ai/cryptoRanking.js';

console.log('🎯 TEST RAPIDE: Ranking avec cache\n');

try {
  const ranked = await getAIRankedOpportunities({ 
    useCache: true, // Utilise le cache existant
    forceRefresh: false 
  });
  
  if (!ranked || ranked.length === 0) {
    console.log('❌ Aucune crypto ranked (cache vide - run check-ai-ranking.mjs d\'abord)');
    process.exit(1);
  }
  
  console.log(`✅ ${ranked.length} cryptos dans le ranking\n`);
  console.log('📊 TOP 20:');
  console.log('─'.repeat(80));
  
  ranked.slice(0, 20).forEach((crypto, i) => {
    const rank = i + 1;
    const hasWarning = crypto.aiReasoning.some(r => r.includes('⚠️'));
    const warningIcon = hasWarning ? '⚠️' : '✅';
    
    console.log(`${rank.toString().padStart(2)}. ${warningIcon} ${crypto.symbol.padEnd(12)} Score: ${crypto.score.toFixed(2)} | ${crypto.opportunity.direction.toUpperCase()}`);
  });
  
  console.log('\n📈 STATISTIQUES:');
  const withConflict = ranked.filter(c => c.aiReasoning.some(r => r.includes('conflict'))).length;
  console.log(`   • Total: ${ranked.length}`);
  console.log(`   • Avec conflit HTF: ${withConflict}`);
  console.log(`   • Sans conflit: ${ranked.length - withConflict}`);
  
  console.log('\n💡 Les conflits HTF ne bloquent plus - juste un score réduit de 15%');
  
} catch (error) {
  console.error('❌ Erreur:', error.message);
  process.exit(1);
}
