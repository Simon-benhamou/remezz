// Test spécifique de validation de l'évitement de conflits
console.log('✅ VALIDATION COMPLÈTE ÉVITEMENT CONFLITS\n');

async function validateCompleteConflictAvoidance() {
  try {
    console.log('🧪 SCENARIO: Tester sélection avec symboles actifs majeurs');
    
    // Tester l'API getOptimizedCryptoList directement
    console.log('\n🔍 Testing internal getOptimizedCryptoList...');
    
    // On sait que BTC, ETH, SOL, XRP, DOGE sont actifs
    const expectedActiveSymbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT'];
    
    console.log(`🚫 Expected active symbols: ${expectedActiveSymbols.join(', ')}`);
    
    // Appeler l'API d'opportunités pour voir la logique
    const response = await fetch('http://localhost:4000/api/agent/intelligent-opportunities');
    const result = await response.json();
    
    if (result.success && result.data) {
      const allSymbols = result.data.map(opp => opp.symbol);
      
      console.log('\n📊 FILTRAGE ANALYSIS:');
      
      // Vérifier que les majeurs sont bien absents
      const filteredMajors = expectedActiveSymbols.filter(symbol => 
        !allSymbols.includes(symbol)
      );
      
      const presentMajors = expectedActiveSymbols.filter(symbol => 
        allSymbols.includes(symbol)
      );
      
      console.log(`✅ Filtered out (as expected): ${filteredMajors.join(', ') || 'None'}`);
      console.log(`⚠️  Still present (unexpected): ${presentMajors.join(', ') || 'None'}`);
      
      // Analyser les alternatives proposées
      console.log('\n🏆 ALTERNATIVES PROPOSÉES:');
      result.data.slice(0, 8).forEach((opp, i) => {
        console.log(`  ${i+1}. ${opp.symbol} - Score: ${opp.score.toFixed(2)} - ${opp.opportunity.direction} ${opp.opportunity.type}`);
      });
      
      // Test de diversification
      const symbols = result.data.map(opp => opp.symbol);
      const bases = symbols.map(s => s.split('/')[0]);
      const uniqueBases = [...new Set(bases)];
      
      console.log('\n🌐 DIVERSIFICATION:');
      console.log(`- Total opportunities: ${result.data.length}`);
      console.log(`- Unique base assets: ${uniqueBases.length}`);
      console.log(`- Diversification ratio: ${(uniqueBases.length / result.data.length * 100).toFixed(1)}%`);
      
      // Vérifier les catégories
      const types = result.data.map(opp => opp.opportunity.type);
      const typeCount = {};
      types.forEach(type => {
        typeCount[type] = (typeCount[type] || 0) + 1;
      });
      
      console.log('\n📈 OPPORTUNITY TYPES:');
      Object.entries(typeCount).forEach(([type, count]) => {
        console.log(`  ${type}: ${count} opportunities`);
      });
      
      // Score distribution
      const scores = result.data.map(opp => opp.score);
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      const maxScore = Math.max(...scores);
      const minScore = Math.min(...scores);
      
      console.log('\n📊 SCORE DISTRIBUTION:');
      console.log(`  Avg: ${avgScore.toFixed(2)}`);
      console.log(`  Max: ${maxScore.toFixed(2)}`);
      console.log(`  Min: ${minScore.toFixed(2)}`);
      console.log(`  Range: ${(maxScore - minScore).toFixed(2)}`);
      
    }
    
    console.log('\n✅ VALIDATION RÉSULTATS:');
    
    if (result.success) {
      const hasExpectedFiltering = !result.data.some(opp => 
        ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'].includes(opp.symbol)
      );
      
      if (hasExpectedFiltering) {
        console.log('🎯 ✅ CONFLICT AVOIDANCE: WORKING');
        console.log('   Les majeurs actifs sont bien filtrés');
      } else {
        console.log('⚠️  ❌ CONFLICT AVOIDANCE: NEEDS REVIEW');
        console.log('   Certains majeurs actifs apparaissent encore');
      }
      
      const hasGoodDiversification = result.data.length >= 10;
      if (hasGoodDiversification) {
        console.log('🎯 ✅ DIVERSIFICATION: SUFFICIENT');
        console.log(`   ${result.data.length} alternatives disponibles`);
      } else {
        console.log('⚠️  ❌ DIVERSIFICATION: LIMITED');
        console.log(`   Seulement ${result.data.length} alternatives`);
      }
      
    } else {
      console.log('❌ API Error - cannot validate');
    }
    
    console.log('\n🎯 NEXT TEST:');
    console.log('Créer un agent AUTO et observer la sélection en temps réel');
    
  } catch (error) {
    console.error('❌ Validation failed:', error);
  }
}

validateCompleteConflictAvoidance();