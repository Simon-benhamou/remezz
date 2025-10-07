import 'dotenv/config';
import { validateBinanceApiKey } from './src/services/binanceWebSocket.ts';
import { prisma } from './src/db/client.js';
import { getUserCredentials } from './src/services/userCredentials.ts';

async function test() {
  console.log('🔑 Testing Binance API key validation...');
  try {
    const user = await prisma.user.findFirst({ where: { username: 'simon' } });
    if (!user) {
      console.log('❌ User simon not found');
      return;
    }
    const creds = await getUserCredentials(user.id, 'binance');
    if (!creds) {
      console.log('❌ No Binance API keys configured for user simon');
      return;
    }
    const result = await validateBinanceApiKey(creds.apiKey, creds.apiSecret);
    console.log('Result:', result);
  } finally {
    try { await prisma.$disconnect(); } catch {}
  }
}

test().catch(console.error);
