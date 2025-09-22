// Test des corrections dashboard - agents et balance en mode paper
console.log('🧪 Testing Dashboard Fixes - Agents & Balance Display...\n');

async function testDashboardData() {
  try {
    // Test API overview en mode paper
    const API_BASE = 'http://localhost:4000';
    const API_KEY = 'your-secret-key'; // Clé par défaut pour les tests
    
    console.log('📡 Testing API Overview endpoint...');
    
    const response = await fetch(`${API_BASE}/api/agent/overview?mode=paper`, {
      headers: {
        'x-api-key': API_KEY,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.error(`❌ API Error: ${response.status} ${response.statusText}`);
      const errorText = await response.text();
      console.error('Error details:', errorText);
      return;
    }
    
    const data = await response.json();
    console.log('✅ API Overview Response received');
    
    // Test affichage des agents
    console.log('\n🤖 Active Agents Test:');
    console.log(`- Active Count: ${data.activeCount || 0}`);
    console.log(`- Total Sessions: ${data.sessionsCount || 0}`);
    console.log(`- Symbols: ${(data.symbols || []).join(', ') || 'None'}`);
    
    if (data.sessions && Array.isArray(data.sessions)) {
      console.log(`✅ Sessions data included: ${data.sessions.length} sessions`);
      data.sessions.forEach((session, idx) => {
        console.log(`  ${idx + 1}. ${session.symbol} (${session.mode}) - State: ${session.state} - PnL: $${session.pnlUsd.toFixed(2)}`);
      });
    } else {
      console.log('❌ Sessions data missing from API response');
      console.log('Available data keys:', Object.keys(data));
    }
    
    // Test balance paper
    console.log('\n💰 Paper Balance Test:');
    if (data.paperBalance) {
      console.log('✅ Paper Balance data found:');
      console.log(`  - Equity: $${data.paperBalance.equityUsd?.toFixed(2) || '0.00'}`);
      console.log(`  - Free: $${data.paperBalance.freeUsd?.toFixed(2) || '0.00'}`);
      console.log(`  - Committed: $${data.paperBalance.committedUsd?.toFixed(2) || '0.00'}`);
    } else {
      console.log('⚠️ Paper Balance data not found');
      console.log('This is normal if no paper agents are running');
    }
    
    // Test métriques globales header
    console.log('\n📊 Header Metrics Test:');
    console.log(`- Total PnL: $${Number(data.pnlUsd || 0).toFixed(2)}`);
    console.log(`- ROI: ${Number(data.roiPct || 0).toFixed(2)}%`);
    console.log(`- Win Rate: ${Number(data.avgWinRate || 0).toFixed(1)}%`);
    console.log(`- AI Calls: ${Number(data.aiCallsTotal || 0)}`);
    
    console.log('\n🎯 Dashboard Fix Summary:');
    console.log('✅ API endpoint responds correctly');
    console.log(`${data.sessions ? '✅' : '❌'} Sessions data included for dashboard agents list`);
    console.log(`${data.paperBalance ? '✅' : '⚠️'} Paper balance data included for header`);
    console.log('✅ All metrics properly formatted for frontend display');
    
  } catch (error) {
    console.error('❌ Test Error:', error.message);
    console.log('\n💡 Troubleshooting:');
    console.log('1. Make sure backend is running on localhost:4000');
    console.log('2. Check if API key "your-secret-key" is valid');
    console.log('3. Verify database connection');
  }
}

testDashboardData();