/**
 * Monthly Performance Comparison: Jan 2026 vs all 2025 months
 */
import { runBacktest, type BacktestResult } from '../src/services/backtestService.js';

const SYMBOLS = [
  'BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT',
  'DOGE/USDT:USDT', 'AVAX/USDT:USDT', 'SUI/USDT:USDT',
  'SEI/USDT:USDT', 'IMX/USDT:USDT', 'XRP/USDT:USDT',
  'ADA/USDT:USDT', 'LINK/USDT:USDT',
];

const INITIAL_CAPITAL = 1000;
const LEVERAGE = 5;

interface MonthDef { label: string; start: Date; end: Date }

function getMonths(): MonthDef[] {
  const months: MonthDef[] = [];
  for (let m = 0; m < 12; m++) {
    const start = new Date(Date.UTC(2025, m, 1));
    const end = new Date(Date.UTC(2025, m + 1, 0, 23, 59, 59));
    const label = start.toLocaleString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    months.push({ label, start, end });
  }
  months.push({
    label: 'Jan 2026',
    start: new Date(Date.UTC(2026, 0, 1)),
    end: new Date(Date.UTC(2026, 0, 30, 23, 59, 59)),
  });
  return months;
}

async function main() {
  const months = getMonths();
  const results: { label: string; summary: BacktestResult['summary'] }[] = [];

  for (const m of months) {
    console.log(`\n🔄 ${m.label} ...`);
    try {
      const warmupStart = new Date(m.start.getTime() - 35 * 24 * 60 * 60 * 1000);
      const result = await runBacktest({
        startDate: m.start,
        endDate: m.end,
        initialCapital: INITIAL_CAPITAL,
        symbols: SYMBOLS,
        leverage: LEVERAGE,
        dataStartDate: warmupStart,
      });
      results.push({ label: m.label, summary: result.summary });
      console.log(`✅ ${m.label}: ${result.summary.totalTrades} trades, PnL ${result.summary.totalPnlPct.toFixed(2)}%`);
    } catch (err: any) {
      console.error(`❌ ${m.label}: ${err?.message}`);
      results.push({
        label: m.label,
        summary: {
          totalTrades: 0, wins: 0, losses: 0, winRate: 0,
          totalPnlUsd: 0, totalPnlPct: 0, maxDrawdownPct: 0,
          avgTradeUsd: 0, avgWinUsd: 0, avgLossUsd: 0,
          profitFactor: 0, sharpeRatio: 0, finalCapital: INITIAL_CAPITAL,
          longTrades: 0, shortTrades: 0, avgHoldMinutes: 0, totalFeesUsd: 0,
        },
      });
    }
  }

  console.log('\n\n═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('                          MONTHLY PERFORMANCE COMPARISON');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log(
    'Month'.padEnd(12) +
    'Trades'.padStart(8) +
    'Wins'.padStart(6) +
    'WR%'.padStart(8) +
    'PnL%'.padStart(10) +
    'PnL$'.padStart(10) +
    'MaxDD%'.padStart(9) +
    'Sharpe'.padStart(9) +
    'PF'.padStart(8) +
    'AvgHold'.padStart(10)
  );
  console.log('─'.repeat(90));

  for (const r of results) {
    const s = r.summary;
    console.log(
      r.label.padEnd(12) +
      String(s.totalTrades).padStart(8) +
      String(s.wins).padStart(6) +
      `${(s.winRate * 100).toFixed(1)}`.padStart(8) +
      `${s.totalPnlPct >= 0 ? '+' : ''}${s.totalPnlPct.toFixed(2)}`.padStart(10) +
      `$${s.totalPnlUsd.toFixed(0)}`.padStart(10) +
      `${s.maxDrawdownPct.toFixed(2)}`.padStart(9) +
      s.sharpeRatio.toFixed(2).padStart(9) +
      s.profitFactor.toFixed(2).padStart(8) +
      `${s.avgHoldMinutes.toFixed(0)}m`.padStart(10)
    );
  }

  // Similarity analysis
  const jan2026 = results.find(r => r.label === 'Jan 2026');
  if (!jan2026) return;

  const months2025 = results.filter(r => r.label !== 'Jan 2026' && r.summary.totalTrades > 0);

  const similarities = months2025.map(m => {
    const j = jan2026.summary;
    const s = m.summary;
    const pnlDiff = Math.abs(j.totalPnlPct - s.totalPnlPct);
    const wrDiff = Math.abs(j.winRate - s.winRate) * 100;
    const ddDiff = Math.abs(j.maxDrawdownPct - s.maxDrawdownPct);
    const tradeDiff = Math.abs(j.totalTrades - s.totalTrades);
    const sharpeDiff = Math.abs(j.sharpeRatio - s.sharpeRatio);
    const pfDiff = Math.abs(j.profitFactor - s.profitFactor);
    const score = pnlDiff * 2 + wrDiff + ddDiff + tradeDiff * 0.1 + sharpeDiff * 5 + pfDiff * 3;
    return { label: m.label, score, pnlDiff, wrDiff, ddDiff };
  }).sort((a, b) => a.score - b.score);

  console.log('\n\n═══════════════════════════════════════════════════════════════════');
  console.log('          SIMILARITY: Jan 2026 vs 2025 months');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('Rank  Month        Score    PnL% Diff   WR Diff   DD Diff');
  console.log('─'.repeat(62));
  similarities.forEach((s, i) => {
    console.log(
      `#${i + 1}`.padEnd(6) +
      s.label.padEnd(13) +
      s.score.toFixed(2).padStart(8) +
      `${s.pnlDiff.toFixed(2)}%`.padStart(12) +
      `${s.wrDiff.toFixed(1)}%`.padStart(10) +
      `${s.ddDiff.toFixed(2)}%`.padStart(10)
    );
  });

  const allByPnl = [...results].sort((a, b) => b.summary.totalPnlPct - a.summary.totalPnlPct);
  const jan2026Rank = allByPnl.findIndex(r => r.label === 'Jan 2026') + 1;

  const avgPnl2025 = months2025.reduce((s, m) => s + m.summary.totalPnlPct, 0) / months2025.length;
  const medianPnl2025 = months2025.map(m => m.summary.totalPnlPct).sort((a, b) => a - b)[Math.floor(months2025.length / 2)];
  const jan2026Pnl = jan2026.summary.totalPnlPct;

  console.log(`\n📊 SUMMARY`);
  console.log(`   Jan 2026 PnL: ${jan2026Pnl >= 0 ? '+' : ''}${jan2026Pnl.toFixed(2)}%`);
  console.log(`   2025 avg monthly PnL: ${avgPnl2025 >= 0 ? '+' : ''}${avgPnl2025.toFixed(2)}%`);
  console.log(`   2025 median monthly PnL: ${medianPnl2025 >= 0 ? '+' : ''}${medianPnl2025.toFixed(2)}%`);
  console.log(`   PnL Rank: #${jan2026Rank} / ${allByPnl.length}`);
  console.log(`   vs 2025 average: ${jan2026Pnl >= avgPnl2025 ? 'ABOVE' : 'BELOW'} (${(jan2026Pnl - avgPnl2025) >= 0 ? '+' : ''}${(jan2026Pnl - avgPnl2025).toFixed(2)}%)`);
  console.log(`   Most similar to: ${similarities[0].label}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
