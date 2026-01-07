import { PrismaClient } from '@prisma/client';

// Get the backtest service
const runBacktest = async () => {
  console.log('='.repeat(100));
  console.log('BACKTEST WITH $300 CAPITAL - Same period as Live trades');
  console.log('Period: Jan 4-6, 2026');
  console.log('='.repeat(100));

  // First, let's get the live trades period
  const prisma = new PrismaClient();

  const liveTrades = await prisma.trade.findMany({
    where: {
      session: { mode: 'live' },
      entryTs: {
        gte: new Date('2026-01-04T00:00:00Z'),
        lte: new Date('2026-01-06T23:59:59Z')
      }
    },
    orderBy: { entryTs: 'asc' }
  });

  console.log(`\nLive trades in period: ${liveTrades.length}`);

  if (liveTrades.length > 0) {
    const firstEntry = liveTrades[0].entryTs;
    const lastExit = liveTrades[liveTrades.length - 1].exitTs;
    console.log(`First entry: ${firstEntry.toISOString()}`);
    console.log(`Last exit: ${lastExit.toISOString()}`);
  }

  // Calculate live stats
  const liveWins = liveTrades.filter(t => t.pctChange > 0).length;
  const liveLosses = liveTrades.filter(t => t.pctChange <= 0).length;
  const liveWinRate = liveTrades.length > 0 ? (liveWins / liveTrades.length * 100).toFixed(1) : 0;
  const liveTotalPnl = liveTrades.reduce((sum, t) => sum + (t.pctChange || 0), 0);
  const liveAvgPnl = liveTrades.length > 0 ? (liveTotalPnl / liveTrades.length).toFixed(2) : 0;

  console.log(`\n--- LIVE STATS ($300 capital) ---`);
  console.log(`Trades: ${liveTrades.length}`);
  console.log(`Wins: ${liveWins} | Losses: ${liveLosses}`);
  console.log(`Win Rate: ${liveWinRate}%`);
  console.log(`Avg PnL per trade: ${liveAvgPnl}%`);
  console.log(`Total PnL sum: ${liveTotalPnl.toFixed(2)}%`);

  // Calculate estimated final capital
  let liveCapital = 300;
  for (const t of liveTrades) {
    liveCapital *= (1 + (t.pctChange || 0) / 100);
  }
  console.log(`Estimated final capital: $${liveCapital.toFixed(2)}`);
  console.log(`ROI: ${((liveCapital - 300) / 300 * 100).toFixed(2)}%`);

  // List all live trades
  console.log('\n--- LIVE TRADES DETAIL ---');
  for (const t of liveTrades) {
    console.log(`  ${t.symbol.replace('/USDT:USDT', '')}: ${t.pctChange?.toFixed(2)}% (${t.exitReason})`);
  }

  await prisma.$disconnect();

  console.log('\n' + '='.repeat(100));
  console.log('To run backtest, use the API endpoint or CLI:');
  console.log('POST /api/backtest with:');
  console.log(JSON.stringify({
    startDate: '2026-01-04',
    endDate: '2026-01-06',
    capital: 300,
    symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT', 'ADA/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT', 'UNI/USDT', 'BCH/USDT', 'APT/USDT', 'IMX/USDT', 'SEI/USDT', 'SUI/USDT']
  }, null, 2));
  console.log('='.repeat(100));
};

runBacktest().catch(console.error);
