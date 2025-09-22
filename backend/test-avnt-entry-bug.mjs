// DIAGNOSTIC SPÉCIFIQUE AVNT - BUG ENTRY ZONE
// Prix 2.2077 au-dessus zone [2.1695, 2.1869] mais agent n'entre pas
console.log('🔍 AVNT ENTRY ZONE BUG DIAGNOSTIC...\n');

async function diagnoseBagEntryBug() {
  const API_BASE = 'http://localhost:4000';
  
  // Obtenir un token valide
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
    return 'your-app-api-key';
  };
  
  const token = await getValidToken();
  
  try {
    console.log('🎯 1. ANALYSING CURRENT SITUATION:');
    console.log('Price: 2.2077');
    console.log('Zone: [2.1695, 2.1869]');
    console.log('Distance above zone: 0.940%');
    console.log('Expected: Agent should enter LONG (price above zone)');
    console.log('Actual: Agent not entering');
    
    // 1. Récupérer l'overview des agents
    console.log('\n📊 2. CHECKING ACTIVE AGENTS ON AVNT:');
    
    const overviewResponse = await fetch(`${API_BASE}/api/agent/overview`, {
      headers: { 'x-api-key': token }
    });
    
    if (!overviewResponse.ok) {
      throw new Error(`Failed to get overview: ${overviewResponse.status}`);
    }
    
    const overview = await overviewResponse.json();
    const avntAgents = overview.sessions?.filter(s => s.symbol === 'AVNT/USDT') || [];
    
    console.log(`Found ${avntAgents.length} AVNT agents:`);
    avntAgents.forEach((agent, idx) => {
      console.log(`  ${idx + 1}. Session ${agent.id} - Status: ${agent.status} - Mode: ${agent.mode}`);
    });
    
    if (avntAgents.length === 0) {
      console.log('❌ No AVNT agents found! Create one first.');
      return;
    }
    
    // 2. Analyser le premier agent AVNT
    const agent = avntAgents[0];
    console.log(`\n🔍 3. DETAILED ANALYSIS OF AGENT ${agent.id}:`);
    
    try {
      // Récupérer l'état de l'agent
      const stateResponse = await fetch(`${API_BASE}/api/agent/state?sessionId=${agent.id}`, {
        headers: { 'x-api-key': token }
      });
      
      if (stateResponse.ok) {
        const state = await stateResponse.json();
        console.log('Agent State:', state.agentState);
        console.log('Has Position:', state.hasPosition || false);
        console.log('Plan Bias:', state.plan?.bias);
        console.log('Plan Playbook:', state.plan?.plan?.meta?.playbook);
        console.log('Zone From:', state.plan?.zone?.from);
        console.log('Zone To:', state.plan?.zone?.to);
        console.log('Zone Mid:', state.plan?.zone?.mid);
      }
      
      // Récupérer les diagnostics
      const diagResponse = await fetch(`${API_BASE}/api/agent/sessions/${agent.id}/diagnostics`, {
        headers: { 'x-api-key': token }
      });
      
      if (diagResponse.ok) {
        const diagnostics = await diagResponse.json();
        console.log('\n🔧 4. DIAGNOSTIC DETAILS:');
        console.log('Can Trade:', diagnostics.canTrade);
        console.log('Reason:', diagnostics.reason);
        
        if (diagnostics.checks) {
          console.log('\n📋 Detailed Checks:');
          
          // Entry zone check
          if (diagnostics.checks.inEntryZone) {
            const zoneCheck = diagnostics.checks.inEntryZone;
            console.log('\n🎯 ENTRY ZONE CHECK:');
            console.log('Status:', zoneCheck.status);
            console.log('Reason:', zoneCheck.reason);
            
            if (zoneCheck.details) {
              console.log('Current Price:', zoneCheck.details.currentPrice);
              console.log('Zone From:', zoneCheck.details.zoneFrom);
              console.log('Zone To:', zoneCheck.details.zoneTo);
              console.log('In Zone:', zoneCheck.details.inZone);
              console.log('Is Dynamic:', zoneCheck.details.isDynamic);
            }
          }
          
          // Autres checks importants
          ['isArmed', 'hasPosition', 'momentumGates', 'qualityScore'].forEach(checkName => {
            if (diagnostics.checks[checkName]) {
              const check = diagnostics.checks[checkName];
              console.log(`\n${checkName.toUpperCase()}:`);
              console.log('Status:', check.status);
              console.log('Reason:', check.reason);
            }
          });
        }
      }
      
    } catch (error) {
      console.log(`❌ Error analyzing agent: ${error.message}`);
    }
    
    // 3. Analyser la logique d'entrée
    console.log('\n🧠 5. ENTRY LOGIC ANALYSIS:');
    
    const currentPrice = 2.2077;
    const zoneFrom = 2.1695121000000004;
    const zoneTo = 2.1869379;
    const zoneMin = Math.min(zoneFrom, zoneTo);
    const zoneMax = Math.max(zoneFrom, zoneTo);
    
    console.log(`Current Price: ${currentPrice}`);
    console.log(`Zone: [${zoneMin.toFixed(4)}, ${zoneMax.toFixed(4)}]`);
    console.log(`Price in zone: ${currentPrice >= zoneMin && currentPrice <= zoneMax}`);
    console.log(`Price above zone: ${currentPrice > zoneMax}`);
    console.log(`Price below zone: ${currentPrice < zoneMin}`);
    
    const distanceAbove = ((currentPrice - zoneMax) / currentPrice * 100);
    console.log(`Distance above zone: ${distanceAbove.toFixed(3)}%`);
    
    // 4. Identifier le problème
    console.log('\n🐛 6. BUG IDENTIFICATION:');
    
    if (currentPrice > zoneMax) {
      console.log('🎯 ISSUE FOUND: Price is ABOVE the zone!');
      console.log('\n💡 Possible Causes:');
      console.log('1. ❌ Agent using MEAN_REVERSION playbook (only enters IN zone)');
      console.log('2. ❌ Agent should use MOMENTUM_BREAKOUT (enters ABOVE zone for LONG)');
      console.log('3. ❌ Bias is not LONG (should be LONG when price above zone)');
      console.log('4. ❌ Other momentum gates blocking entry');
      console.log('5. ❌ Agent not in ARMED state');
      
      console.log('\n🔧 REQUIRED FIXES:');
      console.log('1. ✅ Change playbook to MOMENTUM_BREAKOUT');
      console.log('2. ✅ Ensure bias is LONG');
      console.log('3. ✅ Check momentum gate thresholds');
      console.log('4. ✅ Verify agent is ARMED');
      
      console.log('\n⚡ IMMEDIATE TEST:');
      console.log('If playbook is MOMENTUM_BREAKOUT and bias is LONG:');
      console.log(`const breakoutLong = bias === 'long' && price > upper;`);
      console.log(`Result: ${true} && ${currentPrice} > ${zoneMax} = ${true && currentPrice > zoneMax}`);
      console.log(`Should enter: ${true && currentPrice > zoneMax ? 'YES' : 'NO'}`);
    }
    
    // 5. Solutions recommandées
    console.log('\n🚀 7. RECOMMENDED SOLUTIONS:');
    
    console.log('\n🔄 Option 1: Force Momentum Breakout');
    console.log('• Modify plan to use momentum_breakout playbook');
    console.log('• Ensure LONG bias when price > zone');
    console.log('• Agent will enter on price > zoneMax');
    
    console.log('\n🔄 Option 2: Expand Mean Reversion Zone');
    console.log('• Increase zone size to include current price');
    console.log('• Adjust zone dynamically based on volatility');
    console.log('• Use adaptive zone widths');
    
    console.log('\n🔄 Option 3: Hybrid Approach');
    console.log('• Allow entries both IN zone AND above zone');
    console.log('• Different position sizing for zone vs breakout');
    console.log('• Adaptive strategy based on market conditions');
    
    console.log('\n📊 8. TESTING COMMANDS:');
    console.log(`curl "${API_BASE}/api/debug/test-dynamic-zone/AVNT%2FUSDT/2.2077/long"`);
    console.log(`curl "${API_BASE}/api/agent/sessions/${agent.id}/diagnostics"`);
    
    console.log('\n✅ 9. EXPECTED BEHAVIOR:');
    console.log('With MOMENTUM_BREAKOUT + LONG bias:');
    console.log('• Price 2.2077 > Zone Max 2.1869 = ENTER LONG');
    console.log('• Stop Loss below zone (around 2.16)');
    console.log('• Take Profit above current price (2.25+)');
    
  } catch (error) {
    console.error('❌ Analysis failed:', error);
  }
}

diagnoseBagEntryBug();