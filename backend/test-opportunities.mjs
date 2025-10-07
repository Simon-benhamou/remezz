import 'dotenv/config';
import { scanIntelligentOpportunities } from './src/services/intelligentAgent.ts';
import { getBinanceWebSocket } from './src/services/binanceWebSocket.ts';

async function testOpportunities() {
  console.log('Testing intelligent opportunity scan...');
  try {
    const opportunities = await scanIntelligentOpportunities();
    console.log('Found opportunities:', opportunities.length);
    if (opportunities.length > 0) {
      console.log('Top opportunities:');
      opportunities.slice(0, 3).forEach((opp, i) => {
        console.log(`${i+1}. ${opp.symbol} - Score: ${opp.score.toFixed(2)}, Confidence: ${opp.confidence}`);
      });
    } else {
      console.log('No opportunities found - this explains why agents go to sleep mode');
    }
  } catch (error) {
    console.error('Error testing opportunities:', error);
  } finally {
    // Clean up WebSocket connections
    console.log('🧹 Cleaning up WebSocket connections...');
    const ws = getBinanceWebSocket();
    ws.close();
    console.log('✅ WebSocket connections closed');
  }
}

testOpportunities();
