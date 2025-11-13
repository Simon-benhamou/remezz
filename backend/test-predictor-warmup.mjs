#!/usr/bin/env node
/**
 * Test Predictor Warmup on Agent Creation
 * 
 * This script:
 * 1. Creates a new smart agent
 * 2. Polls the diagnostics API every 500ms
 * 3. Tracks when predictor data becomes available
 * 4. Reports timing and success
 */

const BASE_URL = 'http://localhost:4000';
const POLL_INTERVAL = 500; // ms
const MAX_WAIT_TIME = 30000; // 30 seconds

// Auth credentials
const AUTH_USERNAME = 'simon';
const AUTH_PASSWORD = '143mgsd5';

// Preferred symbols to bypass universe saturation/conflicts
// Can be overridden via env WARMUP_SYMBOL or CLI arg --symbol=FOO/USDT
const ARG_SYMBOL = process.argv.find(a => a.startsWith('--symbol='))?.split('=')[1];
const ENV_SYMBOL = process.env.WARMUP_SYMBOL;
const PREFERRED_SYMBOLS = [
  ARG_SYMBOL || ENV_SYMBOL || 'AGIX/USDT',
  'AIA/USDT',
  'MASK/USDT',
  'INJ/USDT',
  'CFX/USDT',
];

async function getAuthToken() {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: AUTH_USERNAME,
      password: AUTH_PASSWORD,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Login failed: ${response.status} ${error}`);
  }

  const data = await response.json();
  return data.token;
}

async function createSmartAgent(token) {
  console.log('🚀 Creating new smart agent...');

  let lastErr;
  for (const sym of PREFERRED_SYMBOLS) {
    try {
      const response = await fetch(`${BASE_URL}/api/agent/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          mode: 'paper',
          isSmartAgent: true,
          symbol: sym,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        // Try next symbol on 409/universe conflict or selection failures
        if (response.status === 409 || /no_unused_symbol_available|universe_conflict|orderable/i.test(errorText)) {
          console.warn(`⚠️  Symbol ${sym} not accepted (${response.status}). Trying next...`);
          lastErr = new Error(`Failed for ${sym}: ${response.status} ${errorText}`);
          continue;
        }
        throw new Error(`Failed to create agent: ${response.status} ${errorText}`);
      }

      const data = await response.json();

      // Debug response structure
      console.log('Response data:', JSON.stringify(data, null, 2));

      const sessionId = data.session?.id || data.id || data.sessionId;
      const symbol = data.session?.symbol || data.symbol || sym;

      if (!sessionId) {
        throw new Error(`No session ID in response: ${JSON.stringify(data)}`);
      }

      console.log(`✅ Agent created: ${sessionId}`);
      console.log(`   Symbol: ${symbol || 'unknown'}`);
      console.log(`   State: ${data.activation?.state || 'unknown'}`);

      return {
        sessionId,
        symbol,
        createdAt: Date.now(),
      };
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️  Creation attempt with ${sym} failed: ${err.message}`);
    }
  }
  throw lastErr || new Error('Failed to create agent with preferred symbols');
}

async function checkDiagnostics(sessionId, token) {
  const response = await fetch(`${BASE_URL}/api/agent/${sessionId}/diagnostics`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });
  
  if (!response.ok) {
    throw new Error(`Diagnostics request failed: ${response.status}`);
  }

  const data = await response.json();
  return data;
}

async function pollUntilPredictorReady(sessionId, createdAt, token) {
  console.log('\n⏳ Polling diagnostics API for predictor data...\n');
  
  let attempts = 0;
  const maxAttempts = Math.floor(MAX_WAIT_TIME / POLL_INTERVAL);
  
  while (attempts < maxAttempts) {
    attempts++;
    const elapsed = Date.now() - createdAt;
    
    try {
      const diagnostics = await checkDiagnostics(sessionId, token);
      
      const hasPredictor = diagnostics.predictor && diagnostics.predictor.bias !== null;
      const predictionSource = diagnostics.predictor?.source || 'none';
      
      // Log progress
      const statusEmoji = hasPredictor ? '✅' : '⏳';
      const biasValue = diagnostics.predictor?.bias || 'null';
      const confidence = diagnostics.predictor?.confidence || 0;
      
      console.log(`${statusEmoji} Attempt ${attempts} (${elapsed}ms): bias=${biasValue}, confidence=${confidence.toFixed(2)}, source=${predictionSource}`);
      
      if (hasPredictor) {
        console.log('\n🎉 SUCCESS! Predictor data is available!');
        console.log(`\n📊 Final Diagnostics:`);
        console.log(`   Predictor Bias: ${diagnostics.predictor.bias}`);
        console.log(`   Confidence: ${diagnostics.predictor.confidence.toFixed(4)}`);
        console.log(`   Prediction Source: ${predictionSource}`);
        console.log(`   Direction: ${diagnostics.predictor.direction || 'N/A'}`);
        console.log(`   Long Probability: ${diagnostics.predictor.probLong?.toFixed(4) || 'N/A'}`);
        console.log(`   Short Probability: ${diagnostics.predictor.probShort?.toFixed(4) || 'N/A'}`);
        console.log(`\n⏱️  Time to predictor data: ${elapsed}ms (${(elapsed/1000).toFixed(2)}s)`);
        
        // Check symbolProfile too
        if (diagnostics.symbolProfile) {
          const profile = diagnostics.symbolProfile;
          console.log(`\n📈 Symbol Profile:`);
          console.log(`   Win Rate: ${profile.winRate?.toFixed(2) || 0}%`);
          console.log(`   Avg R Multiple: ${profile.avgRMultiple?.toFixed(2) || 0}`);
          console.log(`   Total Trades: ${profile.totalTrades || 0}`);
        }
        
        return { success: true, elapsed, attempts, source: predictionSource };
      }
      
    } catch (error) {
      console.error(`❌ Attempt ${attempts} failed:`, error.message);
    }
    
    // Wait before next attempt
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
  
  console.log(`\n❌ TIMEOUT: Predictor data not available after ${MAX_WAIT_TIME}ms`);
  return { success: false, elapsed: MAX_WAIT_TIME, attempts };
}

async function main() {
  console.log('🧪 Testing Predictor Warmup on Agent Creation\n');
  console.log('='.repeat(60));
  
  try {
    // Login first
    console.log('🔐 Logging in...');
    const token = await getAuthToken();
    console.log('✅ Authenticated\n');
    
    // Create agent
    const agent = await createSmartAgent(token);
    
    // Poll diagnostics
    const result = await pollUntilPredictorReady(agent.sessionId, agent.createdAt, token);
    
    console.log('\n' + '='.repeat(60));
    if (result.success) {
      console.log(`\n✅ TEST PASSED`);
      console.log(`   Predictor warmup completed in ${(result.elapsed/1000).toFixed(2)}s`);
      console.log(`   Source: ${result.source}`);
      console.log(`   Total API calls: ${result.attempts}`);
    } else {
      console.log(`\n❌ TEST FAILED`);
      console.log(`   Predictor data never became available`);
      console.log(`   Max wait time exceeded (${MAX_WAIT_TIME}ms)`);
      process.exit(1);
    }
    
  } catch (error) {
    console.error('\n❌ TEST ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
