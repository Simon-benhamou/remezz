/**
 * Long-period backtest: Compare 2 slots (baseline) vs 3 slots (MAX_POSITIONS_BASE=3)
 *
 * Since CONFIG.SIZING.MAX_POSITIONS_BASE is internal to backtestService,
 * we simulate 3 slots by adjusting capital:
 *   - 2 slots: $1000 → 2 + floor(1000/1500) = 2
 *   - 3 slots: $1500 → 2 + floor(1500/1500) = 3
 *
 * To keep position sizing comparable, we normalize ROI% (not absolute $).
 *
 * Usage: npx tsx scripts/analyze-crash-filters.ts
 */

import { runBacktest, type BacktestParams } from '../src/services/backtestService.js';
import { preloadMarkets } from '../src/exchange/ccxtClient.js';

const SYMBOLS = [
  'APT/USDT:USDT',
  'IMX/USDT:USDT',
  'DOGE/USDT:USDT',
  'DOT/USDT:USDT',
  'XRP/USDT:USDT',
  'SUI/USDT:USDT',
  'SOL/USDT:USDT',
  'SEI/USDT:USDT',
  'BTC/USDT:USDT',
  'ETH/USDT:USDT',
];

// Long period: 6 months
const START = new Date('2025-08-01T00:00:00Z');
const END = new Date('2026-02-06T12:00:00Z');
const DATA_START = new Date('2025-07-15T00:00:00Z');

interface ScenarioSummary {
  label: string;
  capital: number;
  maxPos: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnlPct: number;
  pnlUsd: number;
  maxDrawdownPct: number;
  sharpe: number;
  profitFactor: number;
  avgHoldMin: number;
  feesUsd: number;
  symbolsTraded: number;
  tradesPerDay: number;
}

async function runScenario(label: string, capital: number): Promise<ScenarioSummary> {
  const params: BacktestParams = {
    startDate: START,
    endDate: END,
    dataStartDate: DATA_START,
    initialCapital: capital,
    symbols: SYMBOLS,
    leverage: 5,
  };

  console.log(`\n  Running ${label} ($${capital})...`);
  const result = await runBacktest(params);
  const s = result.summary;

  const days = (END.getTime() - START.getTime()) / 86400000;
  const maxPos = Math.min(2 + Math.floor(capital / 1500), 10);

  // Count unique symbols
  const syms = new Set(result.trades.map(t => t.symbol));

  // Exit reason breakdown
  const exitReasons: Record<string, number> = {};
  for (const t of result.trades) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  }
  console.log(`    Exit reasons:`, Object.entries(exitReasons).map(([k, v]) => `${k}=${v}`).join(', '));

  // Monthly breakdown
  const monthlyPnl: Record<string, number> = {};
  for (const t of result.trades) {
    const month = t.entryTime.slice(0, 7); // YYYY-MM
    monthlyPnl[month] = (monthlyPnl[month] || 0) + t.netPnlPct;
  }
  console.log(`    Monthly ROI%:`, Object.entries(monthlyPnl).map(([k, v]) => `${k}=${v >= 0 ? '+' : ''}${v.toFixed(1)}%`).join(', '));

  return {
    label,
    capital,
    maxPos,
    trades: s.totalTrades,
    wins: s.wins,
    losses: s.losses,
    winRate: s.winRate,
    pnlPct: s.totalPnlPct,
    pnlUsd: s.totalPnlUsd,
    maxDrawdownPct: s.maxDrawdownPct,
    sharpe: s.sharpeRatio,
    profitFactor: s.profitFactor,
    avgHoldMin: s.avgHoldMinutes,
    feesUsd: s.totalFeesUsd,
    symbolsTraded: syms.size,
    tradesPerDay: s.totalTrades / days,
  };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  LONG-PERIOD BACKTEST: 2 slots vs 3 slots (6 months)                   ║');
  console.log('║  Period: Aug 2025 → Feb 2026                                           ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');

  console.log('\nLoading markets...');
  await preloadMarkets();
  console.log('Markets loaded.');

  // Scenario 1: $1000 = 2 slots (baseline)
  const s1 = await runScenario('2 SLOTS (baseline)', 1000);

  // Scenario 2: $1500 = 3 slots
  const s2 = await runScenario('3 SLOTS', 1500);

  // Print comparison
  console.log(`\n${'═'.repeat(90)}`);
  console.log('  COMPARISON: 2 SLOTS vs 3 SLOTS (6 months)');
  console.log('═'.repeat(90));

  const metrics = [
    ['Capital', `$${s1.capital}`, `$${s2.capital}`, ''],
    ['Max Positions', `${s1.maxPos}`, `${s2.maxPos}`, ''],
    ['Total Trades', `${s1.trades}`, `${s2.trades}`, `${s2.trades > s1.trades ? '+' : ''}${s2.trades - s1.trades}`],
    ['Trades/Day', s1.tradesPerDay.toFixed(2), s2.tradesPerDay.toFixed(2), ''],
    ['Win Rate', `${s1.winRate.toFixed(1)}%`, `${s2.winRate.toFixed(1)}%`, `${(s2.winRate - s1.winRate) >= 0 ? '+' : ''}${(s2.winRate - s1.winRate).toFixed(1)}pp`],
    ['ROI %', `${s1.pnlPct.toFixed(2)}%`, `${s2.pnlPct.toFixed(2)}%`, `${(s2.pnlPct - s1.pnlPct) >= 0 ? '+' : ''}${(s2.pnlPct - s1.pnlPct).toFixed(2)}pp`],
    ['Max Drawdown', `${s1.maxDrawdownPct.toFixed(2)}%`, `${s2.maxDrawdownPct.toFixed(2)}%`, `${(s2.maxDrawdownPct - s1.maxDrawdownPct) >= 0 ? '+' : ''}${(s2.maxDrawdownPct - s1.maxDrawdownPct).toFixed(2)}pp`],
    ['Sharpe', s1.sharpe.toFixed(2), s2.sharpe.toFixed(2), `${(s2.sharpe - s1.sharpe) >= 0 ? '+' : ''}${(s2.sharpe - s1.sharpe).toFixed(2)}`],
    ['Profit Factor', s1.profitFactor.toFixed(2), s2.profitFactor.toFixed(2), `${(s2.profitFactor - s1.profitFactor) >= 0 ? '+' : ''}${(s2.profitFactor - s1.profitFactor).toFixed(2)}`],
    ['Avg Hold', `${s1.avgHoldMin.toFixed(0)}m`, `${s2.avgHoldMin.toFixed(0)}m`, ''],
    ['Symbols Traded', `${s1.symbolsTraded}`, `${s2.symbolsTraded}`, ''],
    ['Wins/Losses', `${s1.wins}/${s1.losses}`, `${s2.wins}/${s2.losses}`, ''],
    ['Fees', `$${s1.feesUsd.toFixed(2)}`, `$${s2.feesUsd.toFixed(2)}`, ''],
  ];

  console.log(`  ${'Metric'.padEnd(18)} | ${'2 Slots'.padEnd(14)} | ${'3 Slots'.padEnd(14)} | Delta`);
  console.log(`  ${'─'.repeat(18)}─┼─${'─'.repeat(14)}─┼─${'─'.repeat(14)}─┼─${'─'.repeat(14)}`);
  for (const [name, v1, v2, delta] of metrics) {
    console.log(`  ${name.padEnd(18)} | ${v1.padEnd(14)} | ${v2.padEnd(14)} | ${delta}`);
  }

  // Verdict
  console.log(`\n${'═'.repeat(90)}`);
  const roiDiff = s2.pnlPct - s1.pnlPct;
  const wrDiff = s2.winRate - s1.winRate;
  const ddDiff = s2.maxDrawdownPct - s1.maxDrawdownPct;
  const sharpeDiff = s2.sharpe - s1.sharpe;

  if (roiDiff > 0 && ddDiff <= 5 && wrDiff >= -3) {
    console.log('  ✅ VERDICT: 3 slots is BETTER');
    console.log(`     ROI: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}pp | DD: ${ddDiff >= 0 ? '+' : ''}${ddDiff.toFixed(2)}pp | Sharpe: ${sharpeDiff >= 0 ? '+' : ''}${sharpeDiff.toFixed(2)}`);
    console.log('     → Safe to increase MAX_POSITIONS_BASE from 2 to 3');
  } else if (roiDiff < 0) {
    console.log('  ⚠️ VERDICT: 3 slots is WORSE on ROI');
    console.log(`     ROI: ${roiDiff.toFixed(2)}pp | DD: ${ddDiff >= 0 ? '+' : ''}${ddDiff.toFixed(2)}pp`);
    console.log('     → Keep MAX_POSITIONS_BASE at 2');
  } else {
    console.log('  ⚠️ VERDICT: Mixed results, review manually');
    console.log(`     ROI: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}pp | DD: ${ddDiff >= 0 ? '+' : ''}${ddDiff.toFixed(2)}pp | WR: ${wrDiff >= 0 ? '+' : ''}${wrDiff.toFixed(1)}pp`);
  }
  console.log('═'.repeat(90));

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
