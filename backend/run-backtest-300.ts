import { runBacktest } from './src/services/backtestService';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('='.repeat(100));
  console.log('BACKTEST WITH $300 CAPITAL');
  console.log('Period: Jan 4-6, 2026 (same as live trades)');
  console.log('='.repeat(100));

  const symbols = [
    'BTC/USDT:USDT',
    'SOL/USDT:USDT',
    'XRP/USDT:USDT',
    'DOGE/USDT:USDT',
    'ADA/USDT:USDT',
    'AVAX/USDT:USDT',
    'LINK/USDT:USDT',
    'DOT/USDT:USDT',
    'UNI/USDT:USDT',
    'BCH/USDT:USDT',
    'APT/USDT:USDT',
    'IMX/USDT:USDT',
    'SEI/USDT:USDT',
    'SUI/USDT:USDT'
  ];

  const result = await runBacktest({
    startDate: new Date('2026-01-04T00:00:00Z'),
    endDate: new Date('2026-01-06T23:59:59Z'),
    initialCapital: 300,
    symbols,
    leverage: 4,
  });

  const s = result.summary;

  console.log('\n--- BACKTEST RESULTS ---');
  console.log(`Total trades: ${s.totalTrades}`);
  console.log(`Wins: ${s.wins} | Losses: ${s.losses}`);
  console.log(`Win Rate: ${s.winRate.toFixed(1)}%`);
  console.log(`Final Capital: $${s.finalCapital.toFixed(2)}`);
  console.log(`ROI: ${s.totalPnlPct.toFixed(2)}%`);
  console.log(`Max Drawdown: ${s.maxDrawdownPct.toFixed(2)}%`);
  console.log(`Sharpe Ratio: ${s.sharpeRatio.toFixed(2)}`);
  console.log(`Profit Factor: ${s.profitFactor.toFixed(2)}`);

  // Compare with live
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

  const liveWins = liveTrades.filter(t => (t.pctChange ?? 0) > 0).length;
  const liveLosses = liveTrades.filter(t => (t.pctChange ?? 0) <= 0).length;
  const liveWinRate = liveTrades.length > 0 ? (liveWins / liveTrades.length * 100) : 0;
  let liveCapital = 300;
  for (const t of liveTrades) {
    liveCapital *= (1 + (t.pctChange || 0) / 100);
  }
  const liveROI = ((liveCapital - 300) / 300 * 100);

  console.log('\n' + '='.repeat(100));
  console.log('COMPARISON: BACKTEST vs LIVE');
  console.log('='.repeat(100));
  console.log('');
  console.log('                    BACKTEST      LIVE');
  console.log(`Trades:             ${s.totalTrades.toString().padStart(8)}      ${liveTrades.length}`);
  console.log(`Wins:               ${s.wins.toString().padStart(8)}      ${liveWins}`);
  console.log(`Losses:             ${s.losses.toString().padStart(8)}      ${liveLosses}`);
  console.log(`Win Rate:           ${s.winRate.toFixed(1).padStart(7)}%      ${liveWinRate.toFixed(1)}%`);
  console.log(`Final Capital:      $${s.finalCapital.toFixed(2).padStart(7)}      $${liveCapital.toFixed(2)}`);
  console.log(`ROI:                ${s.totalPnlPct.toFixed(2).padStart(7)}%      ${liveROI.toFixed(2)}%`);

  // List backtest trades by symbol
  console.log('\n--- BACKTEST TRADES DETAIL ---');
  for (const t of result.trades) {
    const symbol = t.symbol.replace('/USDT:USDT', '');
    const entryDate = new Date(t.entryTime);
    console.log(`  ${symbol.padEnd(5)}: ${t.netPnlPct >= 0 ? '+' : ''}${t.netPnlPct.toFixed(2)}% (${t.exitReason.padEnd(15)}) @ ${entryDate.toLocaleString()}`);
  }

  // Live trades detail
  console.log('\n--- LIVE TRADES DETAIL ---');
  for (const t of liveTrades) {
    const symbol = t.symbol.replace('/USDT:USDT', '');
    const pnl = t.pctChange ?? 0;
    console.log(`  ${symbol.padEnd(5)}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}% (${(t.exitReason || 'unknown').padEnd(15)}) @ ${t.entryTs.toLocaleString()}`);
  }

  // Analysis
  console.log('\n' + '='.repeat(100));
  console.log('ANALYSIS');
  console.log('='.repeat(100));

  const btWinRate = s.winRate;
  const liveWR = liveWinRate;
  const winRateDiff = btWinRate - liveWR;

  console.log(`\nWin Rate Difference: ${winRateDiff > 0 ? '+' : ''}${winRateDiff.toFixed(1)}% (Backtest ${winRateDiff > 0 ? 'better' : 'worse'})`);
  console.log(`ROI Difference: ${(s.totalPnlPct - liveROI) > 0 ? '+' : ''}${(s.totalPnlPct - liveROI).toFixed(2)}% (Backtest ${s.totalPnlPct > liveROI ? 'better' : 'worse'})`);

  if (s.totalPnlPct > 0 && liveROI < 0) {
    console.log('\n⚠️  Backtest is PROFITABLE but Live is at LOSS');
    console.log('   This suggests execution/timing differences are causing the divergence');
  } else if (s.totalPnlPct > 0 && liveROI > 0) {
    console.log('\n✅ Both Backtest and Live are PROFITABLE');
  } else if (s.totalPnlPct < 0 && liveROI < 0) {
    console.log('\n⚠️  Both Backtest and Live are at LOSS in this period');
    console.log('   This period may simply be unfavorable market conditions');
  }

  await prisma.$disconnect();
}

main().catch(console.error);
