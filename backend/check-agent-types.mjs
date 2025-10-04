#!/usr/bin/env node
/**
 * 🔍 Script de diagnostic: Vérifier le type des agents (manuel vs auto-select)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkAgentTypes() {
  console.log('\n🔍 DIAGNOSTIC: Type des agents actifs\n');
  console.log('='.repeat(80));
  
  try {
    // Récupérer tous les agents actifs (non stoppés)
    const sessions = await prisma.agentSession.findMany({
      where: {
        stoppedAt: null,
        mode: 'paper'
      },
      select: {
        id: true,
        symbol: true,
        mode: true,
        isSmartAgent: true,
        profileJson: true,
        startedAt: true,
        kpi: {
          select: {
            stats: true
          }
        }
      },
      orderBy: {
        startedAt: 'asc'
      }
    });

    console.log(`\n📊 Trouvé ${sessions.length} agents actifs en mode paper\n`);

    let manualCount = 0;
    let smartCount = 0;

    for (const session of sessions) {
      const profileJson = session.profileJson || {};
      const isIntelligent = profileJson.isIntelligent || false;
      const isSmartAgent = session.isSmartAgent || false;
      const isAutoSelect = isSmartAgent || isIntelligent;
      
      const stats = session.kpi?.stats || {};
      const trades = stats.tradesTotal || stats.trades || 0;
      
      // Format durée depuis création
      const startedAt = new Date(session.startedAt);
      const now = new Date();
      const hoursSinceStart = Math.floor((now - startedAt) / (1000 * 60 * 60));
      const minutesSinceStart = Math.floor(((now - startedAt) % (1000 * 60 * 60)) / (1000 * 60));
      const duration = `${hoursSinceStart}h${minutesSinceStart}m`;

      // Détection du type
      const type = isAutoSelect ? '🤖 AUTO-SELECT' : '👤 MANUEL';
      if (isAutoSelect) smartCount++;
      else manualCount++;

      // État (state est en runtime via AgentHub, pas en DB)
      const sleepMode = profileJson.sleepMode || false;
      const stateDisplay = sleepMode ? '� SLEEP' : '✅ ACTIVE';

      console.log(`${type} | ${stateDisplay.padEnd(18)} | ${session.symbol?.padEnd(15) || 'N/A'.padEnd(15)} | Trades: ${String(trades).padEnd(3)} | Durée: ${duration.padEnd(8)} | ID: ${session.id.slice(0, 8)}`);

      // Détails supplémentaires pour les agents auto-select
      if (isAutoSelect) {
        console.log(`         ├─ isSmartAgent: ${session.isSmartAgent}`);
        console.log(`         ├─ isIntelligent: ${profileJson.isIntelligent}`);
        console.log(`         ├─ sleepMode: ${profileJson.sleepMode || false}`);
        console.log(`         ├─ lastScan: ${profileJson.lastScan || 'N/A'}`);
        console.log(`         └─ nextScanDue: ${profileJson.nextScanDue || 'N/A'}`);
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log(`\n📈 Résumé:`);
    console.log(`   👤 Agents MANUELS: ${manualCount}`);
    console.log(`   🤖 Agents AUTO-SELECT: ${smartCount}`);
    console.log(`   📊 Total: ${sessions.length}\n`);

    // Diagnostic
    if (smartCount === 0 && manualCount > 0) {
      console.log('⚠️  PROBLÈME DÉTECTÉ:');
      console.log('   Tous les agents sont MANUELS (pas d\'auto-select)!');
      console.log('   Les fixes de threshold (0.6 → 0.5) et timing (12h → 6h)');
      console.log('   ne s\'appliquent PAS aux agents manuels.\n');
      console.log('💡 SOLUTION:');
      console.log('   Créer des agents avec isSmartAgent: true OU isIntelligent: true');
      console.log('   Ces agents choisiront dynamiquement leur crypto.\n');
    } else if (smartCount > 0) {
      console.log('✅ Agents auto-select détectés!');
      console.log('   Vérifier si le backend Railway a le nouveau code (threshold 0.5).\n');
    }

  } catch (error) {
    console.error('❌ Erreur lors de la récupération des agents:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Exécution
checkAgentTypes().catch(console.error);
