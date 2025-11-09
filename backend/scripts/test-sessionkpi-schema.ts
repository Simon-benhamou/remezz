#!/usr/bin/env tsx
/**
 * Test script to verify SessionKpi schema changes work correctly
 * Run this once the database is accessible
 */

import { prisma } from '../src/db/client.js';

async function testSessionKpiSchema() {
  console.log('Testing SessionKpi schema...\n');

  try {
    // Test 1: Query with include
    console.log('Test 1: Querying with include: { SessionKpi: true }');
    const sessionsWithKpi = await prisma.agentSession.findMany({
      take: 1,
      include: { SessionKpi: true },
    });
    console.log(`✅ Found ${sessionsWithKpi.length} session(s)`);
    if (sessionsWithKpi.length > 0) {
      const session = sessionsWithKpi[0];
      console.log(`   Session ID: ${session.id}`);
      console.log(`   Has SessionKpi: ${session.SessionKpi ? 'Yes' : 'No'}`);
      if (session.SessionKpi) {
        console.log(`   ROI: ${session.SessionKpi.roiPct}%`);
        console.log(`   Win Rate: ${session.SessionKpi.winRate}%`);
      }
    }
    console.log();

    // Test 2: Query with select
    console.log('Test 2: Querying with select: { SessionKpi: {...} }');
    const sessionsWithSelectKpi = await prisma.agentSession.findMany({
      take: 1,
      select: {
        id: true,
        symbol: true,
        SessionKpi: {
          select: {
            realizedPnlUsd: true,
            unrealizedPnlUsd: true,
            roiPct: true,
            winRate: true,
          },
        },
      },
    });
    console.log(`✅ Found ${sessionsWithSelectKpi.length} session(s)`);
    if (sessionsWithSelectKpi.length > 0) {
      const session = sessionsWithSelectKpi[0];
      console.log(`   Session: ${session.symbol} (${session.id})`);
      console.log(`   SessionKpi data:`, session.SessionKpi);
    }
    console.log();

    // Test 3: Property access
    console.log('Test 3: Testing property access');
    const testSession = await prisma.agentSession.findFirst({
      include: { SessionKpi: true },
    });
    if (testSession) {
      const kpiData = testSession.SessionKpi;
      console.log(`✅ Property access works: testSession.SessionKpi`);
      console.log(`   Type: ${typeof kpiData}`);
      console.log(`   Has data: ${kpiData ? 'Yes' : 'No'}`);
    }
    console.log();

    console.log('✅ All tests passed! Schema changes are working correctly.\n');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

testSessionKpiSchema().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
