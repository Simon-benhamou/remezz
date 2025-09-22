// Test direct de getOptimizedCryptoList pour voir si DOGE apparaît
console.log('🔍 TEST DIRECT getOptimizedCryptoList()\n');

async function testDirectCryptoList() {
  try {
    console.log('📊 Appel direct à getOptimizedCryptoList()...');
    
    // Simuler l'import de la fonction
    const response = await fetch('http://localhost:4000/api/debug/current-selection');
    
    if (response.ok) {
      const result = await response.json();
      console.log('✅ API Response:');
      console.log(`- Count: ${result.count || 'N/A'}`);
      console.log(`- Contains Bitcoin: ${result.containsBitcoin || false}`);
      console.log(`- Bitcoin Rank: ${result.bitcoinRank || 'Not found'}`);
      
      if (result.selectedCryptos && result.selectedCryptos.length > 0) {
        console.log('\n🏆 TOP 10 SELECTED:');
        result.selectedCryptos.slice(0, 10).forEach((crypto, i) => {
          const isDoge = crypto === 'DOGE/USDT';
          const marker = isDoge ? '🚨 DOGE FOUND!' : '';
          console.log(`  ${i+1}. ${crypto} ${marker}`);
        });
        
        const dogeIndex = result.selectedCryptos.indexOf('DOGE/USDT');
        if (dogeIndex >= 0) {
          console.log(`\n🚨 PROBLÈME: DOGE trouvé à la position ${dogeIndex + 1}`);
          console.log(`   La logique d'évitement des conflits ne fonctionne pas`);
        } else {
          console.log(`\n✅ SUCCÈS: DOGE pas dans la liste (évitement de conflit)`);
        }
        
        // Analyser si les alternatives sont disponibles
        const expectedAlternatives = ['ADA/USDT', 'SUI/USDT', 'XLM/USDT'];
        console.log('\n🔍 ALTERNATIVES ATTENDUES:');
        expectedAlternatives.forEach(alt => {
          const found = result.selectedCryptos.includes(alt);
          console.log(`  ${alt}: ${found ? '✅ Présent' : '❌ Absent'}`);
        });
      }
    } else {
      console.log(`❌ API Error: ${response.status}`);
      
      // Test alternatif - vérifier manuellement la logique
      console.log('\n🔧 TEST MANUEL DE LA LOGIQUE:');
      
      // Simuler getActiveAgentSymbols
      console.log('1. Simulation getActiveAgentSymbols():');
      const expectedActive = ['DOGE/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'BTC/USDT'];
      console.log(`   Active symbols: ${expectedActive.join(', ')}`);
      
      // Simuler la liste statique
      const staticList = [
        'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'BNB/USDT', 'ADA/USDT', 
        'AVAX/USDT', 'DOGE/USDT', 'DOT/USDT', 'MATIC/USDT', 'LTC/USDT'
      ];
      
      console.log('\n2. Filtrage des conflits:');
      const available = staticList.filter(symbol => !expectedActive.includes(symbol));
      console.log(`   Disponibles: ${available.join(', ')}`);
      console.log(`   Filtrés: ${staticList.filter(symbol => expectedActive.includes(symbol)).join(', ')}`);
      
      if (available.includes('DOGE/USDT')) {
        console.log('\n🚨 BUG: DOGE devrait être filtré mais apparaît dans disponibles');
      } else {
        console.log('\n✅ CORRECT: DOGE bien filtré de la liste disponible');
      }
    }
    
    console.log('\n💡 HYPOTHÈSES:');
    console.log('1. Cache ancien utilisé par agent AUTO');
    console.log('2. Sélection faite avant implémentation du fix');
    console.log('3. Fallback emergency utilisé');
    console.log('4. Agent utilise autre logique de sélection');
    
    console.log('\n🔧 ACTIONS:');
    console.log('1. Forcer re-selection manuelle de l\'agent AUTO');
    console.log('2. Vérifier logs serveur pour voir logique utilisée');
    console.log('3. Redémarrer agents pour clear cache');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testDirectCryptoList();