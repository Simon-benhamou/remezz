import pkg from '@prisma/client';
const { PrismaClient } = pkg;
const prisma = new PrismaClient();

async function investigate() {
  // 1. Vérifier les sessions actives
  const sessions = await prisma.agentSession.findMany({
    where: { status: 'running' },
    select: { id: true, symbol: true, mode: true, state: true, bias: true, createdAt: true }
  });
  console.log('\n=== SESSIONS ACTIVES ===');
  console.table(sessions);
  
  // 2. Vérifier les positions ouvertes
  const positions = await prisma.position.findMany({
    where: { status: 'open' },
    include: { session: { select: { symbol: true, state: true, bias: true } } }
  });
  console.log('\n=== POSITIONS OUVERTES ===');
  if (positions.length === 0) {
    console.log('Aucune position ouverte');
  } else {
    positions.forEach(p => {
      console.log(`- ${p.session.symbol}: side=${p.side}, entry=${p.entryPrice}, qty=${p.quantity}, session_bias=${p.session.bias}`);
    });
  }
  
  // 3. Vérifier les ordres récents (dernières 24h)
  const recentOrders = await prisma.order.findMany({
    where: { 
      createdAt: { gte: new Date(Date.now() - 24*60*60*1000) }
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { session: { select: { symbol: true, state: true } } }
  });
  console.log('\n=== ORDRES RÉCENTS (24h) ===');
  recentOrders.forEach(o => {
    console.log(`- ${o.session.symbol}: side=${o.side}, type=${o.type}, status=${o.status}, price=${o.price || 'market'}`);
  });
  
  // 4. Compter les SELL vs BUY
  const sellOrders = await prisma.order.count({
    where: { 
      side: 'sell',
      createdAt: { gte: new Date(Date.now() - 24*60*60*1000) }
    }
  });
  const buyOrders = await prisma.order.count({
    where: { 
      side: 'buy',
      createdAt: { gte: new Date(Date.now() - 24*60*60*1000) }
    }
  });
  console.log(`\n=== RÉSUMÉ ORDRES 24H ===`);
  console.log(`BUY: ${buyOrders}, SELL: ${sellOrders}`);
  
  // 5. Vérifier les trades récents et leur direction
  const recentTrades = await prisma.trade.findMany({
    where: {
      createdAt: { gte: new Date(Date.now() - 24*60*60*1000) }
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { session: { select: { symbol: true } } }
  });
  console.log('\n=== TRADES RÉCENTS (24h) ===');
  recentTrades.forEach(t => {
    console.log(`- ${t.session.symbol}: direction=${t.direction}, entry=${t.entryPrice}, exit=${t.exitPrice || 'open'}, pnl=${t.realizedPnlUsd?.toFixed(2) || 'N/A'}`);
  });
  
  await prisma.$disconnect();
}
investigate().catch(console.error);
