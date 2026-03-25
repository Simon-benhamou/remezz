/**
 * Test each symbol individually to identify good/bad symbols for the strategy.
 * Uses V5.92 optimized config (STAG=60, TRAIL_ACT=1.0, TRAIL_DIST=0.4).
 */

import { runBacktest } from '../src/services/backtestService.js';
import { preloadMarkets } from '../src/exchange/ccxtClient.js';

const ALL_SYMBOLS = [
  'BTC/USDT:USDT',
  'ETH/USDT:USDT',
  'SOL/USDT:USDT',
  'DOGE/USDT:USDT',
  'IMX/USDT:USDT',
  'SEI/USDT:USDT',
  'SUI/USDT:USDT',
  'XRP/USDT:USDT',
  'ADA/USDT:USDT',
  'DOT/USDT:USDT',
  'LINK/USDT:USDT',
  'AVAX/USDT:USDT',
  'NEAR/USDT:USDT',
  'ARB/USDT:USDT',
  'APT/USDT:USDT',
  'OP/USDT:USDT',
  'FTM/USDT:USDT',
  'ATOM/USDT:USDT',
];

const START = new Date('2025-01-01T00:00:00.000Z');
const END = new Date('2025-12-31T00:00:00.000Z');
const CAPITAL = 2000;
const LEVERAGE = 4.5;

interface SymResult {
  symbol: string;
  trades: number;
  wins: number;
  winRate: number;
  pnl: number;
  pnlPct: number;
  maxDD: number;
  sharpe: number;
  avgTradeUsd: number;
  fees: number;
  avgHoldMin: number;
}

function padR(s: string, n: number): string {
  return s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
  console.log('[SymbolTest] Preloading markets...');
  const ok = await preloadMarkets();
  if (!ok) throw new Error('Failed to preload markets');
  console.log('[SymbolTest] Markets loaded.\n');

  const results: SymResult[] = [];

  for (let i = 0; i < ALL_SYMBOLS.length; i++) {
    const sym = ALL_SYMBOLS[i];
    const shortName = sym.split('/')[0];
    console.log(`[SymbolTest] ${i + 1}/${ALL_SYMBOLS.length}: ${shortName}...`);

    try {
      const t0 = Date.now();
      const result = await runBacktest({
        startDate: START,
        endDate: END,
        initialCapital: CAPITAL,
        symbols: [sym],
        leverage: LEVERAGE,
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

      const s = result.summary;
      const r: SymResult = {
        symbol: shortName,
        trades: s.totalTrades,
        wins: s.wins,
        winRate: s.winRate,
        pnl: s.totalPnlUsd,
        pnlPct: s.totalPnlPct,
        maxDD: s.maxDrawdownPct,
        sharpe: s.sharpeRatio,
        avgTradeUsd: s.avgTradeUsd,
        fees: s.totalFeesUsd,
        avgHoldMin: s.avgHoldMinutes,
      };
      results.push(r);
      console.log(`  → Trades=${r.trades}, WR=${r.winRate.toFixed(1)}%, PnL=$${r.pnl.toFixed(0)} (${r.pnlPct.toFixed(0)}%), DD=${r.maxDD.toFixed(1)}%, Sharpe=${r.sharpe.toFixed(2)} (${elapsed}s)\n`);
    } catch (err) {
      console.error(`  → ERROR: ${err instanceof Error ? err.message : err}\n`);
      results.push({
        symbol: shortName,
        trades: 0, wins: 0, winRate: 0, pnl: 0, pnlPct: 0,
        maxDD: 0, sharpe: 0, avgTradeUsd: 0, fees: 0, avgHoldMin: 0,
      });
    }
  }

  // Sort by PnL descending
  const sorted = [...results].sort((a, b) => b.pnl - a.pnl);

  console.log('\n' + '═'.repeat(130));
  console.log(
    padR('Rank', 5) +
    padR('Symbol', 8) +
    padR('Trades', 7) +
    padR('Wins', 5) +
    padR('WinRate', 8) +
    padR('NetPnL', 12) +
    padR('PnL%', 10) +
    padR('MaxDD%', 8) +
    padR('Sharpe', 8) +
    padR('AvgTrade', 10) +
    padR('Fees', 10) +
    padR('AvgHold', 8) +
    padR('Verdict', 15)
  );
  console.log('─'.repeat(130));

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    let verdict = '';
    if (r.pnl > 500 && r.winRate > 55) verdict = 'STRONG';
    else if (r.pnl > 0 && r.winRate > 50) verdict = 'OK';
    else if (r.pnl > -100) verdict = 'MARGINAL';
    else verdict = 'AVOID';

    const rank = `${i + 1}`;
    console.log(
      padR(rank, 5) +
      padR(r.symbol, 8) +
      padR(String(r.trades), 7) +
      padR(String(r.wins), 5) +
      padR(r.winRate.toFixed(1) + '%', 8) +
      padR('$' + r.pnl.toFixed(0), 12) +
      padR(r.pnlPct.toFixed(1) + '%', 10) +
      padR(r.maxDD.toFixed(1) + '%', 8) +
      padR(r.sharpe.toFixed(2), 8) +
      padR('$' + r.avgTradeUsd.toFixed(1), 10) +
      padR('$' + r.fees.toFixed(0), 10) +
      padR(r.avgHoldMin.toFixed(0) + 'm', 8) +
      verdict
    );
  }
  console.log('═'.repeat(130));

  // Summary
  const strong = sorted.filter(r => r.pnl > 500 && r.winRate > 55);
  const decent = sorted.filter(r => r.pnl > 0 && r.winRate > 50 && r.pnl <= 500);
  const avoid = sorted.filter(r => r.pnl <= -100);
  const marginal = sorted.filter(r => r.pnl > -100 && r.pnl <= 0);

  console.log(`\nSTRONG (${strong.length}): ${strong.map(r => r.symbol).join(', ')}`);
  console.log(`OK (${decent.length}): ${decent.map(r => r.symbol).join(', ')}`);
  console.log(`MARGINAL (${marginal.length}): ${marginal.map(r => r.symbol).join(', ')}`);
  console.log(`AVOID (${avoid.length}): ${avoid.map(r => r.symbol).join(', ')}`);
}

main().catch((err) => {
  console.error('[SymbolTest] FATAL:', err);
  process.exitCode = 1;
});
