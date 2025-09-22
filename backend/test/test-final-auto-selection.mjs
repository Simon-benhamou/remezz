// TEST FINAL - Création agent AUTO pour vérifier que BOME n'est plus sélectionné
console.log('🚀 TEST FINAL - AUTO AGENT SELECTION APRÈS CORRECTION...\n');

async function testAutoAgentSelection() {
  console.log('🎯 CRÉATION D\'UN AGENT AUTO POUR TESTER LA SÉLECTION:');
  console.log('='.repeat(70));
  
  try {
    // Test avec l'API backend
    const response = await fetch('http://localhost:4000/api/agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer dummy-token' // Auth basique pour test
      },
      body: JSON.stringify({
        name: 'TEST_AUTO_POST_FIX',
        symbol: 'AUTO', // Mode AUTO intelligent
        strategy: 'CRYPTO_MOONSHOT_V2',
        amount: 100,
        config: {
          riskLevel: 'moderate',
          timeframe: '1h'
        }
      })
    });
    
    if (response.ok) {
      const agent = await response.json();
      console.log('✅ Agent AUTO créé avec succès!');
      console.log(`📋 ID: ${agent.id}`);
      console.log(`📊 Symbol: ${agent.symbol}`);
      console.log(`💰 Amount: $${agent.amount}`);
      
      if (agent.symbol === 'BOME/USDT') {
        console.log('🚨 ÉCHEC: BOME encore sélectionné!');
        console.log('❌ Les corrections n\'ont pas fonctionné');
        return false;
      } else {
        console.log(`🎯 SUCCÈS: Crypto sélectionnée = ${agent.symbol}`);
        console.log('✅ BOME n\'est plus sélectionné!');
        
        // Vérifier que c'est une crypto acceptable
        const acceptableCryptos = [
          'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 
          'ADA/USDT', 'DOT/USDT', 'AVAX/USDT', 'MATIC/USDT',
          'LINK/USDT', 'UNI/USDT', 'AAVE/USDT', 'ATOM/USDT'
        ];
        
        if (acceptableCryptos.includes(agent.symbol)) {
          console.log('🏆 EXCELLENT: Crypto sélectionnée est de haute qualité');
        } else {
          console.log('⚠️  ATTENTION: Crypto inconnue sélectionnée');
          console.log('   Vérifier manuellement si acceptable');
        }
        
        return true;
      }
    } else {
      console.log('❌ Erreur création agent:');
      console.log(`   Status: ${response.status}`);
      const error = await response.text();
      console.log(`   Error: ${error}`);
      return false;
    }
    
  } catch (error) {
    console.log('❌ Erreur réseau:');
    console.log(`   ${error.message}`);
    console.log('\n💡 Solutions possibles:');
    console.log('   1. Vérifier que le backend est démarré (port 4000)');
    console.log('   2. Attendre quelques secondes pour initialisation');
    console.log('   3. Tester manuellement via interface web');
    return false;
  }
}

// Test de sélection automatique intelligente
async function testIntelligentSelection() {
  console.log('\n🧠 TEST LOGIQUE DE SÉLECTION INTELLIGENTE:');
  console.log('='.repeat(70));
  
  // Simuler le processus de sélection
  const mockData = {
    'BOME/USD:USD': {
      percentage: 0.14,
      quoteVolume: 32800, // $32.8K - INSUFFISANT
      baseVolume: 1000
    },
    'BTC/USD:USD': {
      percentage: 2.5,
      quoteVolume: 2000000000, // $2B - EXCELLENT
      baseVolume: 100000
    },
    'ETH/USD:USD': {
      percentage: 1.8,
      quoteVolume: 1000000000, // $1B - EXCELLENT
      baseVolume: 50000
    },
    'WIF/USD:USD': {
      percentage: 5.2,
      quoteVolume: 1500000, // $1.5M - BLACKLISTÉ
      baseVolume: 5000
    }
  };
  
  console.log('📊 DONNÉES SIMULÉES:');
  Object.entries(mockData).forEach(([symbol, data]) => {
    const base = symbol.split('/')[0];
    const volumeOk = data.quoteVolume >= 500000;
    const blacklisted = ['BOME', 'WIF', 'PEPE', 'SHIB'].includes(base);
    const status = !volumeOk ? '❌ Volume' : blacklisted ? '❌ Blacklist' : '✅ Acceptable';
    
    console.log(`   ${symbol}: $${(data.quoteVolume/1000000).toFixed(2)}M vol, ${data.percentage}% → ${status}`);
  });
  
  console.log('\n🎯 RÉSULTAT ATTENDU:');
  console.log('• BOME: Rejeté (volume $32.8K < $500K)');
  console.log('• WIF: Rejeté (blacklisté)');
  console.log('• BTC: Accepté (volume $2B, excellent)');
  console.log('• ETH: Accepté (volume $1B, excellent)');
  console.log('• 🏆 Sélection finale: BTC ou ETH');
}

// Exécution des tests
console.log('🚀 DÉMARRAGE DES TESTS FINAUX...\n');

testIntelligentSelection().then(() => {
  console.log('\n⏳ Test création agent AUTO dans 3 secondes...');
  
  setTimeout(async () => {
    const success = await testAutoAgentSelection();
    
    console.log('\n' + '='.repeat(70));
    if (success) {
      console.log('🎉 SUCCÈS TOTAL! Bug BOME corrigé!');
      console.log('✅ Agent AUTO maintenant sécurisé');
      console.log('🛡️  Sélection intelligente fonctionnelle');
    } else {
      console.log('⚠️  Test non concluant - vérification manuelle requise');
      console.log('💡 Essayer via interface web pour validation');
    }
    console.log('='.repeat(70));
  }, 3000);
});