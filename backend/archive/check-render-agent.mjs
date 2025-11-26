#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Checking RENDER agent (cmhwgl06s00048g2jl04dmsor)...\n');
  
  const session = await prisma.agentSession.findUnique({
    where: { id: 'cmhwgl06s00048g2jl04dmsor' }
  });
  
  if (!session) {
    console.log('❌ Session NOT FOUND in database!\n');
    
    // Check recent sessions
    console.log('📋 Recent sessions created in last 2 hours:');
    const recent = await prisma.agentSession.findMany({
      where: {
        startedAt: {
          gte: new Date(Date.now() - 2 * 60 * 60 * 1000)
        }
      },
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        symbol: true,
        startedAt: true,
        isSmartAgent: true
      }
    });
    
    console.table(recent);
  } else {
    console.log('✅ Session FOUND in database!');
    console.log(`   Symbol: ${session.symbol}`);
    console.log(`   Started: ${session.startedAt}`);
    console.log(`   Is Smart Agent: ${session.isSmartAgent}`);
    console.log(`   Current Symbol: ${session.currentSymbol || 'N/A'}`);
    console.log(`   User ID: ${session.userId || 'N/A'}`);
    
    if (session.profileJson) {
      const profile = typeof session.profileJson === 'string' 
        ? JSON.parse(session.profileJson) 
        : session.profileJson;
      console.log(`\n📝 Profile Symbol: ${profile.symbol || 'N/A'}`);
    }
  }
  
  await prisma.$disconnect();
}

main().catch(console.error);
