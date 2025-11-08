/**
 * Optimizer Job Handler
 * Scheduled job to run the strategy optimizer periodically
 */

import { registerSchedulerJobHandler, scheduleJob } from '../services/schedulerJobService.js';
import { optimizeAllSymbols } from './strategyOptimizer.js';
import { pruneOldEvaluations } from './tradeEvaluationLogger.js';

const JOB_TYPE = 'strategy_optimizer';
const DEFAULT_RUN_HOUR = 2; // 2 AM

/**
 * Handler for the optimizer job
 */
async function handleOptimizerJob(): Promise<void> {
  console.log('🧠 Starting strategy optimizer job...');

  try {
    // First, prune old evaluations
    const pruned = await pruneOldEvaluations(90);
    console.log(`🧹 Pruned ${pruned} old trade evaluations`);

    // Run the optimizer (always regime-aware)
    const results = await optimizeAllSymbols();
    
    console.log(`✅ Strategy optimizer job completed successfully`);
    console.log(`   Optimized ${results.size} symbols with regime-aware parameters`);
    
    // Log optimized symbols for tracking
    if (results.size > 0) {
      const symbols = Array.from(results.keys());
      console.log(`   Symbols: ${symbols.join(', ')}`);
    }
  } catch (error) {
    console.error('❌ Strategy optimizer job failed:', error);
    throw error;
  }
}

/**
 * Register the optimizer job handler
 */
export function registerOptimizerJobHandler(): void {
  registerSchedulerJobHandler(JOB_TYPE, handleOptimizerJob);
  console.log('📋 Registered strategy optimizer job handler');
}

/**
 * Schedule the next optimizer job run
 */
export async function scheduleNextOptimizerJob(runHour: number = DEFAULT_RUN_HOUR): Promise<void> {
  const now = new Date();
  const runAt = new Date(now);
  
  // Set to target hour
  runAt.setHours(runHour, 0, 0, 0);
  
  // If that time has passed today, schedule for tomorrow
  if (runAt <= now) {
    runAt.setDate(runAt.getDate() + 1);
  }

  await scheduleJob(JOB_TYPE, runAt);
  console.log(`📅 Scheduled strategy optimizer to run at ${runAt.toISOString()}`);
}

/**
 * Initialize the optimizer scheduling
 */
export async function initializeOptimizerScheduling(): Promise<void> {
  registerOptimizerJobHandler();
  await scheduleNextOptimizerJob();
}
