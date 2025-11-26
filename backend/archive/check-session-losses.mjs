#!/usr/bin/env node

import pkg from '@prisma/client';
const { PrismaClient } = pkg;
const prisma = new PrismaClient();

async function checkRecentActivity() {
  // Check recent sessions
  const sessions = await prisma.agentSession.findMany({
    where: {
      symbol: { in: ['ETH/USDT', 'AVAX/USDT', 'DOGE/USDT', 'ETH/USDT:USDT', 'AVAX/USDT:USDT', 'DOGE/USDT:USDT'] }
    },
    orderBy: { startedAt: 'desc' },
    take: 10,
    include: {
      SessionKpi: true
    }
  });

  console.log('\n=== RECENT SESSIONS (ETH, AVAX, DOGE) ===');
  console.log(`Found ${sessions.length} sessions\n`);
  
  for (const s of sessions) {
    const kpi = s.SessionKpi;
    const realizedPnl = kpi?.realizedPnlUsd || 0;
    const unrealizedPnl = kpi?.unrealizedPnlUsd || 0;
    const totalPnl = realizedPnl + unrealizedPnl;
    const winRate = kpi?.winRate || 0;
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Symbol: ${s.symbol} (${s.mode})`);
    console.log(`Session ID: ${s.id.slice(0, 16)}...`);
    console.log(`Started: ${new Date(s.startedAt).toLocaleString()}`);
    if (s.stoppedAt) console.log(`Stopped: ${new Date(s.stoppedAt).toLocaleString()}`);
    console.log(`Realized PnL: $${realizedPnl.toFixed(2)}`);
    console.log(`Unrealized PnL: $${unrealizedPnl.toFixed(2)}`);
    console.log(`Total PnL: $${totalPnl.toFixed(2)} ${totalPnl < 0 ? '❌' : '✅'}`);
    console.log(`Win Rate: ${winRate.toFixed(1)}%`);
    
    // Check recent entry action intents for this session
    const entryIntents = await prisma.agentActionIntent.findMany({
      where: {
        sessionId: s.id,
        type: { in: ['ENTER', 'enter', 'OPEN_POSITION'] }
      },
      orderBy: { createdAt: 'desc' },
      take: 3
    });
    
    if (entryIntents.length > 0) {
      console.log(`\n📊 Recent Entry Intents (${entryIntents.length}):`);
      for (const intent of entryIntents) {
        const payload = intent.payload || {};
        const confidence = intent.confidence || 0;
        
        console.log(`  - ${new Date(intent.createdAt).toLocaleString()}`);
        console.log(`    Confidence: ${confidence.toFixed(3)}`);
        console.log(`    Status: ${intent.status}`);
        console.log(`    Reason: ${intent.reason.slice(0, 80)}...`);
        
        // Check if payload contains predictor info
        if (payload.predictor || payload.predictorImpact || payload.baseConfidence) {
          const baseConf = payload.baseConfidence || confidence;
          const boost = confidence - baseConf;
          console.log(`    Base Confidence: ${baseConf.toFixed(3)}`);
          console.log(`    Predictor Boost: ${boost > 0 ? '+' : ''}${boost.toFixed(3)}`);
          
          if (boost > 0.05 && baseConf < 0.6 && confidence >= 0.6) {
            console.log(`    🚨 PREDICTOR ENABLED THIS TRADE!`);
          }
          
          if (payload.predictor) {
            console.log(`    Predictor Signal: ${payload.predictor.signal || payload.predictor.decision}`);
            console.log(`    Predictor Prob: ${payload.predictor.probability || payload.predictor.confidence}`);
          }
        }
      }
    }
  }
  
  // Summary
  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📈 SUMMARY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  const losingSessions = sessions.filter(s => {
    const kpi = s.SessionKpi;
    const total = (kpi?.realizedPnlUsd || 0) + (kpi?.unrealizedPnlUsd || 0);
    return total < 0;
  });
  
  console.log(`Total sessions: ${sessions.length}`);
  console.log(`Losing sessions: ${losingSessions.length}`);
  
  let predictorCausedLoss = 0;
  
  for (const s of losingSessions) {
    const entryIntents = await prisma.agentActionIntent.findMany({
      where: { 
        sessionId: s.id, 
        type: { in: ['ENTER', 'enter', 'OPEN_POSITION'] }
      },
      orderBy: { createdAt: 'desc' },
      take: 5
    });
    
    for (const intent of entryIntents) {
      const payload = intent.payload || {};
      const confidence = intent.confidence || 0;
      const baseConf = payload.baseConfidence || confidence;
      
      if (baseConf < 0.6 && confidence >= 0.6) {
        predictorCausedLoss++;
      }
    }
  }
  
  if (predictorCausedLoss > 0) {
    console.log(`\n⚠️  WARNING: ${predictorCausedLoss} entry decision(s) in losing sessions were caused by predictor boost!`);
    console.log(`💡 Recommendation: Consider reducing predictor weight or disabling it temporarily`);
  } else {
    console.log(`\n✅ No evidence of predictor causing unprofitable entries`);
  }
  
  await prisma.$disconnect();
}

checkRecentActivity().catch(console.error);
