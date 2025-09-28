import { AgentHub } from './src/agent/hub.js';
import { prisma } from './src/db/client.js';

async function diagnoseAgents() {
  console.log('🔍 Diagnostic détaillé des agents...\n');

  // 1. État des agents en mémoire
  console.log('📊 Agents en mémoire:');
  const snapshot = AgentHub.snapshot();
  console.log(snapshot);

  // 2. Sessions actives dans la DB
  console.log('\n🗄️ Sessions actives dans la DB:');
  const sessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null },
    select: {
      id: true,
      symbol: true,
      mode: true,
      startedAt: true,
      currentSymbol: true
    }
  });
  console.log(sessions);

  // 3. Agents dans la DB
  console.log('\n🤖 Agents dans la DB:');
  const agents = await prisma.agent.findMany({
    select: {
      id: true,
      symbol: true,
      status: true,
      mode: true,
      createdAt: true,
      updatedAt: true,
      lastTradeAt: true
    }
  });
  console.log(agents);

  // 4. Plans actifs
  console.log('\n📋 Plans actifs:');
  const plans = await prisma.plan.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      sessionId: true,
      symbol: true,
      bias: true,
      zone: true,
      createdAt: true
    }
  });
  console.log(plans);

  // 5. Positions ouvertes
  console.log('\n💰 Positions ouvertes:');
  const positions = await prisma.position.findMany({
    where: { closedAt: null },
    select: {
      id: true,
      sessionId: true,
      symbol: true,
      side: true,
      qty: true,
      entryPrice: true,
      openedAt: true
    }
  });
  console.log(positions);

  console.log('\n✅ Diagnostic terminé');
}

diagnoseAgents().catch(console.error);