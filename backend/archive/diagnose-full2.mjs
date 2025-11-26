import pkg from '@prisma/client';
const { PrismaClient } = pkg;
const prisma = new PrismaClient();
import ccxt from 'ccxt';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('🔍 DIAGNOSTIC COMPLET - Bugs Front/Back');
  console.log('═══════════════════════════════════════════════════════════════════════');
  
  // 1. Sessions actives
  console.log('\n📊 SESSIONS ACTIVES:');
  const sessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null },
    select: { 
      id: true, 
      symbol: true, 
      mode: true,
      startedAt: true,
    },
    orderBy: { startedAt: 'desc' }
  });
  console.table(sessions.map(s => ({
    id: s.id.slice(0, 8),
    symbol: s.symbol,
    mode: s.mode,
    startedAt: new Date(s.startedAt).toLocaleString()
  })));
  
  // 2. Positions
  console.log('\n📈 POSITIONS:');
  const positions = await prisma.position.findMany({
    include: { session: { select: { id: true, symbol: true, stoppedAt: true } } },
    orderBy: { openedAt: 'desc' },
    take: 10
  });
  console.table(positions.map(p => ({
    session: p.sessionId?.slice(0, 8) || 'N/A',
    symbol: p.symbol,
    side: p.side,
    entry: p.entryPrice?.toFixed(4),
    qty: p.qty?.toFixed(4),
    sl: p.stopPrice?.toFixed(4),
    sessionActive: p.session?.stoppedAt === null ? 'YES' : 'NO'
  })));
  
  // 3. TOUS les ordres récents (48h) pour voir pattern
  console.log('\n📋 TOUS LES ORDRES (48h) - pour comprendre les SELL:');
  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 48*60*60*1000) } },
    include: { session: { select: { symbol: true, mode: true } } },
    orderBy: { createdAt: 'desc' },
    take: 30
  });
  
  // Group by symbol pour voir le pattern
  const ordersBySymbol = {};
  for (const o of orders) {
    const sym = o.session?.symbol || 'unknown';
    if (!ordersBySymbol[sym]) ordersBySymbol[sym] = [];
    ordersBySymbol[sym].push({
      side: o.side,
      type: o.type,
      price: o.price?.toFixed(2),
      status: o.status,
      time: new Date(o.createdAt).toLocaleTimeString()
    });
  }
  for (const [sym, ords] of Object.entries(ordersBySymbol)) {
    console.log(`\n  ${sym}:`);
    console.table(ords);
  }
  
  // 4. Résumé des ordres
  const sellCount = orders.filter(o => o.side === 'sell').length;
  const buyCount = orders.filter(o => o.side === 'buy').length;
  console.log(`\n📊 RÉSUMÉ ORDRES 48H: ${buyCount} BUY / ${sellCount} SELL`);
  
  // 5. Vérifier BTC vs SMA200
  console.log('\n🔸 CHECK BTC REGIME:');
  try {
    const exchange = new ccxt.binance({ enableRateLimit: true });
    const btcOhlcv = await exchange.fetchOHLCV('BTC/USDT', '15m', undefined, 250);
    const btcCloses = btcOhlcv.map(c => c[4]);
    const btcNow = btcCloses[btcCloses.length - 1];
    const sma200 = btcCloses.slice(-200).reduce((a, b) => a + b, 0) / 200;
    const isBull = btcNow > sma200;
    console.log(`  BTC: $${btcNow.toFixed(0)}`);
    console.log(`  SMA200: $${sma200.toFixed(0)}`);
    console.log(`  REGIME: ${isBull ? '🐂 BULL (LONG seulement)' : '🐻 BEAR (SHORT seulement)'}`);
    
  } catch (e) {
    console.log('  Erreur fetch BTC:', e.message);
  }
  
  // 6. Fills récents
  console.log('\n📝 FILLS RÉCENTS:');
  const fills = await prisma.fill.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 48*60*60*1000) } },
    include: { session: { select: { symbol: true } } },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  console.table(fills.map(f => ({
    symbol: f.session?.symbol,
    side: f.side,
    price: f.price?.toFixed(4),
    qty: f.qty?.toFixed(4),
    time: new Date(f.createdAt).toLocaleTimeString()
  })));
  
  // 7. Check model schema
  console.log('\n📋 Tables dans Prisma:');
  console.log('  Position, Order, Fill, AgentSession, SessionKpi');
  
  await prisma.$disconnect();
}
main().catch(console.error);
