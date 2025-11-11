#!/usr/bin/env node

/**
 * Test script for close-position endpoint
 */

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function test() {
  try {
    console.log('\n🧪 Testing Close Position Feature\n');
    console.log('='.repeat(60));

    // Find an active session with a position
    const activeSession = await prisma.agentSession.findFirst({
      where: {
        stoppedAt: null,
        positions: {
          some: {},
        },
      },
      include: {
        positions: true,
      },
    });

    if (!activeSession) {
      console.log('❌ No active session with position found');
      console.log('   Start an agent with a position to test this feature');
      return;
    }

    console.log(`\n✅ Found active session: ${activeSession.id}`);
    console.log(`   Symbol: ${activeSession.symbol}`);
    console.log(`   Positions: ${activeSession.positions.length}`);

    for (const pos of activeSession.positions) {
      console.log(`\n   Position:`);
      console.log(`     Side: ${pos.side}`);
      console.log(`     Qty: ${pos.qty}`);
      console.log(`     Entry: $${pos.entryPrice}`);
      console.log(`     Stop: $${pos.stopPrice || 'N/A'}`);
      console.log(`     Opened: ${pos.openedAt}`);
    }

    console.log(`\n\n🎯 Test Endpoint:`);
    console.log(`   POST http://localhost:3002/api/agent/close-position`);
    console.log(`   Body: { "sessionId": "${activeSession.id}" }`);
    
    console.log(`\n   Example curl:`);
    console.log(`   curl -X POST http://localhost:3002/api/agent/close-position \\`);
    console.log(`        -H "Content-Type: application/json" \\`);
    console.log(`        -d '{"sessionId":"${activeSession.id}"}'`);

    console.log(`\n\n💡 To test in browser:`);
    console.log(`   1. Go to Session Cockpit for session ${activeSession.id}`);
    console.log(`   2. Look for "Position Info" card with close button`);
    console.log(`   3. Click "Close Position" button`);
    console.log(`   4. Position should close at market price`);

    console.log('\n' + '='.repeat(60));
    console.log('✅ Test info generated\n');

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

test();
