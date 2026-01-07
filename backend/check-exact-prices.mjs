import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Get exact entry prices from DB
const trades = await prisma.trade.findMany({
  where: {
    symbol: { in: ['SEI/USDT:USDT', 'ADA/USDT:USDT'] },
    exitTs: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
  },
  orderBy: { entryTs: 'desc' }
});

console.log('Trades with exact entry prices:\n');
console.log('Symbol | Side  | Entry Time               | Entry Price (exact) | DB value');
console.log('─'.repeat(90));

for (const t of trades) {
  const sym = t.symbol.replace('/USDT:USDT', '');
  // Show raw entry price without formatting
  console.log(`${sym.padEnd(6)} | ${t.positionSide.padEnd(5)} | ${t.entryTs.toISOString()} | $${t.entryPrice} | ${JSON.stringify(t.entryPrice)}`);
}

await prisma.$disconnect();
