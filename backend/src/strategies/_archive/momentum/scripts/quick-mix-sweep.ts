/**
 * quick-mix-sweep.ts — Find optimal symbol combination
 *
 * Tests: baseline 11, combo 9, union 14, and add/remove variants
 *
 * Usage: npx tsx scripts/quick-mix-sweep.ts
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
const PERIOD = { start: '2025-01-01', end: '2025-12-31' };
const INITIAL_CAPITAL = 2000;
const LEVERAGE = 5;

// Symbol sets
const COMBO_9 = ['AVAX', 'FET', 'WIF', 'DOT', 'IMX', 'STX', 'ADA', 'RENDER', 'XRP'];
const BASELINE_11 = ['FET', 'UNI', 'ARB', 'WIF', 'STX', 'NEAR', 'APT', 'ETH', 'RENDER', 'XRP', 'DOT'];
const ALL_CANDIDATES = [...new Set([...COMBO_9, ...BASELINE_11])]; // 14 unique

// ============================================================================
// DATA LOADING
// ============================================================================
function loadSymbolCandles(symbol: string, since: number, end: number): BacktestCandle[] | null {
  const base = symbol.replace('/USDT:USDT', '') + '_USDT';
  const file15m = `${base}_15m.json`;
  const dataDir = path.resolve(process.cwd(), 'data');
  const data2024Dir = path.resolve(process.cwd(), 'data', '2024');

  let filepath = path.join(dataDir, file15m);
  if (!fs.existsSync(filepath)) {
    filepath = path.join(data2024Dir, file15m);
    if (!fs.existsSync(filepath)) return null;
  }

  const raw = fs.readFileSync(filepath, 'utf8');
  const json = JSON.parse(raw);
  if (!Array.isArray(json) || json.length < 100) return null;

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

  return sliceCandlesByTime(candles, since, end);
}

// ============================================================================
// RUN ONE COMBO
// ============================================================================
interface ComboResult {
  name: string;
  symbols: string[];
  trades: number;
  winRate: number;
  pnl: number;
  roi: number;
  maxDD: number;
  sharpe: number;
  pf: number;
  perSymbol: Record<string, { trades: number; wins: number; pnl: number }>;
}

async function runCombo(
  name: string,
  symbols: string[],
  btcCandles: BacktestCandle[],
  allDataPool: Record<string, BacktestCandle[]>,
  regimeIntervalMs: number,
): Promise<ComboResult | null> {
  const startDate = new Date(PERIOD.start + 'T00:00:00.000Z');
  const endDate = new Date(PERIOD.end + 'T23:59:59.999Z');

  const syms = symbols.map(s => s.includes('/') ? s : `${s}/USDT:USDT`);
  const allData: Record<string, BacktestCandle[]> = {};
  for (const sym of syms) {
    if (allDataPool[sym] && allDataPool[sym].length >= 300) {
      allData[sym] = allDataPool[sym];
    }
  }

  const actualSyms = Object.keys(allData);
  if (actualSyms.length === 0) return null;

  const input: BacktestComputationInput = {
    params: { startDate, endDate, initialCapital: INITIAL_CAPITAL, symbols: actualSyms, leverage: LEVERAGE },
    btcCandles,
    btcCandlesRegime: btcCandles,
    allData,
    CANDLE_REGIME_INTERVAL_MS: regimeIntervalMs,
  };

  const result = await runBacktestComputation(input);
  const s = result.summary;

  const perSymbol: Record<string, { trades: number; wins: number; pnl: number }> = {};
  for (const t of result.trades) {
    const sym = t.symbol.replace('/USDT:USDT', '');
    if (!perSymbol[sym]) perSymbol[sym] = { trades: 0, wins: 0, pnl: 0 };
    perSymbol[sym].trades++;
    if (t.netPnlUsd > 0) perSymbol[sym].wins++;
    perSymbol[sym].pnl += t.netPnlUsd;
  }

  return {
    name,
    symbols: actualSyms.map(s => s.replace('/USDT:USDT', '')),
    trades: s.totalTrades,
    winRate: s.winRate,
    pnl: s.totalPnlUsd,
    roi: s.totalPnlUsd / INITIAL_CAPITAL * 100,
    maxDD: s.maxDrawdownPct,
    sharpe: s.sharpeRatio,
    pf: s.profitFactor,
    perSymbol,
  };
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const startDate = new Date(PERIOD.start + 'T00:00:00.000Z');
  const endDate = new Date(PERIOD.end + 'T23:59:59.999Z');
  const extraBarsMs = 250 * 15 * 60 * 1000;
  const since = startDate.getTime() - extraBarsMs;
  const end = endDate.getTime();

  console.log('=== Symbol Mix Sweep ===\n');

  // Load BTC
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, end);

  // Load ALL candidate symbols
  const allDataPool: Record<string, BacktestCandle[]> = {};
  for (const sym of ALL_CANDIDATES) {
    const fullSym = `${sym}/USDT:USDT`;
    const candles = loadSymbolCandles(fullSym, since, end);
    if (candles && candles.length >= 300) {
      allDataPool[fullSym] = candles;
      console.log(`  ${sym}: ${candles.length} candles`);
    } else {
      console.warn(`  ${sym}: MISSING or insufficient data`);
    }
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);
  const regimeMs = configTfMin * 60 * 1000;

  // ========================================================================
  // DEFINE ALL COMBOS TO TEST
  // ========================================================================
  const combos: { name: string; symbols: string[] }[] = [];

  // 1. The two baselines
  combos.push({ name: 'BASELINE_11 (V5.131)', symbols: BASELINE_11 });
  combos.push({ name: 'COMBO_9 (user)', symbols: COMBO_9 });

  // 2. Union of both (14 symbols)
  combos.push({ name: 'UNION_14 (all)', symbols: ALL_CANDIDATES });

  // 3. Combo 9 + each baseline-only symbol
  const baselineOnly = BASELINE_11.filter(s => !COMBO_9.includes(s)); // UNI, ARB, NEAR, APT, ETH
  for (const add of baselineOnly) {
    combos.push({ name: `COMBO_9 + ${add}`, symbols: [...COMBO_9, add] });
  }

  // 4. Baseline 11 + each combo-only symbol
  const comboOnly = COMBO_9.filter(s => !BASELINE_11.includes(s)); // AVAX, IMX, ADA
  for (const add of comboOnly) {
    combos.push({ name: `BASE_11 + ${add}`, symbols: [...BASELINE_11, add] });
  }

  // 5. Union minus each symbol (leave-one-out)
  for (const remove of ALL_CANDIDATES) {
    const remaining = ALL_CANDIDATES.filter(s => s !== remove);
    combos.push({ name: `UNION_14 - ${remove}`, symbols: remaining });
  }

  // ========================================================================
  // RUN ALL COMBOS
  // ========================================================================
  const results: ComboResult[] = [];
  console.log(`\nRunning ${combos.length} combinations...\n`);

  for (let i = 0; i < combos.length; i++) {
    const c = combos[i];
    process.stdout.write(`  [${i + 1}/${combos.length}] ${c.name.padEnd(25)} `);
    const r = await runCombo(c.name, c.symbols, btcCandles, allDataPool, regimeMs);
    if (r) {
      results.push(r);
      console.log(`${r.trades} trades, $${r.pnl.toFixed(0)}, ${r.winRate.toFixed(1)}% WR, DD ${r.maxDD.toFixed(1)}%`);
    } else {
      console.log('SKIPPED (no data)');
    }
  }

  // ========================================================================
  // RANKING
  // ========================================================================
  results.sort((a, b) => b.pnl - a.pnl);

  console.log('\n' + '='.repeat(110));
  console.log('RANKING BY PNL');
  console.log('='.repeat(110));
  console.log(`  ${'#'.padStart(3)} ${'Name'.padEnd(28)} ${'Syms'.padStart(4)} ${'Trades'.padStart(7)} ${'WR%'.padStart(6)} ${'PnL $'.padStart(12)} ${'ROI%'.padStart(8)} ${'DD%'.padStart(6)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(5)}`);
  console.log('  ' + '-'.repeat(106));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const marker = r.name.includes('BASELINE') ? ' *' : r.name.includes('COMBO_9 (user)') ? ' *' : '';
    console.log(`  ${String(i + 1).padStart(3)} ${(r.name + marker).padEnd(28)} ${String(r.symbols.length).padStart(4)} ${String(r.trades).padStart(7)} ${r.winRate.toFixed(1).padStart(6)} ${('$' + r.pnl.toFixed(0)).padStart(12)} ${r.roi.toFixed(0).padStart(7)}% ${r.maxDD.toFixed(1).padStart(6)} ${r.sharpe.toFixed(2).padStart(7)} ${r.pf.toFixed(2).padStart(5)}`);
  }

  // ========================================================================
  // TOP 5 + COMPARISON
  // ========================================================================
  console.log('\n' + '='.repeat(80));
  console.log('TOP 5 COMBINATIONS');
  console.log('='.repeat(80));
  for (let i = 0; i < Math.min(5, results.length); i++) {
    const r = results[i];
    console.log(`\n  #${i + 1}: ${r.name} (${r.symbols.length} symbols)`);
    console.log(`      Symbols: ${r.symbols.join(', ')}`);
    console.log(`      PnL: $${r.pnl.toFixed(0)} | WR: ${r.winRate.toFixed(1)}% | DD: ${r.maxDD.toFixed(1)}% | Sharpe: ${r.sharpe.toFixed(2)}`);

    const sorted = Object.entries(r.perSymbol).sort((a, b) => b[1].pnl - a[1].pnl);
    console.log(`      Per-symbol: ${sorted.map(([s, d]) => `${s}=$${d.pnl.toFixed(0)}`).join(', ')}`);
  }

  console.log('\n\nDone.');
}

main().catch(console.error);
