/**
 * Funding Rate Strategy Parameter Sweep
 * Tests 8 configurations across 2024 and 2025 with BTC, ETH, SOL, XRP
 *
 * Usage: npx tsx scripts/sweep-funding-rate.ts 2>&1
 */
import { runBacktestComputation, type BacktestComputationInput, type BacktestResult } from '../src/services/backtestService.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';
import { FUNDING_CONFIG } from '../src/strategies/fundingRate/config.js';
import { FundingRateStrategy } from '../src/strategies/fundingRate/strategy.js';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// DEFAULTS (snapshot to reset after each config)
// ============================================================================
const DEFAULTS = { ...FUNDING_CONFIG };

function resetConfig(): void {
  const cfg = FUNDING_CONFIG as any;
  for (const key of Object.keys(DEFAULTS)) {
    cfg[key] = (DEFAULTS as any)[key];
  }
}

// ============================================================================
// CONFIG DEFINITIONS
// ============================================================================
interface SweepConfig {
  name: string;
  label: string;
  overrides: Record<string, number | boolean>;
}

const CONFIGS: SweepConfig[] = [
  {
    name: 'A',
    label: 'Baseline mom=2% hold=8h SL=2%',
    overrides: {},
  },
  {
    name: 'B',
    label: 'Higher threshold 3%',
    overrides: { MOMENTUM_THRESHOLD_PCT: 3.0 },
  },
  {
    name: 'C',
    label: 'Lower threshold 1%',
    overrides: { MOMENTUM_THRESHOLD_PCT: 1.0 },
  },
  {
    name: 'D',
    label: 'Longer hold 16h',
    overrides: { HOLD_HOURS: 16 },
  },
  {
    name: 'E',
    label: 'Tighter SL 1%',
    overrides: { STOP_LOSS_PCT: 1.0 },
  },
  {
    name: 'F',
    label: 'Wider SL 3%',
    overrides: { STOP_LOSS_PCT: 3.0 },
  },
  {
    name: 'G',
    label: 'Short-only (positive funding)',
    overrides: { SHORT_ONLY: true },
  },
  {
    name: 'H',
    label: 'Longer lookback 64 (16h)',
    overrides: { MOMENTUM_LOOKBACK: 64 },
  },
];

// ============================================================================
// LOAD CANDLE DATA
// ============================================================================
function loadSymbolCandles(symbol: string, since: number, end: number): BacktestCandle[] | null {
  const base = symbol.replace('/USDT:USDT', '_USDT');
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
// RESULT TYPES
// ============================================================================
interface ConfigResult {
  config: string;
  label: string;
  year: number;
  trades: number;
  winRate: number;
  pnl: number;
  sharpe: number;
  maxDD: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  winLossRatio: number;
  exitBreakdown: Record<string, { count: number; pnl: number }>;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const INITIAL_CAPITAL = 2000;
  const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];
  const YEARS = [2024, 2025];

  console.log('='.repeat(80));
  console.log('FUNDING RATE STRATEGY PARAMETER SWEEP');
  console.log('='.repeat(80));
  console.log(`Configs:  ${CONFIGS.length} (A-H)`);
  console.log(`Years:    ${YEARS.join(', ')}`);
  console.log(`Symbols:  ${SYMBOLS.map(s => s.replace('/USDT:USDT', '')).join(', ')}`);
  console.log(`Capital:  $${INITIAL_CAPITAL}`);
  console.log(`Leverage: 1x (conservative)`);
  console.log('');

  // Pre-load all data
  console.log('Loading candle data...');

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');

  const yearData: Record<number, {
    btcCandles: BacktestCandle[];
    allData: Record<string, BacktestCandle[]>;
    startDate: Date;
    endDate: Date;
  }> = {};

  for (const year of YEARS) {
    const startDate = new Date(`${year}-01-01T00:00:00.000Z`);
    const endDate = new Date(`${year}-12-31T23:59:59.999Z`);
    const extraBarsMs = 100 * 15 * 60 * 1000; // small warmup needed
    const since = startDate.getTime() - extraBarsMs;
    const end = endDate.getTime();

    const btcCandles = sliceCandlesByTime(btcLocal.candles, since, end);
    console.log(`  ${year} BTC: ${btcCandles.length} candles`);

    const allData: Record<string, BacktestCandle[]> = {};
    for (const sym of SYMBOLS) {
      const candles = loadSymbolCandles(sym, since, end);
      if (!candles || candles.length < 100) {
        console.warn(`  ${year} ${sym}: insufficient data (${candles?.length ?? 0}), skipping`);
        continue;
      }
      allData[sym] = candles;
      console.log(`  ${year} ${sym.replace('/USDT:USDT', '')}: ${candles.length} candles`);
    }

    yearData[year] = { btcCandles, allData, startDate, endDate };
  }

  console.log('\nStarting sweep...\n');

  const allResults: ConfigResult[] = [];

  for (const cfg of CONFIGS) {
    console.log('-'.repeat(80));
    console.log(`CONFIG ${cfg.name}: ${cfg.label}`);
    console.log('-'.repeat(80));

    const overrideEntries = Object.entries(cfg.overrides);
    if (overrideEntries.length === 0) {
      console.log('  (defaults)');
    } else {
      for (const [k, v] of overrideEntries) {
        console.log(`  ${k} = ${v} (default: ${(DEFAULTS as any)[k]})`);
      }
    }
    console.log('');

    for (const year of YEARS) {
      resetConfig();

      const mutableCfg = FUNDING_CONFIG as any;
      for (const [k, v] of Object.entries(cfg.overrides)) {
        mutableCfg[k] = v;
      }

      const strategy = new FundingRateStrategy();
      const stratConfig = strategy.getConfig();

      const yd = yearData[year];
      const input: BacktestComputationInput = {
        params: {
          startDate: yd.startDate,
          endDate: yd.endDate,
          initialCapital: INITIAL_CAPITAL,
          symbols: Object.keys(yd.allData),
          leverage: stratConfig.leverage || 1,
          strategy,
          skipRuleThreshold: 9999,
        },
        btcCandles: yd.btcCandles,
        btcCandlesRegime: yd.btcCandles,
        allData: yd.allData,
        CANDLE_REGIME_INTERVAL_MS: 15 * 60 * 1000,
      };

      const result = await runBacktestComputation(input);
      const s = result.summary;

      const exitBreakdown: Record<string, { count: number; pnl: number }> = {};
      for (const t of result.trades) {
        const reason = t.exitReason || 'UNKNOWN';
        if (!exitBreakdown[reason]) exitBreakdown[reason] = { count: 0, pnl: 0 };
        exitBreakdown[reason].count++;
        exitBreakdown[reason].pnl += t.netPnlUsd;
      }

      const wins = result.trades.filter(t => t.netPnlUsd > 0);
      const losses = result.trades.filter(t => t.netPnlUsd <= 0);
      const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.netPnlUsd, 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((sum, t) => sum + t.netPnlUsd, 0) / losses.length) : 0;
      const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

      const cr: ConfigResult = {
        config: cfg.name,
        label: cfg.label,
        year,
        trades: s.totalTrades,
        winRate: s.winRate,
        pnl: s.totalPnlUsd,
        sharpe: s.sharpeRatio,
        maxDD: s.maxDrawdownPct,
        profitFactor: s.profitFactor,
        avgWin,
        avgLoss,
        winLossRatio,
        exitBreakdown,
      };
      allResults.push(cr);

      const f = (v: number, d = 1) => v.toFixed(d);
      console.log(`  [${year}] Trades: ${s.totalTrades} | WR: ${f(s.winRate)}% | PnL: $${f(s.totalPnlUsd, 2)} | Sharpe: ${f(s.sharpeRatio, 2)} | DD: ${f(s.maxDrawdownPct)}% | PF: ${f(s.profitFactor, 2)}`);
      console.log(`         AvgWin: $${f(avgWin, 2)} | AvgLoss: $${f(avgLoss, 2)} | W/L ratio: ${f(winLossRatio, 2)}`);

      const sortedExits = Object.entries(exitBreakdown).sort((a, b) => b[1].count - a[1].count);
      const exitParts = sortedExits.map(([reason, d]) => `${reason}: ${d.count}t $${d.pnl.toFixed(0)}`);
      console.log(`         Exits: ${exitParts.join(' | ')}`);
      console.log('');
    }
  }

  resetConfig();

  // ============================================================================
  // SUMMARY TABLE
  // ============================================================================
  console.log('\n');
  console.log('='.repeat(120));
  console.log('SUMMARY TABLE -- ALL CONFIGS');
  console.log('='.repeat(120));

  const header = `${'Cfg'.padEnd(4)} ${'Label'.padEnd(32)} ${'Year'.padEnd(5)} ${'Trades'.padStart(7)} ${'WR%'.padStart(6)} ${'PnL $'.padStart(10)} ${'Sharpe'.padStart(7)} ${'DD%'.padStart(6)} ${'PF'.padStart(6)} ${'AvgWin'.padStart(8)} ${'AvgLoss'.padStart(8)} ${'W/L'.padStart(5)}`;
  console.log(header);
  console.log('-'.repeat(120));

  for (const r of allResults) {
    const line = `${r.config.padEnd(4)} ${r.label.padEnd(32)} ${String(r.year).padEnd(5)} ${String(r.trades).padStart(7)} ${r.winRate.toFixed(1).padStart(6)} ${('$' + r.pnl.toFixed(0)).padStart(10)} ${r.sharpe.toFixed(2).padStart(7)} ${r.maxDD.toFixed(1).padStart(6)} ${r.profitFactor.toFixed(2).padStart(6)} ${('$' + r.avgWin.toFixed(1)).padStart(8)} ${('$' + r.avgLoss.toFixed(1)).padStart(8)} ${r.winLossRatio.toFixed(2).padStart(5)}`;
    console.log(line);
  }

  // ============================================================================
  // RANKED BY COMBINED SHARPE
  // ============================================================================
  console.log('\n');
  console.log('='.repeat(100));
  console.log('RANKING -- BY COMBINED 2024+2025 SHARPE');
  console.log('='.repeat(100));

  const byConfig: Record<string, ConfigResult[]> = {};
  for (const r of allResults) {
    if (!byConfig[r.config]) byConfig[r.config] = [];
    byConfig[r.config].push(r);
  }

  const ranked = Object.entries(byConfig).map(([cfg, results]) => {
    const r2024 = results.find(r => r.year === 2024);
    const r2025 = results.find(r => r.year === 2025);
    const sharpe2024 = r2024?.sharpe ?? 0;
    const sharpe2025 = r2025?.sharpe ?? 0;
    const combinedSharpe = (sharpe2024 + sharpe2025) / 2;
    const totalTrades = (r2024?.trades ?? 0) + (r2025?.trades ?? 0);
    const totalPnl = (r2024?.pnl ?? 0) + (r2025?.pnl ?? 0);
    const avgWR = ((r2024?.winRate ?? 0) + (r2025?.winRate ?? 0)) / 2;
    const maxDD = Math.max(r2024?.maxDD ?? 0, r2025?.maxDD ?? 0);
    const label = results[0]?.label ?? '';
    return { cfg, label, sharpe2024, sharpe2025, combinedSharpe, totalTrades, totalPnl, avgWR, maxDD };
  }).sort((a, b) => b.combinedSharpe - a.combinedSharpe);

  const rHeader = `${'Rank'.padEnd(5)} ${'Cfg'.padEnd(4)} ${'Label'.padEnd(32)} ${'Sharpe24'.padStart(9)} ${'Sharpe25'.padStart(9)} ${'Combined'.padStart(9)} ${'Trades'.padStart(7)} ${'PnL $'.padStart(10)} ${'AvgWR%'.padStart(7)} ${'MaxDD%'.padStart(7)}`;
  console.log(rHeader);
  console.log('-'.repeat(100));

  ranked.forEach((r, i) => {
    const line = `${String(i + 1).padEnd(5)} ${r.cfg.padEnd(4)} ${r.label.padEnd(32)} ${r.sharpe2024.toFixed(2).padStart(9)} ${r.sharpe2025.toFixed(2).padStart(9)} ${r.combinedSharpe.toFixed(2).padStart(9)} ${String(r.totalTrades).padStart(7)} ${('$' + r.totalPnl.toFixed(0)).padStart(10)} ${r.avgWR.toFixed(1).padStart(7)} ${r.maxDD.toFixed(1).padStart(7)}`;
    console.log(line);
  });

  if (ranked.length > 0) {
    const best = ranked[0];
    console.log('\n');
    console.log('*'.repeat(80));
    console.log(`BEST CONFIG: ${best.cfg} -- ${best.label}`);
    console.log(`  Combined Sharpe: ${best.combinedSharpe.toFixed(2)} (2024: ${best.sharpe2024.toFixed(2)}, 2025: ${best.sharpe2025.toFixed(2)})`);
    console.log(`  Total Trades: ${best.totalTrades} | Total PnL: $${best.totalPnl.toFixed(0)} | Avg WR: ${best.avgWR.toFixed(1)}% | Max DD: ${best.maxDD.toFixed(1)}%`);
    console.log('*'.repeat(80));
  }

  console.log('\nSweep complete.');
}

main().catch(console.error);
