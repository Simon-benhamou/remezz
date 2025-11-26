import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('🔍 INVESTIGATION PROFONDE V2');
  console.log('═══════════════════════════════════════════════════════════════════════\n');
  
  // 1. Toutes les positions
  const positions = await prisma.position.findMany({
    include: { session: { select: { symbol: true, userId: true } } },
    orderBy: { openedAt: 'desc' }
  });
  
  console.log('📈 TOUTES LES POSITIONS:');
  console.table(positions.map(p => ({
    id: p.id,
    session: p.sessionId,
    symbol: p.symbol || p.session?.symbol,
    side: p.side,
    entry: p.entryPrice?.toFixed(4),
    qty: p.qty?.toFixed(4),
    sl: p.stopLoss?.toFixed(4),
    openedAt: p.openedAt?.toLocaleString()
  })));
  
  // 2. Tous les ordres
  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: sevenDaysAgo } },
    include: { session: { select: { symbol: true } } },
    orderBy: { createdAt: 'asc' }
  });
  
  console.log('\n📋 TOUS LES ORDRES (7 jours):');
  console.table(orders.map(o => ({
    id: o.id,
    symbol: o.symbol || o.session?.symbol,
    side: o.side,
    type: o.type,
    qty: o.qty?.toFixed(4),
    price: o.price?.toFixed(2),
    status: o.status,
    created: o.createdAt?.toLocaleString()
  })));
  
  // 3. Tous les fills - utiliser ts au lieu de createdAt
  const fills = await prisma.fill.findMany({
    where: { ts: { gte: sevenDaysAgo } },
    include: { 
      session: { select: { symbol: true } },
      order: { select: { id: true, side: true, type: true } }
    },
    orderBy: { ts: 'asc' }
  });
  
  console.log('\n📝 TOUS LES FILLS (7 jours):');
  console.table(fills.map(f => ({
    id: f.id,
    orderId: f.orderId,
    orderSide: f.order?.side,
    symbol: f.symbol || f.session?.symbol,
    side: f.side,
    qty: f.qty?.toFixed(4),
    price: f.price?.toFixed(4),
    pnl: f.realizedPnl?.toFixed(2),
    ts: f.ts?.toLocaleString()
  })));
  
  // 4. Analyse de cohérence
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('🔎 ANALYSE DE COHÉRENCE');
  console.log('═══════════════════════════════════════════════════════════════════════\n');
  
  const buyOrders = orders.filter(o => o.side === 'buy');
  const sellOrders = orders.filter(o => o.side === 'sell');
  const buyFills = fills.filter(f => f.side === 'buy');
  const sellFills = fills.filter(f => f.side === 'sell');
  
  console.log(`📊 ORDRES: ${buyOrders.length} BUY, ${sellOrders.length} SELL`);
  console.log(`📊 FILLS: ${buyFills.length} BUY, ${sellFills.length} SELL`);
  console.log(`📊 POSITIONS: ${positions.length} ouvertes\n`);
  
  // 5. Pour chaque position, trouver les ordres/fills correspondants
  console.log('🔍 MATCHING POSITIONS <-> ORDERS:\n');
  for (const pos of positions) {
    const symbol = pos.symbol || pos.session?.symbol;
    console.log(`Position ${symbol} ${pos.side.toUpperCase()} @ ${pos.entryPrice?.toFixed(4)}:`);
    
    // Chercher ordre d'entrée (buy pour long, sell pour short)
    const entrySide = pos.side === 'long' ? 'buy' : 'sell';
    const entryOrders = orders.filter(o => 
      (o.symbol === symbol || o.session?.symbol === symbol) &&
      o.side === entrySide &&
      o.status === 'filled'
    );
    console.log(`  → Ordres ${entrySide}: ${entryOrders.length}`);
    entryOrders.forEach(o => console.log(`    - ${o.id} @ ${o.price?.toFixed(4)} qty ${o.qty?.toFixed(4)}`));
    
    if (entryOrders.length === 0) {
      console.log(`  ⚠️ PROBLÈME: Aucun ordre d'entrée trouvé!`);
    }
  }
  
  // 6. Ordres sans position correspondante
  console.log('\n🔍 ORDRES SELL SANS POSITION LONG CORRESPONDANTE:\n');
  for (const order of sellOrders) {
    const symbol = order.symbol || order.session?.symbol;
    const matchingPos = positions.find(p => 
      (p.symbol === symbol || p.session?.symbol === symbol) &&
      p.side === 'long'
    );
    if (!matchingPos) {
      console.log(`  SELL ${symbol} qty ${order.qty?.toFixed(4)} @ ${order.price?.toFixed(2)} - PAS DE POSITION LONG`);
      console.log(`    → Ce sont probablement des EXIT d'anciennes positions`);
    }
  }
  
  // 7. Sessions actives
  const sessions = await prisma.agentSession.findMany({
    where: { endedAt: null },
    select: { id: true, symbol: true, mode: true, createdAt: true }
  });
  
  console.log('\n📌 SESSIONS ACTIVES:');
  console.table(sessions.map(s => ({
    id: s.id,
    symbol: s.symbol,
    mode: s.mode,
    created: s.createdAt?.toLocaleString()
  })));
  
  await prisma.$disconnect();
}

main().catch(console.error);
