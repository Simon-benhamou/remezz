#!/usr/bin/env node
/**
 * Test du nouveau système de TIERS intelligent
 * Vérifie que BTC, ETH, SOL sont maintenant prioritaires sur les small caps
 */

import { getOptimizedCryptoList, getCryptoTier } from './dist/src/services/intelligentAgent.js';

console.log('🚀 Testing TIER-BASED Crypto Selection System\n');
console.log('=' .repeat(80));

async function testTierSystem() {
  try {
    // Test 1: Vérifier le système de classification par tiers
    console.log('\n📊 TEST 1: Classification des cryptos par TIERS\n');
    console.log('-'.repeat(80));
    
    const testCryptos = [
      { symbol: 'BTC/USDT', volume: 2_000_000_000 },
      { symbol: 'ETH/USDT', volume: 800_000_000 },
      { symbol: 'SOL/USDT', volume: 600_000_000 },
      { symbol: 'XRP/USDT', volume: 100_000_000 },
      { symbol: 'ADA/USDT', volume: 60_000_000 },
      { symbol: 'AVAX/USDT', volume: 15_000_000 },
      { symbol: 'LINK/USDT', volume: 12_000_000 },
      { symbol: 'ENA/USDT', volume: 5_000_000 },
      { symbol: 'EIGEN/USDT', volume: 3_000_000 },
    ];
    
    console.log('Crypto           | Tier | Bonus | Min Move | Reputation  | Label');
    console.log('-'.repeat(80));
    
    for (const crypto of testCryptos) {
      const tierInfo = getCryptoTier(crypto.symbol, crypto.volume);
      const symbol = crypto.symbol.padEnd(16, ' ');
      const tier = `Tier ${tierInfo.tier}`;
      const bonus = tierInfo.bonus > 0 ? `+${tierInfo.bonus.toFixed(1)}` : tierInfo.bonus.toFixed(1);
      const minMove = `${tierInfo.minMovement}%`;
      const reputation = tierInfo.reputation;
      const label = tierInfo.label;
      
      console.log(`${symbol} | ${tier} | ${bonus.padStart(5, ' ')} | ${minMove.padStart(8, ' ')} | ${reputation.padEnd(11, ' ')} | ${label}`);
    }
    
    console.log('\n✅ Résultat attendu:');
    console.log('   - BTC, ETH, SOL → Tier 1 (+2.0 bonus, 0.3% min move)');
    console.log('   - XRP, ADA → Tier 2 (+1.0 bonus, 0.5% min move)');
    console.log('   - AVAX, LINK → Tier 3 (+0.3 bonus, 1.0% min move)');
    console.log('   - ENA, EIGEN → Tier 4 (-1.0 penalty, 3.0% min move)\n');
    
    // Test 2: Sélection réelle des cryptos avec le nouveau système
    console.log('\n📊 TEST 2: Sélection réelle des top cryptos\n');
    console.log('-'.repeat(80));
    console.log('Fetching top cryptos from market with new TIER-BASED system...\n');
    
    const topCryptos = await getOptimizedCryptoList();
    
    console.log(`\n✅ Top ${topCryptos.length} cryptos selected:\n`);
    console.log('Rank | Symbol          | Expected Tier');
    console.log('-'.repeat(80));
    
    topCryptos.slice(0, 20).forEach((symbol, index) => {
      const rank = String(index + 1).padStart(4, ' ');
      const sym = symbol.padEnd(15, ' ');
      
      // Determiner tier attendu
      const base = symbol.split('/')[0];
      let expectedTier = '';
      if (['BTC', 'ETH', 'SOL'].includes(base)) {
        expectedTier = '🔵 Tier 1 (Blue Chip)';
      } else if (['XRP', 'BNB', 'ADA', 'DOGE', 'MATIC', 'TRX', 'LTC', 'DOT'].includes(base)) {
        expectedTier = '🟢 Tier 2 (Major)';
      } else if (['AVAX', 'LINK', 'UNI', 'NEAR', 'SUI', 'APT', 'ARB', 'OP'].includes(base)) {
        expectedTier = '🟡 Tier 3 (Promising Alt)';
      } else {
        expectedTier = '🔴 Tier 4 (Small Cap)';
      }
      
      console.log(`${rank} | ${sym} | ${expectedTier}`);
    });
    
    // Vérifications
    console.log('\n📊 VÉRIFICATIONS:\n');
    console.log('-'.repeat(80));
    
    const top10 = topCryptos.slice(0, 10);
    const btcRank = topCryptos.indexOf('BTC/USDT') + 1;
    const ethRank = topCryptos.indexOf('ETH/USDT') + 1;
    const solRank = topCryptos.indexOf('SOL/USDT') + 1;
    
    const tier1Count = top10.filter(s => ['BTC', 'ETH', 'SOL'].includes(s.split('/')[0])).length;
    const tier2Count = top10.filter(s => ['XRP', 'BNB', 'ADA', 'DOGE', 'MATIC', 'TRX', 'LTC', 'DOT'].includes(s.split('/')[0])).length;
    const tier4Count = top10.filter(s => {
      const base = s.split('/')[0];
      return !['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'DOGE', 'MATIC', 'TRX', 'LTC', 'DOT', 'AVAX', 'LINK', 'UNI', 'NEAR', 'SUI', 'APT', 'ARB', 'OP'].includes(base);
    }).length;
    
    console.log(`✅ BTC rank: ${btcRank > 0 ? `#${btcRank}` : 'NOT IN LIST ❌'}`);
    console.log(`✅ ETH rank: ${ethRank > 0 ? `#${ethRank}` : 'NOT IN LIST ❌'}`);
    console.log(`✅ SOL rank: ${solRank > 0 ? `#${solRank}` : 'NOT IN LIST ❌'}`);
    console.log(`\n📊 Top 10 composition:`);
    console.log(`   - Tier 1 (Blue Chips): ${tier1Count}/10`);
    console.log(`   - Tier 2 (Majors): ${tier2Count}/10`);
    console.log(`   - Tier 4 (Small Caps): ${tier4Count}/10 ${tier4Count === 0 ? '✅ AUCUN!' : '⚠️'}`);
    
    if (tier1Count >= 2 && tier4Count === 0) {
      console.log('\n🎉 SUCCESS: Le système priorise maintenant les cryptos de QUALITÉ!');
      console.log('   ✅ Au moins 2 blue chips dans le top 10');
      console.log('   ✅ Aucun small cap risqué dans le top 10');
    } else if (tier4Count > 0) {
      console.log('\n⚠️  WARNING: Encore des small caps dans le top 10');
      console.log(`   - ${tier4Count} small caps détectés`);
      console.log('   - Peut-être que ces coins ont des mouvements exceptionnels (>3%)');
    } else {
      console.log('\n⚠️  WARNING: Pas assez de blue chips dans le top 10');
      console.log(`   - Seulement ${tier1Count} blue chips détectés`);
    }
    
  } catch (error) {
    console.error('\n❌ Error during test:', error);
    process.exit(1);
  }
}

testTierSystem().then(() => {
  console.log('\n✅ Test complete!\n');
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
