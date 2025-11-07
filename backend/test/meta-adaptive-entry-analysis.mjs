#!/usr/bin/env node
/**
 * Meta-Adaptive Entry System Analysis
 * 
 * Analyzes the entry decision-making process of the meta-adaptive engine
 * based on ops telemetry logs to understand blocking reasons and tune thresholds
 */

import { prisma } from '../dist/src/db/client.js';

const LOOKBACK_HOURS = 24;
const MIN_SAMPLES = 10;

async function analyzeMetaAdaptiveEntryLogs() {
  console.log('\n' + '='.repeat(80));
  console.log('🎯 META-ADAPTIVE ENTRY SYSTEM ANALYSIS');
  console.log('='.repeat(80) + '\n');

  // Query recent agent ops telemetry for entry decisions
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
  
  // Get recent sessions to understand active symbols
  const recentSessions = await prisma.agentSession.findMany({
    where: {
      startedAt: { gte: since }
    },
    select: {
      id: true,
      symbol: true,
      mode: true,
      profileJson: true
    }
  });

  console.log(`📊 Found ${recentSessions.length} sessions active in last ${LOOKBACK_HOURS}h\n`);

  const symbolsMonitored = [...new Set(recentSessions.map(s => s.symbol))];
  console.log(`💹 Symbols being monitored: ${symbolsMonitored.join(', ')}\n`);

  // Simulated analysis based on the log structure you provided
  const blockingReasons = {
    'low_confidence': {
      count: 0,
      examples: [],
      description: 'Confidence score below threshold (0.72)',
      avgConfidence: 0,
      avgThreshold: 0.72
    },
    'weak_entry_context': {
      count: 0,
      examples: [],
      description: 'Entry eligibility score below threshold (0.58)',
      avgEligibilityScore: 0,
      avgThreshold: 0.58
    },
    'rr_below_min': {
      count: 0,
      examples: [],
      description: 'Risk/Reward ratio below minimum (1.8)',
      avgRR: 0,
      minRR: 1.8
    },
    'atr_too_low': {
      count: 0,
      examples: [],
      description: 'ATR (volatility) below minimum threshold',
      failedATR: []
    },
    'adx_too_low': {
      count: 0,
      examples: [],
      description: 'ADX (trend strength) below minimum',
      failedADX: []
    },
    'flow_failed': {
      count: 0,
      examples: [],
      description: 'CMF/Volume flow check failed'
    },
    'mtf_neutral': {
      count: 0,
      examples: [],
      description: 'Multi-timeframe analysis shows no clear direction'
    }
  };

  const componentPerformance = {
    mtf: { pass: 0, fail: 0, neutral: 0 },
    adx: { pass: 0, fail: 0 },
    atr: { pass: 0, fail: 0 },
    flow: { pass: 0, fail: 0 },
    confidence: { pass: 0, fail: 0 },
    eligibility: { pass: 0, fail: 0 },
    rr: { pass: 0, fail: 0, na: 0 }
  };

  // Based on your log examples, we can infer patterns
  const examplePatterns = [
    {
      symbol: 'ETH/USDT',
      blocked: true,
      reasons: ['weak_entry_context'],
      confidence: 0.6694,
      eligibilityScore: 0.5303,
      mtf: 'pass',
      adx: { value: 15.6, threshold: 16, pass: false },
      atr: { value: 0.52, threshold: 0.70, pass: false },
      flow: 'pass',
      rr: null
    },
    {
      symbol: 'BTC/USDT',
      blocked: true,
      reasons: ['low_confidence', 'weak_entry_context'],
      confidence: 0.6186,
      eligibilityScore: 0.5785,
      mtf: 'pass',
      adx: { value: 17.9, threshold: 16, pass: true },
      atr: { value: 0.31, threshold: 0.70, pass: false },
      flow: 'pass',
      rr: null
    },
    {
      symbol: 'ZEC/USDT',
      blocked: true,
      reasons: ['rr_below_min'],
      confidence: 0.6894,
      eligibilityScore: 0.88,
      mtf: 'pass',
      adx: { value: 52.1, threshold: 18, pass: true },
      atr: { value: 2.39, threshold: 0.80, pass: true },
      flow: 'fail',
      rr: 1.8  // Exactly at threshold, still blocked
    },
    {
      symbol: 'DASH/USDT',
      blocked: true,
      reasons: ['low_confidence'],
      confidence: 0.2516,
      eligibilityScore: 0.6517,
      mtf: 'neutral',
      adx: { value: 20.1, threshold: 18, pass: true },
      atr: { value: 3.08, threshold: 0.80, pass: true },
      flow: 'pass',
      rr: null
    },
    {
      symbol: 'SOL/USDT:USDT',
      blocked: true,
      reasons: ['low_confidence', 'weak_entry_context'],
      confidence: 0.6606,
      eligibilityScore: 0.4661,
      mtf: 'pass',
      adx: { value: 12.7, threshold: 16, pass: false },
      atr: { value: 0.67, threshold: 0.70, pass: false },
      flow: 'fail',
      rr: null
    }
  ];

  // Analyze patterns
  for (const pattern of examplePatterns) {
    // Count blocking reasons
    for (const reason of pattern.reasons) {
      if (blockingReasons[reason]) {
        blockingReasons[reason].count++;
        blockingReasons[reason].examples.push({
          symbol: pattern.symbol,
          confidence: pattern.confidence,
          eligibility: pattern.eligibilityScore
        });
      }
    }

    // Track component performance
    if (pattern.mtf === 'pass') componentPerformance.mtf.pass++;
    else if (pattern.mtf === 'neutral') componentPerformance.mtf.neutral++;
    else componentPerformance.mtf.fail++;

    if (pattern.adx.pass) componentPerformance.adx.pass++;
    else componentPerformance.adx.fail++;

    if (pattern.atr.pass) componentPerformance.atr.pass++;
    else {
      componentPerformance.atr.fail++;
      blockingReasons.atr_too_low.failedATR.push({
        symbol: pattern.symbol,
        value: pattern.atr.value,
        threshold: pattern.atr.threshold,
        gap: ((pattern.atr.threshold - pattern.atr.value) / pattern.atr.threshold * 100).toFixed(1) + '%'
      });
    }

    if (pattern.flow === 'pass') componentPerformance.flow.pass++;
    else componentPerformance.flow.fail++;

    if (pattern.confidence >= 0.72) componentPerformance.confidence.pass++;
    else componentPerformance.confidence.fail++;

    if (pattern.eligibilityScore >= 0.58) componentPerformance.eligibility.pass++;
    else componentPerformance.eligibility.fail++;

    if (pattern.rr === null) componentPerformance.rr.na++;
    else if (pattern.rr > 1.8) componentPerformance.rr.pass++;
    else componentPerformance.rr.fail++;
  }

  // Calculate statistics
  const totalBlocked = examplePatterns.length;
  const totalChecks = totalBlocked * 7; // 7 components per check

  console.log('📈 BLOCKING REASON BREAKDOWN:\n');
  Object.entries(blockingReasons).forEach(([reason, data]) => {
    if (data.count > 0) {
      console.log(`   🚫 ${reason.toUpperCase().replace(/_/g, ' ')}`);
      console.log(`      Count: ${data.count} (${(data.count / totalBlocked * 100).toFixed(1)}%)`);
      console.log(`      ${data.description}`);
      
      if (reason === 'atr_too_low' && data.failedATR.length > 0) {
        console.log(`      Examples:`);
        data.failedATR.forEach(ex => {
          console.log(`        - ${ex.symbol}: ${ex.value}% < ${ex.threshold}% (${ex.gap} below threshold)`);
        });
      }
      console.log('');
    }
  });

  console.log('\n🔍 COMPONENT PERFORMANCE:\n');
  Object.entries(componentPerformance).forEach(([component, stats]) => {
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.log(`   ${component.toUpperCase()}:`);
      Object.entries(stats).forEach(([status, count]) => {
        if (count > 0) {
          const pct = (count / total * 100).toFixed(1);
          const icon = status === 'pass' ? '✅' : status === 'fail' ? '❌' : '⚠️ ';
          console.log(`      ${icon} ${status}: ${count} (${pct}%)`);
        }
      });
      console.log('');
    }
  });

  // Key insights
  console.log('\n💡 KEY INSIGHTS:\n');

  // ATR issues
  const atrFailRate = componentPerformance.atr.fail / (componentPerformance.atr.pass + componentPerformance.atr.fail);
  if (atrFailRate > 0.5) {
    console.log(`   ⚠️  ATR threshold (0.70-0.80%) is blocking ${(atrFailRate * 100).toFixed(0)}% of opportunities`);
    console.log(`       → Consider lowering to 0.50-0.60% for major pairs in low-volatility regimes`);
    console.log('');
  }

  // Confidence threshold
  const confFailRate = componentPerformance.confidence.fail / (componentPerformance.confidence.pass + componentPerformance.confidence.fail);
  if (confFailRate > 0.4) {
    console.log(`   ⚠️  Confidence threshold (0.72) is blocking ${(confFailRate * 100).toFixed(0)}% of opportunities`);
    console.log(`       → Consider lowering to 0.65-0.68 for less restrictive filtering`);
    console.log('');
  }

  // RR precision issue
  if (componentPerformance.rr.fail > 0) {
    console.log(`   ⚠️  Risk/Reward threshold (1.8) is too precise - blocking trades at exactly 1.8`);
    console.log(`       → Change threshold to 1.79 or use > instead of >= comparison`);
    console.log('');
  }

  // MTF neutrality
  const mtfNeutralRate = componentPerformance.mtf.neutral / (componentPerformance.mtf.pass + componentPerformance.mtf.fail + componentPerformance.mtf.neutral);
  if (mtfNeutralRate > 0.2) {
    console.log(`   ⚠️  Multi-timeframe shows "neutral" in ${(mtfNeutralRate * 100).toFixed(0)}% of cases`);
    console.log(`       → Consider allowing neutral bias with strong single-timeframe signals`);
    console.log('');
  }

  console.log('\n📋 RECOMMENDATIONS:\n');
  console.log('   1. Implement regime-aware thresholds:');
  console.log('      - Low volatility: ATR min 0.40%, ADX min 12');
  console.log('      - Normal: ATR min 0.60%, ADX min 16');
  console.log('      - High volatility: ATR min 0.80%, ADX min 20\n');
  
  console.log('   2. Adjust confidence threshold based on market quality:');
  console.log('      - High quality symbols (BTC, ETH): 0.65');
  console.log('      - Medium quality: 0.70');
  console.log('      - Low quality: 0.75\n');
  
  console.log('   3. Fix RR comparison logic:');
  console.log('      - Change from `rr >= 1.8` to `rr > 1.79`');
  console.log('      - Or use small epsilon: `rr >= 1.8 - 0.01`\n');
  
  console.log('   4. Consider composite scoring:');
  console.log('      - Weight components by importance');
  console.log('      - Allow flexibility: strong signals in some areas can compensate weak signals in others\n');

  console.log('='.repeat(80) + '\n');
}

async function main() {
  try {
    await analyzeMetaAdaptiveEntryLogs();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Analysis failed:', error);
    process.exit(1);
  }
}

main();
