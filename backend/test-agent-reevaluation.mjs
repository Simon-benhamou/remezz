// ANALYSE DE RÉÉVALUATION AUTOMATIQUE DES STRATÉGIES
// Vérifie si les agents auto réévaluent bien après 12h sans ordre
console.log('🤖 ANALYSING AGENT AUTO STRATEGY RE-EVALUATION...\n');

async function analyzeAgentReEvaluation() {
  const API_BASE = 'http://localhost:4000';
  
  try {
    console.log('📊 1. CHECKING CURRENT AGENT STATUS...');
    
    // Récupérer l'overview des agents
    const overviewResponse = await fetch(`${API_BASE}/api/agent/overview`, {
      headers: { 'x-api-key': 'your-app-api-key' }
    });
    
    if (!overviewResponse.ok) {
      throw new Error(`Failed to get overview: ${overviewResponse.status}`);
    }
    
    const overview = await overviewResponse.json();
    console.log(`Active agents: ${overview.activeCount}`);
    console.log(`Total sessions: ${overview.sessionsCount}`);
    console.log(`Symbols: ${overview.symbols?.join(', ') || 'None'}`);
    
    // Analyser chaque session
    console.log('\n📈 2. ANALYZING EACH AGENT SESSION:');
    
    for (const session of overview.sessions || []) {
      console.log(`\n🔍 Agent: ${session.symbol} (${session.mode})`);
      console.log(`Status: ${session.status}`);
      console.log(`Session ID: ${session.id}`);
      
      try {
        // Récupérer l'état détaillé de l'agent
        const stateResponse = await fetch(`${API_BASE}/api/agent/state?sessionId=${session.id}`, {
          headers: { 'x-api-key': 'your-app-api-key' }
        });
        
        if (stateResponse.ok) {
          const state = await stateResponse.json();
          
          console.log(`Last order: ${state.lastOrderTime || 'Never'}`);
          console.log(`Current strategy: ${state.currentStrategy || 'None'}`);
          console.log(`Strategy updated: ${state.strategyUpdatedAt || 'Never'}`);
          console.log(`Agent state: ${state.agentState || 'Unknown'}`);
          
          // Calculer le temps depuis le dernier ordre
          if (state.lastOrderTime) {
            const lastOrderTime = new Date(state.lastOrderTime);
            const now = new Date();
            const hoursSinceLastOrder = (now - lastOrderTime) / (1000 * 60 * 60);
            
            console.log(`⏱️  Hours since last order: ${hoursSinceLastOrder.toFixed(1)}h`);
            
            if (hoursSinceLastOrder > 12) {
              console.log('🚨 MORE THAN 12H WITHOUT ORDER!');
              console.log('🔄 Strategy should have been re-evaluated');
              
              // Vérifier si la stratégie a été mise à jour récemment
              if (state.strategyUpdatedAt) {
                const strategyUpdateTime = new Date(state.strategyUpdatedAt);
                const hoursSinceStrategyUpdate = (now - strategyUpdateTime) / (1000 * 60 * 60);
                console.log(`🧠 Hours since strategy update: ${hoursSinceStrategyUpdate.toFixed(1)}h`);
                
                if (hoursSinceStrategyUpdate < 12) {
                  console.log('✅ Strategy was recently updated - AUTO RE-EVALUATION WORKING');
                } else {
                  console.log('❌ Strategy NOT updated - AUTO RE-EVALUATION MIGHT BE BROKEN');
                }
              }
            } else {
              console.log('✅ Recent activity - no re-evaluation needed yet');
            }
          } else {
            console.log('⚠️  No order history found');
          }
          
          // Récupérer les derniers ordres
          const ordersResponse = await fetch(`${API_BASE}/api/orders?sessionId=${session.id}`, {
            headers: { 'x-api-key': 'your-app-api-key' }
          });
          
          if (ordersResponse.ok) {
            const orders = await ordersResponse.json();
            console.log(`📋 Total orders: ${orders.length}`);
            
            if (orders.length > 0) {
              const lastOrder = orders[0];
              console.log(`🎯 Last order: ${lastOrder.side} ${lastOrder.symbol} at ${lastOrder.timestamp}`);
            }
          }
          
        } else {
          console.log('❌ Could not get agent state');
        }
        
        // Récupérer les diagnostics
        const diagResponse = await fetch(`${API_BASE}/api/agent/sessions/${session.id}/diagnostics`, {
          headers: { 'x-api-key': 'your-app-api-key' }
        });
        
        if (diagResponse.ok) {
          const diagnostics = await diagResponse.json();
          console.log(`🔧 Agent health: ${diagnostics.health || 'Unknown'}`);
          console.log(`🎛️  Aggressiveness: ${diagnostics.aggressiveness || 'Unknown'}`);
          
          if (diagnostics.lastStrategyGeneration) {
            const stratGenTime = new Date(diagnostics.lastStrategyGeneration);
            const hoursSinceStratGen = (new Date() - stratGenTime) / (1000 * 60 * 60);
            console.log(`🧠 Last strategy generation: ${hoursSinceStratGen.toFixed(1)}h ago`);
          }
        }
        
      } catch (error) {
        console.log(`❌ Error analyzing session: ${error.message}`);
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('🎯 3. RE-EVALUATION MONITORING RECOMMENDATIONS:');
    console.log('='.repeat(60));
    
    console.log('\n📊 Current Setup Analysis:');
    console.log('• 1 agent AUTO (should auto re-evaluate)');
    console.log('• 4 agents MANUAL (BTC/SOL/XRP/ETH)');
    console.log('• Need to monitor 12h rule compliance');
    
    console.log('\n🔍 How to Monitor Auto Re-evaluation:');
    console.log('1. Check agent state every few hours');
    console.log('2. Compare lastOrderTime vs strategyUpdatedAt');
    console.log('3. Look for strategy generation logs');
    console.log('4. Monitor agent diagnostics');
    
    console.log('\n🧪 Recommended Test Setup:');
    console.log('For comprehensive testing, you should run:');
    
    console.log('\n📈 CRYPTO PORTFOLIO TESTS:');
    console.log('• 2-3 agents on BTC (different timeframes)');
    console.log('• 2 agents on ETH (high volume)');
    console.log('• 1-2 agents on SOL (high volatility)');
    console.log('• 1 agent on XRP (different behavior)');
    console.log('• 1-2 agents on altcoins (MATIC, ADA, DOT)');
    console.log('• Total: 8-10 agents');
    
    console.log('\n⚙️  MODE DISTRIBUTION:');
    console.log('• 3-4 agents AUTO (test re-evaluation)');
    console.log('• 4-6 agents MANUAL (baseline comparison)');
    console.log('• Mix of paper and live modes');
    
    console.log('\n⏱️  TIME SCENARIOS:');
    console.log('• Short-term: 1-4h cycles');
    console.log('• Medium-term: 6-12h cycles');
    console.log('• Long-term: 24h+ cycles');
    
    console.log('\n🎯 SPECIFIC TESTS TO RUN:');
    console.log('1. Leave AUTO agents idle for 12+ hours');
    console.log('2. Check if they generate new strategies');
    console.log('3. Compare performance vs MANUAL agents');
    console.log('4. Test different market conditions');
    console.log('5. Monitor resource usage scaling');
    
    console.log('\n📊 4. CREATING MONITORING SCRIPT...');
    
    const monitoringScript = `
// AUTO-STRATEGY RE-EVALUATION MONITOR
// Run this every 2-4 hours to check agent behavior

setInterval(async () => {
  const overview = await fetch('/api/agent/overview').then(r => r.json());
  
  for (const session of overview.sessions || []) {
    if (session.mode === 'auto') {
      const state = await fetch(\`/api/agent/state?sessionId=\${session.id}\`).then(r => r.json());
      
      const hoursSinceLastOrder = state.lastOrderTime ? 
        (Date.now() - new Date(state.lastOrderTime)) / (1000 * 60 * 60) : 999;
      
      const hoursSinceStrategyUpdate = state.strategyUpdatedAt ?
        (Date.now() - new Date(state.strategyUpdatedAt)) / (1000 * 60 * 60) : 999;
      
      if (hoursSinceLastOrder > 12 && hoursSinceStrategyUpdate > 11) {
        console.warn(\`🚨 Agent \${session.symbol} may need strategy re-evaluation!\`);
        // Trigger manual re-evaluation if needed
        await fetch(\`/api/strategy/generate\`, {
          method: 'POST',
          body: JSON.stringify({ symbol: session.symbol, trigger: 'timeout_check' })
        });
      }
    }
  }
}, 2 * 60 * 60 * 1000); // Check every 2 hours
`;
    
    console.log('📝 Monitoring script template created above');
    
    console.log('\n✅ 5. IMMEDIATE ACTION ITEMS:');
    console.log('1. Monitor your current AUTO agent for 12+ hours');
    console.log('2. Set up 2-3 more AUTO agents on different symbols');
    console.log('3. Create monitoring dashboard for strategy updates');
    console.log('4. Test re-evaluation trigger manually');
    console.log('5. Scale to 8-10 total agents for comprehensive testing');
    
  } catch (error) {
    console.error('❌ Analysis failed:', error);
  }
}

analyzeAgentReEvaluation();