#!/usr/bin/env node

import pkg from '@prisma/client';
const { PrismaClient } = pkg;
const prisma = new PrismaClient();

async function analyzeLosingTrades() {
  const losingSessions = await prisma.agentSession.findMany({
    where: {
      symbol: { in: ['ETH/USDT', 'AVAX/USDT', 'DOGE/USDT'] }
    },
    orderBy: { startedAt: 'desc' },
    take: 10,
    include: {
      SessionKpi: true
    }
  });

  const losing = losingSessions.filter(s => {
    const kpi = s.SessionKpi;
    const total = (kpi?.realizedPnlUsd || 0) + (kpi?.unrealizedPnlUsd || 0);
    return total < 0;
  });

  console.log('\n=== ANALYZING LOSING TRADES FOR ETH, AVAX, DOGE ===\n');

  for (const session of losing.slice(0, 3)) {
    const kpi = session.SessionKpi;
    const pnl = (kpi?.realizedPnlUsd || 0) + (kpi?.unrealizedPnlUsd || 0);
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`${session.symbol} - Loss: $${pnl.toFixed(2)}`);
    console.log(`Session: ${session.id.slice(0, 16)}...`);
    console.log(`Started: ${new Date(session.startedAt).toLocaleString()}`);
    
    // Find predictor decisions around session start
    const predictorDecisions = await prisma.predictorDecision.findMany({
      where: {
        symbol: session.symbol,
        createdAt: {
          gte: new Date(session.startedAt.getTime() - 300000), // 5min before
          lte: new Date(session.startedAt.getTime() + 300000)  // 5min after
        }
      },
      orderBy: { createdAt: 'asc' }
    });
    
    if (predictorDecisions.length > 0) {
      console.log(`\n🤖 Predictor Decisions (${predictorDecisions.length}):`);
      for (const pred of predictorDecisions) {
        const conf = pred.confidence || 0;
        const probLong = pred.probabilityLong || 0;
        const probShort = pred.probabilityShort || 0;
        
        console.log(`  ${new Date(pred.createdAt).toLocaleString()}`);
        console.log(`    Decision: ${pred.decision.toUpperCase()}`);
        console.log(`    Confidence: ${conf.toFixed(3)}`);
        console.log(`    Prob Long: ${probLong.toFixed(3)} | Prob Short: ${probShort.toFixed(3)}`);
        console.log(`    Entry Weight: ${pred.entryWeight?.toFixed(3) || 'N/A'}`);
        console.log(`    Price: $${pred.price.toFixed(4)}`);
      }
    } else {
      console.log(`\n❌ No predictor decisions found near session start`);
    }
    
    // Find entry orders
    const entryOrders = await prisma.order.findMany({
      where: {
        sessionId: session.id,
        clientOrderId: { contains: '.entry' }
      },
      orderBy: { createdAt: 'asc' },
      take: 3
    });
    
    if (entryOrders.length > 0) {
      console.log(`\n📈 Entry Orders (${entryOrders.length}):`);
      for (const order of entryOrders) {
        console.log(`  ${new Date(order.createdAt).toLocaleString()}`);
        console.log(`    Side: ${order.side} | Price: $${order.price?.toFixed(4)}`);
        console.log(`    Status: ${order.status}`);
      }
    }
    
    // Check action intents
    const intents = await prisma.agentActionIntent.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
      take: 5
    });
    
    if (intents.length > 0) {
      console.log(`\n💡 Action Intents (${intents.length}):`);
      for (const intent of intents) {
        const payload = intent.payload || {};
        console.log(`  ${new Date(intent.createdAt).toLocaleString()}`);
        console.log(`    Type: ${intent.type} | Status: ${intent.status}`);
        console.log(`    Confidence: ${intent.confidence.toFixed(3)}`);
        console.log(`    Reason: ${intent.reason.slice(0, 100)}${intent.reason.length > 100 ? '...' : ''}`);
        
        // Look for predictor influence in payload
        if (payload.predictor) {
          console.log(`    🤖 Predictor in payload:`);
          console.log(`       Signal: ${payload.predictor.signal || payload.predictor.decision}`);
          console.log(`       Confidence: ${payload.predictor.confidence?.toFixed(3) || 'N/A'}`);
          console.log(`       Probability: ${payload.predictor.probability?.toFixed(3) || 'N/A'}`);
        }
        
        if (payload.baseConfidence !== undefined) {
          const baseConf = payload.baseConfidence;
          const finalConf = intent.confidence;
          const boost = finalConf - baseConf;
          
          console.log(`    📊 Confidence Analysis:`);
          console.log(`       Base: ${baseConf.toFixed(3)} → Final: ${finalConf.toFixed(3)}`);
          console.log(`       Boost: ${boost > 0 ? '+' : ''}${boost.toFixed(3)}`);
          
          if (boost > 0.05 && baseConf < 0.6 && finalConf >= 0.6) {
            console.log(`       🚨 PREDICTOR MADE THIS TRADE POSSIBLE!`);
          }
        }
      }
    }
    
    console.log('');
  }
  
  // Final summary
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 FINAL ANALYSIS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  console.log(`Analyzed ${losing.length} losing sessions`);
  console.log(`Total losses: $${losing.reduce((sum, s) => sum + ((s.SessionKpi?.realizedPnlUsd || 0) + (s.SessionKpi?.unrealizedPnlUsd || 0)), 0).toFixed(2)}`);
  
  let predictorInfluencedCount = 0;
  for (const session of losing) {
    const intents = await prisma.agentActionIntent.findMany({
      where: { sessionId: session.id },
      take: 10
    });
    
    for (const intent of intents) {
      const payload = intent.payload || {};
      if (payload.baseConfidence !== undefined) {
        const baseConf = payload.baseConfidence;
        const finalConf = intent.confidence;
        if (baseConf < 0.6 && finalConf >= 0.6) {
          predictorInfluencedCount++;
        }
      }
    }
  }
  
  if (predictorInfluencedCount > 0) {
    console.log(`\n⚠️  ${predictorInfluencedCount} trade(s) were enabled by predictor boost above threshold`);
    console.log(`💡 Recommendation: Review predictor weight or disable temporarily`);
  } else {
    console.log(`\n✅ No clear evidence of predictor causing bad entries`);
    console.log(`💡 Losses may be due to market conditions, stop placement, or other factors`);
  }
  
  await prisma.$disconnect();
}

analyzeLosingTrades().catch(console.error);
