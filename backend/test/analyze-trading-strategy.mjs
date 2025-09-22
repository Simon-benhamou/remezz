#!/usr/bin/env node

/**
 * Analyse de la stratégie de trading pour identifier les problèmes
 * et proposer des améliorations
 */

import { prisma } from '../dist/db/client.js';

async function analyzeTradingStrategy() {
  console.log('📊 Analyse de la stratégie de trading...\n');

  try {
    // 1. Analyser les derniers trades
    const recentOrders = await prisma.order.findMany({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Dernières 24h
        },
        status: 'filled'
      },
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    console.log(`🎯 ${recentOrders.length} trades exécutés dans les dernières 24h\n`);

    // 2. Analyser les patterns de trading
    const tradesBySession = {};
    const tradePairs = [];

    for (const order of recentOrders) {
      if (!tradesBySession[order.sessionId]) {
        tradesBySession[order.sessionId] = [];
      }
      tradesBySession[order.sessionId].push(order);
    }

    // 3. Analyser chaque session
    for (const [sessionId, orders] of Object.entries(tradesBySession)) {
      console.log(`\n📈 Session ${sessionId.substring(0, 8)}... (${orders.length} trades):`);
      
      // Trier par timestamp
      orders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      
      // Détecter les paires entry/exit
      for (let i = 0; i < orders.length - 1; i++) {
        const entry = orders[i];
        const exit = orders[i + 1];
        
        // Vérifier si c'est une paire entry/exit
        if (entry.side !== exit.side && 
            Math.abs(entry.qty - exit.qty) < 0.01 &&
            entry.symbol === exit.symbol) {
          
          const duration = new Date(exit.createdAt) - new Date(entry.createdAt);
          const durationMinutes = duration / (1000 * 60);
          
          // Calculer le P&L approximatif
          const entryPrice = entry.price;
          const exitPrice = exit.price;
          const pnlPct = entry.side === 'buy' 
            ? ((exitPrice - entryPrice) / entryPrice) * 100
            : ((entryPrice - exitPrice) / entryPrice) * 100;
          
          tradePairs.push({
            sessionId,
            symbol: entry.symbol,
            side: entry.side,
            qty: entry.qty,
            entryPrice,
            exitPrice,
            duration: durationMinutes,
            pnlPct,
            entryTime: entry.createdAt,
            exitTime: exit.createdAt,
            slippage: entry.slippageBps || 0
          });

          console.log(`  💼 Trade: ${entry.side.toUpperCase()} ${entry.symbol}`);
          console.log(`     ⏱️  Durée: ${durationMinutes.toFixed(1)} minutes`);
          console.log(`     💰 P&L: ${pnlPct.toFixed(2)}%`);
          console.log(`     📉 Slippage: ${(entry.slippageBps || 0).toFixed(1)} bps`);
          console.log(`     🎯 Entry: $${entryPrice} → Exit: $${exitPrice}`);
        }
      }
    }

    // 4. Statistiques globales
    console.log(`\n\n📊 ANALYSE GLOBALE (${tradePairs.length} trades complets):`);
    
    if (tradePairs.length > 0) {
      const avgDuration = tradePairs.reduce((sum, t) => sum + t.duration, 0) / tradePairs.length;
      const avgPnl = tradePairs.reduce((sum, t) => sum + t.pnlPct, 0) / tradePairs.length;
      const winRate = tradePairs.filter(t => t.pnlPct > 0).length / tradePairs.length * 100;
      const avgSlippage = tradePairs.reduce((sum, t) => sum + Math.abs(t.slippage), 0) / tradePairs.length;
      
      console.log(`   ⏱️  Durée moyenne: ${avgDuration.toFixed(1)} minutes`);
      console.log(`   💰 P&L moyen: ${avgPnl.toFixed(2)}%`);
      console.log(`   🎯 Win rate: ${winRate.toFixed(1)}%`);
      console.log(`   📉 Slippage moyen: ${avgSlippage.toFixed(1)} bps`);

      // 5. Problèmes identifiés
      console.log(`\n\n🚨 PROBLÈMES IDENTIFIÉS:`);
      
      const shortTrades = tradePairs.filter(t => t.duration < 2); // Moins de 2 minutes
      if (shortTrades.length > 0) {
        console.log(`   ⚡ ${shortTrades.length} trades trop courts (< 2 min) - ${(shortTrades.length/tradePairs.length*100).toFixed(1)}%`);
      }
      
      const highSlippageTrades = tradePairs.filter(t => Math.abs(t.slippage) > 5);
      if (highSlippageTrades.length > 0) {
        console.log(`   📉 ${highSlippageTrades.length} trades avec slippage élevé (> 5 bps) - ${(highSlippageTrades.length/tradePairs.length*100).toFixed(1)}%`);
      }
      
      const losingTrades = tradePairs.filter(t => t.pnlPct < 0);
      if (losingTrades.length > tradePairs.length / 2) {
        console.log(`   📉 Plus de 50% de trades perdants (${(losingTrades.length/tradePairs.length*100).toFixed(1)}%)`);
      }

      if (avgDuration < 5) {
        console.log(`   ⏱️  Durée moyenne trop courte (${avgDuration.toFixed(1)} min) - risque de over-trading`);
      }

      // 6. Recommandations
      console.log(`\n\n💡 RECOMMANDATIONS:`);
      
      if (avgDuration < 5) {
        console.log(`   🎯 Augmenter le minimum hold time à 5-10 minutes`);
      }
      
      if (avgSlippage > 3) {
        console.log(`   📉 Réduire la taille des positions ou utiliser des ordres limit`);
      }
      
      if (winRate < 55) {
        console.log(`   🎯 Améliorer les critères d'entrée - win rate trop faible`);
      }
      
      if (shortTrades.length > tradePairs.length * 0.3) {
        console.log(`   ⏱️  Implémenter un cool-down entre trades (2-5 minutes minimum)`);
      }

      console.log(`   📊 Ajouter plus de filtres de qualité technique avant l'entrée`);
      console.log(`   🎯 Vérifier les niveaux de support/résistance avant trade`);
    }

    // 7. Vérifier les sessions actives
    console.log(`\n\n🔍 SESSIONS ACTIVES:`);
    const activeSessions = await prisma.agentSession.findMany({
      where: { stoppedAt: null },
      select: { 
        id: true, 
        symbol: true, 
        mode: true, 
        startedAt: true,
        isSmartAgent: true
      },
      orderBy: { startedAt: 'desc' }
    });

    console.log(`   📊 ${activeSessions.length} sessions actives:`);
    for (const session of activeSessions) {
      const uptime = new Date() - new Date(session.startedAt);
      const uptimeHours = uptime / (1000 * 60 * 60);
      console.log(`     • ${session.id.substring(0, 8)}... - ${session.symbol} (${session.mode}) - ${uptimeHours.toFixed(1)}h ${session.isSmartAgent ? '🤖 AUTO' : '👤 MANUAL'}`);
    }

  } catch (error) {
    console.error('❌ Erreur lors de l\'analyse:', error);
  } finally {
    await prisma.$disconnect();
  }
}

analyzeTradingStrategy();