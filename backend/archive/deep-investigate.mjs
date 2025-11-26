import pkg from '@prisma/client';
const { PrismaClient } = pkg;
const prisma = new PrismaClient();

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('🔍 INVESTIGATION PROFONDE - Incohérence Orders/Positions');
  console.log('═══════════════════════════════════════════════════════════════════════');
  
  // 1. TOUTES les positions (pas juste 10)
  console.log('\n📈 TOUTES LES POSITIONS:');
  const positions = await prisma.position.findMany({
    include: { session: { select: { id: true, symbol: true, stoppedAt: true } } },
    orderBy: { openedAt: 'desc' },
  });
  console.table(positions.map(p => ({
    id: p.id.slice(0, 8),
    session: p.sessionId?.slice(0, 8),
    symbol: p.symbol,
    side: p.side,
    entry: p.entryPrice?.toFixed(4),
    qty: p.qty?.toFixed(4),
    sl: p.stopPrice?.toFixed(4),
    openedAt: p.openedAt?.toLocaleString()
  })));
  
  // 2. TOUS les ordres (7 derniers jours)
  console.log('\n📋 TOUS LES ORDRES (7 jours):');
  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 7*24*60*60*1000) } },
    include: { session: { select: { symbol: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.table(orders.map(o => ({
    id: o.id.slice(0, 8),
    symbol: o.session?.symbol,
    side: o.side,
    type: o.type,
    qty: o.qty?.toFixed(4),
    price: o.price?.toFixed(2),
    status: o.status,
    created: new Date(o.createdAt).toLocaleString()
  })));
  
  // 3. TOUS les fills (7 derniers jours)
  console.log('\n📝 TOUS LES FILLS (7 jours):');
  const fills = await prisma.fill.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 7*24*60*60*1000) } },
    include: { session: { select: { symbol: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.table(fills.map(f => ({
    id: f.id.slice(0, 8),
    symbol: f.session?.symbol,
    side: f.side,
    qty: f.qty?.toFixed(4),
    price: f.price?.toFixed(4),
    created: new Date(f.createdAt).toLocaleString()
  })));
  
  // 4. Analyse par session
  console.log('\n📊 ANALYSE PAR SESSION:');
  const sessionIds = [...new Set([...positions.map(p => p.sessionId), ...orders.map(o => o.sessionId)])].filter(Boolean);
  
  for (const sid of sessionIds) {
    const sessionOrders = orders.filter(o => o.sessionId === sid);
    const sessionFills = fills.filter(f => f.sessionId === sid);
    const sessionPositions = positions.filter(p => p.sessionId === sid);
    
    const buyOrders = sessionOrders.filter(o => o.side === 'buy').length;
    const sellOrders = sessionOrders.filter(o => o.side === 'sell').length;
    const buyFills = sessionFills.filter(f => f.side === 'buy').length;
    const sellFills = sessionFills.filter(f => f.side === 'sell').length;
    
    const symbol = sessionOrders[0]?.session?.symbol || sessionPositions[0]?.symbol || 'unknown';
    
    console.log(`\n  Session ${sid?.slice(0, 8)} (${symbol}):`);
    console.log(`    Positions: ${sessionPositions.length}`);
    console.log(`    Orders: ${buyOrders} BUY / ${sellOrders} SELL`);
    console.log(`    Fills: ${buyFills} BUY / ${sellFills} SELL`);
    
    if (sessionPositions.length > 0 && buyOrders === 0 && buyFills === 0) {
      console.log(`    ⚠️ INCOHÉRENCE: Position sans ordre/fill BUY!`);
    }
  }
  
  // 5. Résumé global
  const totalBuyOrders = orders.filter(o => o.side === 'buy').length;
  const totalSellOrders = orders.filter(o => o.side === 'sell').length;
  const totalBuyFills = fills.filter(f => f.side === 'buy').length;
  const totalSellFills = fills.filter(f => f.side === 'sell').length;
  
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('📊 RÉSUMÉ GLOBAL (7 jours):');
  console.log(`  Positions: ${positions.length}`);
  console.log(`  Orders: ${totalBuyOrders} BUY / ${totalSellOrders} SELL`);
  console.log(`  Fills: ${totalBuyFills} BUY / ${totalSellFills} SELL`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  
  await prisma.$disconnect();
}
main().catch(console.error);
