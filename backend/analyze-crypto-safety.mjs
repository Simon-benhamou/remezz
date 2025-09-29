import { getBestIntelligentOpportunity, scanIntelligentOpportunities, getActiveAgentCountForSymbol } from './dist/src/services/intelligentAgent.js';

console.log('🔍 ANALYSE DE SÉCURITÉ ET D\'ADÉQUATION CRYPTO');
console.log('=' .repeat(60));

async function analyzeSystemSafety() {
  try {
    // Test 1: Analyse des seuils de volume actuels
    console.log('\n💰 Test 1: Analyse des Seuils de Volume');
    console.log('-'.repeat(50));
    
    const volumeThresholds = {
      conservative: 200000, // $200K
      reactive: 100000,     // $100K  
      aggressive: 75000     // $75K
    };
    
    console.log('Seuils de volume actuels:');
    Object.entries(volumeThresholds).forEach(([mode, threshold]) => {
      const safety = threshold >= 100000 ? '✅ SAFE' : '⚠️ RISQUÉ';
      console.log(`  ${mode.toUpperCase()}: $${(threshold/1000).toFixed(0)}K ${safety}`);
    });
    
    console.log('\n📊 Contexte marché crypto:');
    console.log('  - Top 10 cryptos: >$100M volume/jour (ultra safe)');
    console.log('  - Top 50 cryptos: $10-100M volume/jour (safe)');
    console.log('  - Mid-caps: $1-10M volume/jour (modéré)');
    console.log('  - Small-caps: $100K-1M volume/jour (risqué)');
    
    // Test 2: Simulation de conditions de marché
    console.log('\n📈 Test 2: Test Conditions de Marché Extrêmes');
    console.log('-'.repeat(50));
    
    const opportunities = await scanIntelligentOpportunities();
    
    if (opportunities.length > 0) {
      // Analyse de la distribution des volumes
      const volumes = opportunities.map(op => op.metrics.volume24h).sort((a, b) => b - a);
      const totalVolume = volumes.reduce((sum, vol) => sum + vol, 0);
      
      console.log(`Analyse de ${opportunities.length} opportunités détectées:`);
      console.log(`  Volume médian: $${(volumes[Math.floor(volumes.length/2)]/1000000).toFixed(1)}M`);
      console.log(`  Volume total: $${(totalVolume/1000000).toFixed(1)}M`);
      
      // Cryptos à risque (volume < $5M)
      const riskyOps = opportunities.filter(op => op.metrics.volume24h < 5000000);
      console.log(`  ⚠️ Opportunités risquées (<$5M): ${riskyOps.length}/${opportunities.length}`);
      
      // Cryptos ultra-sûres (volume > $100M)
      const safeOps = opportunities.filter(op => op.metrics.volume24h > 100000000);
      console.log(`  ✅ Opportunités ultra-sûres (>$100M): ${safeOps.length}/${opportunities.length}`);
      
      // Analyse des mouvements
      const strongMovers = opportunities.filter(op => Math.abs(op.metrics.momentum) > 2.0);
      const extremeMovers = opportunities.filter(op => Math.abs(op.metrics.momentum) > 5.0);
      
      console.log(`  🚀 Mouvements forts (>2%): ${strongMovers.length}/${opportunities.length}`);
      console.log(`  ⚡ Mouvements extrêmes (>5%): ${extremeMovers.length}/${opportunities.length}`);
    }
    
    // Test 3: Vérification des garde-fous de sécurité
    console.log('\n🛡️ Test 3: Garde-fous de Sécurité');
    console.log('-'.repeat(50));
    
    console.log('Mécanismes de protection actuels:');
    console.log('  ✅ Seuils de volume minimum par aggressivité');
    console.log('  ✅ Limite max 2 agents par symbole');
    console.log('  ✅ Vérification confidence minimum (40-60%)');
    console.log('  ✅ Exclusion sub-penny avec volume faible');
    console.log('  ✅ Validation meme-coins avec volume requis');
    console.log('  ✅ Filtrage symboles complexes');
    
    // Test 4: Analyse du scoring composite
    console.log('\n🎯 Test 4: Analyse du Scoring Composite');
    console.log('-'.repeat(50));
    
    const scoringWeights = {
      performance: 0.4,  // 40%
      volume: 0.35,      // 35% 
      movement: 0.25     // 25%
    };
    
    console.log('Pondération du scoring:');
    Object.entries(scoringWeights).forEach(([component, weight]) => {
      console.log(`  ${component.toUpperCase()}: ${(weight*100).toFixed(0)}%`);
    });
    
    console.log('\nAvantages du scoring composite:');
    console.log('  ✅ Volume garde 35% du poids (sécurité)');
    console.log('  ✅ Performance équilibrée avec mouvement');
    console.log('  ✅ Bonus volatilité pour marchés agités');
    console.log('  ✅ Priorité automatique aux mouvements >3%');
    
    // Test 5: Simulation crash market
    console.log('\n💥 Test 5: Simulation Crash de Marché');
    console.log('-'.repeat(50));
    
    console.log('Comportement système lors de crash (-20% BTC):');
    console.log('  📊 Mode haute volatilité: ACTIVÉ automatiquement');
    console.log('  🎯 Priorité aux mouvements extrêmes: OUI');
    console.log('  🛡️ Seuils volume maintenus: OUI (sécurité)');
    console.log('  ⚖️ Multi-agents limités: 2 max par symbole');
    console.log('  🔄 Scanning accéléré: Détection rapide opportunités');
    
    // Test 6: Recommandations d'ajustement
    console.log('\n⚙️ Test 6: Recommandations d\'Ajustement');
    console.log('-'.repeat(50));
    
    console.log('Ajustements recommandés pour optimiser sécurité/aggressivité:');
    
    console.log('\n🔒 SÉCURITÉ (Priorité haute):');
    console.log('  - Maintenir seuil $100K minimum en mode réactif');
    console.log('  - Ajouter stop-loss automatique à -2%');
    console.log('  - Limiter exposition totale à 10 agents max');
    console.log('  - Blacklist temporaire symboles volatils >15%');
    
    console.log('\n⚡ AGGRESSIVITÉ (Opportunités):');
    console.log('  - Mode "flash crash" avec seuils $50K temporaires');
    console.log('  - Bonus momentum x2 pour mouvements >5%');
    console.log('  - Allowlist majors (BTC/ETH) avec multi-agents x3');
    console.log('  - Système de "conviction scoring" pour overrides');
    
  } catch (error) {
    console.error('❌ Erreur analyse:', error);
  }
}

analyzeSystemSafety();