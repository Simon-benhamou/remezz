#!/usr/bin/env node

import pkg from '@prisma/client';
const { PrismaClient } = pkg;
const prisma = new PrismaClient();

async function checkPositions() {
  const pos = await prisma.position.findMany({
    where: {
      symbol: { in: ['ETH/USDT', 'AVAX/USDT', 'DOGE/USDT', 'ETH/USDT:USDT', 'AVAX/USDT:USDT', 'DOGE/USDT:USDT'] }
    },
    orderBy: { openedAt: 'desc' },
    take: 15,
    include: { session: { select: { id: true, symbol: true, mode: true } } }
  });

  console.log('\n=== RECENT POSITIONS (ETH, AVAX, DOGE) ===');
  console.log(`Found ${pos.length} positions\n`);
  
  for (const p of pos) {
    const pnl = p.unrealizedPnl || 0;
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    console.log(`${p.symbol.padEnd(15)} ${p.side.padEnd(5)} | Entry: $${p.entryPrice?.toFixed(4)} | Mark: $${p.markPrice?.toFixed(4)} | PnL: ${pnlStr.padEnd(10)} | Mode: ${p.session?.mode}`);
  }
  
  const losses = pos.filter(p => (p.unrealizedPnl || 0) < 0);
  console.log(`\n${losses.length} positions with losses`);
  
  await prisma.$disconnect();
}

checkPositions().catch(console.error);
