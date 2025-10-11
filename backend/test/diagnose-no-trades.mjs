#!/usr/bin/env node

/**
 * Script de diagnostic pour analyser pourquoi les agents ne font pas de trades
 */

import { prisma } from '../dist/db/client.js';
import { AgentHub } from '../dist/agent/hub.js';

async function diagnoseNoTrades() {
  console.log('🔍 Diagnostic: Pourquoi les agents ne font pas de trades\n');

  try {
    // 1. Vérifier les sessions actives
    const activeSessions = await prisma.agentSession.findMany({
      where: { stoppedAt: null },
      include: {
        positions: true,
        orders: {
          where: {
            createdAt: {
              gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24h
            }
          }
        }
      }
    });

    console.log(`📊 Sessions actives: ${activeSessions.length}`);

    if (activeSessions.length === 0) {
      console.log('❌ Aucune session active trouvée!');
      return;
    }

    const stateCounts = new Map();
    const blockerCounts = new Map();

    // 2. Analyser chaque session active
    for (const session of activeSessions) {
      const shortId = session.id.substring(0, 8);
      console.log(`\n🔍 Analyse session ${shortId} (${session.symbol}):`);

      // Check agent hub
      const agent = AgentHub.get(session.id);
      if (!agent) {
        console.log('  ❌ Agent non trouvé dans AgentHub');
        continue;
      }

      console.log(`  ✅ Agent actif dans hub`);

      const state = agent.state;
      stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);

      // Check agent state
      try {
        console.log(`  📊 État: ${state || 'unknown'}`);

        const profile = agent.profile;
        console.log(`  📋 Profil: ${profile ? 'configuré' : 'manquant'}`);

        const plan = agent.plan;
        console.log(`  📝 Plan: ${plan ? 'configuré' : 'manquant'}`);
        
        // Check position
        const position = agent.pos;
        console.log(`  💼 Position: ${position ? `${position.side} ${position.size}` : 'aucune'}`);
        
        // Check orders in last 24h
        console.log(`  📝 Ordres 24h: ${session.orders.length}`);
        
        // Check diagnostics
        const diagnostics = await agent.getDiagnostics?.() || null;
        if (diagnostics) {
          console.log(`  🎯 Peut trader maintenant: ${diagnostics.canTrade ? 'oui' : 'non'}`);
          if (diagnostics.trigger) {
            console.log(`  🧭 Phase actuelle: ${diagnostics.trigger.phase || 'unknown'}`);
          }

          if (diagnostics.reason) {
            console.log(`  📌 Diagnostic: ${diagnostics.reason}`);
          }

          const blockers = Array.isArray(diagnostics.blockers) ? diagnostics.blockers : [];
          const primary = diagnostics.primaryBlocker || blockers[0];
          if (primary) {
            const label = primary.reason || primary.message || primary.code || primary.key;
            console.log(`  🚧 Blocage principal: ${label}`);
          }

          if (blockers.length > 0) {
            console.log(`  🚫 Détails des blocages:`);
            blockers.forEach((blocker) => {
              const label = blocker.reason || blocker.message || blocker.code || blocker.key;
              console.log(`    - [${blocker.key}] ${label}`);
              const mapKey = blocker.code || blocker.key;
              const entry = blockerCounts.get(mapKey) || { count: 0, reason: label, sessions: new Set() };
              entry.count += 1;
              entry.reason = label;
              entry.sessions.add(shortId);
              blockerCounts.set(mapKey, entry);
            });
          }
        }

        // Check recent market data
        const lastTick = agent.lastTick;
        if (lastTick) {
          console.log(`  📊 Prix actuel: $${lastTick.close}`);
          console.log(`  ⏰ Dernière donnée: ${new Date(lastTick.timestamp).toLocaleString()}`);
        } else {
          console.log(`  ❌ Aucune donnée de marché récente`);
        }
        
      } catch (error) {
        console.log(`  ❌ Erreur lors de l'analyse: ${error.message}`);
      }
    }

    if (stateCounts.size) {
      console.log(`\n📊 Répartition des états agents:`);
      for (const [state, count] of Array.from(stateCounts.entries()).sort((a, b) => b[1] - a[1])) {
        console.log(`  • ${state || 'UNKNOWN'}: ${count}`);
      }
    }

    if (blockerCounts.size) {
      console.log(`\n📌 Principaux blocages détectés:`);
      for (const [code, info] of Array.from(blockerCounts.entries()).sort((a, b) => b[1].count - a[1].count)) {
        const sessions = Array.from(info.sessions).join(', ');
        console.log(`  • ${code}: ${info.reason} (x${info.count}) [sessions: ${sessions}]`);
      }
    } else {
      console.log(`\n✅ Aucun blocage structurant détecté par les diagnostics (agents possiblement en phase d'échauffement).`);
    }

    // 3. Vérifier les métriques globales
    console.log(`\n📊 Métriques globales:`);
    
    const totalOrders24h = await prisma.order.count({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
        }
      }
    });
    
    const totalTrades24h = await prisma.order.count({
      where: {
        status: 'filled',
        updatedAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
        }
      }
    });
    
    console.log(`  📝 Ordres créés 24h: ${totalOrders24h}`);
    console.log(`  ✅ Trades exécutés 24h: ${totalTrades24h}`);
    
    // 4. Vérifier les derniers logs d'erreur si possible
    console.log(`\n🔍 Recommandations:`);
    
    if (totalOrders24h === 0) {
      console.log(`  • Aucun ordre créé → Vérifier les conditions de trading`);
      console.log(`  • Vérifier les seuils RSI, ADX, volatilité`);
      console.log(`  • Vérifier les price triggers et entry zones`);
    }
    
    if (totalOrders24h > 0 && totalTrades24h === 0) {
      console.log(`  • Ordres créés mais non exécutés → Vérifier l'exchange`);
      console.log(`  • Vérifier les API keys`);
      console.log(`  • Vérifier les prix et slippage`);
    }
    
    const smartAgents = activeSessions.filter(s => s.profileJson?.isIntelligent || s.isSmartAgent);
    if (smartAgents.length > 0) {
      console.log(`  • ${smartAgents.length} Smart Agent(s) actif(s) → Vérifier les opportunités disponibles`);
    }

    // 5. Test simple d'un agent
    if (activeSessions.length > 0) {
      console.log(`\n🧪 Test rapide avec agent ${activeSessions[0].id.substring(0, 8)}:`);
      const testAgent = AgentHub.get(activeSessions[0].id);
      if (testAgent) {
        try {
          // Get current market conditions
          const canTrade = await testAgent.canTrade?.() || false;
          console.log(`  🎯 Peut trader: ${canTrade}`);
          
          if (!canTrade) {
            const reasons = await testAgent.getBlockingReasons?.() || [];
            console.log(`  🚫 Raisons du blocage:`);
            reasons.forEach((reason) => {
              console.log(`    - ${reason}`);
            });
          }
        } catch (error) {
          console.log(`  ❌ Erreur test: ${error.message}`);
        }
      }
    }

  } catch (error) {
    console.error('❌ Erreur pendant le diagnostic:', error);
  } finally {
    await prisma.$disconnect();
  }
}

diagnoseNoTrades();