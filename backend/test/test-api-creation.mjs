import { PrismaClient } from '@prisma/client';
import { initializeIntelligentAgent, getActiveAgentSymbols } from '../dist/services/intelligentAgent.js';

const prisma = new PrismaClient();

async function testCreateAgent() {
  console.log('🧪 Testing creating AUTO agent via frontend API...\n');

  try {
    // 1. Check current active symbols
    console.log('1️⃣ Current active agent symbols:');
    const activeSymbols = await getActiveAgentSymbols();
    console.log('Active symbols:', activeSymbols);
    console.log('DOGE active?', activeSymbols.includes('DOGE/USDT') ? '✅ OUI' : '❌ NON');
    console.log('');

    // 2. Test creating via API instead of direct DB
    console.log('2️⃣ Creating via frontend API endpoint...');
    const response = await fetch('http://localhost:3000/api/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'auto'
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    console.log('✅ Agent created via API:', result.sessionId);
    console.log('Selected symbol:', result.symbol || 'UNKNOWN');

    if (result.symbol === 'DOGE/USDT') {
      console.log('❌ CONFLICT: Still selected DOGE despite active sessions!');
    } else {
      console.log('✅ SUCCESS: Conflict avoidance working!');
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

testCreateAgent();