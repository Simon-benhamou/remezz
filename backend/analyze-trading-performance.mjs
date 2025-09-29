#!/usr/bin/env node

import { PrismaClient } from '@prisma/client';
import { getTicker } from './src/data/market.js';
import { getBestIntelligentOpportunity } from './src/services/intelligentAgent.js';

const prisma = new PrismaClient();

async function analyzeLast24Hours() {
  console.log('🔍 Analyse des performances trading des dernières 24h...\n');

  // 1. Analyser les ordres des dernières 24h
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  const orders = await prisma.order.findMany({
    where: {
      createdAt: {
        gte: yesterday
      }
    },
    orderBy: { createdAt: 'desc' },
    include: {
      session: true
    }
  });

  console.log(`📊 Nombre d'ordres des dernières 24h: ${orders.length}`);
  
  // Grouper par symbole
  const symbolStats = {};
  orders.forEach(order => {
    if (!symbolStats[order.symbol]) {
      symbolStats[order.symbol] = { orders: 0, pnl: 0 };
    }
    symbolStats[order.symbol].orders++;
    if (order.pctChange) {
      symbolStats[order.symbol].pnl += parseFloat(order.pctChange);
    }
  });

  console.log('\n📈 Stats par symbole:');
  Object.entries(symbolStats).forEach(([symbol, stats]) => {
    console.log(`  ${symbol}: ${stats.orders} ordres, PnL: ${stats.pnl.toFixed(3)}%`);
  });

  // 2. Analyser les sessions actives
  const activeSessions = await prisma.agentSession.findMany({
    where: {
      stoppedAt: null,
      OR: [
        { isSmartAgent: true }
      ]
    }
  });

  console.log(`\n🤖 Sessions intelligentes actives: ${activeSessions.length}`);
  activeSessions.forEach(session => {
    console.log(`  - ${session.symbol} (${session.id.slice(-8)}): ${session.isSmartAgent ? 'Smart' : 'Intelligent'}`);
  });

  // 3. Tester la sélection d'opportunités actuellement
  console.log('\n🎯 Test de sélection d\'opportunités...');
  try {
    const opportunity = await getBestIntelligentOpportunity();
    if (opportunity) {
      console.log(`✅ Opportunité trouvée: ${opportunity.symbol}`);
      console.log(`   Score: ${opportunity.finalScore}`);
      console.log(`   Confiance: ${opportunity.confidence}`);
      console.log(`   Projection: ${opportunity.projectedReturn}`);
    } else {
      console.log('❌ Aucune opportunité trouvée');
    }
  } catch (error) {
    console.error('❌ Erreur lors du test d\'opportunité:', error.message);
  }

  // 4. Analyser les performances crypto majeures
  console.log('\n📊 Analyse des cryptos majeures...');
  const majorCryptos = ['BTC/USDT', 'XRP/USDT', 'SOL/USDT', 'ETH/USDT'];
  
  for (const symbol of majorCryptos) {
    try {
      const ticker = await getTicker(symbol);
      if (ticker) {
        const change24h = ticker.percentage || 0;
        const volume = ticker.quoteVolume || 0;
        console.log(`  ${symbol}: ${change24h > 0 ? '+' : ''}${change24h.toFixed(2)}%, Volume: $${(volume/1000000).toFixed(1)}M`);
        
        // Vérifier si ce symbole a des ordres
        const symbolOrders = orders.filter(o => o.symbol === symbol);
        console.log(`    Ordres: ${symbolOrders.length}`);
      }
    } catch (error) {
      console.log(`    ${symbol}: Erreur récupération données`);
    }
  }

  // 5. Analyser les logs récents
  console.log('\n📋 Recherche des logs récents...');
  const recentLogs = await prisma.sessionKpi.findMany({
    where: {
      createdAt: {
        gte: yesterday
      },
      OR: [
        { key: { contains: 'opportunity' } },
        { key: { contains: 'agent' } },
        { key: { contains: 'selection' } }
      ]
    },
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  recentLogs.forEach(log => {
    console.log(`  ${log.createdAt.toISOString()}: ${log.key} = ${log.value}`);
  });

  await prisma.$disconnect();
}

// Exécuter l'analyse
analyzeLast24Hours().catch(console.error);