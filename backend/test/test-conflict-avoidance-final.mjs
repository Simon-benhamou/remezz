import { PrismaClient } from '@prisma/client';
import { initializeIntelligentAgent, getActiveAgentSymbols } from '../dist/services/intelligentAgent.js';

const prisma = new PrismaClient();

async function testConflictAvoidanceFinal() {
  console.log('🧪 Testing final conflict avoidance fix...\n');

  try {
    // 1. Check current active symbols
    console.log('1️⃣ Current active agent symbols:');
    const activeSymbols = await getActiveAgentSymbols();
    console.log('Active symbols:', activeSymbols);
    console.log('DOGE active?', activeSymbols.includes('DOGE/USDT') ? '✅ OUI' : '❌ NON');
    console.log('');

    // 2. Create a new AUTO agent session
    console.log('2️⃣ Creating new AUTO agent session...');
    const session = await prisma.agentSession.create({
      data: {
        symbol: 'TEMP',
        mode: 'auto',
        isSmartAgent: true,
        balance: 1000,
        currentPrice: 0,
        profitLoss: 0
      }
    });

    console.log(`✅ Session created: ${session.id}`);
    console.log('');

    // 3. Initialize the intelligent agent (this should avoid DOGE)
    console.log('3️⃣ Initializing intelligent agent with conflict avoidance...');
    const success = await initializeIntelligentAgent(session.id);
    
    if (!success) {
      console.log('❌ Initialization failed');
      return;
    }

    // 4. Check the selected symbol
    const updatedSession = await prisma.agentSession.findUnique({
      where: { id: session.id }
    });

    if (updatedSession?.symbol) {
      console.log(`✅ Agent initialized successfully!`);
      console.log(`Selected symbol: ${updatedSession.symbol}`);
      
      if (updatedSession.symbol === 'DOGE/USDT') {
        console.log('❌ CONFLICT DETECTED: Still selected DOGE despite active sessions!');
      } else {
        console.log('✅ SUCCESS: Conflict avoidance working - selected different symbol!');
      }
    } else {
      console.log('💤 Agent in sleep mode (no opportunities found)');
    }

    console.log('');
    console.log('4️⃣ Final active symbols check:');
    const finalActiveSymbols = await getActiveAgentSymbols();
    console.log('Active symbols after creation:', finalActiveSymbols);

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

testConflictAvoidanceFinal();