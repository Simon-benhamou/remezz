/**
 * Analyze TradeEvaluation records to understand decision meanings
 */
import { prisma } from '../src/db/client.js';

async function analyzeEvaluations() {
  console.log('📊 Analyzing TradeEvaluation Records...\n');

  // Get total counts
  const total = await prisma.tradeEvaluation.count();
  const executed = await prisma.tradeEvaluation.count({ where: { decision: 'executed' } });
  const blocked = await prisma.tradeEvaluation.count({ where: { decision: 'blocked' } });

  console.log(`Total Evaluations: ${total}`);
  console.log(`├─ Executed: ${executed} (${((executed/total)*100).toFixed(1)}%)`);
  console.log(`└─ Blocked: ${blocked} (${((blocked/total)*100).toFixed(1)}%)\n`);

  // Check blocked reasons
  const withBlockedReason = await prisma.tradeEvaluation.count({
    where: { 
      decision: 'blocked',
      blockedReason: { not: null }
    }
  });

  const withoutBlockedReason = await prisma.tradeEvaluation.count({
    where: { 
      decision: 'blocked',
      blockedReason: null
    }
  });

  console.log(`Blocked Reason Analysis:`);
  console.log(`├─ With reason: ${withBlockedReason}`);
  console.log(`└─ Without reason (NULL): ${withoutBlockedReason}\n`);

  // Sample some recent evaluations
  console.log(`\n📋 Recent Evaluations Sample:\n`);
  
  const recent = await prisma.tradeEvaluation.findMany({
    take: 10,
    orderBy: { timestamp: 'desc' },
    select: {
      id: true,
      symbol: true,
      decision: true,
      blockedReason: true,
      confidenceScore: true,
      timestamp: true,
      inputMetrics: true,
    }
  });

  recent.forEach((record, idx) => {
    console.log(`${idx + 1}. ${record.symbol} - ${record.decision.toUpperCase()}`);
    console.log(`   Time: ${record.timestamp.toISOString()}`);
    console.log(`   Confidence: ${record.confidenceScore.toFixed(4)}`);
    console.log(`   Blocked Reason: ${record.blockedReason || 'NULL'}`);
    
    // Check inputMetrics completeness
    const metrics = record.inputMetrics as any;
    if (metrics && typeof metrics === 'object') {
      const fields = Object.keys(metrics);
      const complete = fields.filter(f => metrics[f] != null).length;
      console.log(`   Input Metrics: ${complete}/${fields.length} fields populated`);
    }
    console.log('');
  });

  // Check what "executed" actually means
  console.log(`\n🔍 Understanding "executed" decision:\n`);
  console.log(`"executed" = Signal/Opportunity was EVALUATED and PASSED all entry filters`);
  console.log(`           ≠ Actual trade was placed on exchange`);
  console.log(`\nThe decision logs the ENTRY EVALUATION result, not the final trade execution.`);
  console.log(`An "executed" evaluation means:`);
  console.log(`  ✅ Confidence score met threshold`);
  console.log(`  ✅ ADX met threshold`);
  console.log(`  ✅ Trend strength met threshold`);
  console.log(`  ✅ Risk/reward ratio acceptable`);
  console.log(`  ✅ Volatility within acceptable range`);
  console.log(`\nBut the actual trade might still be blocked by:`);
  console.log(`  ❌ Insufficient balance`);
  console.log(`  ❌ Position limit reached`);
  console.log(`  ❌ Daily loss limit hit`);
  console.log(`  ❌ Agent in cooldown`);
  console.log(`  ❌ Exchange rate limits`);
  console.log(`  ❌ Symbol not available on exchange`);

  // Check for evaluations with NULL blocked reasons when decision is blocked
  if (withoutBlockedReason > 0) {
    console.log(`\n⚠️  Found ${withoutBlockedReason} "blocked" evaluations with NULL reason`);
    console.log(`This is a BUG - blocked evaluations should always have a reason!\n`);
    
    const buggyBlocked = await prisma.tradeEvaluation.findMany({
      where: {
        decision: 'blocked',
        blockedReason: null,
      },
      take: 5,
      orderBy: { timestamp: 'desc' },
      select: {
        symbol: true,
        timestamp: true,
        confidenceScore: true,
      }
    });

    console.log(`Sample buggy records:`);
    buggyBlocked.forEach(b => {
      console.log(`  - ${b.symbol} at ${b.timestamp.toISOString()} (confidence: ${b.confidenceScore.toFixed(4)})`);
    });
  }

  console.log(`\n✅ Analysis complete!`);
}

analyzeEvaluations()
  .catch((err) => {
    console.error('❌ Analysis failed:', err);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
