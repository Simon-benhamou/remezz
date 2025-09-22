// Test direct de getTopCryptos pour vérifier le filtrage
console.log('🔍 TEST getTopCryptos() - Filtrage statique\n');

async function testStaticFiltering() {
  try {
    console.log('📊 Test du fallback statique getTopCryptos()...');
    
    // Simuler la logique getTopCryptos
    const staticList = [
      'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'BNB/USDT', 'ADA/USDT', 
      'AVAX/USDT', 'DOGE/USDT', 'DOT/USDT', 'MATIC/USDT', 'LTC/USDT',
      'LINK/USDT', 'UNI/USDT', 'BCH/USDT', 'XLM/USDT', 'ATOM/USDT', 
      'APT/USDT', 'OP/USDT', 'ARB/USDT', 'SUI/USDT', 'BTC/USDT'
    ];
    
    console.log(`📋 Liste statique complète: ${staticList.length} cryptos`);
    console.log(`   ${staticList.join(', ')}`);
    
    // Simuler getActiveAgentSymbols (du cache)
    const currentActiveSessions = [
      'DOGE/USDT',   // 3 sessions
      'DOGE/USDT', 
      'DOGE/USDT',
      'ETH/USDT',    // Normalisé depuis ETH/USD:USD
      'XRP/USDT',    // Normalisé depuis XRP/USD:USD
      'SOL/USDT',    // Normalisé depuis SOL/USD:USD
      'BTC/USDT',    // Normalisé depuis BTC/USD:USD
      'AVNT/USDT'    // Ancien agent
    ];
    
    // Dédupliquer
    const uniqueActive = [...new Set(currentActiveSessions)];
    console.log(`\n🚫 Symboles actifs uniques: ${uniqueActive.length}`);
    console.log(`   ${uniqueActive.join(', ')}`);
    
    // Appliquer le filtrage
    const availableSymbols = staticList.filter(symbol => !uniqueActive.includes(symbol));
    
    console.log(`\n✅ Symboles disponibles: ${availableSymbols.length}`);
    console.log(`   ${availableSymbols.join(', ')}`);
    
    console.log(`\n🚫 Symboles filtrés: ${staticList.length - availableSymbols.length}`);
    const filtered = staticList.filter(symbol => uniqueActive.includes(symbol));
    console.log(`   ${filtered.join(', ')}`);
    
    // Vérifications spécifiques
    const dogeFiltered = !availableSymbols.includes('DOGE/USDT');
    const adaAvailable = availableSymbols.includes('ADA/USDT');
    
    console.log(`\n🎯 VÉRIFICATIONS CRITIQUES:`);
    console.log(`- DOGE filtré: ${dogeFiltered ? '✅ OUI' : '❌ NON'}`);
    console.log(`- ADA disponible: ${adaAvailable ? '✅ OUI' : '❌ NON'}`);
    
    if (dogeFiltered && adaAvailable) {
      console.log(`\n✅ LOGIQUE STATIQUE CORRECTE`);
      console.log(`   Premier disponible: ${availableSymbols[0]}`);
      console.log(`   Le fallback statique devrait choisir ${availableSymbols[0]}, pas DOGE`);
    } else {
      console.log(`\n❌ PROBLÈME DANS LA LOGIQUE STATIQUE`);
      if (!dogeFiltered) {
        console.log(`   DOGE n'est pas filtré correctement`);
      }
      if (!adaAvailable) {
        console.log(`   ADA n'est pas disponible`);
      }
    }
    
    console.log(`\n💡 HYPOTHÈSE DU PROBLÈME:`);
    
    if (dogeFiltered) {
      console.log(`- La logique de filtrage est correcte`);
      console.log(`- Le problème vient probablement d'ailleurs:`);
      console.log(`  • Cache d'une version antérieure`);
      console.log(`  • Erreur dans getActiveAgentSymbols()`); 
      console.log(`  • Exchange API qui override la sélection`);
      console.log(`  • Fallback d'urgence qui bypass tout`);
    } else {
      console.log(`- La logique de filtrage a un bug`);
      console.log(`- getActiveAgentSymbols() ne retourne pas les bons symboles`);
    }
    
    console.log(`\n🔧 ACTIONS RECOMMANDÉES:`);
    console.log(`1. Checker les logs serveur lors création agent AUTO`);
    console.log(`2. Voir si "🚫 Symbols already active" apparaît`);
    console.log(`3. Vérifier quelle logique est utilisée (API vs statique)`);
    console.log(`4. Forcer re-sélection sur agent existant pour test`);
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testStaticFiltering();