#!/usr/bin/env node
/**
 * Database Cleanup Script - Remove Alert Spam
 * 
 * Cleans up 46k+ spam alerts from database
 */

import { config } from 'dotenv';
import pkg from '@prisma/client';
const { PrismaClient } = pkg;

config();
const prisma = new PrismaClient();

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = COLORS.reset) {
  console.log(`${color}${message}${COLORS.reset}`);
}

async function main() {
  log('\n' + '='.repeat(70), COLORS.cyan);
  log('DATABASE CLEANUP - REMOVING ALERT SPAM', COLORS.bright + COLORS.cyan);
  log('='.repeat(70) + '\n', COLORS.cyan);
  
  try {
    // Count before cleanup
    log('📊 Counting records before cleanup...', COLORS.blue);
    
    const agentActionCount = await prisma.agentActionIntent.count({
      where: { type: 'publish_alert' }
    });
    
    const alertCount = await prisma.alert.count({
      where: { kind: { startsWith: 'agent_action_' } }
    });
    
    log(`  AgentActionIntent (publish_alert): ${COLORS.yellow}${agentActionCount}${COLORS.reset}`, COLORS.reset);
    log(`  Alert (agent_action_*): ${COLORS.yellow}${alertCount}${COLORS.reset}\n`, COLORS.reset);
    
    if (agentActionCount === 0 && alertCount === 0) {
      log('✓ Database is already clean! No spam alerts found.', COLORS.green);
      return;
    }
    
    // Confirm cleanup
    log('⚠️  This will delete spam alerts, keeping only the last 100 of each type.', COLORS.yellow);
    log('   Real alerts (trades, errors) will NOT be deleted.\n', COLORS.yellow);
    
    // Clean AgentActionIntent table
    if (agentActionCount > 100) {
      log('🧹 Cleaning AgentActionIntent table...', COLORS.blue);
      
      // Get IDs of last 100 to keep
      const toKeep = await prisma.agentActionIntent.findMany({
        where: { type: 'publish_alert' },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true }
      });
      
      const keepIds = toKeep.map(a => a.id);
      
      // Delete old ones
      const deletedActions = await prisma.agentActionIntent.deleteMany({
        where: {
          type: 'publish_alert',
          id: { notIn: keepIds }
        }
      });
      
      log(`  ✓ Deleted ${COLORS.green}${deletedActions.count}${COLORS.reset} spam AgentActionIntent records`, COLORS.reset);
      log(`  ✓ Kept ${COLORS.green}100${COLORS.reset} most recent\n`, COLORS.reset);
    } else {
      log('  ✓ AgentActionIntent table OK (< 100 records)\n', COLORS.green);
    }
    
    // Clean Alert table
    if (alertCount > 100) {
      log('🧹 Cleaning Alert table...', COLORS.blue);
      
      // Get IDs of last 100 to keep
      const toKeepAlerts = await prisma.alert.findMany({
        where: { kind: { startsWith: 'agent_action_' } },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true }
      });
      
      const keepAlertIds = toKeepAlerts.map(a => a.id);
      
      // Delete old ones
      const deletedAlerts = await prisma.alert.deleteMany({
        where: {
          kind: { startsWith: 'agent_action_' },
          id: { notIn: keepAlertIds }
        }
      });
      
      log(`  ✓ Deleted ${COLORS.green}${deletedAlerts.count}${COLORS.reset} spam Alert records`, COLORS.reset);
      log(`  ✓ Kept ${COLORS.green}100${COLORS.reset} most recent\n`, COLORS.reset);
    } else {
      log('  ✓ Alert table OK (< 100 records)\n', COLORS.green);
    }
    
    // Count after cleanup
    log('📊 Final counts:', COLORS.blue);
    
    const finalAgentActionCount = await prisma.agentActionIntent.count({
      where: { type: 'publish_alert' }
    });
    
    const finalAlertCount = await prisma.alert.count({
      where: { kind: { startsWith: 'agent_action_' } }
    });
    
    log(`  AgentActionIntent (publish_alert): ${COLORS.green}${finalAgentActionCount}${COLORS.reset}`, COLORS.reset);
    log(`  Alert (agent_action_*): ${COLORS.green}${finalAlertCount}${COLORS.reset}\n`, COLORS.reset);
    
    // Summary
    const totalDeleted = (agentActionCount - finalAgentActionCount) + (alertCount - finalAlertCount);
    
    log('='.repeat(70), COLORS.green);
    log(`✓ CLEANUP COMPLETE! Removed ${totalDeleted} spam records`, COLORS.green + COLORS.bright);
    log('='.repeat(70) + '\n', COLORS.green);
    
    log('💡 Next steps:', COLORS.cyan);
    log('  1. Restart backend to stop creating new spam', COLORS.reset);
    log('  2. Monitor alert counts - should stay < 100', COLORS.reset);
    log('  3. New alerts = real events only (trades, errors)\n', COLORS.reset);
    
  } catch (error) {
    log('\n✗ Cleanup failed:', COLORS.red);
    console.error(error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
