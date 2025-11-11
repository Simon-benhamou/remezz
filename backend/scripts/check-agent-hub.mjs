#!/usr/bin/env node
/**
 * Quick diagnostic: Check which agents are in the AgentHub
 */

import { AgentHub } from '../dist/src/agent/hub.js';
import { prisma } from '../dist/src/db/client.js';

console.log('🔍 DIAGNOSTIC: Agent Hub Status\n');

try {
  // Get all active sessions from DB
  const activeSessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null },
    select: {
      id: true,
      symbol: true,
      mode: true,
      startedAt: true
    },
    orderBy: { startedAt: 'desc' }
  });
  
  console.log(`📊 Active sessions in DB: ${activeSessions.length}\n`);
  
  if (activeSessions.length === 0) {
    console.log('❌ No active sessions found in database');
    process.exit(0);
  }
  
  // Check each session in the hub
  console.log('🔎 Checking AgentHub:\n');
  
  // Debug: List all agents in hub
  const hubAgents = AgentHub.listActiveIds();
  console.log(`🔍 AgentHub contains ${hubAgents.length} agent(s): ${hubAgents.join(', ') || 'NONE'}\n`);
  
  for (const session of activeSessions) {
    const agent = AgentHub.get(session.id);
    const inHub = agent !== undefined && agent !== null;
    const hasSnap = (agent && typeof agent === 'object') ? Boolean(agent.snap || agent.lastSnap) : false;
    
    const status = inHub 
      ? (hasSnap ? '✅ In Hub + Has Snapshot' : '⚠️  In Hub but NO Snapshot')
      : '❌ NOT in Hub';
    
    console.log(`${status}`);
    console.log(`   ID: ${session.id}`);
    console.log(`   Symbol: ${session.symbol}`);
    console.log(`   Mode: ${session.mode}`);
    console.log(`   Started: ${new Date(session.startedAt).toLocaleString()}`);
    
    if (agent && !hasSnap) {
      console.log(`   ⚠️  Agent exists but waiting for first market tick`);
    }
    
    console.log('');
  }
  
  console.log('\n💡 DIAGNOSTIC RESULTS:');
  const inHubCount = activeSessions.filter(s => {
    const a = AgentHub.get(s.id);
    return a !== undefined && a !== null;
  }).length;
  const withSnapCount = activeSessions.filter(s => {
    const a = AgentHub.get(s.id);
    return a && typeof a === 'object' && (a.snap || a.lastSnap);
  }).length;
  
  console.log(`   • Sessions in DB: ${activeSessions.length}`);
  console.log(`   • In AgentHub: ${inHubCount}`);
  console.log(`   • With Snapshot: ${withSnapCount}`);
  
  if (inHubCount < activeSessions.length) {
    console.log(`\n⚠️  ${activeSessions.length - inHubCount} session(s) in DB but NOT in Hub`);
    console.log('   → Possible causes:');
    console.log('     1. Backend restarted - agents lost from memory');
    console.log('     2. Agent failed to start');
    console.log('     3. Session was just created');
  }
  
  if (withSnapCount < inHubCount) {
    console.log(`\n⚠️  ${inHubCount - withSnapCount} agent(s) in Hub but no snapshot yet`);
    console.log('   → Waiting for first market data tick (usually takes 1-15 seconds)');
  }
  
  if (prisma.$disconnect) {
    await prisma.$disconnect();
  }
  
} catch (error) {
  console.error('❌ Error:', error);
  process.exit(1);
}
