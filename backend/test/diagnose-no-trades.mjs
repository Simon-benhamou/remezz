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

    // 2. Analyser chaque session active
    for (const session of activeSessions) {
      console.log(`\n🔍 Analyse session ${session.id.substring(0, 8)} (${session.symbol}):`);
      
      // Check agent hub
      const agent = AgentHub.get(session.id);
      if (!agent) {
        console.log('  ❌ Agent non trouvé dans AgentHub');
        continue;
      }

      console.log(`  ✅ Agent actif dans hub`);
      
      // Check agent state
      try {
        const state = agent.state;
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
          console.log(`  🎯 Signal trading: ${diagnostics.tradingSignal || 'neutral'}`);
          console.log(`  📈 Market triggers: ${diagnostics.marketTriggers?.overall || 'unknown'}`);
          console.log(`  💭 Trade vibes: ${diagnostics.tradeVibes?.overall || 'unknown'}`);
          
          if (diagnostics.blockers && diagnostics.blockers.length > 0) {
            console.log(`  🚫 Blockers:`);
            diagnostics.blockers.forEach((blocker) => {
              console.log(`    - ${blocker.reason || blocker}`);
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