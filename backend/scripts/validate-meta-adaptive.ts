#!/usr/bin/env tsx
/**
 * Meta-Adaptive Validation Runner
 * 
 * Demonstrates comprehensive overfitting detection and validation
 * for the Meta-Adaptive strategy
 */

import { buildMetaAdaptiveSyntheticCandles } from '../src/quantai/strategies/metaAdaptive/backtest.js';
import { runComprehensiveValidation } from '../src/quantai/validation/metaAdaptiveValidation.js';
import type { MetaAdaptiveBacktestOptions } from '../src/quantai/strategies/metaAdaptive/backtest.js';

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   Meta-Adaptive Strategy - Overfitting Validation Suite  ');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Generate synthetic candle data (1 week for faster testing)
  console.log('📊 Generating test data (1 week of synthetic market data)...');
  const candles = buildMetaAdaptiveSyntheticCandles({ minutes: 60 * 24 * 7 });
  console.log(`✓ Generated ${candles.length} candles\n`);

  // Configure backtest options
  const options: MetaAdaptiveBacktestOptions = {
    symbol: 'ETH/USDT',
    equityUsd: 10_000,
    slippageBps: 5,
    makerFeeBps: 2,
    takerFeeBps: 6,
    fundingAnnualPct: 8,
    latencyMs: 150,
    impactBpsPerMillion: 3,
    strategyHealthWarmupTrades: 5,
    disableStrategyHealthRisk: false
  };

  console.log('🔍 Running Comprehensive Validation...\n');
  console.log('This includes:');
  console.log('  - Full backtest with walk-forward analysis');
  console.log('  - 5-fold cross-validation');
  console.log('  - Out-of-sample testing (70/30 split)');
  console.log('  - Overfitting detection across all methods\n');

  const startTime = Date.now();
  
  try {
    const validation = await runComprehensiveValidation(candles, options);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✓ Validation completed in ${duration}s\n`);

    // Display the detailed summary
    console.log(validation.overfittingAnalysis.summary);

    // Additional detailed metrics
    console.log('\n📈 Detailed Performance Breakdown:\n');
    
    console.log('Overall Backtest:');
    console.log(`  Total Return: ${validation.overall.metrics.totalReturnPct.toFixed(2)}%`);
    console.log(`  Sharpe Ratio: ${validation.overall.metrics.sharpe.toFixed(2)}`);
    console.log(`  Max Drawdown: ${validation.overall.metrics.maxDrawdownPct.toFixed(2)}%`);
    console.log(`  Win Rate: ${(validation.overall.metrics.hitRate * 100).toFixed(1)}%`);
    console.log(`  Profit Factor: ${validation.overall.metrics.profitFactor.toFixed(2)}`);
    console.log(`  Total Trades: ${validation.overall.trades.length}`);
    console.log();

    console.log('Walk-Forward Segments:');
    const walkForward = validation.walkForward ?? [];
    console.log(`  Number of Segments: ${walkForward.length}`);
    if (walkForward.length > 0) {
      const avgWFSharpe = walkForward.reduce((sum, seg) => sum + seg.metrics.sharpe, 0) / walkForward.length;
      console.log(`  Average Sharpe: ${avgWFSharpe.toFixed(2)}`);
      
      const sharpes = walkForward.map(seg => seg.metrics.sharpe);
      const minSharpe = Math.min(...sharpes);
      const maxSharpe = Math.max(...sharpes);
      console.log(`  Sharpe Range: ${minSharpe.toFixed(2)} to ${maxSharpe.toFixed(2)}`);
    }
    console.log();

    console.log('Cross-Validation (5-fold):');
    console.log(`  Avg Train Sharpe: ${validation.crossValidation.avgTrainMetrics.sharpe.toFixed(2)}`);
    console.log(`  Avg Test Sharpe: ${validation.crossValidation.avgTestMetrics.sharpe.toFixed(2)}`);
    console.log(`  Stability Score: ${(validation.crossValidation.stabilityScore * 100).toFixed(1)}%`);
    console.log();

    console.log('Out-of-Sample Test:');
    console.log(`  In-Sample Sharpe: ${validation.outOfSample.inSample.sharpe.toFixed(2)}`);
    console.log(`  Out-of-Sample Sharpe: ${validation.outOfSample.outOfSample.sharpe.toFixed(2)}`);
    console.log(`  Degradation: ${validation.outOfSample.degradationPct.toFixed(1)}%`);
    console.log(`  Statistically Significant: ${validation.outOfSample.isSignificant ? 'Yes' : 'No'}`);
    console.log();

    // Final verdict
    console.log('═══════════════════════════════════════════════════════════');
    console.log('                     FINAL VERDICT                         ');
    console.log('═══════════════════════════════════════════════════════════\n');

    const { flags } = validation.overfittingAnalysis;
    
    if (flags.isOverfitted) {
      console.log(`❌ OVERFITTING DETECTED - Severity: ${flags.severity.toUpperCase()}`);
      console.log(`   Confidence: ${(flags.confidence * 100).toFixed(1)}%`);
      console.log();
      
      if (validation.overfittingAnalysis.actionRequired) {
        console.log('🚨 IMMEDIATE ACTION REQUIRED');
        console.log();
        console.log('Recommended Actions:');
        for (const rec of flags.recommendations) {
          console.log(`  • ${rec}`);
        }
      } else {
        console.log('⚠️  Monitor the situation closely');
      }
    } else {
      console.log('✅ NO SIGNIFICANT OVERFITTING DETECTED');
      console.log(`   Confidence: ${(flags.confidence * 100).toFixed(1)}%`);
      console.log();
      console.log('Strategy appears robust for deployment.');
      
      if (flags.flags.length > 0) {
        console.log();
        console.log('Minor issues noted:');
        for (const flag of flags.flags) {
          console.log(`  • [${flag.severity}] ${flag.description}`);
        }
      }
    }

    console.log('\n═══════════════════════════════════════════════════════════\n');

    // Return appropriate exit code
    process.exit(validation.overfittingAnalysis.actionRequired ? 1 : 0);

  } catch (error) {
    console.error('\n❌ Validation failed with error:');
    console.error(error);
    process.exit(2);
  }
}

// Run the validation
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(2);
});
