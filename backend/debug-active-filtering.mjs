#!/usr/bin/env node

import { getActiveAgentSymbols, scanIntelligentOpportunities } from './dist/src/services/intelligentAgent.js';

async function debugActiveFiltering() {
  console.log('🔍 Debug: Why Smart Agent only finds one opportunity\n');
  
  try {
    // Étape 1: Cryptos actuellement actives
    console.log('1️⃣ CRYPTOS ACTUELLEMENT ACTIVES:');
    const activeSymbols = await getActiveAgentSymbols();
    console.log(`   Active: [${activeSymbols.join(', ')}] (${activeSymbols.length} cryptos)`);
    
    // Étape 2: Scan complet (sans filtre exclusion)
    console.log('\n2️⃣ SCAN COMPLET (toutes cryptos):');
    const allOpportunities = await scanIntelligentOpportunities(); // Pas d'exclusion
    console.log(`   Trouvées: ${allOpportunities.length} opportunités`);
    allOpportunities.slice(0, 5).forEach((opp, i) => {
      const isActive = activeSymbols.includes(opp.symbol);
      console.log(`   ${i+1}. ${opp.symbol}: score ${opp.score.toFixed(2)} ${isActive ? '🔴 ACTIVE' : '🟢 LIBRE'}`);
    });
    
    // Étape 3: Scan avec exclusion (ce que fait Smart Agent)
    console.log('\n3️⃣ SCAN SMART AGENT (avec exclusion):');
    const smartOpportunities = await scanIntelligentOpportunities('fake-session-id'); // Simule exclusion
    console.log(`   Disponibles: ${smartOpportunities.length} opportunités`);
    smartOpportunities.slice(0, 5).forEach((opp, i) => {
      console.log(`   ${i+1}. ${opp.symbol}: score ${opp.score.toFixed(2)} 🟢 LIBRE`);
    });
    
    console.log('\n💡 ANALYSE:');
    if (smartOpportunities.length === 0) {
      console.log('❌ PROBLÈME: Aucune crypto disponible après filtrage des actives');
      console.log('   → Toutes les bonnes cryptos sont déjà prises par des agents');
      console.log('   → Smart Agent ne trouve plus rien → SMART/SLEEP');
    } else if (smartOpportunities.length < 3) {
      console.log('⚠️ LIMITATION: Très peu de cryptos disponibles');
      console.log(`   → Seulement ${smartOpportunities.length} cryptos libres`);
      console.log('   → Selection limitée pour Smart Agent');
    } else {
      console.log('✅ NORMAL: Plusieurs cryptos disponibles');
      console.log('   → Le problème est ailleurs (seuils, confidence, etc.)');
    }
    
    console.log('\n🔧 SOLUTIONS POSSIBLES:');
    console.log('1. Permettre plusieurs agents sur même crypto (différentes stratégies)');
    console.log('2. Élargir la liste de cryptos scannées (plus que top 20)');
    console.log('3. Réduire les seuils de confidence/score pour plus d\'opportunités');
    console.log('4. Mode rotation intelligente (switch crypto quand inactive)');
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
  }
}

debugActiveFiltering();