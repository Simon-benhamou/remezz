import pkg from '@prisma/client';
const { PrismaClient } = pkg;
const prisma = new PrismaClient();
import ccxt from 'ccxt';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('🔍 DIAGNOSTIC COMPLET - Bugs Front/Back');
  console.log('═══════════════════════════════════════════════════════════════════════');
  
  // 1. Sessions actives (avec positions)
  console.log('\n📊 SESSIONS ACTIVES (stoppedAt = null):');
  const sessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null },
    select: { 
      id: true, 
      symbol: true, 
      mode: true,
      startedAt: true,
      currentSymbol: true,
      isSmartAgent: true,
    },
    orderBy: { startedAt: 'desc' }
  });
  console.table(sessions.map(s => ({
    id: s.id.slice(0, 8),
    symbol: s.symbol,
    mode: s.mode,
    smart: s.isSmartAgent,
    startedAt: new Date(s.startedAt).toLocaleString()
  })));
  
  // 2. Positions (pas de status dans ce schema)
  console.log('\n📈 POSITIONS (toutes):');
  const positions = await prisma.position.findMany({
    include: { session: { select: { id: true, symbol: true, mode: true, stoppedAt: true } } },
    orderBy: { openedAt: 'desc' },
    take: 10
  });
  if (positions.length === 0) {
    console.log('  ➜ Aucune position en DB');
  } else {
    console.table(positions.map(p => ({
      session: p.sessionId?.slice(0, 8) || 'N/A',
      symbol: p.symbol,
      side: p.side,
      entry: p.entryPrice?.toFixed(4),
      qty: p.qty?.toFixed(4),
      sl: p.stopPrice?.toFixed(4),
      sessionActive: p.session?.stoppedAt === null ? 'YES' : 'NO'
    })));
  }
  
  // 3. Ordres récents (24h)
  console.log('\n📋 ORDRES RÉCENTS (24h):');
  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 24*60*60*1000) } },
    include: { session: { select: { symbol: true, mode: true } } },
    orderBy: { createdAt: 'desc' },
    take: 20
  });
  console.table(orders.map(o => ({
    symbol: o.session?.symbol,
    side: o.side,
    type: o.type,
    price: o.price?.toFixed(2) || 'market',
    status: o.status,
    created: new Date(o.createdAt).toLocaleTimeString()
  })));
  
  // 4. Compter SELL vs BUY des 24h
  const sellCount = orders.filter(o => o.side === 'sell').length;
  const buyCount = orders.filter(o => o.side === 'buy').length;
  console.log(`\n📊 RÉSUMÉ ORDRES 24H: ${buyCount} BUY / ${sellCount} SELL`);
  
  // 5. Trades récents avec direction
  console.log('\n💰 TRADES RÉCENTS (24h):');
  const trades = await prisma.trade.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 24*60*60*1000) } },
    include: { session: { select: { symbol: true } } },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  console.table(trades.map(t => ({
    symbol: t.session?.symbol,
    direction: t.direction,
    entry: t.entryPrice?.toFixed(4),
    exit: t.exitPrice?.toFixed(4) || 'OPEN',
    pnl: t.realizedPnlUsd?.toFixed(2) || 'N/A'
  })));
  
  // 6. Vérifier BTC vs SMA200 maintenant
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
    
    // 7. Comparer avec les positions de sessions actives
    const activePositions = positions.filter(p => p.session?.stoppedAt === null);
    if (activePositions.length > 0) {
      console.log('\n⚠️ VÉRIFICATION COHÉRENCE:');
      for (const p of activePositions) {
        const isCorrect = isBull ? p.side === 'long' : p.side === 'short';
        console.log(`  ${p.symbol}: ${p.side.toUpperCase()} ${isCorrect ? '✅ OK' : '❌ INCOHÉRENT avec régime'}`);
      }
    }
    
  } catch (e) {
    console.log('  Erreur fetch BTC:', e.message);
  }
  
  // 8. Check SessionKpi (pour win rate, pnl)
  console.log('\n📊 SESSION KPIs (sessions actives):');
  const kpis = await prisma.sessionKpi.findMany({
    where: { sessionId: { in: sessions.map(s => s.id) } }
  });
  console.table(kpis.map(k => ({
    session: k.sessionId.slice(0, 8),
    pnl: k.realizedPnlUsd?.toFixed(2),
    winRate: k.winRate?.toFixed(1) + '%'
  })));
  
  // 9. Check overview API simulation
  console.log('\n🔍 SIMULATION API OVERVIEW:');
  const sessionsWithKpis = await prisma.agentSession.findMany({
    where: { stoppedAt: null },
    include: { 
      SessionKpi: true,
      positions: true
    }
  });
  console.table(sessionsWithKpis.map(s => ({
    id: s.id.slice(0, 8),
    symbol: s.symbol,
    posCount: s.positions.length,
    pnl: s.SessionKpi?.realizedPnlUsd?.toFixed(2) || '0',
    winRate: (s.SessionKpi?.winRate?.toFixed(1) || '0') + '%'
  })));
  
  await prisma.$disconnect();
}
main().catch(console.error);
