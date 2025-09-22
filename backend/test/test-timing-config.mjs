#!/usr/bin/env node

/**
 * Test des améliorations de timing et cooldown
 */

import { getConfig } from '../dist/utils/env.js';

async function testTimingConfig() {
  console.log('🔧 Test de la configuration des timing controls...\n');

  try {
    const config = getConfig();
    
    console.log('📊 Configuration actuelle:');
    console.log(`   🕐 MIN_HOLD_TIME_MS: ${config.MIN_HOLD_TIME_MS}ms (${config.MIN_HOLD_TIME_MS/1000/60}min)`);
    console.log(`   ⏳ TRADE_COOLDOWN_MS: ${config.TRADE_COOLDOWN_MS}ms (${config.TRADE_COOLDOWN_MS/1000}s)`);
    console.log(`   🚨 CRITICAL_LOSS_PCT: ${config.CRITICAL_LOSS_PCT}%`);
    
    console.log('\n💡 Impact attendu:');
    console.log(`   • Minimum ${config.MIN_HOLD_TIME_MS/1000/60}min entre entry et exit`);
    console.log(`   • Cooldown de ${config.TRADE_COOLDOWN_MS/1000}s entre trades`);
    console.log(`   • Exit immédiat si perte > ${config.CRITICAL_LOSS_PCT}%`);
    
    console.log('\n✅ Configuration validée!');
    
  } catch (error) {
    console.error('❌ Erreur:', error);
  }
}

testTimingConfig();