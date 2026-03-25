import { runBacktest } from '../src/services/backtestService.js';
import { preloadMarkets } from '../src/exchange/ccxtClient.js';
async function main() {
  await preloadMarkets();
  const result = await runBacktest({
    startDate: new Date('2026-02-07T00:00:00.000Z'),
    endDate: new Date('2026-02-09T23:59:59.000Z'),
    initialCapital: 2000,
    symbols: ['IMX/USDT:USDT','AVAX/USDT:USDT','SEI/USDT:USDT','ADA/USDT:USDT','DOT/USDT:USDT','DOGE/USDT:USDT','BTC/USDT:USDT'],
    leverage: 4.5,
  });
  console.log('=== TRADE DETAILS ===');
  for (const t of result.trades) {
    console.log(JSON.stringify({
      symbol: t.symbol,
      side: t.side,
      entryTime: new Date(t.entryTime).toISOString(),
      exitTime: new Date(t.exitTime).toISOString(),
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      entryReason: t.entryReason,
      exitReason: t.exitReason,
      netPnlUsd: t.netPnlUsd?.toFixed(2),
      netPnlPct: t.netPnlPct?.toFixed(2),
    }));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
