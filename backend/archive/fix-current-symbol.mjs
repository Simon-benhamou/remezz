#!/usr/bin/env node
/**
 * Fix currentSymbol NULL Bug
 * 
 * Root Cause: currentSymbol field added to schema but never populated
 * - startSession() never sets it
 * - Symbol updates only modify 'symbol' field
 * - Raw SQL in core.ts fails silently
 * 
 * This script:
 * 1. Diagnoses all sessions with NULL currentSymbol
 * 2. Repairs by copying symbol → currentSymbol
 * 3. Validates fix with test query
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 DIAGNOSING currentSymbol NULL BUG...\n');
  
  // 1. Find all sessions with NULL currentSymbol but non-null symbol
  const allSessions = await prisma.agentSession.findMany({
    where: {
      currentSymbol: null,
    },
    select: {
      id: true,
      symbol: true,
      currentSymbol: true,
      isSmartAgent: true,
      startedAt: true,
      stoppedAt: true,
    },
    orderBy: { startedAt: 'desc' },
  });
  
  // Filter to sessions that have symbol but not currentSymbol
  const brokenSessions = allSessions.filter(s => s.symbol !== null);
  
  console.log(`📊 Found ${brokenSessions.length} sessions with NULL currentSymbol:\n`);
  
  if (brokenSessions.length === 0) {
    console.log('✅ No broken sessions found! System is healthy.\n');
    return;
  }
  
  // Show broken sessions
  for (const s of brokenSessions) {
    const status = s.stoppedAt ? '❌ STOPPED' : '✅ ACTIVE';
    const type = s.isSmartAgent ? 'SMART' : 'MANUAL';
    const age = Math.round((Date.now() - s.startedAt.getTime()) / 1000 / 60 / 60);
    console.log(`  ${status} ${type} | ${s.id.slice(0, 8)} | symbol: ${s.symbol} | currentSymbol: ${s.currentSymbol} | age: ${age}h`);
  }
  
  console.log('\n🔧 FIXING currentSymbol for all sessions...\n');
  
  // 2. Fix by copying symbol → currentSymbol for ALL sessions (active and stopped)
  let fixed = 0;
  for (const s of brokenSessions) {
    try {
      await prisma.agentSession.update({
        where: { id: s.id },
        data: {
          currentSymbol: s.symbol, // Copy symbol to currentSymbol
        },
      });
      console.log(`  ✅ Fixed session ${s.id.slice(0, 8)}: currentSymbol = ${s.symbol}`);
      fixed++;
    } catch (error) {
      console.error(`  ❌ Failed to fix session ${s.id.slice(0, 8)}:`, error.message);
    }
  }
  
  console.log(`\n✅ Fixed ${fixed}/${brokenSessions.length} sessions\n`);
  
  // 3. Validate fix
  const stillBrokenAll = await prisma.agentSession.findMany({
    where: { currentSymbol: null },
    select: { id: true, symbol: true },
  });
  const stillBroken = stillBrokenAll.filter(s => s.symbol !== null).length;
  
  if (stillBroken === 0) {
    console.log('✅ VALIDATION: All sessions now have currentSymbol set!\n');
  } else {
    console.log(`⚠️ VALIDATION: ${stillBroken} sessions still broken\n`);
  }
  
  // 4. Show active sessions that were fixed
  const activeSessions = await prisma.agentSession.findMany({
    where: {
      stoppedAt: null,
      id: { in: brokenSessions.filter(s => !s.stoppedAt).map(s => s.id) },
    },
    select: {
      id: true,
      symbol: true,
      currentSymbol: true,
      isSmartAgent: true,
    },
  });
  
  if (activeSessions.length > 0) {
    console.log(`🎯 ${activeSessions.length} ACTIVE sessions now ready to trade:\n`);
    for (const s of activeSessions) {
      const type = s.isSmartAgent ? 'SMART' : 'MANUAL';
      console.log(`  ${type} | ${s.id.slice(0, 8)} | symbol: ${s.symbol} | currentSymbol: ${s.currentSymbol}`);
    }
  }
  
  console.log('\n🔍 NEXT STEPS:');
  console.log('  1. Monitor filter_passed signals → should now proceed to order_placed');
  console.log('  2. Watch for new orders in next 10 minutes');
  console.log('  3. Run: node diagnose-system.mjs to verify trading pipeline');
  console.log('  4. Fix code to prevent recurrence (see recommendations below)\n');
  
  console.log('📝 CODE FIXES REQUIRED:');
  console.log('  - src/session/session.ts: Add currentSymbol: symbol in startSession()');
  console.log('  - src/routes/agent.ts line 947: Update both symbol AND currentSymbol');
  console.log('  - src/ws/hub.ts line 236: Update both symbol AND currentSymbol');
  console.log('  - Remove failed raw SQL in core.ts (lines 3878-3884)');
  console.log('  - Use Prisma update() instead of $executeRaw\n');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
