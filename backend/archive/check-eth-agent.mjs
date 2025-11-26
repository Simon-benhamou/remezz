import { prisma } from './dist/src/db/client.js';

async function checkETHAgents() {
  try {
    console.log('🔍 Recherche des agents ETH...\n');
    
    const agents = await prisma.agent.findMany({
      where: {
        symbol: {
          contains: 'ETH'
        }
      },
      orderBy: {
        updatedAt: 'desc'
      },
      take: 10
    });

    if (agents.length === 0) {
      console.log('❌ Aucun agent ETH trouvé');
      return;
    }

    console.log(`✅ ${agents.length} agent(s) ETH trouvé(s):\n`);

    for (const agent of agents) {
      console.log(`📊 Agent ${agent.symbol}`);
      console.log(`   ID: ${agent.id}`);
      console.log(`   Status: ${agent.status}`);
      console.log(`   Position: ${agent.position || 'NONE'}`);
      console.log(`   Current Bias: ${agent.currentBias || 'N/A'}`);
      console.log(`   Strategy: ${agent.strategyType}`);
      console.log(`   Updated: ${agent.updatedAt}`);
      
      // Chercher les orders SHORT pour cet agent
      const orders = await prisma.order.findMany({
        where: {
          agentId: agent.id,
          side: 'SELL'
        },
        orderBy: {
          createdAt: 'desc'
        },
        take: 3
      });

      if (orders.length > 0) {
        console.log(`   📉 Orders SHORT récents:`);
        for (const order of orders) {
          console.log(`      - ${order.status} at ${order.price} (${order.createdAt})`);
        }
      }
      
      console.log('');
    }

    // Chercher dans la table PredictorCache
    const cacheEntries = await prisma.predictorCache.findMany({
      where: {
        symbol: {
          contains: 'ETH'
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 5
    });

    if (cacheEntries.length > 0) {
      console.log('\n🧠 Cache Predictor pour ETH:');
      for (const cache of cacheEntries) {
        console.log(`   Symbol: ${cache.symbol}`);
        console.log(`   Decision: ${cache.decision}`);
        console.log(`   Confidence: ${(cache.confidence * 100).toFixed(2)}%`);
        console.log(`   Probabilities: L=${(cache.probLong * 100).toFixed(1)}% S=${(cache.probShort * 100).toFixed(1)}% N=${(cache.probNone * 100).toFixed(1)}%`);
        console.log(`   Created: ${cache.createdAt}`);
        console.log('');
      }
    }

  } catch (error) {
    console.error('❌ Erreur:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkETHAgents();
