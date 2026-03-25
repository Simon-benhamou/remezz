/**
 * Regime Timeframe Comparison Script
 * ====================================
 * Tests the impact of different BTC candle timeframes for regime detection
 * on our aggressive momentum breakout strategy.
 *
 * Configurations tested:
 *  1. 15m regime (SMA200 = 50h = ~2 days) — very responsive
 *  2. 30m regime (SMA200 = 100h = ~4 days) — faster than 1h
 *  3. 1h regime  (SMA200 = 200h = ~8 days) — current baseline
 *  4. 4h regime  (SMA200 = 800h = ~33 days) — slow, big picture
 *  5. 30m regime w/ SMA400 (= 200h, same window as 1h SMA200, but smoother)
 *  6. 1h regime w/ SMA100 (= 100h, same as 30m SMA200, but on 1h bars)
 *
 * Also tests MTF filter lookback adjustment:
 *  - For non-1h timeframes, adjusts MTF LOOKBACK_CANDLES to keep ~10h window
 *
 * Usage: npx tsx scripts/compare-regime-timeframes.ts
 */

import { runBacktest, type BacktestResult } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import { preloadMarkets, initializeMinimalMarkets } from '../src/exchange/ccxtClient.js';

// Use symbols with local JSON data to avoid slow API fetches
const SYMBOLS = [
  'DOGE/USDT:USDT',
  'IMX/USDT:USDT',
  'AVAX/USDT:USDT',
  'FET/USDT:USDT',
  'WIF/USDT:USDT',
];

// Local JSON data covers Dec 16 2024 - Feb 9 2026
// Use Jan 2025 start (enough warmup from Dec data) to Feb 2026
const PARAMS = {
  startDate: new Date('2025-01-01T00:00:00Z'),
  endDate: new Date('2026-02-09T00:00:00Z'),
  initialCapital: 2000,
  symbols: SYMBOLS,
  leverage: 4.5,
};

interface TestConfig {
  label: string;
  regimeTimeframeMinutes: number;
  smaPeriod: number;
  mtfLookbackCandles: number;
}

const CONFIGS: TestConfig[] = [
  // A) Same SMA200 period, different timeframes (different lookback windows)
  { label: '15m SMA200 (50h window)',    regimeTimeframeMinutes: 15,  smaPeriod: 200, mtfLookbackCandles: 40 },   // 40×15m = 10h
  { label: '30m SMA200 (100h window)',   regimeTimeframeMinutes: 30,  smaPeriod: 200, mtfLookbackCandles: 20 },   // 20×30m = 10h
  { label: '1h SMA200 (200h) BASELINE',  regimeTimeframeMinutes: 60,  smaPeriod: 200, mtfLookbackCandles: 10 },   // 10×1h = 10h (current)
  { label: '4h SMA200 (800h window)',    regimeTimeframeMinutes: 240, smaPeriod: 200, mtfLookbackCandles: 3 },    // 3×4h = 12h (~10h)

  // B) Same ~200h lookback, different granularity (adjusted SMA period)
  { label: '30m SMA400 (200h, smooth)',  regimeTimeframeMinutes: 30,  smaPeriod: 400, mtfLookbackCandles: 20 },
  { label: '1h SMA100 (100h, faster)',   regimeTimeframeMinutes: 60,  smaPeriod: 100, mtfLookbackCandles: 10 },
];

function printSummary(label: string, r: BacktestResult) {
  const s = r.summary;
  const longTrades = r.trades.filter(t => t.side === 'long');
  const shortTrades = r.trades.filter(t => t.side === 'short');
  const longWins = longTrades.filter(t => t.netPnlPct > 0).length;
  const shortWins = shortTrades.filter(t => t.netPnlPct > 0).length;
  const longWR = longTrades.length > 0 ? (longWins / longTrades.length * 100) : 0;
  const shortWR = shortTrades.length > 0 ? (shortWins / shortTrades.length * 100) : 0;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Trades:       ${s.totalTrades}  (L: ${longTrades.length}, S: ${shortTrades.length})`);
  console.log(`  Win Rate:     ${s.winRate.toFixed(1)}%  (L: ${longWR.toFixed(1)}%, S: ${shortWR.toFixed(1)}%)`);
  console.log(`  ROI:          ${s.totalPnlPct.toFixed(1)}%`);
  console.log(`  Final Cap:    $${s.finalCapital.toFixed(0)}`);
  console.log(`  Sharpe:       ${s.sharpeRatio.toFixed(2)}`);
  console.log(`  Profit F:     ${s.profitFactor.toFixed(2)}`);
  console.log(`  Max DD:       ${s.maxDrawdownPct.toFixed(1)}%`);

  // Avg PnL per trade
  const avgPnl = s.totalTrades > 0 ? s.totalPnlPct / s.totalTrades : 0;
  console.log(`  Avg PnL/trade: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(3)}%`);
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  REGIME TIMEFRAME COMPARISON: Impact on Momentum Breakout Strategy  ║');
  console.log('║  Period: Jan 2025 - Feb 2026 (13 months)                            ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`\nSymbols: ${SYMBOLS.map(s => s.split('/')[0]).join(', ')}`);
  console.log(`Capital: $${PARAMS.initialCapital} | Leverage: ${PARAMS.leverage}x`);
  console.log(`\nConfigurations to test: ${CONFIGS.length}`);

  // Preload markets
  console.log('\nPreloading markets...');
  let ok = false;
  try { ok = await preloadMarkets(); } catch { ok = false; }
  if (!ok) {
    console.log('  API unavailable, using minimal markets...');
    initializeMinimalMarkets();
  }
  console.log('  Markets ready.\n');

  // Save original config values
  const origSmaPeriod = MomentumConfig.ENTRY.BTC_SMA_PERIOD;
  const origMtfLookback = MomentumConfig.MULTI_TIMEFRAME_FILTER.LOOKBACK_CANDLES;

  const results: { config: TestConfig; result: BacktestResult }[] = [];

  for (let i = 0; i < CONFIGS.length; i++) {
    const cfg = CONFIGS[i];
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`[${i + 1}/${CONFIGS.length}] Running: ${cfg.label}`);
    console.log(`  Regime TF: ${cfg.regimeTimeframeMinutes}m | SMA: ${cfg.smaPeriod} | MTF Lookback: ${cfg.mtfLookbackCandles} candles`);

    // Override MomentumConfig for this run
    (MomentumConfig.ENTRY as any).BTC_SMA_PERIOD = cfg.smaPeriod;
    (MomentumConfig.MULTI_TIMEFRAME_FILTER as any).LOOKBACK_CANDLES = cfg.mtfLookbackCandles;

    const t0 = Date.now();
    const result = await runBacktest({
      ...PARAMS,
      regimeTimeframeMinutes: cfg.regimeTimeframeMinutes,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  Done in ${elapsed}s — ${result.summary.totalTrades} trades, ${result.summary.winRate.toFixed(1)}% WR, ROI ${result.summary.totalPnlPct.toFixed(1)}%`);

    results.push({ config: cfg, result });
  }

  // Restore original config
  (MomentumConfig.ENTRY as any).BTC_SMA_PERIOD = origSmaPeriod;
  (MomentumConfig.MULTI_TIMEFRAME_FILTER as any).LOOKBACK_CANDLES = origMtfLookback;

  // ═══════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════

  console.log('\n\n');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║                         DETAILED RESULTS                            ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  for (const { config, result } of results) {
    printSummary(config.label, result);
  }

  // ═══════════════════════════════════════════════════════════════
  // COMPARISON TABLE
  // ═══════════════════════════════════════════════════════════════

  const baseline = results.find(r => r.config.regimeTimeframeMinutes === 60 && r.config.smaPeriod === 200);
  if (!baseline) {
    console.log('\nERROR: Baseline (1h SMA200) not found in results');
    return;
  }
  const bSum = baseline.result.summary;

  console.log('\n\n');
  console.log('╔══════════════════════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                                    COMPARISON TABLE (vs 1h SMA200 baseline)                            ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`${'Configuration'.padEnd(32)} ${'Trades'.padStart(7)} ${'WR%'.padStart(7)} ${'ROI%'.padStart(9)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD%'.padStart(7)} ${'ΔWR'.padStart(7)} ${'ΔROI'.padStart(9)} ${'ΔSharpe'.padStart(8)}`);
  console.log('─'.repeat(110));

  for (const { config, result } of results) {
    const s = result.summary;
    const isBaseline = config.regimeTimeframeMinutes === 60 && config.smaPeriod === 200;
    const deltaWR = (s.winRate - bSum.winRate);
    const deltaROI = (s.totalPnlPct - bSum.totalPnlPct);
    const deltaSharpe = (s.sharpeRatio - bSum.sharpeRatio);

    const marker = isBaseline ? ' <<<' : '';
    console.log(
      `${config.label.padEnd(32)} ` +
      `${s.totalTrades.toString().padStart(7)} ` +
      `${s.winRate.toFixed(1).padStart(6)}% ` +
      `${s.totalPnlPct.toFixed(1).padStart(8)}% ` +
      `${s.sharpeRatio.toFixed(2).padStart(7)} ` +
      `${s.profitFactor.toFixed(2).padStart(6)} ` +
      `${s.maxDrawdownPct.toFixed(1).padStart(6)}% ` +
      `${(deltaWR >= 0 ? '+' : '') + deltaWR.toFixed(1) + 'pp'}`.padStart(7) + ` ` +
      `${(deltaROI >= 0 ? '+' : '') + deltaROI.toFixed(0) + '%'}`.padStart(9) + ` ` +
      `${(deltaSharpe >= 0 ? '+' : '') + deltaSharpe.toFixed(2)}`.padStart(8) +
      marker
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // REGIME SWITCH ANALYSIS
  // ═══════════════════════════════════════════════════════════════

  console.log('\n\n');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║                    REGIME SWITCH ANALYSIS                           ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  for (const { config, result } of results) {
    const longTrades = result.trades.filter(t => t.side === 'long');
    const shortTrades = result.trades.filter(t => t.side === 'short');
    const longPnl = longTrades.reduce((s, t) => s + t.netPnlUsd, 0);
    const shortPnl = shortTrades.reduce((s, t) => s + t.netPnlUsd, 0);
    const longWR = longTrades.length > 0 ? longTrades.filter(t => t.netPnlPct > 0).length / longTrades.length * 100 : 0;
    const shortWR = shortTrades.length > 0 ? shortTrades.filter(t => t.netPnlPct > 0).length / shortTrades.length * 100 : 0;

    console.log(`\n  ${config.label}:`);
    console.log(`    LONG:  ${longTrades.length} trades, ${longWR.toFixed(1)}% WR, $${longPnl.toFixed(0)} PnL`);
    console.log(`    SHORT: ${shortTrades.length} trades, ${shortWR.toFixed(1)}% WR, $${shortPnl.toFixed(0)} PnL`);
    console.log(`    Ratio: ${longTrades.length > 0 && shortTrades.length > 0 ? (longTrades.length / shortTrades.length).toFixed(2) : 'N/A'} L/S`);
  }

  // ═══════════════════════════════════════════════════════════════
  // RECOMMENDATION
  // ═══════════════════════════════════════════════════════════════

  // Sort by ROI (primary), then Sharpe (secondary)
  const ranked = [...results].sort((a, b) => {
    const roiDiff = b.result.summary.totalPnlPct - a.result.summary.totalPnlPct;
    if (Math.abs(roiDiff) > 10) return roiDiff; // ROI difference > 10% → use ROI
    return b.result.summary.sharpeRatio - a.result.summary.sharpeRatio; // Close ROI → use Sharpe
  });

  console.log('\n\n');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║                         RANKING                                     ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  for (let i = 0; i < ranked.length; i++) {
    const { config, result } = ranked[i];
    const s = result.summary;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
    console.log(`  ${medal} #${i + 1}: ${config.label} — ROI ${s.totalPnlPct.toFixed(0)}%, WR ${s.winRate.toFixed(1)}%, Sharpe ${s.sharpeRatio.toFixed(2)}, DD ${s.maxDrawdownPct.toFixed(1)}%`);
  }

  const best = ranked[0];
  console.log(`\n  RECOMMENDATION: ${best.config.label}`);
  console.log(`  → Regime TF: ${best.config.regimeTimeframeMinutes}m, SMA: ${best.config.smaPeriod}, MTF Lookback: ${best.config.mtfLookbackCandles}`);
  if (best.config.regimeTimeframeMinutes !== 60 || best.config.smaPeriod !== 200) {
    console.log(`  → This differs from current production (1h SMA200)`);
  } else {
    console.log(`  → Current production config is already optimal`);
  }
}

main().catch(console.error);
