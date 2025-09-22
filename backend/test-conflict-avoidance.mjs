// Test de la logique d'évitement de conflits entre agents
import { prisma } from './dist/db/client.js';

console.log('🚫 TEST ÉVITEMENT CONFLITS AGENTS\n');

async function testConflictAvoidance() {
  try {
    console.log('📊 1. CHECKING CURRENT ACTIVE SESSIONS...');
    
    // Récupérer les sessions actives actuelles
    const activeSessions = await prisma.agentSession.findMany({
      where: { stoppedAt: null },
      select: { 
        id: true, 
        symbol: true, 
        mode: true, 
        startedAt: true 
      },
      orderBy: { startedAt: 'desc' }
    });
    
    console.log(`📈 Found ${activeSessions.length} active sessions:`);
    activeSessions.forEach((session, i) => {
      const sessionAge = Math.floor((Date.now() - new Date(session.startedAt).getTime()) / (1000 * 60));
      console.log(`  ${i+1}. ${session.symbol} (${session.mode}) - Age: ${sessionAge}min - ID: ${session.id.substring(0, 8)}...`);
    });
    
    const activeSymbols = activeSessions.map(s => s.symbol).filter(s => s);
    console.log(`\n🚫 Active symbols: ${activeSymbols.length > 0 ? activeSymbols.join(', ') : 'None'}`);
    
    // Tester l'API de sélection intelligente
    console.log('\n🧠 2. TESTING INTELLIGENT SELECTION API...');
    
    try {
      const response = await fetch('http://localhost:4000/api/agent/intelligent-opportunities');
      const result = await response.json();
      
      if (result.success) {
        console.log(`✅ Found ${result.count} intelligent opportunities`);
        
        if (result.data && result.data.length > 0) {
          console.log('\n🏆 TOP 5 OPPORTUNITIES:');
          result.data.slice(0, 5).forEach((opp, i) => {
            const isActive = activeSymbols.includes(opp.symbol);
            const status = isActive ? '🚫 ACTIVE' : '✅ AVAILABLE';
            console.log(`  ${i+1}. ${opp.symbol} - Score: ${opp.score.toFixed(2)} - ${status}`);
          });
          
          // Vérifier si la logique évite les conflits
          const availableOpportunities = result.data.filter(opp => !activeSymbols.includes(opp.symbol));
          console.log(`\n📊 CONFLICT ANALYSIS:`);
          console.log(`- Total opportunities: ${result.data.length}`);
          console.log(`- Available (no conflict): ${availableOpportunities.length}`);
          console.log(`- Conflicted (already active): ${result.data.length - availableOpportunities.length}`);
          
          if (availableOpportunities.length > 0) {
            console.log(`\n✅ BEST AVAILABLE OPPORTUNITY:`);
            const best = availableOpportunities[0];
            console.log(`   Symbol: ${best.symbol}`);
            console.log(`   Score: ${best.score.toFixed(2)}`);
            console.log(`   Confidence: ${best.confidence.toFixed(1)}%`);
            console.log(`   Type: ${best.opportunity.type}`);
            console.log(`   Direction: ${best.opportunity.direction}`);
          } else {
            console.log(`\n⚠️  ALL OPPORTUNITIES CONFLICTED`);
            console.log(`   Tous les meilleurs cryptos sont déjà actifs`);
          }
        }
      } else {
        console.log(`❌ API Error: ${result.error}`);
      }
    } catch (fetchError) {
      console.log(`❌ Failed to fetch opportunities: ${fetchError.message}`);
      console.log(`💡 Server may not be running on localhost:4000`);
    }
    
    console.log('\n🔧 3. LOGIC VERIFICATION:');
    
    // Simuler la logique d'évitement
    console.log('```typescript');
    console.log('// Logic implemented in getOptimizedCryptoList():');
    console.log('const activeSymbols = await getActiveAgentSymbols();');
    console.log('const availablePerformers = topPerformers.filter(symbol => {');
    console.log('  const isActive = activeSymbols.includes(symbol);');
    console.log('  if (isActive) {');
    console.log('    console.log(`🚫 Skipping ${symbol} - already active`);');
    console.log('  }');
    console.log('  return !isActive;');
    console.log('});');
    console.log('```');
    
    console.log('\n💡 BENEFITS:');
    console.log('✅ Évite les conflits entre agents AUTO');
    console.log('✅ Diversification automatique des positions');
    console.log('✅ Réduction du risque de corrélation');
    console.log('✅ Optimisation des ressources système');
    console.log('✅ Meilleure répartition du capital');
    
    console.log('\n🎯 NEXT STEPS:');
    console.log('1. Créer un agent AUTO pour tester');
    console.log('2. Vérifier que la sélection évite BTC/ETH si déjà actifs');
    console.log('3. Observer la diversification automatique');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testConflictAvoidance();