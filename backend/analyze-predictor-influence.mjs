#!/usr/bin/env node

import pkg from '@prisma/client';
const { PrismaClient } = pkg;
const prisma = new PrismaClient();

async function analyzePredictorInfluence() {
  console.log('Starting analysis...\n');
  
  // Get recent closed positions for ETH, AVAX, DOGE with losses
  const positions = await prisma.position.findMany({
    where: {
      symbol: { in: ['ETH/USDT', 'AVAX/USDT', 'DOGE/USDT', 'ETH/USDT:USDT', 'AVAX/USDT:USDT', 'DOGE/USDT:USDT'] },
      unrealizedPnl: { lt: 0 }
    },
    orderBy: { updatedAt: 'desc' },
    take: 15,
    include: {
      session: { 
        select: { 
          id: true, 
          symbol: true,
          startedAt: true 
        } 
      }
    }
  });

  console.log(`=== RECENT LOSING POSITIONS (ETH, AVAX, DOGE) ===`);
  console.log(`Found ${positions.length} positions with losses\n`);
  
  for (const pos of positions.slice(0, 5)) {
    if (!pos.session) continue;
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Position: ${pos.symbol} (${pos.side})`);
    console.log(`Session: ${pos.session.id.slice(0, 12)}...`);
    console.log(`Opened: ${new Date(pos.openedAt).toLocaleString()}`);
    console.log(`Entry: $${pos.entryPrice?.toFixed(4)} | Current: $${pos.markPrice?.toFixed(4)}`);
    console.log(`Unrealized PnL: $${pos.unrealizedPnl?.toFixed(2)}`);
    
    // Find entry decision within 2 minutes of position opening
    const entryDecision = await prisma.agentDecision.findFirst({
      where: {
        sessionId: pos.session.id,
        action: 'ENTER',
        createdAt: {
          gte: new Date(pos.openedAt.getTime() - 120000), // 2min before
          lte: new Date(pos.openedAt.getTime() + 120000)  // 2min after
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (entryDecision) {
      const meta = entryDecision.metadata || {};
      const finalConf = meta.finalConfidence || meta.confidence || 0;
      const baseConf = meta.baseConfidence || finalConf;
      const predictorImpact = meta.predictorImpact || meta.predictorBoost || 0;
      const predictorSignal = meta.predictorSignal || meta.predictor?.signal;
      const reason = meta.reason || meta.entryReason || 'N/A';
      
      console.log(`\n📊 Entry Decision Analysis:`);
      console.log(`   Time: ${new Date(entryDecision.createdAt).toLocaleString()}`);
      console.log(`   Base Confidence: ${baseConf.toFixed(3)}`);
      console.log(`   Final Confidence: ${finalConf.toFixed(3)}`);
      console.log(`   Predictor Impact: ${predictorImpact > 0 ? '+' : ''}${predictorImpact.toFixed(3)}`);
      console.log(`   Predictor Signal: ${predictorSignal || 'N/A'}`);
      console.log(`   Entry Reason: ${reason}`);
      
      // Analyze if predictor made the trade possible
      const boost = finalConf - baseConf;
      const threshold = 0.6; // typical entry threshold
      
      if (boost > 0.05) {
        console.log(`\n⚠️  PREDICTOR BOOSTED CONFIDENCE BY +${boost.toFixed(3)}`);
        
        if (baseConf < threshold && finalConf >= threshold) {
          console.log(`🚨 CRITICAL: Predictor pushed trade above threshold!`);
          console.log(`   Without predictor: ${baseConf.toFixed(3)} < ${threshold} (NO TRADE)`);
          console.log(`   With predictor: ${finalConf.toFixed(3)} >= ${threshold} (TRADE ENTERED)`);
          console.log(`   Result: Current LOSS of $${Math.abs(pos.unrealizedPnl || 0).toFixed(2)}`);
        } else if (baseConf >= threshold) {
          console.log(`   Trade would have entered anyway (base: ${baseConf.toFixed(3)})`);
        }
      } else if (boost < -0.05) {
        console.log(`\n✅ Predictor REDUCED confidence by ${boost.toFixed(3)}`);
      } else {
        console.log(`\n➖ Predictor had minimal impact (${boost.toFixed(3)})`);
      }
      
      // Check metadata for more details
      if (meta.predictor) {
        console.log(`\n🔍 Predictor Details:`);
        console.log(`   Probability: ${meta.predictor.probability || 'N/A'}`);
        console.log(`   Confidence: ${meta.predictor.confidence || 'N/A'}`);
      }
      
    } else {
      console.log(`\n❌ No entry decision found near position opening`);
    }
    console.log('');
  }
  
  // Summary statistics
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📈 SUMMARY: Predictor Impact on Losing Positions');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  let positionsAnalyzed = 0;
  let predictorCausedEntry = 0;
  let predictorBoosted = 0;
  let totalLoss = 0;
  
  for (const pos of positions.slice(0, 10)) {
    if (!pos.session) continue;
    
    const entryDecision = await prisma.agentDecision.findFirst({
      where: {
        sessionId: pos.session.id,
        action: 'ENTER',
        createdAt: {
          gte: new Date(pos.openedAt.getTime() - 120000),
          lte: new Date(pos.openedAt.getTime() + 120000)
        }
      }
    });
    
    if (entryDecision) {
      positionsAnalyzed++;
      totalLoss += Math.abs(pos.unrealizedPnl || 0);
      
      const meta = entryDecision.metadata || {};
      const finalConf = meta.finalConfidence || meta.confidence || 0;
      const baseConf = meta.baseConfidence || finalConf;
      const boost = finalConf - baseConf;
      const threshold = 0.6;
      
      if (boost > 0.05) {
        predictorBoosted++;
        if (baseConf < threshold && finalConf >= threshold) {
          predictorCausedEntry++;
        }
      }
    }
  }
  
  if (positionsAnalyzed > 0) {
    console.log(`Positions with decision data: ${positionsAnalyzed}`);
    console.log(`Positions where predictor boosted confidence: ${predictorBoosted} (${(predictorBoosted/positionsAnalyzed*100).toFixed(1)}%)`);
    console.log(`Positions caused by predictor boost: ${predictorCausedEntry} (${(predictorCausedEntry/positionsAnalyzed*100).toFixed(1)}%)`);
    console.log(`Total unrealized losses: $${totalLoss.toFixed(2)}`);
    
    if (predictorCausedEntry > 0) {
      console.log(`\n⚠️  WARNING: ${predictorCausedEntry} losing position(s) would NOT have entered without predictor boost!`);
      console.log(`💡 Consider: Reducing predictor weight or increasing entry threshold`);
    } else {
      console.log(`\n✅ Predictor did not cause entries that wouldn't have happened otherwise`);
    }
  } else {
    console.log('No positions with entry decision data found');
  }
}

analyzePredictorInfluence()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
