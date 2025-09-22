// Test création nouveau agent AUTO après fix évitement conflits
console.log('🆕 TEST NOUVEL AGENT AUTO - POST FIX ÉVITEMENT CONFLITS\n');

async function testNewAutoAgentPostFix() {
  try {
    console.log('🎯 Objectif: Vérifier qu\'un nouvel agent AUTO évite DOGE');
    console.log('Attendu: ADA/USDT (top opportunity), pas DOGE/USDT\n');
    
    console.log('📊 État actuel:');
    console.log('- DOGE/USDT: 2 agents actifs (conflicts)');
    console.log('- ADA/USDT: Score 6.69, #1 opportunity');
    console.log('- Logique: Nouveau agent devrait choisir ADA\n');
    
    console.log('🚀 Instructions pour test manuel:');
    console.log('1. Aller sur /sessions');
    console.log('2. Cliquer "Create New Agent"');
    console.log('3. Activer "Auto-Select Mode" 🎯');
    console.log('4. Créer l\'agent');
    console.log('5. Observer la crypto sélectionnée\n');
    
    console.log('✅ SUCCÈS si:');
    console.log('- Agent choisit ADA/USDT ou SUI/USDT');
    console.log('- Agent évite DOGE/USDT (déjà actif)');
    console.log('- Logs montrent "🚫 Skipping DOGE/USDT - already active"\n');
    
    console.log('❌ ÉCHEC si:');
    console.log('- Agent choisit encore DOGE/USDT');
    console.log('- Pas de filtrage des conflits visible\n');
    
    console.log('🔍 ALTERNATIVE - Test API (nécessite auth):');
    console.log('```bash');
    console.log('curl -X POST "http://localhost:4000/api/agent/start" \\');
    console.log('  -H "Content-Type: application/json" \\');
    console.log('  -H "x-api-key: YOUR_API_KEY" \\');
    console.log('  -d \'{');
    console.log('    "mode": "paper",');
    console.log('    "startBalanceUsd": 1000,');
    console.log('    "isSmartAgent": true,');
    console.log('    "aggressiveness": "conservative"');
    console.log('  }\'');
    console.log('```\n');
    
    console.log('📋 LOG MONITORING:');
    console.log('Dans les logs serveur, chercher:');
    console.log('- "🚫 Symbols already active: DOGE/USDT, ..."');
    console.log('- "🚫 Skipping DOGE/USDT - already active in another agent"');
    console.log('- "✅ Selected X available performers (Y filtered out due to conflicts)"');
    console.log('- "🎯 Best opportunity found: ADA/USDT"');
    
    console.log('\n🎯 ATTENDU:');
    console.log('📊 Symbols already active: DOGE/USDT, DOGE/USDT, ETH/USD:USD, XRP/USD:USD, SOL/USD:USD, BTC/USD:USD');
    console.log('🚫 Skipping DOGE/USDT - already active in another agent');
    console.log('🚫 Skipping ETH/USDT - already active in another agent (normalized from ETH/USD:USD)');
    console.log('🚫 Skipping SOL/USDT - already active in another agent');
    console.log('🚫 Skipping XRP/USDT - already active in another agent');
    console.log('🚫 Skipping BTC/USDT - already active in another agent');
    console.log('✅ Selected 15 available performers (5 filtered out due to conflicts)');
    console.log('🎯 Best opportunity found: ADA/USDT (current: ETH/USDT)');
    console.log('🔄 Forcing switch: ETH/USDT → ADA/USDT');
    
    console.log('\n💡 Pourquoi les anciens agents ont DOGE:');
    console.log('- Créés AVANT implémentation du fix évitement conflits');
    console.log('- À ce moment, DOGE était dans liste statique sans filtrage');
    console.log('- Fix appliqué seulement aux NOUVEAUX agents');
    
    console.log('\n🔄 Pour tester sur agent existant:');
    console.log('- Utiliser bouton "Re-select" dans interface Smart Agent');
    console.log('- Ou appeler API /api/agent/smart/:sessionId/reselect');
    console.log('- Forcer re-evaluation avec nouvelle logique');
    
  } catch (error) {
    console.error('❌ Test setup failed:', error);
  }
}

testNewAutoAgentPostFix();