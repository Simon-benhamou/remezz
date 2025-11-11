#!/usr/bin/env tsx
/**
 * Bias Statistics Report
 * 
 * Generates a report showing long/short bias distribution over time
 * to monitor for any systemic biases in the trading system.
 * 
 * Usage: npm run report:bias [days]
 * Example: npm run report:bias 30
 */

import { logBiasStatistics, hasSignificantBias } from '../src/services/intelligentAgent/biasMonitor.js';

async function main() {
  const args = process.argv.slice(2);
  const days = args[0] ? parseInt(args[0], 10) : 30;

  if (isNaN(days) || days < 1) {
    console.error('❌ Invalid number of days. Please provide a positive integer.');
    process.exit(1);
  }

  console.log('\n🔍 Generating Bias Statistics Report...\n');

  // Log detailed statistics
  await logBiasStatistics(days);

  // Check for significant imbalances
  const biasCheck = await hasSignificantBias(days, 70);

  if (biasCheck.hasImbalance) {
    console.log('\n⚠️ ACTION REQUIRED');
    console.log('='.repeat(80));
    console.log(`Significant ${biasCheck.direction.toUpperCase()} bias detected!`);
    console.log(`${biasCheck.percentage.toFixed(1)}% of decisions favor ${biasCheck.direction} positions.`);
    console.log('');
    console.log('Recommended Actions:');
    console.log('1. Review determineOptimalBias() logic for asymmetries');
    console.log('2. Check if confidence thresholds are blocking one direction');
    console.log('3. Verify regime-aware parameters include both long_bias and short_bias');
    console.log('4. Run tests: npm run test:jest -- long-short-bias-balance');
    console.log('='.repeat(80) + '\n');
  }

  console.log('✅ Report complete\n');
}

main().catch((error) => {
  console.error('❌ Error generating bias report:', error);
  process.exit(1);
});
