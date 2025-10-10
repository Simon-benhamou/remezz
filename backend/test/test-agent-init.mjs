import 'dotenv/config';
import { initializeIntelligentAgent } from '../src/services/intelligentAgent.ts';
import { getBinanceWebSocket } from '../src/services/binanceWebSocket.ts';

async function testAgentInitialization() {
  console.log('🧪 Testing agent initialization with auto-select...');

  try {
    // Test with a mock session ID (this won't actually create a session, just test the logic)
    const sessionId = 'test-session-' + Date.now();

    console.log(`🤖 Testing intelligent agent initialization for session ${sessionId}...`);

    // This will test the opportunity scanning logic
    const success = await initializeIntelligentAgent(sessionId, undefined, { testMode: true });

    if (success) {
      console.log('✅ Agent initialization would succeed - opportunities found!');
      console.log('🎯 Agents should now be able to select symbols instead of going to sleep mode');
    } else {
      console.log('❌ Agent initialization would fail - no opportunities found');
      console.log('💤 Agents would still go to sleep mode');
    }

  } catch (error) {
    console.error('❌ Error testing agent initialization:', error);
  } finally {
    // Clean up WebSocket connections
    console.log('🧹 Cleaning up WebSocket connections...');
    const ws = getBinanceWebSocket();
    ws.close();
    console.log('✅ WebSocket connections closed');
  }
}

testAgentInitialization();
