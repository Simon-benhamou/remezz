#!/usr/bin/env node

const API_URL = 'http://localhost:4000';
const AUTH = {
  username: 'simon',
  password: '143mgsd5'
};

async function getAuthToken() {
  const response = await globalThis.fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(AUTH)
  });
  const data = await response.json();
  return data.token;
}

async function createSmartAgent(token, aggressiveness, maxLeverage = 7) {
  console.log(`\n🚀 Creating ${aggressiveness} agent with ${maxLeverage}x leverage...`);
  
  const payload = {
    mode: 'paper',
    smartAutoMode: true,
    maxLeverage,
    aggressiveness,
    strategyEngine: 'meta_adaptive'
  };

  // Step 1: Prepare
  const prepareRes = await globalThis.fetch(`${API_URL}/api/agent/prepare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  const prepare = await prepareRes.json();
  console.log(`   ✓ Prepared: ${prepare.selection?.symbol || 'unknown'}`);

  if (!prepare.creationId || !prepare.selection?.symbol) {
    console.log(`   ❌ Failed to prepare: No symbol selected (might be filtered for unclear signal)`);
    return null;
  }

  // Step 2: Create session
  await globalThis.fetch(`${API_URL}/api/agent/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      creationId: prepare.creationId,
      symbol: prepare.selection.symbol
    })
  });

  // Step 3: Activate
  const activateRes = await globalThis.fetch(`${API_URL}/api/agent/activate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ creationId: prepare.creationId })
  });
  const activation = await activateRes.json();
  console.log(`   ✓ Activated: ${activation.sessionId}`);
  
  return {
    sessionId: activation.sessionId,
    symbol: activation.symbol
  };
}

async function checkDiagnostics(token, sessionId, symbol) {
  console.log(`\n📊 Checking diagnostics for ${sessionId}...`);
  
  const response = await globalThis.fetch(`${API_URL}/api/agent/${sessionId}/diagnostics`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await response.json();
  
  console.log(`   Symbol: ${data.symbol}`);
  console.log(`   Predictor available: ${data.predictor?.available || false}`);
  console.log(`   Predictor confidence: ${data.predictor?.confidence || 'N/A'}`);
  console.log(`   Strategy: ${data.strategy?.id || 'N/A'}`);
  console.log(`   Symbol profile regime: ${data.symbolProfile?.volatilityRegime || 'unknown'}`);
  
  return data;
}

async function main() {
  console.log('🧪 Testing Agent Creation Fixes\n');
  console.log('=' .repeat(60));
  
  const token = await getAuthToken();
  console.log('✓ Authenticated\n');
  
  // Test 1: Create 3 agents in parallel to check duplication fix
  console.log('TEST 1: Creating 3 agents in parallel (checking duplication fix)');
  console.log('-'.repeat(60));
  
  const agents = await Promise.all([
    createSmartAgent(token, 'conservative', 7),
    createSmartAgent(token, 'reactive', 7),
    createSmartAgent(token, 'aggressive', 7)
  ]);
  
  const validAgents = agents.filter(a => a !== null);
  const symbols = validAgents.map(a => a.symbol);
  const uniqueSymbols = new Set(symbols);
  
  console.log(`\n✓ Created ${validAgents.length} agents`);
  console.log(`   Symbols: ${symbols.join(', ')}`);
  console.log(`   Unique symbols: ${uniqueSymbols.size}`);
  
  if (uniqueSymbols.size === validAgents.length) {
    console.log('   ✅ PASS: No duplicate symbols!');
  } else {
    console.log('   ❌ FAIL: Found duplicate symbols!');
  }
  
  // Test 2: Check immediate diagnostics (first tick)
  if (validAgents.length > 0) {
    console.log('\n\nTEST 2: Checking immediate diagnostics (first tick fix)');
    console.log('-'.repeat(60));
    
    // Wait 2 seconds for first tick to complete
    console.log('Waiting 2 seconds for first tick...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    for (const agent of validAgents) {
      const diagnostics = await checkDiagnostics(token, agent.sessionId, agent.symbol);
      
      if (diagnostics.predictor?.available && diagnostics.strategy?.id) {
        console.log(`   ✅ PASS: ${agent.symbol} has immediate diagnostics!`);
      } else {
        console.log(`   ⚠️  PARTIAL: ${agent.symbol} diagnostics not fully populated yet`);
      }
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Tests complete!');
}

main().catch(console.error);
