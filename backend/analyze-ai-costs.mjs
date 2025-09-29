import { getBestIntelligentOpportunity, scanIntelligentOpportunities } from './dist/src/services/intelligentAgent.js';

console.log('💰 ANALYSE DES COÛTS IA ET OPTIMISATION');
console.log('=' .repeat(60));

async function analyzeAICosts() {
  try {
    console.log('\n🔍 UTILISATION IA ACTUELLE');
    console.log('-'.repeat(40));
    
    // Simulation d'un scan complet
    const opportunities = await scanIntelligentOpportunities();
    const analyzeCount = opportunities.length;
    
    console.log('📊 Statistiques du scan actuel:');
    console.log(`  🎯 Cryptos analysées: ${analyzeCount}`);
    console.log(`  🤖 Appels IA par scan: ${analyzeCount} (TOUTES les cryptos)`);
    console.log(`  ⏱️ Fréquence: Toutes les 5 minutes`);
    console.log(`  📈 Appels IA par heure: ${Math.round(analyzeCount * 12)} calls`);
    console.log(`  💰 Appels IA par jour: ${Math.round(analyzeCount * 12 * 24)} calls`);
    
    console.log('\n💸 ESTIMATION DES COÛTS');
    console.log('-'.repeat(40));
    
    // Coûts estimés OpenAI GPT-4
    const costPerCall = 0.03; // $0.03 per call (estimation)
    const callsPerDay = analyzeCount * 12 * 24;
    const dailyCost = callsPerDay * costPerCall;
    const monthlyCost = dailyCost * 30;
    
    console.log(`💳 Coût estimé par appel IA: $${costPerCall}`);
    console.log(`📅 Coût quotidien actuel: $${dailyCost.toFixed(2)}/jour`);
    console.log(`📊 Coût mensuel actuel: $${monthlyCost.toFixed(2)}/mois`);
    console.log(`🚨 Coût annuel actuel: $${(monthlyCost * 12).toFixed(2)}/an`);
    
    if (monthlyCost > 100) {
      console.log(`⚠️ ALERTE: Coût mensuel élevé (>${100}$)`);
    }
    
    console.log('\n🎯 OPTIMISATIONS PROPOSÉES');
    console.log('-'.repeat(40));
    
    // Calcul des optimisations
    const majorCryptos = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT'];
    const highVolumeCount = Math.ceil(analyzeCount * 0.2); // Top 20%
    const strongMoverCount = Math.ceil(analyzeCount * 0.1); // Top 10% mouvements
    
    console.log('🔧 Stratégie d\'optimisation intelligente:');
    
    console.log('\n1️⃣ FILTRAGE PAR PRIORITÉ:');
    console.log(`   🏆 Majors (BTC, ETH, etc.): ${majorCryptos.length} cryptos`);
    console.log(`   📈 Fort volume (>$100M): ~${highVolumeCount} cryptos`);
    console.log(`   🚀 Mouvements forts (>2%): ~${strongMoverCount} cryptos`);
    console.log(`   💡 Réduction IA: ${Math.round((1 - (majorCryptos.length + highVolumeCount + strongMoverCount) / analyzeCount) * 100)}%`);
    
    console.log('\n2️⃣ CACHE INTELLIGENT:');
    console.log(`   ⏱️ Cache 15min pour cryptos <1% mouvement`);
    console.log(`   🔄 Cache 5min pour cryptos 1-2% mouvement`);
    console.log(`   ⚡ Temps réel pour cryptos >2% mouvement`);
    console.log(`   💡 Réduction IA: ~70%`);
    
    console.log('\n3️⃣ IA PRÉDICTIVE CIBLÉE:');
    console.log(`   🎯 Seulement sur top 10 cryptos par volume`);
    console.log(`   📊 ML simple pour les autres (pas d'API calls)`);
    console.log(`   🧠 Deep IA seulement si >80% confidence`);
    console.log(`   💡 Réduction IA: ~85%`);
    
    // Calculs optimisés
    const optimizedCalls = Math.ceil(analyzeCount * 0.15); // 15% seulement
    const optimizedDailyCost = optimizedCalls * 12 * 24 * costPerCall;
    const optimizedMonthlyCost = optimizedDailyCost * 30;
    
    console.log('\n💎 RÉSULTATS OPTIMISÉS');
    console.log('-'.repeat(40));
    console.log(`🎯 Appels IA réduits: ${optimizedCalls} par scan (-${Math.round((1 - optimizedCalls/analyzeCount) * 100)}%)`);
    console.log(`📅 Nouveau coût quotidien: $${optimizedDailyCost.toFixed(2)}/jour`);
    console.log(`📊 Nouveau coût mensuel: $${optimizedMonthlyCost.toFixed(2)}/mois`);
    console.log(`💰 Économie mensuelle: $${(monthlyCost - optimizedMonthlyCost).toFixed(2)}`);
    console.log(`🎉 Économie annuelle: $${((monthlyCost - optimizedMonthlyCost) * 12).toFixed(2)}`);
    
    console.log('\n🚀 AMÉLIORATIONS À IMPLÉMENTER');
    console.log('-'.repeat(50));
    
    console.log('📍 PHASE 1 - Filtrage immédiat:');
    console.log('  ✅ IA seulement si volume >$50M OU mouvement >1.5%');
    console.log('  ✅ Cache 10min pour analyse technique seule');
    console.log('  ✅ Priorité majors: BTC, ETH, SOL, XRP, ADA');
    
    console.log('\n📍 PHASE 2 - Cache avancé:');
    console.log('  ✅ WebSocket temps réel pour top 10');
    console.log('  ✅ Scan 1min au lieu de 5min (mais moins d\'IA)');
    console.log('  ✅ Système de scoring hybride (technique + IA selective)');
    
    console.log('\n📍 PHASE 3 - IA prédictive:');
    console.log('  ✅ ML léger local pour patterns simples');
    console.log('  ✅ IA premium seulement pour décisions critiques');
    console.log('  ✅ Auto-apprentissage des patterns de marché');
    
    console.log('\n🎯 RECOMMANDATION FINALE');
    console.log('-'.repeat(40));
    console.log(`💡 Budget IA recommandé: $${Math.min(50, optimizedMonthlyCost).toFixed(2)}/mois`);
    console.log(`⚖️ Équilibre: Performance maintenue, coûts divisés par ${Math.round(monthlyCost/optimizedMonthlyCost)}`);
    console.log(`🏆 ROI: Meilleure détection + économies substantielles`);
    
  } catch (error) {
    console.error('❌ Erreur analyse:', error);
  }
}

analyzeAICosts();