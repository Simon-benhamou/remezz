// Debug getActiveAgentSymbols - Pourquoi DOGE pas détecté
console.log('🔍 DEBUG getActiveAgentSymbols() - Détection DOGE\n');

async function debugActiveAgentSymbols() {
  try {
    console.log('📊 1. TEST DIRECT getActiveAgentSymbols():');
    
    // Reproduire exactement la logique
    console.log('Simulation logique getActiveAgentSymbols()...');
    
    // Récupérer les sessions actives
    const response = await fetch('http://localhost:4000/api/agent/sessions');
    const allSessions = await response.json();
    
    console.log(`\n📋 Total sessions: ${allSessions.length}`);
    
    // Filtrer les sessions actives (stoppedAt = null)
    const activeSessions = allSessions.filter(session => !session.stoppedAt);
    console.log(`📈 Sessions actives: ${activeSessions.length}`);
    
    // Extraire et normaliser les symboles
    const symbols = activeSessions
      .map(session => session.symbol)
      .filter(symbol => symbol); // Remove null/undefined
    
    console.log(`\n🎯 Symboles bruts extraits:`);
    symbols.forEach((symbol, i) => {
      console.log(`  ${i+1}. ${symbol}`);
    });
    
    // Appliquer la normalisation
    const normalizedSymbols = symbols.map(symbol => {
      // Convert ETH/USD:USD → ETH/USDT
      if (symbol.includes('/USD:USD')) {
        const base = symbol.split('/')[0];
        const normalized = `${base}/USDT`;
        console.log(`🔄 Normalizing: ${symbol} → ${normalized}`);
        return normalized;
      }
      return symbol;
    });
    
    // Dédupliquer
    const uniqueSymbols = normalizedSymbols.filter((symbol, index, arr) => arr.indexOf(symbol) === index);
    
    console.log(`\n✅ Résultat final getActiveAgentSymbols():`);
    console.log(`   Uniques: ${uniqueSymbols.length}`);
    uniqueSymbols.forEach((symbol, i) => {
      console.log(`   ${i+1}. ${symbol}`);
    });
    
    // Vérifications critiques
    const dogeDetected = uniqueSymbols.includes('DOGE/USDT');
    console.log(`\n🚨 VÉRIFICATION CRITIQUE:`);
    console.log(`- DOGE/USDT détecté: ${dogeDetected ? '✅ OUI' : '❌ NON'}`);
    
    if (!dogeDetected) {
      console.log(`\n🔍 ANALYSE DU PROBLÈME:`);
      
      // Chercher les sessions DOGE
      const dogeSessions = activeSessions.filter(s => s.symbol && s.symbol.includes('DOGE'));
      console.log(`- Sessions avec DOGE: ${dogeSessions.length}`);
      
      dogeSessions.forEach((session, i) => {
        console.log(`  ${i+1}. ID: ${session.id.substring(0, 8)}... Symbol: "${session.symbol}" Active: ${!session.stoppedAt}`);
      });
      
      if (dogeSessions.length > 0) {
        console.log(`\n🚨 BUG TROUVÉ: Il y a ${dogeSessions.length} sessions DOGE actives mais elles ne sont pas détectées!`);
        console.log(`Problème dans la logique getActiveAgentSymbols()`);
      } else {
        console.log(`\n🤔 Étrange: Aucune session DOGE active trouvée`);
        console.log(`Peut-être que les sessions ont été arrêtées entre temps?`);
      }
    } else {
      console.log(`\n✅ DOGE correctement détecté - le problème est ailleurs`);
    }
    
    console.log(`\n🧪 2. TEST getOptimizedCryptoList() avec ces symboles:`);
    
    // Simuler le filtrage dans getOptimizedCryptoList
    const staticList = [
      'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'BNB/USDT', 'ADA/USDT', 
      'AVAX/USDT', 'DOGE/USDT', 'DOT/USDT', 'MATIC/USDT', 'LTC/USDT'
    ];
    
    console.log(`\nListe statique: ${staticList.length} cryptos`);
    console.log(`Symboles actifs à filtrer: ${uniqueSymbols.length} cryptos`);
    
    const availableFromStatic = staticList.filter(symbol => !uniqueSymbols.includes(symbol));
    
    console.log(`\n📊 Résultat filtrage statique:`);
    console.log(`- Disponibles: ${availableFromStatic.length}`);
    console.log(`- Filtrés: ${staticList.length - availableFromStatic.length}`);
    
    if (availableFromStatic.length > 0) {
      console.log(`\n🏆 Premier disponible: ${availableFromStatic[0]}`);
      
      if (availableFromStatic[0] === 'DOGE/USDT') {
        console.log(`🚨 PROBLÈME: DOGE est premier disponible - pas filtré!`);
      } else {
        console.log(`✅ CORRECT: ${availableFromStatic[0]} sélectionné au lieu de DOGE`);
      }
    }
    
  } catch (error) {
    console.error('❌ Debug failed:', error);
  }
}

debugActiveAgentSymbols();