import { runBacktest } from '../src/services/backtestService.js';
import { initializeMinimalMarkets } from '../src/exchange/ccxtClient.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';

async function main() {
  console.log('=== V5.94 PARITY FIX VERIFICATION ===');
  console.log('Fix: Exclude current BTC 15m candle from backtest (match live behavior)');
  console.log('');

  // Use minimal markets (no REST needed - only local candle files)
  initializeMinimalMarkets();

  const symbols = [
    'DOGE/USDT:USDT', 'DOT/USDT:USDT', 'WIF/USDT:USDT', 'IMX/USDT:USDT',
    'FET/USDT:USDT', 'AVAX/USDT:USDT', 'ADA/USDT:USDT', 'TIA/USDT:USDT',
    'STX/USDT:USDT', 'BTC/USDT:USDT',
  ];

  // ── TEST 1: Short window (Feb 7-9) to verify fix matches live ──
  console.log('══════════════════════════════════════');
  console.log('  TEST 1: Feb 7-9 (data available range)');
  console.log('══════════════════════════════════════');

  const shortResult = await runBacktest({
    startDate: new Date('2026-02-07T00:00:00.000Z'),
    endDate: new Date('2026-02-09T23:59:00.000Z'),
    initialCapital: 2000,
    symbols,
    leverage: 5,
  });

  const s1 = shortResult.summary;
  console.log('Trades:        ' + s1.totalTrades + ' (' + s1.longTrades + ' long, ' + s1.shortTrades + ' short)');
  console.log('Win Rate:      ' + s1.winRate.toFixed(1) + '%');
  console.log('Net PnL:       $' + s1.totalPnlUsd.toFixed(2));
  console.log('');

  // Show individual trades
  if (shortResult.trades && shortResult.trades.length > 0) {
    console.log('TRADES:');
    for (const t of shortResult.trades) {
      const entry = new Date(t.entryTime).toISOString().substring(0, 16);
      const exit = new Date(t.exitTime).toISOString().substring(0, 16);
      const pnlSign = t.netPnlUsd >= 0 ? '+' : '';
      console.log(`  ${t.symbol.replace('/USDT:USDT', '')} ${t.side.toUpperCase()} | ${entry} → ${exit} | ${pnlSign}$${t.netPnlUsd.toFixed(2)} (${pnlSign}${t.netPnlPct.toFixed(2)}%) | Exit: ${t.exitReason}`);
    }
  } else {
    console.log('NO TRADES in this period.');
  }

  console.log('');
  console.log('══════════════════════════════════════');
  console.log('  TEST 2: Full 2025 (Jan-Dec)');
  console.log('══════════════════════════════════════');

  // ── TEST 2: Full 2025 backtest ──
  const fullResult = await runBacktest({
    startDate: new Date('2025-01-01T00:00:00.000Z'),
    endDate: new Date('2025-12-31T00:00:00.000Z'),
    initialCapital: 2000,
    symbols,
    leverage: 5,
  });

  const s2 = fullResult.summary;
  console.log('Trades:        ' + s2.totalTrades + ' (' + s2.longTrades + ' long, ' + s2.shortTrades + ' short)');
  console.log('Win Rate:      ' + s2.winRate.toFixed(1) + '%');
  console.log('Net PnL:       $' + s2.totalPnlUsd.toFixed(2) + ' (' + s2.totalPnlPct.toFixed(1) + '%)');
  console.log('Final Capital: $' + s2.finalCapital.toFixed(2));
  console.log('Max Drawdown:  ' + s2.maxDrawdownPct.toFixed(1) + '%');
  console.log('Sharpe:        ' + s2.sharpeRatio.toFixed(2));
  console.log('Profit Factor: ' + s2.profitFactor.toFixed(2));
  console.log('Avg Hold:      ' + s2.avgHoldMinutes.toFixed(0) + ' min');
  console.log('Total Fees:    $' + s2.totalFeesUsd.toFixed(2));
  console.log('══════════════════════════════════════');

  // Monthly breakdown
  if (fullResult.trades && fullResult.trades.length > 0) {
    const monthly: Record<string, { trades: number; pnl: number; wins: number }> = {};
    for (const t of fullResult.trades) {
      const month = new Date(t.entryTime).toISOString().substring(0, 7);
      if (!monthly[month]) monthly[month] = { trades: 0, pnl: 0, wins: 0 };
      monthly[month].trades++;
      monthly[month].pnl += t.netPnlUsd;
      if (t.netPnlUsd > 0) monthly[month].wins++;
    }

    console.log('');
    console.log('MONTHLY BREAKDOWN:');
    console.log('Month    | Trades | WR     | PnL');
    console.log('---------|--------|--------|--------');
    for (const [month, data] of Object.entries(monthly).sort()) {
      const wr = data.trades > 0 ? (data.wins / data.trades * 100).toFixed(1) : '0.0';
      const pnlSign = data.pnl >= 0 ? '+' : '';
      console.log(`${month}  | ${String(data.trades).padStart(6)} | ${wr.padStart(5)}% | ${pnlSign}$${data.pnl.toFixed(2)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
