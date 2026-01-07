import { runBacktest } from './dist/src/services/backtestService.js';

const symbolsList = ['SOL', 'ETH', 'BTC', 'DOGE', 'LINK', 'AVAX'];
const start = '2024-01-01';
const end = '2024-12-31';

async function run() {
  console.log('=== V5.38 BACKTEST VALIDATION ===');
  console.log('Testing exit alignment: SL on wick → Trailing on close (2-candle)');
  console.log('Period:', start, 'to', end);
  console.log('');
  
  let totalTrades = 0, totalWins = 0, totalPnl = 0;
  const results = [];
  
  for (const sym of symbolsList) {
    try {
      const r = await runBacktest({
        symbols: [sym + '/USDT:USDT'],  // Fixed: use 'symbols' array with CCXT format
        startDate: new Date(start),
        endDate: new Date(end),
        initialCapital: 10000,
        leverage: 5,
        trailingConfirmCandles: 2
      });
      
      const wr = r.summary.totalTrades > 0 ? (r.summary.wins / r.summary.totalTrades * 100).toFixed(1) : 0;
      const avgTrade = r.summary.totalTrades > 0 ? (r.summary.totalPnlPct / r.summary.totalTrades).toFixed(2) : 0;
      
      // Count exit reasons
      const exits = {};
      r.trades.forEach(t => { exits[t.exitReason] = (exits[t.exitReason] || 0) + 1; });
      
      results.push({
        symbol: sym,
        trades: r.summary.totalTrades,
        wr: wr + '%',
        pnl: r.summary.totalPnlPct.toFixed(1) + '%',
        avgTrade: avgTrade + '%',
        exits
      });
      
      totalTrades += r.summary.totalTrades;
      totalWins += r.summary.wins;
      totalPnl += r.summary.totalPnlPct;
      
    } catch (e) {
      console.log(sym + ': Error -', e.message);
    }
  }
  
  console.log('RESULTS BY SYMBOL:');
  console.log('─'.repeat(80));
  results.forEach(r => {
    console.log(r.symbol.padEnd(6), '| Trades:', String(r.trades).padStart(3), '| WR:', r.wr.padStart(6), '| PnL:', r.pnl.padStart(8), '| Avg:', r.avgTrade.padStart(6));
    const exitStr = Object.entries(r.exits).map(([k,v]) => k + ':' + v).join(', ');
    console.log('       | Exits:', exitStr);
  });
  
  console.log('─'.repeat(80));
  const overallWR = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : 0;
  const avgPnl = totalTrades > 0 ? (totalPnl / totalTrades).toFixed(2) : 0;
  console.log('TOTAL  | Trades:', totalTrades, '| WR:', overallWR + '%', '| Total PnL:', totalPnl.toFixed(1) + '%', '| Avg/Trade:', avgPnl + '%');
}

run().catch(console.error);
