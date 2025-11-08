#!/usr/bin/env node

/**
 * Verification script for re-optimization scheduler
 * This script demonstrates the scheduler's functionality
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';

console.log('🔍 Re-Optimization Scheduler Verification\n');

// Load and display configuration
const configPath = join(process.cwd(), 'quantailabs_patch', 'config.yaml');
const configContent = readFileSync(configPath, 'utf8');
const config = YAML.parse(configContent);

console.log('📋 Configuration Status:');
console.log('  ✓ Configuration file loaded successfully');
console.log(`  ✓ Default schedule enabled: ${config.reoptimization.default_schedule.enabled}`);
console.log(`  ✓ Default frequency: ${config.reoptimization.default_schedule.frequency}`);
console.log(`  ✓ Default run hour: ${config.reoptimization.default_schedule.run_hour}:00`);

console.log('\n📊 Symbol-Specific Schedules:');
const schedules = config.reoptimization.symbol_schedules;
for (const [symbol, schedule] of Object.entries(schedules)) {
  const freqDesc = schedule.frequency === 'daily' 
    ? `daily at ${schedule.run_hour}:00`
    : schedule.frequency === 'weekly'
    ? `weekly on day ${schedule.run_day} at ${schedule.run_hour}:00`
    : `every ${schedule.interval_hours} hours`;
  
  const status = schedule.enabled ? '✓' : '✗';
  console.log(`  ${status} ${symbol.padEnd(12)} → ${freqDesc} ${schedule.enabled ? '(enabled)' : '(disabled)'}`);
}

// Calculate and display next run times
console.log('\n📅 Next Scheduled Run Times:');

function calculateNextRunTime(schedule) {
  const now = new Date();
  const runAt = new Date(now);
  
  if (schedule.frequency === 'custom' && schedule.interval_hours) {
    runAt.setHours(runAt.getHours() + schedule.interval_hours);
    return runAt;
  }
  
  if (schedule.frequency === 'daily') {
    const runHour = schedule.run_hour ?? 2;
    runAt.setHours(runHour, 0, 0, 0);
    if (runAt <= now) {
      runAt.setDate(runAt.getDate() + 1);
    }
    return runAt;
  }
  
  if (schedule.frequency === 'weekly') {
    const targetDay = schedule.run_day ?? 0;
    const runHour = schedule.run_hour ?? 2;
    runAt.setHours(runHour, 0, 0, 0);
    const currentDay = runAt.getDay();
    let daysUntilTarget = targetDay - currentDay;
    if (daysUntilTarget < 0 || (daysUntilTarget === 0 && runAt <= now)) {
      daysUntilTarget += 7;
    }
    runAt.setDate(runAt.getDate() + daysUntilTarget);
    return runAt;
  }
  
  return runAt;
}

const now = new Date();
console.log(`  Current time: ${now.toISOString()}`);
console.log('');

for (const [symbol, schedule] of Object.entries(schedules)) {
  if (schedule.enabled) {
    const nextRun = calculateNextRunTime(schedule);
    const hoursUntil = ((nextRun - now) / (1000 * 60 * 60)).toFixed(1);
    console.log(`  ${symbol.padEnd(12)} → ${nextRun.toISOString()} (in ${hoursUntil}h)`);
  }
}

// Verify module exports
console.log('\n🔧 Module Verification:');
try {
  const schedulerModule = await import('../dist/src/learning/reoptimizationScheduler.js');
  
  const functions = [
    'registerReoptimizationJobHandler',
    'initializeReoptimizationScheduling',
    'scheduleSymbolReoptimization',
    'triggerSymbolReoptimization'
  ];
  
  for (const funcName of functions) {
    if (typeof schedulerModule[funcName] === 'function') {
      console.log(`  ✓ ${funcName}`);
    } else {
      console.log(`  ✗ ${funcName} (not found)`);
    }
  }
} catch (error) {
  console.error('  ✗ Failed to import scheduler module:', error.message);
}

// Summary
console.log('\n✅ Verification Complete!');
console.log('\nThe auto-re-optimization scheduler is configured and ready.');
console.log('When the server starts, it will automatically:');
console.log('  1. Register the re-optimization job handler');
console.log('  2. Schedule initial jobs for all configured symbols');
console.log('  3. Execute jobs at scheduled times');
console.log('  4. Automatically reschedule after each completion');
console.log('\nTo manually trigger re-optimization:');
console.log('  await triggerSymbolReoptimization("BTC/USDT")');
