import { prisma } from './dist/src/db/client.js';

async function diagnoseETH() {
  try {
    console.log('🔍 Diagnostic ETH - Agent créé hier\n');
    
    // 1. Trouver les sessions ETH récentes
    const sessions = await prisma.tradingSession.findMany({
      where: { crypto: 'ETH' },
      orderBy: { createdAt: 'desc' },
      take: 5
    });
    
    console.log(`📊 Sessions ETH trouvées: ${sessions.length}\n`);
    
    for (const session of sessions) {
      const age = Math.floor((Date.now() - session.createdAt.getTime()) / (1000 * 60 * 60));
      console.log(`\n🤖 Session #${session.id} - ${session.crypto}`);
      console.log(`   Créée: ${session.createdAt.toISOString()} (il y a ${age}h)`);
      console.log(`   Statut: ${session.isActive ? '✅ ACTIVE' : '❌ INACTIVE'}`);
      console.log(`   Alert Level: ${session.alertLevel}`);
      console.log(`   Strategy: ${session.strategyType || 'N/A'}`);
      console.log(`   Budget: $${session.budget}`);
      console.log(`   Leverage: ${session.leverage}x`);
      console.log(`   Current position: ${session.hasOpenPosition ? 'OUI' : 'NON'}`);
      
      // Vérifier les locks
      const now = new Date();
      if (session.entryLockedUntil && session.entryLockedUntil > now) {
        const minutesLeft = Math.ceil((session.entryLockedUntil.getTime() - now.getTime()) / (1000 * 60));
        console.log(`   ⚠️  ENTRY LOCKED jusqu'à ${session.entryLockedUntil.toISOString()} (${minutesLeft} min)`);
      }
      
      if (session.exitLockedUntil && session.exitLockedUntil > now) {
        const minutesLeft = Math.ceil((session.exitLockedUntil.getTime() - now.getTime()) / (1000 * 60));
        console.log(`   ⚠️  EXIT LOCKED jusqu'à ${session.exitLockedUntil.toISOString()} (${minutesLeft} min)`);
      }
      
      // Cooldowns
      if (session.cooldownUntil && session.cooldownUntil > now) {
        const minutesLeft = Math.ceil((session.cooldownUntil.getTime() - now.getTime()) / (1000 * 60));
        console.log(`   ⏱️  COOLDOWN actif jusqu'à ${session.cooldownUntil.toISOString()} (${minutesLeft} min)`);
        console.log(`   Raison: ${session.cooldownReason || 'N/A'}`);
      }
      
      // Dernières décisions
      const decisions = await prisma.tradingDecision.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: 'desc' },
        take: 10
      });
      
      if (decisions.length > 0) {
        console.log(`\n   📋 ${decisions.length} dernières décisions:`);
        for (const dec of decisions) {
          const ago = Math.floor((Date.now() - dec.createdAt.getTime()) / (1000 * 60));
          const status = dec.action === 'NONE' ? '⏸️ ' : dec.action === 'OPEN_LONG' || dec.action === 'OPEN_SHORT' ? '🚀' : '🔄';
          console.log(`      ${status} ${dec.action} - ${dec.createdAt.toISOString().slice(11, 19)} (il y a ${ago} min)`);
          console.log(`         Raison: ${dec.reason?.slice(0, 100) || 'N/A'}`);
          if (dec.blockReason) {
            console.log(`         ❌ BLOQUÉ: ${dec.blockReason}`);
          }
        }
      }
      
      // Positions
      const positions = await prisma.position.findMany({
        where: { sessionId: session.id },
        orderBy: { openedAt: 'desc' },
        take: 3
      });
      
      if (positions.length > 0) {
        console.log(`\n   💼 ${positions.length} positions récentes:`);
        for (const pos of positions) {
          const duration = pos.closedAt 
            ? Math.floor((pos.closedAt.getTime() - pos.openedAt.getTime()) / (1000 * 60))
            : Math.floor((Date.now() - pos.openedAt.getTime()) / (1000 * 60));
          const status = pos.status === 'OPEN' ? '🟢 OUVERTE' : pos.status === 'CLOSED' ? '🔴 FERMÉE' : pos.status;
          console.log(`      ${status} - ${pos.side} @ ${pos.entryPrice} (${duration} min)`);
          if (pos.closedAt) {
            console.log(`         P&L: ${pos.realizedPnl > 0 ? '✅' : '❌'} $${pos.realizedPnl?.toFixed(2)}`);
          }
        }
      }
      
      // Orders
      const orders = await prisma.order.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: 'desc' },
        take: 5
      });
      
      if (orders.length > 0) {
        console.log(`\n   📝 ${orders.length} derniers orders:`);
        for (const order of orders) {
          const ago = Math.floor((Date.now() - order.createdAt.getTime()) / (1000 * 60));
          console.log(`      ${order.status} - ${order.side} @ ${order.price} (il y a ${ago} min)`);
        }
      }
    }
    
    // 2. Vérifier les agents (ancien système)
    console.log('\n\n🤖 Vérification table Agent (ancien système)...');
    const agents = await prisma.agent.findMany({
      where: { symbol: { contains: 'ETH' } },
      orderBy: { updatedAt: 'desc' },
      take: 3
    });
    
    if (agents.length > 0) {
      console.log(`   Trouvé ${agents.length} agents ETH dans l'ancien système`);
      for (const agent of agents) {
        console.log(`   - ${agent.symbol}: ${agent.status}, position=${agent.position || 'NONE'}`);
      }
    } else {
      console.log('   ✅ Pas d\'agents dans l\'ancien système (normal)');
    }
    
    // 3. Logs ops récents
    console.log('\n\n📜 Recherche dans les logs ops_events...');
    const logPath = './logs/ops_events.log';
    try {
      const fs = await import('fs');
      const readline = await import('readline');
      
      const fileStream = fs.createReadStream(logPath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });
      
      const ethLogs = [];
      for await (const line of rl) {
        if (line.includes('ETH') && (
          line.includes('decision') || 
          line.includes('entry') || 
          line.includes('blocked') ||
          line.includes('cooldown') ||
          line.includes('lock')
        )) {
          ethLogs.push(line);
        }
      }
      
      if (ethLogs.length > 0) {
        console.log(`   Trouvé ${ethLogs.length} entrées de log pertinentes (dernières 20):`);
        ethLogs.slice(-20).forEach(log => {
          console.log(`   ${log.slice(0, 200)}`);
        });
      } else {
        console.log('   Aucune entrée de log trouvée');
      }
    } catch (err) {
      console.log(`   ⚠️  Impossible de lire les logs: ${err.message}`);
    }
    
  } catch (error) {
    console.error('❌ Erreur:', error);
  } finally {
    await prisma.$disconnect();
  }
}

diagnoseETH();
