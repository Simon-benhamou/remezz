#!/usr/bin/env node
/**
 * Test script for Predictor Retraining System
 * 
 * Tests:
 * 1. Check scheduler status
 * 2. Verify current model metrics
 * 3. Check backup system
 * 4. Display retraining schedule
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
const pythonDir = join(projectRoot, 'python');

console.log('🔍 Predictor Retraining System - Test & Status\n');

// Load environment configuration
const config = {
  schedule: process.env.PREDICTOR_RETRAIN_SCHEDULE || 'weekly',
  day: parseInt(process.env.PREDICTOR_RETRAIN_DAY || '0', 10),
  hour: parseInt(process.env.PREDICTOR_RETRAIN_HOUR || '3', 10),
  minAccuracy: parseFloat(process.env.PREDICTOR_MIN_ACCURACY || '0.50'),
  minF1: parseFloat(process.env.PREDICTOR_MIN_F1 || '0.45'),
  maxAccuracyDrop: parseFloat(process.env.PREDICTOR_MAX_ACCURACY_DROP || '0.05'),
  disabled: process.env.PREDICTOR_RETRAINING_DISABLED === 'true',
};

// Day names
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

console.log('📋 Configuration:');
console.log('  Status:', config.disabled ? '❌ DISABLED' : '✅ ENABLED');
console.log('  Schedule:', config.schedule);
console.log('  Day:', dayNames[config.day]);
console.log('  Hour:', `${config.hour}:00 UTC`);
console.log('  Min Accuracy Threshold:', `${(config.minAccuracy * 100).toFixed(1)}%`);
console.log('  Min F1 Threshold:', `${(config.minF1 * 100).toFixed(1)}%`);
console.log('  Max Accuracy Drop:', `${(config.maxAccuracyDrop * 100).toFixed(1)}%`);
console.log();

// Load current model metrics
async function loadCurrentMetrics() {
  try {
    const metricsPath = join(pythonDir, 'training_metrics.json');
    const content = await readFile(metricsPath, 'utf-8');
    const data = JSON.parse(content);
    
    return {
      accuracy: data.accuracy || 0,
      f1_score: data.f1_score || 0,
      precision: data.precision || 0,
      recall: data.recall || 0,
      timestamp: data.timestamp || 0,
      samples: data.samples || 0,
    };
  } catch (error) {
    return null;
  }
}

// Calculate next retraining date
function calculateNextRetraining() {
  const now = new Date();
  const targetDay = config.day;
  const targetHour = config.hour;
  
  let nextDate = new Date(now);
  nextDate.setUTCHours(targetHour, 0, 0, 0);
  
  // Find next occurrence of target day
  const currentDay = now.getUTCDay();
  let daysUntilTarget = (targetDay - currentDay + 7) % 7;
  
  // If target day is today but time has passed, schedule for next week
  if (daysUntilTarget === 0 && now.getUTCHours() >= targetHour) {
    daysUntilTarget = 7;
  }
  
  nextDate.setUTCDate(now.getUTCDate() + daysUntilTarget);
  
  // For biweekly: add 7 days
  if (config.schedule === 'biweekly' && daysUntilTarget === 0) {
    nextDate.setUTCDate(nextDate.getUTCDate() + 7);
  }
  
  // For bimonthly: add 7 more days
  if (config.schedule === 'bimonthly' && daysUntilTarget === 0) {
    nextDate.setUTCDate(nextDate.getUTCDate() + 14);
  }
  
  return nextDate;
}

// Check validation status
function checkValidationStatus(metrics) {
  const checks = [];
  
  // Check accuracy threshold
  const accuracyCheck = metrics.accuracy >= config.minAccuracy;
  checks.push({
    name: 'Accuracy Threshold',
    status: accuracyCheck ? '✅' : '❌',
    value: `${(metrics.accuracy * 100).toFixed(2)}%`,
    threshold: `≥ ${(config.minAccuracy * 100).toFixed(1)}%`,
  });
  
  // Check F1 threshold
  const f1Check = metrics.f1_score >= config.minF1;
  checks.push({
    name: 'F1 Score Threshold',
    status: f1Check ? '✅' : '❌',
    value: `${(metrics.f1_score * 100).toFixed(2)}%`,
    threshold: `≥ ${(config.minF1 * 100).toFixed(1)}%`,
  });
  
  return { allPassed: accuracyCheck && f1Check, checks };
}

// Main execution
async function main() {
  // Load current metrics
  console.log('📊 Current Model Metrics:');
  const metrics = await loadCurrentMetrics();
  
  if (!metrics) {
    console.log('  ❌ No metrics found - Model may not be trained yet');
    console.log();
  } else {
    const age = Date.now() - metrics.timestamp;
    const ageHours = Math.floor(age / (1000 * 60 * 60));
    const ageDays = Math.floor(ageHours / 24);
    
    console.log('  Accuracy:', `${(metrics.accuracy * 100).toFixed(2)}%`);
    console.log('  F1 Score:', `${(metrics.f1_score * 100).toFixed(2)}%`);
    console.log('  Precision:', `${(metrics.precision * 100).toFixed(2)}%`);
    console.log('  Recall:', `${(metrics.recall * 100).toFixed(2)}%`);
    console.log('  Training Samples:', metrics.samples.toLocaleString());
    console.log('  Model Age:', ageDays > 0 ? `${ageDays} day(s)` : `${ageHours} hour(s)`);
    console.log('  Last Trained:', new Date(metrics.timestamp).toISOString());
    console.log();
    
    // Validation status
    const validation = checkValidationStatus(metrics);
    console.log('✓ Validation Status:');
    validation.checks.forEach(check => {
      console.log(`  ${check.status} ${check.name}: ${check.value} (threshold: ${check.threshold})`);
    });
    console.log('  Overall:', validation.allPassed ? '✅ WOULD DEPLOY' : '❌ WOULD ROLLBACK');
    console.log();
  }
  
  // Next retraining schedule
  if (!config.disabled) {
    const nextRetrain = calculateNextRetraining();
    const timeUntil = nextRetrain.getTime() - Date.now();
    const hoursUntil = Math.floor(timeUntil / (1000 * 60 * 60));
    const daysUntil = Math.floor(hoursUntil / 24);
    
    console.log('📅 Next Scheduled Retraining:');
    console.log('  Date:', nextRetrain.toISOString());
    console.log('  Time Until:', daysUntil > 0 ? `${daysUntil} day(s)` : `${hoursUntil} hour(s)`);
    console.log();
  }
  
  // Recommendations
  console.log('💡 Recommendations:');
  if (!metrics) {
    console.log('  ⚠️  Initial training required: npm run train-model');
  } else {
    const ageDays = Math.floor((Date.now() - metrics.timestamp) / (1000 * 60 * 60 * 24));
    if (ageDays > 14) {
      console.log('  ⚠️  Model is older than 2 weeks - consider manual retraining');
    } else if (ageDays > 7) {
      console.log('  ℹ️  Model is older than 1 week - automatic retraining will occur soon');
    } else {
      console.log('  ✅ Model age is acceptable');
    }
    
    if (metrics.accuracy < 0.55) {
      console.log('  ⚠️  Accuracy is below 55% - monitor prediction performance');
    }
    
    if (metrics.samples < 1000) {
      console.log('  ⚠️  Low sample count - ensure sufficient historical data');
    }
  }
  
  console.log();
  console.log('📚 For more information, see: PREDICTOR_RETRAINING_GUIDE.md');
  console.log('🔧 To trigger manual retraining: POST /api/ops/predictor/retrain (requires admin auth)');
}

main().catch(console.error);
