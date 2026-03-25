/**
 * optimize-symbol-allocation.ts — Multi-phase symbol allocation optimizer
 *
 * Phase 1: Per-symbol breakdown in COMBINED (multi-symbol) context
 * Phase 2: Incremental removal of worst performers
 * Phase 3: Capital scaling analysis
 * Phase 4: Tier A only vs Tier A+B comparison
 *
 * Usage:
 *   npx tsx scripts/optimize-symbol-allocation.ts
 *   npx tsx scripts/optimize-symbol-allocation.ts --phase 1       # Run only phase 1
 *   npx tsx scripts/optimize-symbol-allocation.ts --phase 1,2     # Run phases 1 and 2
 */
import { runBacktestComputation, type BacktestComputationInput, type BacktestResult, type BacktestTrade } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';

// ============================================================================
// CONFIG
// ============================================================================
const START_DATE = '2025-01-01';
const END_DATE = '2025-12-31';
const BASE_CAPITAL = 2000;
const LEVERAGE = 5;

// All 19 symbols from MomentumConfig.SYMBOLS
const ALL_SYMBOLS = MomentumConfig.SYMBOLS as string[];

// Tier A symbols
const TIER_A_SYMBOLS = MomentumConfig.SIGNAL_TIER_A as string[];

// CLI args
const args = process.argv.slice(2);
function getArg(name: string, def: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
}
const PHASES_TO_RUN = getArg('phase', '1,2,3,4').split(',').map(Number);

// ============================================================================
// HELPERS
// ============================================================================
function padR(s: string, n: number) { return s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length); }
function padL(s: string, n: number) { return s.length >= n ? s.substring(0, n) : ' '.repeat(n - s.length) + s; }
function shortName(sym: string) { return sym.replace('/USDT:USDT', ''); }
function fmt$(n: number) { return (n >= 0 ? '+' : '') + '$' + n.toFixed(0); }
function fmtPct(n: number) { return n.toFixed(1) + '%'; }

function printSeparator(title: string) {
  console.log('\n' + '='.repeat(120));
  console.log(`  ${title}`);
  console.log('='.repeat(120));
}

// ============================================================================
// DATA LOADING
// ============================================================================
interface LoadedData {
  btcCandles: BacktestCandle[];
  allData: Record<string, BacktestCandle[]>;
  CANDLE_REGIME_INTERVAL_MS: number;
}

async function loadData(symbols: string[]): Promise<LoadedData> {
  const startMs = new Date(START_DATE + 'T00:00:00.000Z').getTime();
  const endMs = new Date(END_DATE + 'T23:59:59.999Z').getTime();
  const extraBarsMs = 250 * 15 * 60 * 1000; // warmup
  const since = startMs - extraBarsMs;

  // Load BTC
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);

  // Load symbol data
  const allData: Record<string, BacktestCandle[]> = {};
  for (const symbol of symbols) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) {
      console.warn(`  WARNING: No local data for ${shortName(symbol)}, skipping`);
      continue;
    }
    const sliced = sliceCandlesByTime(local.candles, since, endMs);
    if (sliced.length < 300) {
      console.warn(`  WARNING: ${shortName(symbol)} only ${sliced.length} candles, skipping`);
      continue;
    }
    allData[symbol] = sliced;
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  return { btcCandles, allData, CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000 };
}

// ============================================================================
// RUN BACKTEST
// ============================================================================
async function runBT(data: LoadedData, symbols: string[], capital: number = BASE_CAPITAL): Promise<BacktestResult> {
  const startDate = new Date(START_DATE + 'T00:00:00.000Z');
  const endDate = new Date(END_DATE + 'T23:59:59.999Z');

  // Filter allData to only requested symbols that have data
  const filteredData: Record<string, BacktestCandle[]> = {};
  const validSymbols: string[] = [];
  for (const sym of symbols) {
    if (data.allData[sym]) {
      filteredData[sym] = data.allData[sym];
      validSymbols.push(sym);
    }
  }

  const input: BacktestComputationInput = {
    params: {
      startDate,
      endDate,
      initialCapital: capital,
      symbols: validSymbols,
      leverage: LEVERAGE,
      postProcess1m: false,
    },
    btcCandles: data.btcCandles,
    btcCandlesRegime: data.btcCandles, // 15m regime
    allData: filteredData,
    CANDLE_REGIME_INTERVAL_MS: data.CANDLE_REGIME_INTERVAL_MS,
  };

  return runBacktestComputation(input);
}

// ============================================================================
// PER-SYMBOL ANALYSIS FROM TRADES
// ============================================================================
interface SymbolBreakdown {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnlUsd: number;
  avgPnlPerTrade: number;
  longTrades: number;
  shortTrades: number;
  longPnl: number;
  shortPnl: number;
  avgHoldMin: number;
}

function analyzePerSymbol(trades: BacktestTrade[]): SymbolBreakdown[] {
  const bySymbol = new Map<string, BacktestTrade[]>();
  for (const t of trades) {
    const arr = bySymbol.get(t.symbol) || [];
    arr.push(t);
    bySymbol.set(t.symbol, arr);
  }

  const results: SymbolBreakdown[] = [];
  for (const [symbol, symTrades] of bySymbol) {
    const wins = symTrades.filter(t => t.netPnlUsd > 0).length;
    const losses = symTrades.length - wins;
    const pnlUsd = symTrades.reduce((s, t) => s + t.netPnlUsd, 0);
    const longTrades = symTrades.filter(t => t.side === 'long');
    const shortTrades = symTrades.filter(t => t.side === 'short');

    results.push({
      symbol: shortName(symbol),
      trades: symTrades.length,
      wins,
      losses,
      winRate: symTrades.length > 0 ? wins / symTrades.length * 100 : 0,
      pnlUsd,
      avgPnlPerTrade: symTrades.length > 0 ? pnlUsd / symTrades.length : 0,
      longTrades: longTrades.length,
      shortTrades: shortTrades.length,
      longPnl: longTrades.reduce((s, t) => s + t.netPnlUsd, 0),
      shortPnl: shortTrades.reduce((s, t) => s + t.netPnlUsd, 0),
      avgHoldMin: symTrades.length > 0 ? symTrades.reduce((s, t) => s + t.holdMinutes, 0) / symTrades.length : 0,
    });
  }

  results.sort((a, b) => b.pnlUsd - a.pnlUsd);
  return results;
}

// ============================================================================
// PHASE 1: Per-symbol breakdown in combined context
// ============================================================================
async function phase1(data: LoadedData): Promise<{ result: BacktestResult; breakdown: SymbolBreakdown[] }> {
  printSeparator('PHASE 1: Per-Symbol Breakdown in Combined Context (19 symbols)');

  console.log(`\nRunning combined backtest: ${ALL_SYMBOLS.length} symbols, $${BASE_CAPITAL}, ${LEVERAGE}x...`);
  const result = await runBT(data, ALL_SYMBOLS);
  const s = result.summary;

  console.log(`\n  Combined result: ${s.totalTrades} trades, ${fmtPct(s.winRate)} WR, ${fmt$(s.totalPnlUsd)} PnL, ${fmtPct(s.maxDrawdownPct)} DD, Sharpe ${s.sharpeRatio.toFixed(2)}`);

  const breakdown = analyzePerSymbol(result.trades);

  // Print per-symbol table
  console.log('\n  Per-symbol performance (in combined context):');
  const hdr = [
    padR('Symbol', 8), padL('Trades', 7), padL('Wins', 5), padL('WR%', 6),
    padL('PnL $', 10), padL('$/trade', 8), padL('L/S', 8),
    padL('L-PnL', 9), padL('S-PnL', 9), padL('Hold', 6),
  ].join(' | ');
  console.log('  ' + hdr);
  console.log('  ' + '-'.repeat(hdr.length));

  let positiveCount = 0;
  let negativeCount = 0;

  for (const r of breakdown) {
    const flag = r.pnlUsd > 0 ? '+' : '-';
    if (r.pnlUsd > 0) positiveCount++;
    else negativeCount++;

    console.log(`  ${flag} ${[
      padR(r.symbol, 7),
      padL(String(r.trades), 7),
      padL(String(r.wins), 5),
      padL(fmtPct(r.winRate), 6),
      padL(fmt$(r.pnlUsd), 10),
      padL(fmt$(r.avgPnlPerTrade), 8),
      padL(`${r.longTrades}/${r.shortTrades}`, 8),
      padL(fmt$(r.longPnl), 9),
      padL(fmt$(r.shortPnl), 9),
      padL(String(Math.round(r.avgHoldMin)) + 'm', 6),
    ].join(' | ')}`);
  }

  console.log('  ' + '-'.repeat(hdr.length));
  console.log(`  ${positiveCount} positive, ${negativeCount} negative symbols in combined context`);
  console.log(`  Total PnL: ${fmt$(s.totalPnlUsd)} | Note: combined context includes signal competition + capital allocation effects`);

  return { result, breakdown };
}

// ============================================================================
// PHASE 2: Incremental removal
// ============================================================================
interface RemovalStep {
  step: number;
  removedSymbol: string;
  remainingCount: number;
  remainingSymbols: string[];
  totalPnl: number;
  delta: number;
  winRate: number;
  trades: number;
  maxDD: number;
  sharpe: number;
}

async function phase2(data: LoadedData, breakdown: SymbolBreakdown[]): Promise<RemovalStep[]> {
  printSeparator('PHASE 2: Incremental Removal of Worst Performers');

  // Start with all symbols, remove worst one at a time
  let currentSymbols = [...ALL_SYMBOLS];
  const steps: RemovalStep[] = [];

  // Baseline
  console.log(`\n  Step 0: All ${currentSymbols.length} symbols (baseline)...`);
  let prevResult = await runBT(data, currentSymbols);
  let prevPnl = prevResult.summary.totalPnlUsd;

  steps.push({
    step: 0,
    removedSymbol: '(baseline)',
    remainingCount: currentSymbols.length,
    remainingSymbols: currentSymbols.map(shortName),
    totalPnl: prevPnl,
    delta: 0,
    winRate: prevResult.summary.winRate,
    trades: prevResult.summary.totalTrades,
    maxDD: prevResult.summary.maxDrawdownPct,
    sharpe: prevResult.summary.sharpeRatio,
  });

  console.log(`    ${prevResult.summary.totalTrades} trades, ${fmtPct(prevResult.summary.winRate)} WR, ${fmt$(prevPnl)} PnL, Sharpe ${prevResult.summary.sharpeRatio.toFixed(2)}`);

  // Remove worst performer one at a time until 5 remain
  const MIN_SYMBOLS = 5;
  while (currentSymbols.length > MIN_SYMBOLS) {
    // Analyze current trades to find worst performer
    const currentBreakdown = analyzePerSymbol(prevResult.trades);

    // Find the worst performer (lowest PnL)
    const worst = currentBreakdown[currentBreakdown.length - 1];
    if (!worst) break;

    // Find the full symbol name to remove
    const worstFull = currentSymbols.find(s => shortName(s) === worst.symbol);
    if (!worstFull) break;

    currentSymbols = currentSymbols.filter(s => s !== worstFull);
    const stepNum = steps.length;

    console.log(`  Step ${stepNum}: Remove ${worst.symbol} (${fmt$(worst.pnlUsd)}, ${fmtPct(worst.winRate)} WR)...`);

    const result = await runBT(data, currentSymbols);
    const pnl = result.summary.totalPnlUsd;
    const delta = pnl - prevPnl;

    steps.push({
      step: stepNum,
      removedSymbol: worst.symbol,
      remainingCount: currentSymbols.length,
      remainingSymbols: currentSymbols.map(shortName),
      totalPnl: pnl,
      delta,
      winRate: result.summary.winRate,
      trades: result.summary.totalTrades,
      maxDD: result.summary.maxDrawdownPct,
      sharpe: result.summary.sharpeRatio,
    });

    console.log(`    ${result.summary.totalTrades} trades, ${fmtPct(result.summary.winRate)} WR, ${fmt$(pnl)} PnL (${delta >= 0 ? '+' : ''}$${delta.toFixed(0)}), Sharpe ${result.summary.sharpeRatio.toFixed(2)}`);

    prevResult = result;
    prevPnl = pnl;
  }

  // Print summary table
  console.log('\n  Incremental Removal Summary:');
  const hdr = [
    padL('Step', 5), padR('Removed', 10), padL('#Sym', 5), padL('Trades', 7),
    padL('WR%', 6), padL('PnL $', 10), padL('Delta $', 9), padL('DD%', 6), padL('Sharpe', 7),
  ].join(' | ');
  console.log('  ' + hdr);
  console.log('  ' + '-'.repeat(hdr.length));

  let bestStep = steps[0];
  for (const step of steps) {
    if (step.totalPnl > bestStep.totalPnl) bestStep = step;

    const deltaStr = step.delta >= 0 ? `+$${step.delta.toFixed(0)}` : `-$${Math.abs(step.delta).toFixed(0)}`;
    console.log(`  ${[
      padL(String(step.step), 5),
      padR(step.removedSymbol, 10),
      padL(String(step.remainingCount), 5),
      padL(String(step.trades), 7),
      padL(fmtPct(step.winRate), 6),
      padL(fmt$(step.totalPnl), 10),
      padL(deltaStr, 9),
      padL(fmtPct(step.maxDD), 6),
      padL(step.sharpe.toFixed(2), 7),
    ].join(' | ')}`);
  }

  console.log('  ' + '-'.repeat(hdr.length));
  console.log(`\n  BEST STEP: Step ${bestStep.step} with ${bestStep.remainingCount} symbols (${fmt$(bestStep.totalPnl)} PnL, Sharpe ${bestStep.sharpe.toFixed(2)})`);
  console.log(`  Symbols: ${bestStep.remainingSymbols.join(', ')}`);

  return steps;
}

// ============================================================================
// PHASE 3: Capital scaling
// ============================================================================
interface CapitalResult {
  capital: number;
  pnlUsd: number;
  roiPct: number;
  trades: number;
  winRate: number;
  maxDD: number;
  sharpe: number;
  finalCapital: number;
}

async function phase3(data: LoadedData, bestSymbols: string[]): Promise<CapitalResult[]> {
  printSeparator('PHASE 3: Capital Scaling Analysis');

  const capitalLevels = [2000, 5000, 10000, 20000];
  const results: CapitalResult[] = [];

  console.log(`\n  Testing with best symbol set: ${bestSymbols.map(shortName).join(', ')}`);
  console.log(`  Leverage: ${LEVERAGE}x, Period: ${START_DATE} to ${END_DATE}\n`);

  for (const capital of capitalLevels) {
    console.log(`  $${capital.toLocaleString()}...`);
    const result = await runBT(data, bestSymbols, capital);
    const s = result.summary;

    const entry: CapitalResult = {
      capital,
      pnlUsd: s.totalPnlUsd,
      roiPct: s.totalPnlUsd / capital * 100,
      trades: s.totalTrades,
      winRate: s.winRate,
      maxDD: s.maxDrawdownPct,
      sharpe: s.sharpeRatio,
      finalCapital: s.finalCapital,
    };
    results.push(entry);

    console.log(`    ${s.totalTrades} trades, ${fmtPct(s.winRate)} WR, ${fmt$(s.totalPnlUsd)} PnL (${fmtPct(entry.roiPct)} ROI), DD ${fmtPct(s.maxDrawdownPct)}`);
  }

  // Print table
  console.log('\n  Capital Scaling Results:');
  const hdr = [
    padL('Capital', 10), padL('Trades', 7), padL('WR%', 6), padL('PnL $', 12),
    padL('ROI%', 10), padL('DD%', 6), padL('Sharpe', 7), padL('Final $', 12),
  ].join(' | ');
  console.log('  ' + hdr);
  console.log('  ' + '-'.repeat(hdr.length));

  for (const r of results) {
    console.log(`  ${[
      padL('$' + r.capital.toLocaleString(), 10),
      padL(String(r.trades), 7),
      padL(fmtPct(r.winRate), 6),
      padL(fmt$(r.pnlUsd), 12),
      padL(fmtPct(r.roiPct), 10),
      padL(fmtPct(r.maxDD), 6),
      padL(r.sharpe.toFixed(2), 7),
      padL('$' + r.finalCapital.toLocaleString(undefined, { maximumFractionDigits: 0 }), 12),
    ].join(' | ')}`);
  }

  // Scaling analysis
  if (results.length >= 2) {
    console.log('\n  Scaling Analysis:');
    const base = results[0];
    for (let i = 1; i < results.length; i++) {
      const r = results[i];
      const capitalMultiple = r.capital / base.capital;
      const pnlMultiple = r.pnlUsd / (base.pnlUsd || 1);
      const tradeMultiple = r.trades / (base.trades || 1);
      console.log(`    $${r.capital.toLocaleString()} (${capitalMultiple}x capital): PnL ${pnlMultiple.toFixed(2)}x, Trades ${tradeMultiple.toFixed(2)}x, ROI delta ${(r.roiPct - base.roiPct).toFixed(1)}pp`);
    }
  }

  return results;
}

// ============================================================================
// PHASE 4: Tier A only vs Tier A+B
// ============================================================================
interface TierComparison {
  label: string;
  symbols: string[];
  trades: number;
  winRate: number;
  pnlUsd: number;
  maxDD: number;
  sharpe: number;
  profitFactor: number;
  avgPnlPerTrade: number;
}

async function phase4(data: LoadedData, bestSubsetSymbols: string[]): Promise<TierComparison[]> {
  printSeparator('PHASE 4: Tier A Only vs Tier A+B vs Best Subset');

  const configs: { label: string; symbols: string[] }[] = [
    { label: 'Tier A only (9)', symbols: TIER_A_SYMBOLS },
    { label: `All 19 (A+B)`, symbols: ALL_SYMBOLS },
    { label: `Best subset (${bestSubsetSymbols.length})`, symbols: bestSubsetSymbols },
  ];

  const results: TierComparison[] = [];

  for (const config of configs) {
    console.log(`\n  ${config.label}: ${config.symbols.map(shortName).join(', ')}...`);
    const result = await runBT(data, config.symbols);
    const s = result.summary;

    results.push({
      label: config.label,
      symbols: config.symbols,
      trades: s.totalTrades,
      winRate: s.winRate,
      pnlUsd: s.totalPnlUsd,
      maxDD: s.maxDrawdownPct,
      sharpe: s.sharpeRatio,
      profitFactor: s.profitFactor,
      avgPnlPerTrade: s.totalTrades > 0 ? s.totalPnlUsd / s.totalTrades : 0,
    });

    console.log(`    ${s.totalTrades} trades, ${fmtPct(s.winRate)} WR, ${fmt$(s.totalPnlUsd)} PnL, DD ${fmtPct(s.maxDrawdownPct)}, Sharpe ${s.sharpeRatio.toFixed(2)}, PF ${s.profitFactor.toFixed(2)}`);
  }

  // Print comparison table
  console.log('\n  Tier Comparison:');
  const hdr = [
    padR('Config', 22), padL('Trades', 7), padL('WR%', 6), padL('PnL $', 10),
    padL('$/trade', 8), padL('DD%', 6), padL('Sharpe', 7), padL('PF', 5),
  ].join(' | ');
  console.log('  ' + hdr);
  console.log('  ' + '-'.repeat(hdr.length));

  for (const r of results) {
    console.log(`  ${[
      padR(r.label, 22),
      padL(String(r.trades), 7),
      padL(fmtPct(r.winRate), 6),
      padL(fmt$(r.pnlUsd), 10),
      padL(fmt$(r.avgPnlPerTrade), 8),
      padL(fmtPct(r.maxDD), 6),
      padL(r.sharpe.toFixed(2), 7),
      padL(r.profitFactor.toFixed(2), 5),
    ].join(' | ')}`);
  }

  // Analysis
  console.log('\n  Key Insights:');
  if (results.length >= 2) {
    const tierA = results[0];
    const allAB = results[1];
    const tradeGain = allAB.trades - tierA.trades;
    const pnlDelta = allAB.pnlUsd - tierA.pnlUsd;
    console.log(`    Tier B adds ${tradeGain} trades (${tierA.trades} -> ${allAB.trades})`);
    console.log(`    Tier B PnL contribution: ${fmt$(pnlDelta)} (${pnlDelta >= 0 ? 'positive' : 'NEGATIVE'} value)`);
    console.log(`    Tier A WR ${fmtPct(tierA.winRate)} vs All ${fmtPct(allAB.winRate)} (${(allAB.winRate - tierA.winRate).toFixed(1)}pp delta)`);
    console.log(`    Tier A Sharpe ${tierA.sharpe.toFixed(2)} vs All ${allAB.sharpe.toFixed(2)}`);

    if (results[2]) {
      const best = results[2];
      console.log(`\n    Best subset (${best.symbols.length} symbols):`);
      console.log(`      vs Tier A: ${fmt$(best.pnlUsd - tierA.pnlUsd)} PnL, ${(best.sharpe - tierA.sharpe).toFixed(2)} Sharpe`);
      console.log(`      vs All 19: ${fmt$(best.pnlUsd - allAB.pnlUsd)} PnL, ${(best.sharpe - allAB.sharpe).toFixed(2)} Sharpe`);
    }
  }

  return results;
}

// ============================================================================
// FINAL RECOMMENDATION
// ============================================================================
function printRecommendation(
  steps: RemovalStep[],
  tierComparisons: TierComparison[],
  capitalResults: CapitalResult[],
) {
  printSeparator('FINAL RECOMMENDATION');

  // Find best step by Sharpe (risk-adjusted)
  let bestBySharpe = steps[0];
  let bestByPnl = steps[0];
  for (const step of steps) {
    if (step.sharpe > bestBySharpe.sharpe) bestBySharpe = step;
    if (step.totalPnl > bestByPnl.totalPnl) bestByPnl = step;
  }

  console.log('\n  BEST BY SHARPE (risk-adjusted):');
  console.log(`    ${bestBySharpe.remainingCount} symbols: ${bestBySharpe.remainingSymbols.join(', ')}`);
  console.log(`    PnL: ${fmt$(bestBySharpe.totalPnl)}, WR: ${fmtPct(bestBySharpe.winRate)}, DD: ${fmtPct(bestBySharpe.maxDD)}, Sharpe: ${bestBySharpe.sharpe.toFixed(2)}`);

  if (bestByPnl.step !== bestBySharpe.step) {
    console.log('\n  BEST BY PNL (absolute return):');
    console.log(`    ${bestByPnl.remainingCount} symbols: ${bestByPnl.remainingSymbols.join(', ')}`);
    console.log(`    PnL: ${fmt$(bestByPnl.totalPnl)}, WR: ${fmtPct(bestByPnl.winRate)}, DD: ${fmtPct(bestByPnl.maxDD)}, Sharpe: ${bestByPnl.sharpe.toFixed(2)}`);
  }

  // Tier comparison summary
  if (tierComparisons.length >= 2) {
    const tierA = tierComparisons[0];
    const all = tierComparisons[1];
    console.log('\n  TIER ANALYSIS:');
    if (tierA.sharpe > all.sharpe) {
      console.log(`    Tier A only is BETTER risk-adjusted (Sharpe ${tierA.sharpe.toFixed(2)} vs ${all.sharpe.toFixed(2)})`);
      if (all.pnlUsd > tierA.pnlUsd) {
        console.log(`    But All 19 has MORE absolute PnL (${fmt$(all.pnlUsd)} vs ${fmt$(tierA.pnlUsd)})`);
        console.log(`    Trade-off: ${fmt$(all.pnlUsd - tierA.pnlUsd)} extra PnL at the cost of ${(tierA.sharpe - all.sharpe).toFixed(2)} Sharpe`);
      }
    } else {
      console.log(`    All 19 is BETTER overall (Sharpe ${all.sharpe.toFixed(2)} vs ${tierA.sharpe.toFixed(2)}, PnL ${fmt$(all.pnlUsd)} vs ${fmt$(tierA.pnlUsd)})`);
    }
  }

  // Capital scaling insight
  if (capitalResults.length >= 2) {
    const baseROI = capitalResults[0].roiPct;
    const topROI = capitalResults[capitalResults.length - 1].roiPct;
    console.log('\n  CAPITAL SCALING:');
    if (topROI > baseROI * 0.9) {
      console.log(`    ROI scales well: $${capitalResults[0].capital} -> ${fmtPct(baseROI)}, $${capitalResults[capitalResults.length - 1].capital} -> ${fmtPct(topROI)}`);
      console.log(`    Strategy maintains edge at higher capital levels`);
    } else {
      console.log(`    ROI degrades at scale: $${capitalResults[0].capital} -> ${fmtPct(baseROI)}, $${capitalResults[capitalResults.length - 1].capital} -> ${fmtPct(topROI)}`);
      console.log(`    Diminishing returns — capital constraints limit position count`);
    }
  }

  console.log('\n  RECOMMENDATION:');
  console.log(`    Use ${bestBySharpe.remainingCount} symbols for best risk-adjusted returns:`);
  console.log(`    ${bestBySharpe.remainingSymbols.join(', ')}`);
  console.log(`    Expected: ${fmt$(bestBySharpe.totalPnl)} PnL, ${fmtPct(bestBySharpe.winRate)} WR, ${fmtPct(bestBySharpe.maxDD)} DD on $${BASE_CAPITAL} at ${LEVERAGE}x`);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('================================================================');
  console.log('  Symbol Allocation Optimizer');
  console.log(`  Period: ${START_DATE} to ${END_DATE}`);
  console.log(`  Base Capital: $${BASE_CAPITAL}, Leverage: ${LEVERAGE}x`);
  console.log(`  Symbols: ${ALL_SYMBOLS.length} (${TIER_A_SYMBOLS.length} Tier A + ${ALL_SYMBOLS.length - TIER_A_SYMBOLS.length} Tier B)`);
  console.log(`  Phases: ${PHASES_TO_RUN.join(', ')}`);
  console.log('================================================================');

  console.log('\nLoading market data...');
  const data = await loadData(ALL_SYMBOLS);
  const loadedSymbols = Object.keys(data.allData);
  console.log(`  BTC 15m: ${data.btcCandles.length} candles`);
  console.log(`  Loaded: ${loadedSymbols.length}/${ALL_SYMBOLS.length} symbols`);

  let breakdown: SymbolBreakdown[] = [];
  let steps: RemovalStep[] = [];
  let capitalResults: CapitalResult[] = [];
  let tierComparisons: TierComparison[] = [];

  // Phase 1
  if (PHASES_TO_RUN.includes(1)) {
    const p1 = await phase1(data);
    breakdown = p1.breakdown;
  }

  // Phase 2
  if (PHASES_TO_RUN.includes(2)) {
    // If phase 1 wasn't run, do a quick baseline to get breakdown
    if (breakdown.length === 0) {
      console.log('\nRunning baseline backtest for phase 2...');
      const baseResult = await runBT(data, ALL_SYMBOLS);
      breakdown = analyzePerSymbol(baseResult.trades);
    }
    steps = await phase2(data, breakdown);
  }

  // Find the best symbol set from phase 2 (or use all if phase 2 wasn't run)
  let bestSymbols = ALL_SYMBOLS;
  if (steps.length > 0) {
    let bestStep = steps[0];
    for (const step of steps) {
      if (step.sharpe > bestStep.sharpe) bestStep = step;
    }
    // Convert short names back to full symbol names
    bestSymbols = bestStep.remainingSymbols.map(sn =>
      ALL_SYMBOLS.find(s => shortName(s) === sn) || `${sn}/USDT:USDT`
    );
  }

  // Phase 3
  if (PHASES_TO_RUN.includes(3)) {
    capitalResults = await phase3(data, bestSymbols);
  }

  // Phase 4
  if (PHASES_TO_RUN.includes(4)) {
    tierComparisons = await phase4(data, bestSymbols);
  }

  // Final recommendation
  if (steps.length > 0 || tierComparisons.length > 0) {
    printRecommendation(steps, tierComparisons, capitalResults);
  }

  console.log('\n\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
