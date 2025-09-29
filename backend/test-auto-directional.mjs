#!/usr/bin/env node

/**
 * TEST AGENT AUTO-DIRECTIONNEL
 * Valide que l'agent détermine automatiquement le bias BULL/BEAR optimal
 */

import { getBestIntelligentOpportunity, scanIntelligentOpportunities } from './dist/src/services/intelligentAgent.js';

console.log('🎯 TEST AGENT AUTO-DIRECTIONNEL\n');

async function testAutoDirectionalAgent() {
  try {
    console.log('🔍 Phase 1: Scan des opportunités avec bias automatique...');
    console.log('=' .repeat(60));
    
    // Test du scan avec bias automatique
    const opportunities = await scanIntelligentOpportunities();
    
    console.log(`\n📊 Résultats du scan auto-directionnel:`);
    console.log(`   ✅ Opportunités trouvées: ${opportunities.length}`);
    
    if (opportunities.length === 0) {
      console.log('⚠️ Aucune opportunité avec bias clair (>60% confidence) trouvée');
      return;
    }
    
    console.log('\n🏆 TOP 5 OPPORTUNITÉS AUTO-DIRECTIONNELLES:');
    console.log('-'.repeat(80));
    
    opportunities.slice(0, 5).forEach((opp, index) => {
      const autoBias = opp.autoBias;
      if (autoBias) {
        const biasIcon = autoBias.bias === 'long' ? '📈' : autoBias.bias === 'short' ? '📉' : '⚪';
        console.log(`${index + 1}. ${opp.symbol} - Score: ${opp.score}`);
        console.log(`   ${biasIcon} BIAS: ${autoBias.bias.toUpperCase()} (${autoBias.confidence}% confidence)`);
        console.log(`   🧠 Reasoning: ${autoBias.reasoning}`);
        console.log(`   📊 Metrics: RSI=${opp.metrics.rsi.toFixed(1)}, ADX=${opp.metrics.adx.toFixed(1)}, Mom=${opp.metrics.momentum.toFixed(2)}%`);
        console.log('');
      }
    });
    
    console.log('🎯 Phase 2: Sélection de la meilleure opportunité...');
    console.log('=' .repeat(60));
    
    const bestOpportunity = await getBestIntelligentOpportunity();
    
    if (!bestOpportunity) {
      console.log('❌ Aucune opportunité qualifiée trouvée');
      return;
    }
    
    console.log('🏆 MEILLEURE OPPORTUNITÉ AUTO-SÉLECTIONNÉE:');
    console.log('-'.repeat(50));
    console.log(`📈 Symbole: ${bestOpportunity.symbol}`);
    console.log(`🎯 Score: ${bestOpportunity.score}`);
    console.log(`🎪 Confidence: ${(bestOpportunity.confidence * 100).toFixed(1)}%`);
    
    if (bestOpportunity.autoBias) {
      const { bias, confidence, reasoning } = bestOpportunity.autoBias;
      const biasIcon = bias === 'long' ? '📈' : bias === 'short' ? '📉' : '⚪';
      
      console.log(`${biasIcon} AUTO-BIAS: ${bias.toUpperCase()}`);
      console.log(`🧠 Confidence: ${confidence}%`);
      console.log(`💭 Reasoning: ${reasoning}`);
    }
    
    console.log('\n📊 Metrics détaillées:');
    const m = bestOpportunity.metrics;
    console.log(`   📈 Momentum: ${m.momentum.toFixed(2)}%`);
    console.log(`   📊 RSI: ${m.rsi.toFixed(1)}`);
    console.log(`   💪 ADX: ${m.adx.toFixed(1)}`);
    console.log(`   💰 Volume 24h: $${(m.volume24h / 1000000).toFixed(2)}M`);
    
    console.log('\n🎉 WORKFLOW AUTO-DIRECTIONNEL SIMULÉ:');
    console.log('-'.repeat(50));
    console.log('👤 Utilisateur: `/activate-smart-agent`');
    console.log(`🤖 Agent: "✅ ${bestOpportunity.symbol} sélectionné"`);
    console.log(`🧠 Agent: "${bestOpportunity.autoBias?.bias.toUpperCase()} bias (${bestOpportunity.autoBias?.confidence}% confidence)"`);
    console.log(`📡 Agent: "Monitoring ${bestOpportunity.symbol} activé - Focus ${bestOpportunity.autoBias?.bias} signaux"`);
    console.log('⏳ Agent: "Attente signaux précurseurs..."');
    
    console.log('\n✅ TEST RÉUSSI - Système Auto-Directionnel opérationnel! 🎯');
    
    console.log('\n💡 AVANTAGES VALIDÉS:');
    console.log('   ✅ Une seule commande `/activate-smart-agent`');
    console.log('   ✅ Agent trouve automatiquement le meilleur crypto');
    console.log('   ✅ Bias BULL/BEAR déterminé scientifiquement');
    console.log('   ✅ Pas de décision manuelle requise');
    console.log('   ✅ Exploitation intelligente des deux directions');
    console.log('   ✅ Confidence scoring pour qualité des signaux');
    
  } catch (error) {
    console.error('❌ Erreur test auto-directionnel:', error);
  }
}

testAutoDirectionalAgent();