/**
 * Intelligent Predictor Retraining System
 * 
 * Features:
 * - Scheduled automatic retraining (weekly by default)
 * - Performance validation before model deployment
 * - Rollback if new model performs worse
 * - Emergency retraining triggers
 * - Comprehensive logging and metrics tracking
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIntegrationLogger } from '../utils/integrationLogger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(dirname(__dirname)));
const pythonDir = join(projectRoot, 'python');

const logger = createIntegrationLogger({
  component: 'PredictorRetrainer',
  action: 'retrain',
});

// Configuration from environment
const RETRAIN_SCHEDULE = process.env.PREDICTOR_RETRAIN_SCHEDULE || 'weekly'; // weekly, biweekly, bimonthly
const RETRAIN_DAY = parseInt(process.env.PREDICTOR_RETRAIN_DAY || '0', 10); // 0=Sunday
const RETRAIN_HOUR = parseInt(process.env.PREDICTOR_RETRAIN_HOUR || '3', 10); // 3am
const MIN_ACCURACY_THRESHOLD = parseFloat(process.env.PREDICTOR_MIN_ACCURACY || '0.50');
const MIN_F1_THRESHOLD = parseFloat(process.env.PREDICTOR_MIN_F1 || '0.45');
const MAX_ACCURACY_DROP = parseFloat(process.env.PREDICTOR_MAX_ACCURACY_DROP || '0.05'); // 5% max drop

interface TrainingMetrics {
  accuracy: number;
  f1_score: number;
  precision: number;
  recall: number;
  timestamp: number;
  samples: number;
}

interface RetrainingResult {
  success: boolean;
  deployed: boolean;
  oldMetrics: TrainingMetrics | null;
  newMetrics: TrainingMetrics | null;
  reason: string;
  duration: number;
}

let retrainScheduler: NodeJS.Timeout | null = null;
let lastRetrainTime = 0;
let retrainingInProgress = false;

/**
 * Load current model metrics
 */
async function loadCurrentMetrics(): Promise<TrainingMetrics | null> {
  try {
    const metricsPath = join(pythonDir, 'training_metrics.json');
    const content = await readFile(metricsPath, 'utf-8');
    const data = JSON.parse(content);
    
    return {
      accuracy: data.accuracy || 0,
      f1_score: data.f1_score || 0,
      precision: data.precision || 0,
      recall: data.recall || 0,
      timestamp: data.timestamp || Date.now(),
      samples: data.samples || 0,
    };
  } catch (error) {
    logger.warn('Failed to load current metrics', { error: (error as Error).message });
    return null;
  }
}

/**
 * Backup current model and metrics
 */
async function backupCurrentModel(): Promise<boolean> {
  try {
    const modelPath = join(pythonDir, 'xgboost_direction.json');
    const metricsPath = join(pythonDir, 'training_metrics.json');
    const featuresPath = join(pythonDir, 'features.txt');
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    await copyFile(modelPath, join(pythonDir, `xgboost_direction.backup.${timestamp}.json`));
    await copyFile(metricsPath, join(pythonDir, `training_metrics.backup.${timestamp}.json`));
    await copyFile(featuresPath, join(pythonDir, `features.backup.${timestamp}.txt`));
    
    logger.info('Model backup created', { timestamp });
    return true;
  } catch (error) {
    logger.error('Failed to backup model', { error: (error as Error).message });
    return false;
  }
}

/**
 * Restore model from backup
 */
async function restoreModelFromBackup(timestamp: string): Promise<boolean> {
  try {
    const modelPath = join(pythonDir, 'xgboost_direction.json');
    const metricsPath = join(pythonDir, 'training_metrics.json');
    const featuresPath = join(pythonDir, 'features.txt');
    
    await copyFile(join(pythonDir, `xgboost_direction.backup.${timestamp}.json`), modelPath);
    await copyFile(join(pythonDir, `training_metrics.backup.${timestamp}.json`), metricsPath);
    await copyFile(join(pythonDir, `features.backup.${timestamp}.txt`), featuresPath);
    
    logger.info('Model restored from backup', { timestamp });
    return true;
  } catch (error) {
    logger.error('Failed to restore model', { error: (error as Error).message, timestamp });
    return false;
  }
}

/**
 * Execute Python retraining script
 */
async function executePythonRetraining(): Promise<{ success: boolean; output: string; metrics: any }> {
  return new Promise((resolve) => {
    const scriptPath = join(pythonDir, 'scheduled_training.py');
    const timeout = 10 * 60 * 1000; // 10 minutes max
    
    logger.info('Starting Python retraining script', { scriptPath });
    
    const child = spawn('python3', [scriptPath], {
      cwd: pythonDir,
      env: process.env,
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      logger.error('Retraining timeout exceeded');
      resolve({ success: false, output: 'Timeout exceeded', metrics: null });
    }, timeout);
    
    child.on('close', (code) => {
      clearTimeout(timer);
      
      if (code === 0) {
        try {
          // Parse JSON output from script
          const lines = stdout.trim().split('\n');
          const lastLine = lines[lines.length - 1];
          const metrics = JSON.parse(lastLine);
          
          logger.info('Retraining completed successfully', { metrics });
          resolve({ success: true, output: stdout, metrics });
        } catch (error) {
          logger.error('Failed to parse training output', { error: (error as Error).message, stdout });
          resolve({ success: false, output: stdout, metrics: null });
        }
      } else {
        logger.error('Retraining failed', { code, stderr });
        resolve({ success: false, output: stderr, metrics: null });
      }
    });
    
    child.on('error', (error) => {
      clearTimeout(timer);
      logger.error('Failed to spawn retraining process', { error: error.message });
      resolve({ success: false, output: error.message, metrics: null });
    });
  });
}

/**
 * Validate new model against current model
 */
function validateNewModel(
  oldMetrics: TrainingMetrics | null,
  newMetrics: TrainingMetrics
): { valid: boolean; reason: string } {
  // Check minimum thresholds
  if (newMetrics.accuracy < MIN_ACCURACY_THRESHOLD) {
    return {
      valid: false,
      reason: `Accuracy ${newMetrics.accuracy.toFixed(3)} below threshold ${MIN_ACCURACY_THRESHOLD}`,
    };
  }
  
  if (newMetrics.f1_score < MIN_F1_THRESHOLD) {
    return {
      valid: false,
      reason: `F1 score ${newMetrics.f1_score.toFixed(3)} below threshold ${MIN_F1_THRESHOLD}`,
    };
  }
  
  // If we have old metrics, ensure no significant performance drop
  if (oldMetrics) {
    const accuracyDrop = oldMetrics.accuracy - newMetrics.accuracy;
    
    if (accuracyDrop > MAX_ACCURACY_DROP) {
      return {
        valid: false,
        reason: `Accuracy dropped by ${(accuracyDrop * 100).toFixed(2)}% (max allowed: ${(MAX_ACCURACY_DROP * 100).toFixed(2)}%)`,
      };
    }
    
    // Check that new model is not significantly worse on F1
    const f1Drop = oldMetrics.f1_score - newMetrics.f1_score;
    if (f1Drop > MAX_ACCURACY_DROP) {
      return {
        valid: false,
        reason: `F1 score dropped by ${(f1Drop * 100).toFixed(2)}%`,
      };
    }
    
    // Log performance comparison
    logger.info('Model validation comparison', {
      oldAccuracy: oldMetrics.accuracy.toFixed(3),
      newAccuracy: newMetrics.accuracy.toFixed(3),
      accuracyChange: ((newMetrics.accuracy - oldMetrics.accuracy) * 100).toFixed(2) + '%',
      oldF1: oldMetrics.f1_score.toFixed(3),
      newF1: newMetrics.f1_score.toFixed(3),
      f1Change: ((newMetrics.f1_score - oldMetrics.f1_score) * 100).toFixed(2) + '%',
    });
  }
  
  return {
    valid: true,
    reason: `Model validated: accuracy=${newMetrics.accuracy.toFixed(3)}, f1=${newMetrics.f1_score.toFixed(3)}`,
  };
}

/**
 * Perform complete retraining with validation
 */
export async function retrainPredictorModel(): Promise<RetrainingResult> {
  if (retrainingInProgress) {
    logger.warn('Retraining already in progress, skipping');
    return {
      success: false,
      deployed: false,
      oldMetrics: null,
      newMetrics: null,
      reason: 'Retraining already in progress',
      duration: 0,
    };
  }
  
  retrainingInProgress = true;
  const startTime = Date.now();
  
  try {
    logger.info('🔄 Starting intelligent model retraining');
    
    // Step 1: Load current metrics
    const oldMetrics = await loadCurrentMetrics();
    logger.info('Current model metrics loaded', { oldMetrics });
    
    // Step 2: Backup current model
    const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupSuccess = await backupCurrentModel();
    
    if (!backupSuccess) {
      logger.error('Failed to backup current model, aborting retraining');
      return {
        success: false,
        deployed: false,
        oldMetrics,
        newMetrics: null,
        reason: 'Backup failed',
        duration: Date.now() - startTime,
      };
    }
    
    // Step 3: Execute retraining
    const retrainResult = await executePythonRetraining();
    
    if (!retrainResult.success) {
      logger.error('Retraining execution failed', { output: retrainResult.output });
      return {
        success: false,
        deployed: false,
        oldMetrics,
        newMetrics: null,
        reason: 'Training execution failed',
        duration: Date.now() - startTime,
      };
    }
    
    // Step 4: Load new metrics
    const newMetrics = await loadCurrentMetrics();
    
    if (!newMetrics) {
      logger.error('Failed to load new model metrics');
      await restoreModelFromBackup(backupTimestamp);
      return {
        success: false,
        deployed: false,
        oldMetrics,
        newMetrics: null,
        reason: 'Failed to load new metrics',
        duration: Date.now() - startTime,
      };
    }
    
    // Step 5: Validate new model
    const validation = validateNewModel(oldMetrics, newMetrics);
    
    if (!validation.valid) {
      logger.warn('New model failed validation, rolling back', { reason: validation.reason });
      await restoreModelFromBackup(backupTimestamp);
      return {
        success: true,
        deployed: false,
        oldMetrics,
        newMetrics,
        reason: `Validation failed: ${validation.reason}`,
        duration: Date.now() - startTime,
      };
    }
    
    // Step 6: Success - new model deployed
    logger.info('✅ New model validated and deployed', {
      reason: validation.reason,
      improvement: oldMetrics 
        ? `+${((newMetrics.accuracy - oldMetrics.accuracy) * 100).toFixed(2)}% accuracy`
        : 'baseline model',
    });
    
    lastRetrainTime = Date.now();
    
    return {
      success: true,
      deployed: true,
      oldMetrics,
      newMetrics,
      reason: validation.reason,
      duration: Date.now() - startTime,
    };
    
  } catch (error) {
    logger.error('Unexpected error during retraining', { error: (error as Error).message });
    return {
      success: false,
      deployed: false,
      oldMetrics: null,
      newMetrics: null,
      reason: `Error: ${(error as Error).message}`,
      duration: Date.now() - startTime,
    };
  } finally {
    retrainingInProgress = false;
  }
}

/**
 * Check if retraining is needed based on schedule
 */
function shouldRetrain(): boolean {
  const now = new Date();
  const currentDay = now.getUTCDay(); // 0=Sunday, 6=Saturday
  const currentHour = now.getUTCHours();
  
  // Check if we're in the right hour
  if (currentHour !== RETRAIN_HOUR) {
    return false;
  }
  
  // Avoid retraining multiple times in the same hour
  const hoursSinceLastRetrain = (Date.now() - lastRetrainTime) / (1000 * 60 * 60);
  if (hoursSinceLastRetrain < 1) {
    return false;
  }
  
  // Check schedule
  switch (RETRAIN_SCHEDULE) {
    case 'weekly':
      return currentDay === RETRAIN_DAY;
    
    case 'biweekly':
      // Train on configured day and 3 days later
      return currentDay === RETRAIN_DAY || currentDay === (RETRAIN_DAY + 3) % 7;
    
    case 'bimonthly':
      // Train on 1st and 15th of month
      const dayOfMonth = now.getUTCDate();
      return (dayOfMonth === 1 || dayOfMonth === 15) && currentDay === RETRAIN_DAY;
    
    default:
      return false;
  }
}

/**
 * Start the retraining scheduler
 */
export function startPredictorRetrainingScheduler(): () => void {
  if (retrainScheduler) {
    clearInterval(retrainScheduler);
  }
  
  logger.info('🤖 Predictor retraining scheduler started', {
    schedule: RETRAIN_SCHEDULE,
    day: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][RETRAIN_DAY],
    hour: `${RETRAIN_HOUR}:00 UTC`,
    minAccuracy: MIN_ACCURACY_THRESHOLD,
    minF1: MIN_F1_THRESHOLD,
    maxDrop: `${(MAX_ACCURACY_DROP * 100).toFixed(0)}%`,
  });
  
  // Check every hour
  retrainScheduler = setInterval(async () => {
    if (shouldRetrain() && !retrainingInProgress) {
      logger.info('⏰ Scheduled retraining triggered');
      const result = await retrainPredictorModel();
      
      if (result.success && result.deployed) {
        logger.info('🎉 Scheduled retraining completed successfully', {
          duration: `${(result.duration / 1000).toFixed(1)}s`,
          oldAccuracy: result.oldMetrics?.accuracy.toFixed(3),
          newAccuracy: result.newMetrics?.accuracy.toFixed(3),
        });
      } else if (result.success && !result.deployed) {
        logger.warn('⚠️ Retraining completed but model not deployed', {
          reason: result.reason,
        });
      } else {
        logger.error('❌ Scheduled retraining failed', {
          reason: result.reason,
        });
      }
    }
  }, 60 * 60 * 1000); // Check every hour
  
  return () => {
    if (retrainScheduler) {
      clearInterval(retrainScheduler);
      retrainScheduler = null;
      logger.info('Predictor retraining scheduler stopped');
    }
  };
}

/**
 * Manual retraining trigger (for API endpoint)
 */
export async function triggerManualRetraining(): Promise<RetrainingResult> {
  logger.info('🔧 Manual retraining triggered');
  return retrainPredictorModel();
}

/**
 * Get retraining status
 */
export function getRetrainingStatus() {
  return {
    inProgress: retrainingInProgress,
    lastRetrainTime,
    schedule: RETRAIN_SCHEDULE,
    nextCheck: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    config: {
      minAccuracy: MIN_ACCURACY_THRESHOLD,
      minF1: MIN_F1_THRESHOLD,
      maxAccuracyDrop: MAX_ACCURACY_DROP,
      retrainDay: RETRAIN_DAY,
      retrainHour: RETRAIN_HOUR,
    },
  };
}
