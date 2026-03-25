/**
 * analyze-h1h2-symbols.ts — H1/H2 2025 cross-validation for symbol selection
 *
 * Tests ALL symbols individually on H1 (Jan-Jun) and H2 (Jul-Dec) 2025.
 * Identifies symbols that are consistently profitable in BOTH halves.
 * Then runs combined multi-symbol backtests to measure real portfolio PnL
 * (accounting for signal competition when capital is limited).
 *
 * Usage:
 *   npx tsx scripts/analyze-h1h2-symbols.ts
 */
import { runBacktestComputation, type BacktestComputationInput } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// CONFIG
// ============================================================================
const H1 = { start: '2025-01-01', end: '2025-06-30', label: 'H1 (Jan-Jun)' };
const H2 = { start: '2025-07-01', end: '2025-12-31', label: 'H2 (Jul-Dec)' };
const INITIAL_CAPITAL = 2000;
const LEVERAGE = 5;

// Thresholds for "consistent" symbol
const MIN_SHARPE_BOTH = 1.0;   // Sharpe >= 1 in BOTH halves
const MIN_PF_BOTH = 1.1;       // PF >= 1.1 in BOTH halves
const MIN_TRADES = 20;          // At least 20 trades per half

// ============================================================================
// HELPERS
// ============================================================================
function padR(s: string, n: number) { return s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length); }
function padL(s: string, n: number) { return s.length >= n ? s.substring(0, n) : ' '.repeat(n - s.length) + s; }

// ============================================================================
// LOAD DATA
// ============================================================================
async function loadAllSymbolData(startMs: number, endMs: number) {
  const extraBarsMs = 250 * 15 * 60 * 1000;
  const since = startMs - extraBarsMs;

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);

  const dataDir = path.resolve(process.cwd(), 'data');
  const data2024Dir = path.resolve(process.cwd(), 'data', '2024');
  const symbolFiles = new Map<string, string>();

  for (const f of fs.readdirSync(dataDir)) {
    const m = f.match(/^([A-Z]+_USDT)_15m\.json$/);
    if (m) {
      const sym = m[1].replace('_', '/') + ':USDT';
      symbolFiles.set(sym, path.join(dataDir, f));
    }
  }
  if (fs.existsSync(data2024Dir)) {
    for (const f of fs.readdirSync(data2024Dir)) {
      const m = f.match(/^([A-Z]+_USDT)_15m\.json$/);
      if (m) {
        const sym = m[1].replace('_', '/') + ':USDT';
        if (!symbolFiles.has(sym)) {
          symbolFiles.set(sym, path.join(data2024Dir, f));
        }
      }
    }
  }

  const allData: Record<string, BacktestCandle[]> = {};
  const available: string[] = [];

  for (const [symbol, filepath] of symbolFiles) {
    if (symbol === 'BTC/USDT:USDT') continue;
    try {
      const raw = fs.readFileSync(filepath, 'utf8');
      const json = JSON.parse(raw);
      if (!Array.isArray(json) || json.length < 100) continue;
      const candles: BacktestCandle[] = json
        .filter((c: any) => c.openTime && c.open && c.close)
        .map((c: any) => ({
          timestamp: c.openTime,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume || 0),
        }))
        .sort((a: BacktestCandle, b: BacktestCandle) => a.timestamp - b.timestamp);

      const sliced = sliceCandlesByTime(candles, since, endMs);
      if (sliced.length < 300) continue;
      allData[symbol] = sliced;
      available.push(symbol);
    } catch { /* skip */ }
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  return { btcCandles, allData, available, CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000 };
}

// ============================================================================
// PER-SYMBOL BACKTEST
// ============================================================================
interface SymbolHalfResult {
  symbol: string;
  trades: number;
  winRate: number;
  pnlUsd: number;
  pnlPerTrade: number;
  maxDD: number;
  sharpe: number;
  profitFactor: number;
  roi: number;
}

async function runPerSymbolHalf(
  data: Awaited<ReturnType<typeof loadAllSymbolData>>,
  period: { start: string; end: string; label: string },
): Promise<SymbolHalfResult[]> {
  const startDate = new Date(period.start + 'T00:00:00.000Z');
  const endDate = new Date(period.end + 'T23:59:59.999Z');
  const results: SymbolHalfResult[] = [];

  for (let i = 0; i < data.available.length; i++) {
    const symbol = data.available[i];
    const symData: Record<string, BacktestCandle[]> = { [symbol]: data.allData[symbol] };

    const input: BacktestComputationInput = {
      params: { startDate, endDate, initialCapital: INITIAL_CAPITAL, symbols: [symbol], leverage: LEVERAGE },
      btcCandles: data.btcCandles,
      btcCandlesRegime: data.btcCandles,
      allData: symData,
      CANDLE_REGIME_INTERVAL_MS: data.CANDLE_REGIME_INTERVAL_MS,
    };

    const result = await runBacktestComputation(input);
    const s = result.summary;
    const shortName = symbol.replace('/USDT:USDT', '');

    results.push({
      symbol: shortName,
      trades: s.totalTrades,
      winRate: s.winRate,
      pnlUsd: s.totalPnlUsd,
      pnlPerTrade: s.totalTrades > 0 ? s.totalPnlUsd / s.totalTrades : 0,
      maxDD: s.maxDrawdownPct,
      sharpe: s.sharpeRatio,
      profitFactor: s.profitFactor,
      roi: INITIAL_CAPITAL > 0 ? s.totalPnlUsd / INITIAL_CAPITAL * 100 : 0,
    });

    process.stdout.write(`  [${i + 1}/${data.available.length}] ${padR(shortName, 8)} ${s.totalTrades}tr $${s.totalPnlUsd.toFixed(0)} ${s.winRate.toFixed(1)}%WR Sh=${s.sharpeRatio.toFixed(2)}\n`);
  }

  return results;
}

// ============================================================================
// COMBINED MULTI-SYMBOL BACKTEST
// ============================================================================
async function runCombined(
  data: Awaited<ReturnType<typeof loadAllSymbolData>>,
  symbols: string[],
  period: { start: string; end: string },
  label: string,
) {
  const startDate = new Date(period.start + 'T00:00:00.000Z');
  const endDate = new Date(period.end + 'T23:59:59.999Z');

  const fullSymbols = symbols.map(s => s.includes('/') ? s : `${s}/USDT:USDT`);
  const symData: Record<string, BacktestCandle[]> = {};
  for (const sym of fullSymbols) {
    if (data.allData[sym]) symData[sym] = data.allData[sym];
  }

  const input: BacktestComputationInput = {
    params: { startDate, endDate, initialCapital: INITIAL_CAPITAL, symbols: fullSymbols, leverage: LEVERAGE },
    btcCandles: data.btcCandles,
    btcCandlesRegime: data.btcCandles,
    allData: symData,
    CANDLE_REGIME_INTERVAL_MS: data.CANDLE_REGIME_INTERVAL_MS,
  };

  const result = await runBacktestComputation(input);
  const s = result.summary;
  console.log(`  ${padR(label, 30)} ${s.totalTrades}tr $${s.totalPnlUsd.toFixed(0)} ${s.winRate.toFixed(1)}%WR Sh=${s.sharpeRatio.toFixed(2)} PF=${s.profitFactor.toFixed(2)} DD=${s.maxDrawdownPct.toFixed(1)}%`);
  return { trades: s.totalTrades, pnl: s.totalPnlUsd, wr: s.winRate, sharpe: s.sharpeRatio, pf: s.profitFactor, dd: s.maxDrawdownPct };
}

// ============================================================================
// ANALYSIS
// ============================================================================
function analyzeH1H2(h1: SymbolHalfResult[], h2: SymbolHalfResult[]) {
  // Build lookup
  const h2Map = new Map(h2.map(r => [r.symbol, r]));

  // All symbols that exist in both halves
  const allSymbols = h1.filter(r => h2Map.has(r.symbol));

  // Sort by average PnL
  allSymbols.sort((a, b) => {
    const aAvg = (a.pnlUsd + (h2Map.get(a.symbol)!.pnlUsd)) / 2;
    const bAvg = (b.pnlUsd + (h2Map.get(b.symbol)!.pnlUsd)) / 2;
    return bAvg - aAvg;
  });

  // Print header
  console.log('\n' + '='.repeat(150));
  console.log('H1 vs H2 COMPARISON — Per-Symbol');
  console.log('='.repeat(150));
  console.log([
    padR('Symbol', 8), '|',
    padR('--- H1 (Jan-Jun) ---', 45), '|',
    padR('--- H2 (Jul-Dec) ---', 45), '|',
    padR('Consistency', 12),
  ].join(' '));
  console.log([
    padR('', 8), '|',
    padL('Trades', 6), padL('PnL$', 8), padL('WR%', 6), padL('Sharpe', 7), padL('PF', 5), padL('DD%', 6), '     |',
    padL('Trades', 6), padL('PnL$', 8), padL('WR%', 6), padL('Sharpe', 7), padL('PF', 5), padL('DD%', 6), '     |',
    padR('', 12),
  ].join(' '));
  console.log('-'.repeat(150));

  const consistent: string[] = [];
  const goodH1only: string[] = [];
  const goodH2only: string[] = [];
  const bad: string[] = [];

  for (const r1 of allSymbols) {
    const r2 = h2Map.get(r1.symbol)!;

    const h1Good = r1.sharpe >= MIN_SHARPE_BOTH && r1.profitFactor >= MIN_PF_BOTH && r1.trades >= MIN_TRADES;
    const h2Good = r2.sharpe >= MIN_SHARPE_BOTH && r2.profitFactor >= MIN_PF_BOTH && r2.trades >= MIN_TRADES;

    let flag: string;
    if (h1Good && h2Good) {
      flag = 'CONSISTENT';
      consistent.push(r1.symbol);
    } else if (h1Good && !h2Good) {
      flag = 'H1-only';
      goodH1only.push(r1.symbol);
    } else if (!h1Good && h2Good) {
      flag = 'H2-only';
      goodH2only.push(r1.symbol);
    } else {
      flag = r1.pnlUsd > 0 && r2.pnlUsd > 0 ? 'MARGINAL' : 'AVOID';
      bad.push(r1.symbol);
    }

    const line = [
      padR(r1.symbol, 8), '|',
      padL(String(r1.trades), 6),
      padL('$' + r1.pnlUsd.toFixed(0), 8),
      padL(r1.winRate.toFixed(1), 6),
      padL(r1.sharpe.toFixed(2), 7),
      padL(r1.profitFactor.toFixed(2), 5),
      padL(r1.maxDD.toFixed(1), 6), '     |',
      padL(String(r2.trades), 6),
      padL('$' + r2.pnlUsd.toFixed(0), 8),
      padL(r2.winRate.toFixed(1), 6),
      padL(r2.sharpe.toFixed(2), 7),
      padL(r2.profitFactor.toFixed(2), 5),
      padL(r2.maxDD.toFixed(1), 6), '     |',
      padR(flag, 12),
    ].join(' ');
    console.log(line);
  }

  console.log('-'.repeat(150));
  console.log(`\nCONSISTENT (good BOTH halves): ${consistent.join(', ') || 'none'}`);
  console.log(`H1-only (good H1, weak H2):    ${goodH1only.join(', ') || 'none'}`);
  console.log(`H2-only (weak H1, good H2):    ${goodH2only.join(', ') || 'none'}`);
  console.log(`AVOID/MARGINAL:                ${bad.join(', ') || 'none'}`);

  return { consistent, goodH1only, goodH2only, bad };
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('=== H1/H2 2025 Symbol Cross-Validation ===\n');
  console.log(`Config: $${INITIAL_CAPITAL} capital, ${LEVERAGE}x leverage`);
  console.log(`Consistent threshold: Sharpe >= ${MIN_SHARPE_BOTH}, PF >= ${MIN_PF_BOTH}, Trades >= ${MIN_TRADES}\n`);

  // Load all data (full year range for warmup)
  const fullStart = new Date('2025-01-01T00:00:00.000Z');
  const fullEnd = new Date('2025-12-31T23:59:59.999Z');
  console.log('Loading ALL available symbol data...');
  const data = await loadAllSymbolData(fullStart.getTime(), fullEnd.getTime());
  console.log(`  BTC 15m: ${data.btcCandles.length} candles`);
  console.log(`  Symbols: ${data.available.length} → ${data.available.map(s => s.replace('/USDT:USDT', '')).join(', ')}\n`);

  // ====== PHASE 1: Per-symbol H1 ======
  console.log(`\n${'='.repeat(60)}`);
  console.log(`PHASE 1: Per-symbol backtests — ${H1.label}`);
  console.log('='.repeat(60));
  const h1Results = await runPerSymbolHalf(data, H1);

  // ====== PHASE 2: Per-symbol H2 ======
  console.log(`\n${'='.repeat(60)}`);
  console.log(`PHASE 2: Per-symbol backtests — ${H2.label}`);
  console.log('='.repeat(60));
  const h2Results = await runPerSymbolHalf(data, H2);

  // ====== PHASE 3: Comparison ======
  console.log(`\n${'='.repeat(60)}`);
  console.log('PHASE 3: Cross-validation');
  console.log('='.repeat(60));
  const { consistent, goodH1only, goodH2only } = analyzeH1H2(h1Results, h2Results);

  // ====== PHASE 4: Combined multi-symbol backtests ======
  console.log(`\n${'='.repeat(60)}`);
  console.log('PHASE 4: Combined multi-symbol backtests (signal competition)');
  console.log('='.repeat(60));
  console.log('(Multi-symbol = capital shared, signals compete for limited slots)\n');

  // Current 19 (Tier A+B from V5.130)
  const current19 = ['WIF', 'UNI', 'FET', 'STX', 'IMX', 'ARB', 'SEI', 'SUI', 'NEAR',
    'ADA', 'APT', 'ETH', 'SONIC', 'RENDER', 'XRP', 'DOGE', 'DOT', 'BCH', 'SOL'];

  // Current Tier A only (9)
  const tierA = ['WIF', 'UNI', 'FET', 'STX', 'IMX', 'ARB', 'SEI', 'SUI', 'NEAR'];

  // Consistently good (from our analysis)
  const consistentSyms = consistent;

  // Consistent + H1-only (might still be valuable)
  const consistentPlusH1 = [...consistent, ...goodH1only];

  // Consistent + H2-only (more recent performance)
  const consistentPlusH2 = [...consistent, ...goodH2only];

  const portfolios: { label: string; symbols: string[] }[] = [
    { label: 'Current 19 (V5.130)', symbols: current19 },
    { label: 'Current Tier A (9)', symbols: tierA },
    { label: 'CONSISTENT only', symbols: consistentSyms },
    { label: 'CONSISTENT + H1-only', symbols: consistentPlusH1 },
    { label: 'CONSISTENT + H2-only', symbols: consistentPlusH2 },
  ];

  // Remove duplicate portfolios (if consistent includes all)
  const seen = new Set<string>();

  console.log('--- Full Year (Jan-Dec 2025) ---\n');
  for (const p of portfolios) {
    const key = p.symbols.sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    if (p.symbols.length === 0) { console.log(`  ${padR(p.label, 30)} (empty)`); continue; }
    await runCombined(data, p.symbols, { start: '2025-01-01', end: '2025-12-31' }, `${p.label} (${p.symbols.length}sym)`);
  }

  // Also test on H2 specifically (OOS for H1-selected portfolios)
  console.log('\n--- H2 only (Jul-Dec 2025) = Out-of-sample for H1-based selection ---\n');
  seen.clear();
  for (const p of portfolios) {
    const key = p.symbols.sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    if (p.symbols.length === 0) { console.log(`  ${padR(p.label, 30)} (empty)`); continue; }
    await runCombined(data, p.symbols, { start: '2025-07-01', end: '2025-12-31' }, `${p.label} (${p.symbols.length}sym)`);
  }

  // ====== PHASE 5: Top-N symbol selection ======
  console.log(`\n${'='.repeat(60)}`);
  console.log('PHASE 5: Optimal portfolio size (top N by avg Sharpe)');
  console.log('='.repeat(60));

  // Rank symbols by average Sharpe across H1+H2
  const h2Map = new Map(h2Results.map(r => [r.symbol, r]));
  const ranked = h1Results
    .filter(r => h2Map.has(r.symbol) && r.trades >= MIN_TRADES && h2Map.get(r.symbol)!.trades >= MIN_TRADES)
    .map(r => ({
      symbol: r.symbol,
      avgSharpe: (r.sharpe + h2Map.get(r.symbol)!.sharpe) / 2,
      avgPnl: (r.pnlUsd + h2Map.get(r.symbol)!.pnlUsd) / 2,
      minSharpe: Math.min(r.sharpe, h2Map.get(r.symbol)!.sharpe),
    }))
    .filter(r => r.avgPnl > 0)
    .sort((a, b) => b.avgSharpe - a.avgSharpe);

  console.log('\nRanking by avg Sharpe (H1+H2):');
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    console.log(`  ${i + 1}. ${padR(r.symbol, 8)} avgSh=${r.avgSharpe.toFixed(2)} minSh=${r.minSharpe.toFixed(2)} avgPnl=$${r.avgPnl.toFixed(0)}`);
  }

  // Test top-5, top-8, top-10, top-12, top-15
  console.log('\n--- Combined backtests by portfolio size (Full Year) ---\n');
  for (const n of [5, 8, 10, 12, 15]) {
    if (n > ranked.length) continue;
    const topN = ranked.slice(0, n).map(r => r.symbol);
    await runCombined(data, topN, { start: '2025-01-01', end: '2025-12-31' }, `Top-${n} (${topN.join(',')})`);
  }

  console.log('\n--- Combined backtests by portfolio size (H2 OOS) ---\n');
  for (const n of [5, 8, 10, 12, 15]) {
    if (n > ranked.length) continue;
    const topN = ranked.slice(0, n).map(r => r.symbol);
    await runCombined(data, topN, { start: '2025-07-01', end: '2025-12-31' }, `Top-${n} (${topN.join(',')})`);
  }

  console.log('\n\nDone.');
}

main().catch(console.error);
