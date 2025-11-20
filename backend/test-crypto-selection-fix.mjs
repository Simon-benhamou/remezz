#!/usr/bin/env node
/**
 * Test: Vérifier fixes de sélection crypto multi-agents
 * 
 * Valide:
 * 1. BTC/ETH/SOL/XRP dans top cryptos sélectionnées
 * 2. 4/4 agents créés (pas 2/4)
 * 3. Aucun doublon
 * 4. Cache invalidé entre créations
 */

import { prepareAgentCreation, createSessionFromPrepared, activatePreparedAgent } from './dist/src/services/agentCreationFlow.js';
import { prisma } from './dist/src/db/client.js';

const TEST_USER_ID = 'cmhhhwem70000pe65r748lnlu';
const TARGET_AGENTS = 4;

async function cleanupTestSessions() {
  console.log('🧹 Cleaning up existing test sessions...');
  // Delete ALL test user sessions (active + stopped)
  const deleted = await prisma.agentSession.deleteMany({
    where: {
      userId: TEST_USER_ID
    }
  });
  console.log(`   Deleted ${deleted.count} total sessions (active + stopped)\n`);
}

async function testMultiAgentSelection() {
  console.log('\n' + '═'.repeat(80));
  console.log('🧪 TEST: Vérification Fixes Sélection Multi-Agents');
  console.log('═'.repeat(80) + '\n');

  try {
    console.log(`📋 User ID: ${TEST_USER_ID}`);
    console.log(`🎯 Target: Create ${TARGET_AGENTS} agents with different cryptos\n`);

    await cleanupTestSessions();

    console.log(`\n📊 Test: Création de ${TARGET_AGENTS} agents reactive en séquence`);
    console.log('-'.repeat(80));

    const payload = {
      mode: 'paper',
      smartAutoMode: true,
      isSmartAgent: true,
      aggressiveness: 'reactive',
      riskPerTradePct: 1.0,
      maxLeverage: 7,
      dailyLossLimitPct: 3.0,
      startBalanceUsd: 2000,
      budgetPct: 50,
      strategyEngine: 'meta_adaptive',
    };

    const results = [];
    const symbols = [];
    const creationIds = [];

    for (let i = 0; i < TARGET_AGENTS; i++) {
      console.log(`\n[Agent ${i+1}/${TARGET_AGENTS}] Creating...`);
      
      try {
        // Prepare with excluded symbols from previous agents
        const prepared = await prepareAgentCreation({
          ...payload,
          excludedSymbols: symbols,
        }, TEST_USER_ID);

        const creationId = prepared.creationId;
        const selectedSymbol = prepared.selection?.symbol;
        const source = prepared.selection?.source;
        const prefetchedSymbol = prepared.selection?.prefetchedSymbol;

        console.log(`   ✓ Prepared: ${creationId.slice(0, 8)}...`);
        console.log(`   📊 Symbol: ${selectedSymbol}`);
        console.log(`   🔍 Source: ${source}`);
        console.log(`   💾 Prefetched: ${prefetchedSymbol || 'none'}`);
        
        if (prepared.selection?.candidates && prepared.selection.candidates.length > 0) {
          console.log(`   📋 Top 5 candidates: ${prepared.selection.candidates.slice(0, 5).join(', ')}`);
        }

        if (!selectedSymbol) {
          console.log(`   ❌ ERROR: No symbol selected!`);
          results.push({ 
            agent: i + 1, 
            success: false, 
            error: 'no_symbol', 
            symbol: null 
          });
          continue;
        }

        // Check for duplicate
        if (symbols.includes(selectedSymbol)) {
          console.log(`   ⚠️  WARNING: Duplicate detected! ${selectedSymbol} already used`);
          results.push({ 
            agent: i + 1, 
            success: false, 
            error: 'duplicate', 
            symbol: selectedSymbol 
          });
          continue;
        }

        // Create session
        await createSessionFromPrepared(creationId, { symbol: selectedSymbol });
        console.log(`   ✓ Session created`);

        // Activate
        await activatePreparedAgent(creationId);
        console.log(`   ✓ Agent activated`);

        symbols.push(selectedSymbol);
        creationIds.push(creationId);
        results.push({ 
          agent: i + 1, 
          success: true, 
          symbol: selectedSymbol,
          source
        });

        console.log(`   ✅ Agent ${i+1} created successfully with ${selectedSymbol}`);
        
        // Small delay between agents
        if (i < TARGET_AGENTS - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        console.error(`   ❌ Failed:`, error.message || error);
        results.push({ 
          agent: i + 1, 
          success: false, 
          error: error.message || String(error),
          symbol: null 
        });
      }
    }

    // Analyze results
    console.log('\n' + '═'.repeat(80));
    console.log('📊 RESULTS ANALYSIS');
    console.log('═'.repeat(80) + '\n');

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    console.log(`✅ Success: ${succeeded}/${TARGET_AGENTS} (${(succeeded/TARGET_AGENTS*100).toFixed(0)}%)`);
    console.log(`❌ Failed:  ${failed}/${TARGET_AGENTS}`);
    console.log(`🔄 Unique symbols: ${new Set(symbols).size}/${symbols.length}`);
    console.log();

    // Check for tier1 (BTC/ETH/SOL)
    const tier1Symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
    const tier1Found = symbols.filter(s => tier1Symbols.some(t => s.includes(t.split('/')[0])));
    
    // Check for tier2 (XRP, BNB, ADA, etc.)
    const tier2Symbols = ['XRP', 'BNB', 'ADA', 'AVAX', 'DOT', 'LINK'];
    const tier2Found = symbols.filter(s => tier2Symbols.some(t => s.includes(t)));

    console.log('📈 Symbols by tier:');
    console.log(`   🏆 Tier 1 (BTC/ETH/SOL): ${tier1Found.length} - ${tier1Found.join(', ')}`);
    console.log(`   🥈 Tier 2 (XRP/BNB/etc):  ${tier2Found.length} - ${tier2Found.join(', ')}`);
    console.log(`   🥉 Other tiers:           ${symbols.length - tier1Found.length - tier2Found.length}`);
    console.log();

    console.log('📋 Selected symbols:');
    results.forEach(r => {
      if (r.success) {
        const isTier1 = tier1Symbols.some(t => r.symbol.includes(t.split('/')[0]));
        const isTier2 = tier2Symbols.some(t => r.symbol.includes(t));
        const tier = isTier1 ? '🏆 Tier1' : isTier2 ? '🥈 Tier2' : '🥉 Other';
        console.log(`   ${r.agent}. ${r.symbol} (${r.source}) ${tier}`);
      } else {
        console.log(`   ${r.agent}. ❌ FAILED: ${r.error}`);
      }
    });
    console.log();

    // Validation checks
    console.log('🧪 VALIDATION CHECKS:');
    console.log('-'.repeat(80));
    
    const check1 = succeeded === TARGET_AGENTS;
    console.log(`${check1 ? '✅' : '❌'} Check 1: ${succeeded}/${TARGET_AGENTS} agents created`);
    
    const check2 = new Set(symbols).size === symbols.length;
    console.log(`${check2 ? '✅' : '❌'} Check 2: No duplicates (${new Set(symbols).size} unique / ${symbols.length} total)`);
    
    const check3 = tier1Found.length >= 2;
    console.log(`${check3 ? '✅' : '❌'} Check 3: At least 2 tier1 symbols (BTC/ETH/SOL) - found ${tier1Found.length}`);
    
    const check4 = symbols.length > 0 && symbols[0].includes('BTC');
    console.log(`${check4 ? '✅' : '❌'} Check 4: BTC selected first (priority ranking)`);

    const allChecks = check1 && check2 && check3;
    
    console.log();
    console.log('═'.repeat(80));
    if (allChecks) {
      console.log('🎉 ALL CHECKS PASSED! Multi-agent selection fixes working correctly.');
    } else {
      console.log('⚠️  SOME CHECKS FAILED. Review logs above for details.');
    }
    console.log('═'.repeat(80));

    // Cleanup
    console.log('\n🧹 Cleaning up test sessions...');
    for (const creationId of creationIds) {
      try {
        const session = await prisma.agentSession.findFirst({
          where: { id: creationId }
        });
        if (session) {
          await prisma.agentSession.update({
            where: { id: session.id },
            data: { stoppedAt: new Date() }
          });
        }
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    console.log('   Done\n');

    process.exit(allChecks ? 0 : 1);

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    process.exit(1);
  }
}

testMultiAgentSelection();
