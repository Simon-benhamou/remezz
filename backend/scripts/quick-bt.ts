import { runBacktest } from '../src/services/backtestService.js';
import { preloadMarkets } from '../src/exchange/ccxtClient.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';

async function main() {
  console.log('CONFIG CHECK:');
  console.log('  MAX_CONSEC_DOWN =', MomentumConfig.ENTRY_SHORT.MAX_CONSEC_DOWN);
  console.log('  MAX_CONSEC_UP   =', MomentumConfig.ENTRY_LONG.MAX_CONSEC_UP);
  console.log('  MAX_POSITIONS   =', MomentumConfig.RISK.MAX_POSITIONS_BASE);
  console.log('  POSITION_SIZE   =', MomentumConfig.RISK.POSITION_SIZE_PCT);
  console.log('');
  await preloadMarkets();
  const result = await runBacktest({
    startDate: new Date('2025-01-01T00:00:00.000Z'),
    endDate: new Date('2025-12-31T00:00:00.000Z'),
    initialCapital: 2000,
    symbols: [
      'DOGE/USDT:USDT', 'DOT/USDT:USDT', 'WIF/USDT:USDT', 'IMX/USDT:USDT',
      'FET/USDT:USDT', 'AVAX/USDT:USDT', 'ADA/USDT:USDT', 'TIA/USDT:USDT',
      'STX/USDT:USDT', 'BTC/USDT:USDT',
    ],
    leverage: 5,
  });
  const s = result.summary;
  console.log('==========================================');
  console.log('  BACKTEST — $2,000 / 5x / 10 symbols / 2025');
  console.log('==========================================');
  console.log('Trades:        ' + s.totalTrades + ' (' + s.longTrades + ' long, ' + s.shortTrades + ' short)');
  console.log('Win Rate:      ' + s.winRate.toFixed(1) + '%');
  console.log('Net PnL:       $' + s.totalPnlUsd.toFixed(2) + ' (' + s.totalPnlPct.toFixed(1) + '%)');
  console.log('Final Capital: $' + s.finalCapital.toFixed(2));
  console.log('Max Drawdown:  ' + s.maxDrawdownPct.toFixed(1) + '%');
  console.log('Sharpe:        ' + s.sharpeRatio.toFixed(2));
  console.log('Profit Factor: ' + s.profitFactor.toFixed(2));
  console.log('Avg Hold:      ' + s.avgHoldMinutes.toFixed(0) + ' min');
  console.log('Total Fees:    $' + s.totalFeesUsd.toFixed(2));
  console.log('==========================================');
}
main().catch(e => { console.error(e); process.exit(1); });
