/**
 * V5.97 SHORT S/R FILTER GRID SEARCH
 * ===================================
 * Tests multiple SHORT S/R filter configurations to maximize ROI.
 *
 * BASELINE FINDINGS (V5.96):
 *   No S/R filter:  776 trades, 62.9% WR, ROI 1571%
 *   V5.96 filter:   653 trades, 63.9% WR, ROI 1210% (SHORT filter too aggressive!)
 *
 * The SHORT filter removes 103 profitable shorts → -361% ROI loss.
 * Goal: Find SHORT S/R params that keep good shorts, filter only bad ones.
 */

import { runBacktest, type BacktestResult } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import { preloadMarkets, initializeMinimalMarkets } from '../src/exchange/ccxtClient.js';

const SYMBOLS = [
  'BTC/USDT:USDT',
  'AVAX/USDT:USDT',
  'FET/USDT:USDT',
  'WIF/USDT:USDT',
  'DOT/USDT:USDT',
  'TIA/USDT:USDT',
  'IMX/USDT:USDT',
  'STX/USDT:USDT',
  'DOGE/USDT:USDT',
  'ADA/USDT:USDT',
];

const PARAMS = {
  startDate: new Date('2024-06-01T00:00:00Z'),
  endDate: new Date('2025-12-31T23:59:59Z'),
  initialCapital: 2000,
  symbols: SYMBOLS,
  leverage: 4.5,
};

interface ConfigResult {
  label: string;
  srEnabled: boolean;
  shortMaxRatio: number;
  shortMaxDistR: number;
  longMinRatio: number;
  trades: number;
  longTrades: number;
  shortTrades: number;
  winRate: number;
  longWR: number;
  shortWR: number;
  roi: number;
  longAvgPnl: number;
  shortAvgPnl: number;
  sharpe: number;
  pf: number;
  maxDD: number;
  finalCapital: number;
}

function extractResult(label: string, r: BacktestResult, cfg: {srEnabled: boolean; shortMaxRatio: number; shortMaxDistR: number; longMinRatio: number}): ConfigResult {
  const s = r.summary;
  const longTrades = r.trades.filter(t => t.side === 'long');
  const shortTrades = r.trades.filter(t => t.side === 'short');
  const longWins = longTrades.filter(t => t.netPnlPct > 0).length;
  const shortWins = shortTrades.filter(t => t.netPnlPct > 0).length;
  const longWR = longTrades.length > 0 ? (longWins / longTrades.length * 100) : 0;
  const shortWR = shortTrades.length > 0 ? (shortWins / shortTrades.length * 100) : 0;
  const longAvgPnl = longTrades.length > 0 ? longTrades.reduce((s, t) => s + t.netPnlPct, 0) / longTrades.length : 0;
  const shortAvgPnl = shortTrades.length > 0 ? shortTrades.reduce((s, t) => s + t.netPnlPct, 0) / shortTrades.length : 0;

  return {
    label,
    ...cfg,
    trades: s.totalTrades,
    longTrades: longTrades.length,
    shortTrades: shortTrades.length,
    winRate: s.winRate,
    longWR,
    shortWR,
    roi: s.totalPnlPct,
    longAvgPnl,
    shortAvgPnl,
    sharpe: s.sharpeRatio,
    pf: s.profitFactor,
    maxDD: s.maxDrawdownPct,
    finalCapital: s.finalCapital,
  };
}

async function runConfig(label: string, srEnabled: boolean, shortMaxRatio: number, shortMaxDistR: number, longMinRatio: number): Promise<ConfigResult> {
  const cfg = MomentumConfig as any;
  cfg.SR_PROXIMITY_FILTER.ENABLED = srEnabled;
  if (srEnabled) {
    cfg.SR_PROXIMITY_FILTER.SHORT_MAX_SR_RATIO = shortMaxRatio;
    cfg.SR_PROXIMITY_FILTER.SHORT_MAX_DIST_RESISTANCE_PCT = shortMaxDistR;
    cfg.SR_PROXIMITY_FILTER.LONG_MIN_SR_RATIO = longMinRatio;
  }

  const t = Date.now();
  const result = await runBacktest(PARAMS);
  const elapsed = ((Date.now() - t) / 1000).toFixed(0);
  console.log(`   [${elapsed}s] ${label}: ${result.summary.totalTrades} trades, ROI: ${result.summary.totalPnlPct.toFixed(1)}%`);

  return extractResult(label, result, { srEnabled, shortMaxRatio, shortMaxDistR, longMinRatio });
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     SHORT S/R FILTER GRID SEARCH - Maximize ROI                    ║');
  console.log('║     Period: Jun 2024 - Dec 2025 (18 months)                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  let ok = false;
  try { ok = await preloadMarkets(); } catch { ok = false; }
  if (!ok) { initializeMinimalMarkets(); }
  console.log('Markets ready.\n');

  const results: ConfigResult[] = [];

  // ============================================================
  // CONFIGS TO TEST
  // ============================================================

  const configs = [
    // 1. No S/R filter at all (absolute baseline)
    { label: '1. NO_SR_FILTER', srEnabled: false, shortMaxRatio: 99, shortMaxDistR: 99, longMinRatio: 0 },

    // 2. Current V5.96 (LONG + SHORT filter)
    { label: '2. V5.96_CURRENT', srEnabled: true, shortMaxRatio: 0.5, shortMaxDistR: 5.0, longMinRatio: 0.2 },

    // 3. LONG S/R only (disable SHORT S/R via very loose thresholds)
    { label: '3. LONG_ONLY_SR', srEnabled: true, shortMaxRatio: 1.0, shortMaxDistR: 100, longMinRatio: 0.2 },

    // 4. Loose SHORT: ratio 0.7, dist 8%
    { label: '4. SHORT_LOOSE_07_8', srEnabled: true, shortMaxRatio: 0.7, shortMaxDistR: 8.0, longMinRatio: 0.2 },

    // 5. Loose SHORT: ratio 0.8, dist 10%
    { label: '5. SHORT_LOOSE_08_10', srEnabled: true, shortMaxRatio: 0.8, shortMaxDistR: 10.0, longMinRatio: 0.2 },

    // 6. Medium SHORT: ratio 0.6, dist 7%
    { label: '6. SHORT_MED_06_7', srEnabled: true, shortMaxRatio: 0.6, shortMaxDistR: 7.0, longMinRatio: 0.2 },

    // 7. Tight SHORT: ratio 0.35, dist 3% (only best shorts)
    { label: '7. SHORT_TIGHT_035_3', srEnabled: true, shortMaxRatio: 0.35, shortMaxDistR: 3.0, longMinRatio: 0.2 },

    // 8. Very loose SHORT: ratio 0.9, dist 15%
    { label: '8. SHORT_VLOOSE_09_15', srEnabled: true, shortMaxRatio: 0.9, shortMaxDistR: 15.0, longMinRatio: 0.2 },

    // 9. Loosened LONG too: LONG 0.15 + loose SHORT
    { label: '9. LONG015_SHORT08_10', srEnabled: true, shortMaxRatio: 0.8, shortMaxDistR: 10.0, longMinRatio: 0.15 },

    // 10. No LONG filter + loose SHORT
    { label: '10. NO_LONG_LOOSE_SHORT', srEnabled: true, shortMaxRatio: 0.8, shortMaxDistR: 10.0, longMinRatio: 0.0 },

    // 11. ratio 0.65, dist 6% (sweet spot hypothesis)
    { label: '11. SHORT_065_6', srEnabled: true, shortMaxRatio: 0.65, shortMaxDistR: 6.0, longMinRatio: 0.2 },

    // 12. ratio 0.75, dist 9%
    { label: '12. SHORT_075_9', srEnabled: true, shortMaxRatio: 0.75, shortMaxDistR: 9.0, longMinRatio: 0.2 },
  ];

  for (const cfg of configs) {
    console.log(`\n🔄 Testing: ${cfg.label}`);
    const r = await runConfig(cfg.label, cfg.srEnabled, cfg.shortMaxRatio, cfg.shortMaxDistR, cfg.longMinRatio);
    results.push(r);
  }

  // Restore original config
  const cfg = MomentumConfig as any;
  cfg.SR_PROXIMITY_FILTER.ENABLED = true;
  cfg.SR_PROXIMITY_FILTER.SHORT_MAX_SR_RATIO = 0.5;
  cfg.SR_PROXIMITY_FILTER.SHORT_MAX_DIST_RESISTANCE_PCT = 5.0;
  cfg.SR_PROXIMITY_FILTER.LONG_MIN_SR_RATIO = 0.2;

  // ============================================================
  // RESULTS TABLE
  // ============================================================

  console.log('\n\n' + '═'.repeat(140));
  console.log('GRID SEARCH RESULTS - SORTED BY ROI');
  console.log('═'.repeat(140));

  results.sort((a, b) => b.roi - a.roi);

  console.log(`${'Config'.padEnd(28)} ${'Trades'.padStart(6)} ${'L/S'.padStart(8)} ${'WR%'.padStart(6)} ${'LWR'.padStart(6)} ${'SWR'.padStart(6)} ${'ROI%'.padStart(10)} ${'L_Avg'.padStart(7)} ${'S_Avg'.padStart(7)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(5)} ${'MaxDD'.padStart(7)} ${'Final$'.padStart(9)}`);
  console.log('-'.repeat(140));

  const baseROI = results.find(r => r.label.includes('NO_SR'))?.roi ?? 0;

  for (const r of results) {
    const roiDelta = r.roi - baseROI;
    const roiStr = `${r.roi.toFixed(1)}${roiDelta !== 0 ? ` (${roiDelta >= 0 ? '+' : ''}${roiDelta.toFixed(0)})` : ''}`;
    console.log(
      `${r.label.padEnd(28)} ` +
      `${String(r.trades).padStart(6)} ` +
      `${(r.longTrades + '/' + r.shortTrades).padStart(8)} ` +
      `${r.winRate.toFixed(1).padStart(6)} ` +
      `${r.longWR.toFixed(1).padStart(6)} ` +
      `${r.shortWR.toFixed(1).padStart(6)} ` +
      `${roiStr.padStart(10)} ` +
      `${r.longAvgPnl.toFixed(2).padStart(7)} ` +
      `${r.shortAvgPnl.toFixed(2).padStart(7)} ` +
      `${r.sharpe.toFixed(2).padStart(7)} ` +
      `${r.pf.toFixed(2).padStart(5)} ` +
      `${r.maxDD.toFixed(1).padStart(7)} ` +
      `${('$' + r.finalCapital.toFixed(0)).padStart(9)}`
    );
  }

  // Best config
  const best = results[0];
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`WINNER: ${best.label}`);
  console.log(`  ROI: ${best.roi.toFixed(1)}% | Trades: ${best.trades} (L:${best.longTrades} S:${best.shortTrades})`);
  console.log(`  WR: ${best.winRate.toFixed(1)}% (L:${best.longWR.toFixed(1)}% S:${best.shortWR.toFixed(1)}%)`);
  console.log(`  Avg PnL: L:${best.longAvgPnl.toFixed(3)}% S:${best.shortAvgPnl.toFixed(3)}%`);
  console.log(`  Sharpe: ${best.sharpe.toFixed(2)} | PF: ${best.pf.toFixed(2)} | MaxDD: ${best.maxDD.toFixed(1)}%`);
  console.log(`  Config: SR_ENABLED=${best.srEnabled} SHORT_MAX_RATIO=${best.shortMaxRatio} SHORT_MAX_DIST_R=${best.shortMaxDistR}% LONG_MIN_RATIO=${best.longMinRatio}`);
  console.log('═'.repeat(80));

  // Compare best with current V5.96
  const current = results.find(r => r.label.includes('V5.96'));
  if (current) {
    console.log(`\nIMPROVEMENT vs V5.96:`);
    console.log(`  ROI: ${current.roi.toFixed(1)}% → ${best.roi.toFixed(1)}% (${best.roi > current.roi ? '+' : ''}${(best.roi - current.roi).toFixed(1)}%)`);
    console.log(`  Trades: ${current.trades} → ${best.trades} (${best.trades > current.trades ? '+' : ''}${best.trades - current.trades})`);
    console.log(`  WR: ${current.winRate.toFixed(1)}% → ${best.winRate.toFixed(1)}% (${best.winRate > current.winRate ? '+' : ''}${(best.winRate - current.winRate).toFixed(1)}pp)`);
    console.log(`  SHORT avg PnL: ${current.shortAvgPnl.toFixed(3)}% → ${best.shortAvgPnl.toFixed(3)}% (${best.shortAvgPnl > current.shortAvgPnl ? '+' : ''}${(best.shortAvgPnl - current.shortAvgPnl).toFixed(3)}%)`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
