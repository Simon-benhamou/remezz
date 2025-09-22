// Test en temps réel - Création agent AUTO et vérification résultat
console.log('🚨 TEST EN TEMPS RÉEL - CRÉATION AGENT AUTO\n');

async function testRealTimeAgentCreation() {
  try {
    console.log('🎯 AVANT CRÉATION:');
    console.log('- ADA/USDT devrait être sélectionné (score 6.69)');
    console.log('- DOGE/USDT devrait être évité (conflit)');
    console.log('- 3 sessions DOGE déjà actives');
    
    console.log('\n📊 État des sessions AVANT:');
    
    // Vérifier sessions actuelles
    try {
      const sessionsResponse = await fetch('http://localhost:4000/api/agent/sessions');
      const sessions = await sessionsResponse.json();
      
      const dogeSessions = sessions.filter(s => s.symbol && s.symbol.includes('DOGE'));
      console.log(`- Sessions DOGE actuelles: ${dogeSessions.length}`);
      dogeSessions.forEach((s, i) => {
        console.log(`  ${i+1}. ID: ${s.id.substring(0, 8)}... Symbol: ${s.symbol}`);
      });
      
    } catch (e) {
      console.log('❌ Erreur récupération sessions:', e.message);
    }
    
    console.log('\n🔍 MONITORING INSTRUCTIONS:');
    console.log('1. Va sur /sessions dans ton navigateur');
    console.log('2. Clique "Create New Agent"');
    console.log('3. Active "Auto-Select Mode" 🎯');
    console.log('4. Clique "Start Agent"');
    console.log('5. OBSERVE le symbol sélectionné');
    
    console.log('\n📋 LOGS À SURVEILLER (dans console serveur):');
    console.log('✅ SUCCÈS si tu vois:');
    console.log('   🚫 Symbols already active: DOGE/USDT, ...');
    console.log('   🚫 Skipping DOGE/USDT - already active in another agent');
    console.log('   ✅ Selected ADA/USDT as best available opportunity');
    console.log('   🎯 Best opportunity found: ADA/USDT');
    
    console.log('\n❌ ÉCHEC si tu vois:');
    console.log('   Pas de logs de filtrage');
    console.log('   Agent sélectionne encore DOGE/USDT');
    console.log('   Aucun message "already active"');
    
    console.log('\n⏱️  TIMING IMPORTANT:');
    console.log('- Faire le test MAINTENANT pendant que nous debuggons');
    console.log('- Observer les logs en temps réel');
    console.log('- Noter l\'EXACT symbol sélectionné');
    
    // Surveiller en continu les nouvelles sessions
    console.log('\n🔄 SURVEILLANCE AUTOMATIQUE...');
    console.log('(Appuie Ctrl+C pour arrêter)');
    
    let lastSessionCount = 0;
    
    const monitor = setInterval(async () => {
      try {
        const response = await fetch('http://localhost:4000/api/agent/sessions');
        const sessions = await response.json();
        
        if (sessions.length > lastSessionCount) {
          console.log(`\n🆕 NOUVELLE SESSION DÉTECTÉE!`);
          const newSessions = sessions.slice(lastSessionCount);
          
          newSessions.forEach(session => {
            const isAuto = session.isSmartAgent;
            const symbol = session.symbol;
            const id = session.id.substring(0, 8);
            
            console.log(`📋 Nouvelle session: ${id}...`);
            console.log(`   Symbol: ${symbol}`);
            console.log(`   Smart Agent: ${isAuto}`);
            console.log(`   Timestamp: ${session.startedAt}`);
            
            if (isAuto) {
              if (symbol === 'DOGE/USDT') {
                console.log(`🚨 PROBLÈME: Agent AUTO a encore choisi DOGE!`);
                console.log(`   Notre fix d'évitement de conflits ne fonctionne pas`);
              } else if (symbol === 'ADA/USDT') {
                console.log(`✅ SUCCÈS: Agent AUTO a choisi ADA!`);
                console.log(`   Fix d'évitement de conflits fonctionne`);
              } else {
                console.log(`🤔 AUTRE: Agent AUTO a choisi ${symbol}`);
                console.log(`   Pas DOGE (bon) mais pas ADA non plus`);
              }
            }
          });
          
          lastSessionCount = sessions.length;
        }
        
      } catch (e) {
        // Ignore erreurs monitoring
      }
    }, 2000); // Check toutes les 2 secondes
    
    // Timeout après 2 minutes
    setTimeout(() => {
      clearInterval(monitor);
      console.log('\n⏰ Timeout monitoring - arrêt automatique');
      process.exit(0);
    }, 120000);
    
  } catch (error) {
    console.error('❌ Test setup failed:', error);
  }
}

testRealTimeAgentCreation();