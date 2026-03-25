/**
 * quick-mix-sweep-parallel.ts — Find optimal symbol combination using child processes
 *
 * Runs 6 backtests in parallel via child_process
 *
 * Usage: npx tsx scripts/quick-mix-sweep-parallel.ts
 */
import { execFile } from 'child_process';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ============================================================================
// CONFIG
// ============================================================================
const PERIOD = { start: '2025-01-01', end: '2025-12-31' };
const INITIAL_CAPITAL = 2000;
const LEVERAGE = 5;
const MAX_PARALLEL = 6;

// Symbol sets
const COMBO_9 = ['AVAX', 'FET', 'WIF', 'DOT', 'IMX', 'STX', 'ADA', 'RENDER', 'XRP'];
const BASELINE_11 = ['FET', 'UNI', 'ARB', 'WIF', 'STX', 'NEAR', 'APT', 'ETH', 'RENDER', 'XRP', 'DOT'];
const ALL_CANDIDATES = [...new Set([...COMBO_9, ...BASELINE_11])];

// ============================================================================
// DATA LOADING
// ============================================================================
function loadSymbolCandles(symbol: string, since: number, end: number): BacktestCandle[] | null {
  const base = symbol + '_USDT';
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
// RUN ONE CHILD PROCESS
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

function runChild(
  name: string,
  symbols: string[],
  btcFile: string,
  dataFile: string,
  regimeMs: number,
): Promise<ComboResult | null> {
  return new Promise((resolve) => {
    const childScript = path.resolve(process.cwd(), 'scripts', 'mix-sweep-child.ts');
    const args = [
      childScript,
      btcFile,
      dataFile,
      name,
      symbols.join(','),
      String(regimeMs),
      String(INITIAL_CAPITAL),
      String(LEVERAGE),
      PERIOD.start,
      PERIOD.end,
    ];

    const npxPath = path.resolve(process.cwd(), '../node_modules/.bin/tsx');

    execFile(npxPath, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      cwd: process.cwd(),
    }, (error, stdout, stderr) => {
      if (error) {
        console.error(`    ${name}: ERROR - ${error.message}`);
        resolve(null);
        return;
      }

      try {
        // Find the last JSON line in output (skip warnings/logs from backtest)
        const lines = stdout.trim().split('\n');
        let jsonLine = '';
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].startsWith('{')) { jsonLine = lines[i]; break; }
        }
        if (!jsonLine) { resolve(null); return; }

        const parsed = JSON.parse(jsonLine);
        if (parsed.result) {
          resolve({ name, ...parsed.result });
        } else {
          resolve(null);
        }
      } catch {
        console.error(`    ${name}: parse error`);
        resolve(null);
      }
    });
  });
}

// Parallel with concurrency limit
async function runAll(
  combos: { name: string; symbols: string[] }[],
  btcFile: string,
  dataFile: string,
  regimeMs: number,
): Promise<ComboResult[]> {
  const results: ComboResult[] = [];
  let completed = 0;
  const total = combos.length;

  for (let i = 0; i < combos.length; i += MAX_PARALLEL) {
    const batch = combos.slice(i, i + MAX_PARALLEL);
    const batchNum = Math.floor(i / MAX_PARALLEL) + 1;
    console.log(`\n  Batch ${batchNum}/${Math.ceil(total / MAX_PARALLEL)}: ${batch.map(c => c.name).join(', ')}`);

    const promises = batch.map(c => runChild(c.name, c.symbols, btcFile, dataFile, regimeMs));
    const batchResults = await Promise.all(promises);

    for (const r of batchResults) {
      completed++;
      if (r) {
        results.push(r);
        console.log(`    [${completed}/${total}] ${r.name.padEnd(28)} $${r.pnl.toFixed(0).padStart(7)} | ${r.winRate.toFixed(1)}% WR | DD ${r.maxDD.toFixed(1)}% | Sharpe ${r.sharpe.toFixed(2)}`);
      } else {
        console.log(`    [${completed}/${total}] FAILED`);
      }
    }
  }

  return results;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const startMs = Date.now();
  const startDate = new Date(PERIOD.start + 'T00:00:00.000Z');
  const endDate = new Date(PERIOD.end + 'T23:59:59.999Z');
  const extraBarsMs = 250 * 15 * 60 * 1000;
  const since = startDate.getTime() - extraBarsMs;
  const end = endDate.getTime();

  console.log(`=== Parallel Symbol Mix Sweep (${MAX_PARALLEL} workers) ===\n`);

  // Load BTC
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, end);
  console.log(`BTC 15m: ${btcCandles.length} candles`);

  // Load ALL candidate symbols
  const allDataPool: Record<string, BacktestCandle[]> = {};
  for (const sym of ALL_CANDIDATES) {
    const fullSym = `${sym}/USDT:USDT`;
    const candles = loadSymbolCandles(sym, since, end);
    if (candles && candles.length >= 300) {
      allDataPool[fullSym] = candles;
      console.log(`  ${sym}: ${candles.length} candles`);
    } else {
      console.warn(`  ${sym}: MISSING`);
    }
  }

  // Write shared data to temp files
  const tmpDir = os.tmpdir();
  const btcFile = path.join(tmpDir, 'bt-sweep-btc.json');
  const dataFile = path.join(tmpDir, 'bt-sweep-data.json');
  fs.writeFileSync(btcFile, JSON.stringify(btcCandles));
  fs.writeFileSync(dataFile, JSON.stringify(allDataPool));
  const btcSize = (fs.statSync(btcFile).size / 1e6).toFixed(1);
  const dataSize = (fs.statSync(dataFile).size / 1e6).toFixed(1);
  console.log(`\nShared data: ${btcSize}MB BTC + ${dataSize}MB symbols (tmpdir)`);

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);
  const regimeMs = configTfMin * 60 * 1000;

  // ========================================================================
  // DEFINE ALL COMBOS
  // ========================================================================
  const combos: { name: string; symbols: string[] }[] = [];

  // Baselines
  combos.push({ name: 'BASELINE_11', symbols: BASELINE_11 });
  combos.push({ name: 'COMBO_9', symbols: COMBO_9 });
  combos.push({ name: 'UNION_14', symbols: ALL_CANDIDATES });

  // Combo 9 + each baseline-only
  const baselineOnly = BASELINE_11.filter(s => !COMBO_9.includes(s));
  for (const add of baselineOnly) {
    combos.push({ name: `C9+${add}`, symbols: [...COMBO_9, add] });
  }

  // Baseline 11 + each combo-only
  const comboOnly = COMBO_9.filter(s => !BASELINE_11.includes(s));
  for (const add of comboOnly) {
    combos.push({ name: `B11+${add}`, symbols: [...BASELINE_11, add] });
  }

  // Union minus each (leave-one-out from union)
  for (const remove of ALL_CANDIDATES) {
    combos.push({ name: `U14-${remove}`, symbols: ALL_CANDIDATES.filter(s => s !== remove) });
  }

  console.log(`\n${combos.length} combinations to test...\n`);

  // ========================================================================
  // RUN
  // ========================================================================
  const results = await runAll(combos, btcFile, dataFile, regimeMs);

  // Cleanup
  try { fs.unlinkSync(btcFile); } catch {}
  try { fs.unlinkSync(dataFile); } catch {}

  // ========================================================================
  // RANKING
  // ========================================================================
  results.sort((a, b) => b.pnl - a.pnl);

  console.log('\n' + '='.repeat(115));
  console.log('RANKING BY PNL');
  console.log('='.repeat(115));
  console.log(`  ${'#'.padStart(3)} ${'Name'.padEnd(28)} ${'Sym'.padStart(3)} ${'Trades'.padStart(7)} ${'WR%'.padStart(6)} ${'PnL $'.padStart(12)} ${'ROI%'.padStart(8)} ${'DD%'.padStart(6)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(5)}`);
  console.log('  ' + '-'.repeat(111));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const marker = r.name === 'BASELINE_11' || r.name === 'COMBO_9' ? ' <<' : '';
    console.log(`  ${String(i + 1).padStart(3)} ${r.name.padEnd(28)} ${String(r.symbols.length).padStart(3)} ${String(r.trades).padStart(7)} ${r.winRate.toFixed(1).padStart(6)} ${('$' + r.pnl.toFixed(0)).padStart(12)} ${r.roi.toFixed(0).padStart(7)}% ${r.maxDD.toFixed(1).padStart(6)} ${r.sharpe.toFixed(2).padStart(7)} ${r.pf.toFixed(2).padStart(5)}${marker}`);
  }

  // TOP 5
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

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
  console.log(`\n\nDone in ${elapsed}s.`);
}

main().catch(console.error);
