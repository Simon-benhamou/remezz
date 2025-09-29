#!/usr/bin/env node

import { getBestIntelligentOpportunity } from './src/services/intelligentAgent.js';

console.log('🧪 Test des améliorations apportées...\n');

console.log('📋 MODIFICATIONS APPLIQUÉES:');
console.log('=' .repeat(50));
console.log('✅ Seuil volume réactif: $200K → $100K');
console.log('✅ Seuil volume agressif: $150K → $75K');
console.log('✅ Seuil volume conservateur: $300K → $200K');
console.log('✅ Exception agents multiples sur cryptos >2% hausse');

console.log('\n🎯 Test de sélection d\'opportunités...');

try {
  // Test en mode agressif pour voir plus d'opportunités
  const opportunity = await getBestIntelligentOpportunity(undefined, { 
    aggressiveness: 'aggressive',
    relaxSteps: 3
  });
  
  if (opportunity) {
    console.log('✅ OPPORTUNITÉ TROUVÉE:');
    console.log(`   Symbole: ${opportunity.symbol}`);
    console.log(`   Score: ${opportunity.finalScore}`);
    console.log(`   Confiance: ${opportunity.confidence}`);
    console.log(`   Projection: ${opportunity.projectedReturn}%`);
    console.log(`   Reasoning: ${opportunity.reasoning}`);
    
    // Vérifier si c'est un symbole qui était bloqué avant
    const majorSymbols = ['BTC/USDT', 'XRP/USDT', 'SOL/USDT', 'ETH/USDT'];
    if (majorSymbols.includes(opportunity.symbol)) {
      console.log('🎉 SUCCÈS: Crypto majeure sélectionnée !');
    } else {
      console.log('ℹ️ Crypto alternative sélectionnée');
    }
  } else {
    console.log('❌ Aucune opportunité trouvée');
    
    console.log('\n🔄 Test en mode encore plus agressif...');
    // Test ultra-agressif
    const fallbackOpp = await getBestIntelligentOpportunity(undefined, { 
      aggressiveness: 'aggressive',
      relaxSteps: 5
    });
    
    if (fallbackOpp) {
      console.log('✅ OPPORTUNITÉ FALLBACK:');
      console.log(`   Symbole: ${fallbackOpp.symbol}`);
      console.log(`   Score: ${fallbackOpp.finalScore}`);
    } else {
      console.log('❌ Toujours aucune opportunité - problème plus profond');
    }
  }
  
} catch (error) {
  console.error('❌ Erreur lors du test:', error.message);
}

console.log('\n📊 ANALYSE ATTENDUE:');
console.log('=' .repeat(50));
console.log('• Plus de cryptos devraient passer le filtre de volume');
console.log('• BCH ($185K) et AAVE ($170K) devraient être éligibles');
console.log('• Si BTC/XRP/SOL sont en hausse >2%, agents multiples autorisés');
console.log('• Davantage d\'opportunités disponibles globalement');

console.log('\n🚀 Si ce test réussit, nous devrions voir:');
console.log('✅ Plus de trades générés automatiquement');
console.log('✅ Capture des mouvements crypto majeurs');
console.log('✅ Diversification du portefeuille d\'agents');