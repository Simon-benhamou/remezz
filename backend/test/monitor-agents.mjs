// MONITORING SCRIPT PRATIQUE - RÉÉVALUATION AUTO DES AGENTS
// Lance ce script pour vérifier l'état de tes agents en temps réel
console.log('🔍 PRACTICAL AGENT MONITORING SCRIPT...\n');

async function monitorAgents() {
  const API_BASE = 'http://localhost:4000';
  
  // Fonction pour obtenir un token valide
  const getValidToken = async () => {
    try {
      const loginResponse = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'password123' })
      });
      
      if (loginResponse.ok) {
        const data = await loginResponse.json();
        return data.token;
      }
    } catch (error) {
      console.log('⚠️  Could not get token, using default API key');
    }
    return 'your-app-api-key'; // fallback
  };
  
  const token = await getValidToken();
  console.log('🔑 Using authentication token for monitoring\n');
  
  try {
    // 1. Récupérer l'overview
    console.log('📊 CURRENT AGENT STATUS:');
    console.log('='.repeat(80));
    
    const overviewResponse = await fetch(`${API_BASE}/api/agent/overview`, {
      headers: { 'x-api-key': token }
    });
    
    if (!overviewResponse.ok) {
      throw new Error(`API Error: ${overviewResponse.status}`);
    }
    
    const overview = await overviewResponse.json();
    
    console.log(`📈 Active Agents: ${overview.activeCount || 0}`);
    console.log(`📋 Total Sessions: ${overview.sessionsCount || 0}`);
    console.log(`💰 Total P&L: $${overview.pnlUsd?.toFixed(2) || '0.00'}`);
    console.log(`📊 Symbols: ${overview.symbols?.join(', ') || 'None'}`);
    
    if (!overview.sessions || overview.sessions.length === 0) {
      console.log('\n⚠️  No active sessions found. Start some agents first!');
      console.log('\n🚀 Quick Setup Commands:');
      console.log('1. Go to dashboard → Create Agent');
      console.log('2. Set mode to AUTO for re-evaluation testing');
      console.log('3. Choose different symbols (BTC, ETH, SOL)');
      console.log('4. Run this monitor again');
      return;
    }
    
    console.log('\n🔍 DETAILED AGENT ANALYSIS:');
    console.log('='.repeat(80));
    
    // 2. Analyser chaque agent
    for (let i = 0; i < overview.sessions.length; i++) {
      const session = overview.sessions[i];
      console.log(`\n${i + 1}. 🤖 ${session.symbol} (${session.mode?.toUpperCase() || 'UNKNOWN'})`);
      console.log(`   Status: ${session.status || 'Unknown'}`);
      console.log(`   Session ID: ${session.id}`);
      
      try {
        // Récupérer l'état détaillé
        const stateResponse = await fetch(`${API_BASE}/api/agent/state?sessionId=${session.id}`, {
          headers: { 'x-api-key': token }
        });
        
        if (stateResponse.ok) {
          const state = await stateResponse.json();
          
          // Analyser les temps
          const now = new Date();
          let lastOrderHours = 'Never';
          let strategyUpdateHours = 'Never';
          let needsReEval = false;
          
          if (state.lastOrderTime) {
            const lastOrderTime = new Date(state.lastOrderTime);
            const hours = (now - lastOrderTime) / (1000 * 60 * 60);
            lastOrderHours = `${hours.toFixed(1)}h ago`;
            
            // Vérifier si re-evaluation est nécessaire
            if (hours > 12) {
              needsReEval = true;
            }
          }
          
          if (state.strategyUpdatedAt) {
            const strategyTime = new Date(state.strategyUpdatedAt);
            const hours = (now - strategyTime) / (1000 * 60 * 60);
            strategyUpdateHours = `${hours.toFixed(1)}h ago`;
          }
          
          console.log(`   🕒 Last Order: ${lastOrderHours}`);
          console.log(`   🧠 Strategy Updated: ${strategyUpdateHours}`);
          console.log(`   🎯 Agent State: ${state.agentState || 'Unknown'}`);
          
          // Déterminer le statut de re-evaluation
          if (session.mode === 'auto' || session.mode === 'AUTO') {
            if (needsReEval) {
              // Vérifier si la stratégie a été mise à jour récemment
              if (state.strategyUpdatedAt) {
                const stratHours = (now - new Date(state.strategyUpdatedAt)) / (1000 * 60 * 60);
                if (stratHours < 1) {
                  console.log(`   ✅ RE-EVALUATION: Just completed (${stratHours.toFixed(1)}h ago)`);
                } else if (stratHours < 12) {
                  console.log(`   ✅ RE-EVALUATION: Recently completed (${stratHours.toFixed(1)}h ago)`);
                } else {
                  console.log(`   ❌ RE-EVALUATION: MISSING! Should have happened ${(stratHours - 12).toFixed(1)}h ago`);
                }
              } else {
                console.log(`   ❌ RE-EVALUATION: MISSING! No strategy update found`);
              }
            } else {
              console.log(`   ⏳ RE-EVALUATION: Not needed yet (${(12 - parseFloat(lastOrderHours)).toFixed(1)}h remaining)`);
            }
          } else {
            console.log(`   📝 MANUAL MODE: Re-evaluation not applicable`);
          }
          
          // Récupérer les ordres récents
          const ordersResponse = await fetch(`${API_BASE}/api/orders?sessionId=${session.id}`, {
            headers: { 'x-api-key': token }
          });
          
          if (ordersResponse.ok) {
            const orders = await ordersResponse.json();
            console.log(`   📋 Total Orders: ${orders.length}`);
            
            if (orders.length > 0) {
              const recentOrders = orders.slice(0, 3);
              console.log(`   🎯 Recent Orders:`);
              recentOrders.forEach((order, idx) => {
                const time = new Date(order.timestamp).toLocaleString();
                console.log(`      ${idx + 1}. ${order.side} ${order.amount} ${order.symbol} @ ${time}`);
              });
            }
          }
          
        } else {
          console.log(`   ❌ Could not fetch agent state`);
        }
        
      } catch (error) {
        console.log(`   ❌ Error: ${error.message}`);
      }
    }
    
    // 3. Résumé et recommandations
    console.log('\n📊 SUMMARY & RECOMMENDATIONS:');
    console.log('='.repeat(80));
    
    const autoAgents = overview.sessions.filter(s => s.mode === 'auto' || s.mode === 'AUTO');
    const manualAgents = overview.sessions.filter(s => s.mode === 'manual' || s.mode === 'MANUAL');
    
    console.log(`\n📈 Current Distribution:`);
    console.log(`   AUTO agents: ${autoAgents.length}`);
    console.log(`   MANUAL agents: ${manualAgents.length}`);
    console.log(`   Total: ${overview.sessions.length}`);
    
    console.log(`\n🎯 Optimal Testing Setup (8-10 agents):`);
    console.log(`   Recommended: 4-5 AUTO + 4-5 MANUAL agents`);
    console.log(`   Current gap: ${Math.max(0, 8 - overview.sessions.length)} more agents needed`);
    
    if (autoAgents.length < 3) {
      console.log(`\n🚀 Quick Setup Suggestions:`);
      console.log(`   1. Add ${3 - autoAgents.length} more AUTO agents`);
      console.log(`   2. Use different symbols: BTC, ETH, SOL, MATIC, ADA`);
      console.log(`   3. Start with paper trading for safety`);
    }
    
    console.log(`\n⏱️  Monitoring Schedule:`);
    console.log(`   • Check every 2-4 hours during market hours`);
    console.log(`   • Look for 12h+ agents without re-evaluation`);
    console.log(`   • Document any re-evaluation failures`);
    console.log(`   • Compare AUTO vs MANUAL performance weekly`);
    
    console.log(`\n🔧 Next Steps:`);
    console.log(`   1. Run this monitor daily`);
    console.log(`   2. Note any agents missing re-evaluation`);
    console.log(`   3. Scale to 8-10 agents for comprehensive testing`);
    console.log(`   4. Track performance differences over time`);
    
    console.log(`\n💡 Pro Tips:`);
    console.log(`   • Save this output to track patterns over time`);
    console.log(`   • Set up automated alerts for stuck agents`);
    console.log(`   • Use different risk levels for variety`);
    console.log(`   • Monitor during both stable and volatile periods`);
    
  } catch (error) {
    console.error('❌ Monitoring failed:', error);
    console.log('\n🔧 Troubleshooting:');
    console.log('1. Ensure backend server is running on port 4000');
    console.log('2. Check if any agents are actually running');
    console.log('3. Verify authentication is working');
    console.log('4. Try accessing the dashboard manually first');
  }
}

// Auto-run the monitoring
console.log('🚀 Starting agent monitoring...\n');
monitorAgents();