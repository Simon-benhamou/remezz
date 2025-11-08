/**
 * Re-Optimization Scheduler
 * Manages automated re-optimization of trading strategies on configurable schedules
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import YAML from 'yaml';

import { registerSchedulerJobHandler, scheduleJob } from '../services/schedulerJobService.js';

import { savePersonalityProfile } from './personalityProfile.js';
import { optimizeSymbolParameters } from './strategyOptimizer.js';

const JOB_TYPE_SYMBOL_REOPT = 'symbol_reoptimization';

/**
 * Schedule configuration for re-optimization
 */
type ScheduleConfig = {
  enabled: boolean;
  frequency: 'daily' | 'weekly' | 'custom';
  run_hour?: number;
  run_day?: number;
  interval_hours?: number;
};

/**
 * Re-optimization configuration structure
 */
type ReoptimizationConfig = {
  default_schedule: ScheduleConfig;
  symbol_schedules?: Record<string, ScheduleConfig>;
};

/**
 * Job payload for symbol re-optimization
 */
type SymbolReoptimizationPayload = {
  symbol: string;
  scheduleConfig: ScheduleConfig;
};

/**
 * Load re-optimization configuration from YAML file
 */
function loadReoptimizationConfig(): ReoptimizationConfig | null {
  try {
    const configPath = join(process.cwd(), 'quantailabs_patch', 'config.yaml');
    const configContent = readFileSync(configPath, 'utf8');
    const config = YAML.parse(configContent);
    
    if (!config.reoptimization) {
      console.warn('⚠️ No reoptimization section found in config.yaml');
      return null;
    }
    
    return config.reoptimization as ReoptimizationConfig;
  } catch (error) {
    console.error('❌ Failed to load re-optimization config:', error);
    return null;
  }
}

/**
 * Calculate next run time based on schedule configuration
 */
function calculateNextRunTime(config: ScheduleConfig): Date {
  const now = new Date();
  const runAt = new Date(now);
  
  if (config.frequency === 'custom' && config.interval_hours) {
    // Custom interval: schedule from now + interval
    runAt.setHours(runAt.getHours() + config.interval_hours);
    return runAt;
  }
  
  if (config.frequency === 'daily') {
    // Daily schedule at specific hour
    const runHour = config.run_hour ?? 2;
    runAt.setHours(runHour, 0, 0, 0);
    
    // If that time has passed today, schedule for tomorrow
    if (runAt <= now) {
      runAt.setDate(runAt.getDate() + 1);
    }
    return runAt;
  }
  
  if (config.frequency === 'weekly') {
    // Weekly schedule on specific day and hour
    const targetDay = config.run_day ?? 0; // 0 = Sunday
    const runHour = config.run_hour ?? 2;
    
    runAt.setHours(runHour, 0, 0, 0);
    
    const currentDay = runAt.getDay();
    let daysUntilTarget = targetDay - currentDay;
    
    // If target day has passed this week, schedule for next week
    if (daysUntilTarget < 0 || (daysUntilTarget === 0 && runAt <= now)) {
      daysUntilTarget += 7;
    }
    
    runAt.setDate(runAt.getDate() + daysUntilTarget);
    return runAt;
  }
  
  // Default to daily at 2 AM
  runAt.setHours(2, 0, 0, 0);
  if (runAt <= now) {
    runAt.setDate(runAt.getDate() + 1);
  }
  return runAt;
}

/**
 * Handler for symbol re-optimization job
 */
async function handleSymbolReoptimization(job: any): Promise<void> {
  const payload = job.payload as SymbolReoptimizationPayload;
  const { symbol, scheduleConfig } = payload;
  
  console.log(`🔄 Starting re-optimization for ${symbol}...`);
  
  try {
    // Run optimization for the specific symbol
    const optimalParams = await optimizeSymbolParameters(symbol);
    
    if (optimalParams) {
      await savePersonalityProfile(symbol, optimalParams);
      console.log(`✅ Re-optimization completed successfully for ${symbol}`);
    } else {
      console.log(`⚠️ Re-optimization for ${symbol} did not produce new parameters (insufficient data)`);
    }
    
    // Schedule the next run for this symbol
    await scheduleSymbolReoptimization(symbol, scheduleConfig);
    
  } catch (error) {
    console.error(`❌ Re-optimization failed for ${symbol}:`, error);
    throw error;
  }
}

/**
 * Schedule a re-optimization job for a specific symbol
 */
export async function scheduleSymbolReoptimization(
  symbol: string,
  config: ScheduleConfig,
): Promise<void> {
  if (!config.enabled) {
    console.log(`⏸️ Re-optimization scheduling disabled for ${symbol}`);
    return;
  }
  
  const runAt = calculateNextRunTime(config);
  const payload: SymbolReoptimizationPayload = {
    symbol,
    scheduleConfig: config,
  };
  
  await scheduleJob(JOB_TYPE_SYMBOL_REOPT, runAt, payload);
  
  const scheduleDesc = config.frequency === 'custom' 
    ? `every ${config.interval_hours} hours`
    : config.frequency === 'weekly'
    ? `weekly on day ${config.run_day}`
    : `daily at ${config.run_hour ?? 2}:00`;
  
  console.log(`📅 Scheduled re-optimization for ${symbol} (${scheduleDesc}) at ${runAt.toISOString()}`);
}

/**
 * Get the schedule configuration for a symbol
 */
function getSymbolScheduleConfig(
  symbol: string,
  reoptConfig: ReoptimizationConfig,
): ScheduleConfig {
  // Check if there's a symbol-specific schedule
  if (reoptConfig.symbol_schedules && reoptConfig.symbol_schedules[symbol]) {
    return reoptConfig.symbol_schedules[symbol];
  }
  
  // Fall back to default schedule
  return reoptConfig.default_schedule;
}

/**
 * Register the re-optimization job handler
 */
export function registerReoptimizationJobHandler(): void {
  registerSchedulerJobHandler(JOB_TYPE_SYMBOL_REOPT, handleSymbolReoptimization);
  console.log('📋 Registered symbol re-optimization job handler');
}

/**
 * Initialize re-optimization scheduling for all configured symbols
 */
export async function initializeReoptimizationScheduling(): Promise<void> {
  console.log('🚀 Initializing re-optimization scheduler...');
  
  // Register the job handler
  registerReoptimizationJobHandler();
  
  // Load configuration
  const config = loadReoptimizationConfig();
  if (!config) {
    console.warn('⚠️ Re-optimization scheduler not initialized (no config)');
    return;
  }
  
  // Schedule jobs for symbols with specific schedules
  if (config.symbol_schedules) {
    for (const [symbol, scheduleConfig] of Object.entries(config.symbol_schedules)) {
      await scheduleSymbolReoptimization(symbol, scheduleConfig);
    }
  }
  
  console.log('✅ Re-optimization scheduler initialized');
}

/**
 * Manually trigger re-optimization for a symbol (useful for testing or manual intervention)
 */
export async function triggerSymbolReoptimization(symbol: string): Promise<void> {
  const config = loadReoptimizationConfig();
  if (!config) {
    throw new Error('Re-optimization configuration not found');
  }
  
  const scheduleConfig = getSymbolScheduleConfig(symbol, config);
  const payload: SymbolReoptimizationPayload = {
    symbol,
    scheduleConfig,
  };
  
  // Schedule immediately
  await scheduleJob(JOB_TYPE_SYMBOL_REOPT, new Date(), payload);
  console.log(`🔄 Triggered immediate re-optimization for ${symbol}`);
}
