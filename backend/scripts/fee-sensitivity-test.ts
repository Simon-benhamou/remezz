/**
 * Fee Sensitivity Test
 * Tests top strategy configs at different fee levels on 2024 and 2025.
 *
 * Usage: npx tsx scripts/fee-sensitivity-test.ts 2>&1
 */
import { runBacktestComputation, type BacktestComputationInput, type BacktestResult } from '../src/services/backtestService.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';
import { MomentumConfig } from '../src/strategies/config/momentumConfig.js';
import { MEAN_REV_CONFIG } from '../src/strategies/meanReversion/config.js';
import { MeanReversionStrategy } from '../src/strategies/meanReversion/strategy.js';
import { GridStrategy } from '../src/strategies/grid/strategy.js';
import { FUNDING_HUNTER_CONFIG } from '../src/strategies/fundingHunter/config.js';
import { FundingHunterStrategy } from '../src/strategies/fundingHunter/strategy.js';
import { MEAN_REV_4H_CONFIG } from '../src/strategies/meanReversion4h/config.js';
import { MeanReversion4hStrategy } from '../src/strategies/meanReversion4h/strategy.js';
import type { IStrategy } from '../src/strategies/types.js';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// FEE LEVELS
// ============================================================================
interface FeeLevel {
  name: string;
  tradingPct: number;
  slippagePct: number;
  label: string;
}

const FEE_LEVELS: FeeLevel[] = [
  { name: 'pessimistic',      tradingPct: 0.04, slippagePct: 0.05, label: 'Taker + high slippage (current)' },
  { name: 'realistic_taker',  tradingPct: 0.04, slippagePct: 0.01, label: 'Taker + minimal slippage' },
  { name: 'realistic_maker',  tradingPct: 0.02, slippagePct: 0.01, label: 'Maker limit orders' },
  { name: 'optimistic_maker', tradingPct: 0.01, slippagePct: 0.005, label: 'VIP tier maker' },
  { name: 'zero_fee',         tradingPct: 0.00, slippagePct: 0.000, label: 'Theoretical max (no fees)' },
];

// ============================================================================
// STRATEGY DEFINITIONS
// ============================================================================
interface StrategyDef {
  name: string;
  label: string;
  create: () => IStrategy;
  applyOverrides: () => void;
  resetOverrides: () => void;
}

// Snapshots for reset
const MR_DEFAULTS = { ...MEAN_REV_CONFIG };
const FH_DEFAULTS = { ...FUNDING_HUNTER_CONFIG };
const MR4H_DEFAULTS = { ...MEAN_REV_4H_CONFIG };

function resetMeanRev(): void {
  const cfg = MEAN_REV_CONFIG as any;
  for (const key of Object.keys(MR_DEFAULTS)) cfg[key] = (MR_DEFAULTS as any)[key];
}

function resetFundingHunter(): void {
  const cfg = FUNDING_HUNTER_CONFIG as any;
  for (const key of Object.keys(FH_DEFAULTS)) cfg[key] = (FH_DEFAULTS as any)[key];
}

function resetMeanRev4h(): void {
  const cfg = MEAN_REV_4H_CONFIG as any;
  for (const key of Object.keys(MR4H_DEFAULTS)) cfg[key] = (MR4H_DEFAULTS as any)[key];
}

const STRATEGIES: StrategyDef[] = [
  {
    name: 'MeanRev 15m F',
    label: 'Mean Reversion 15m — Config F (let winners run)',
    create: () => new MeanReversionStrategy(),
    applyOverrides: () => {
      const cfg = MEAN_REV_CONFIG as any;
      cfg.BB_STD_ENTRY = 2.0;
      cfg.STOP_LOSS_PCT = 1.5;
      cfg.TRAILING_AFTER_PCT = 2.0;
      cfg.TRAILING_DISTANCE_PCT = 1.0;
    },
    resetOverrides: resetMeanRev,
  },
  {
    name: 'Grid Baseline',
    label: 'Grid — Default config',
    create: () => new GridStrategy(),
    applyOverrides: () => {}, // no overrides needed
    resetOverrides: () => {},
  },
  {
    name: 'FundingHunter J',
    label: 'Funding Hunter — Config J (conservative)',
    create: () => new FundingHunterStrategy(),
    applyOverrides: () => {
      const cfg = FUNDING_HUNTER_CONFIG as any;
      cfg.HIGH_FUNDING_ENTRY = 0.03;
      cfg.STOP_LOSS_PCT = 3.0;
      cfg.HOLD_CANDLES = 64;     // 16h
      cfg.TRAILING_ACTIVATION_PCT = 2.0;
      cfg.TRAILING_DISTANCE_PCT = 1.5;
      cfg.LEVERAGE = 3;
    },
    resetOverrides: resetFundingHunter,
  },
  {
    name: 'MeanRev 4h F',
    label: 'Mean Reversion 4h — Config F (relaxed RSI)',
    create: () => new MeanReversion4hStrategy(),
    applyOverrides: () => {
      const cfg = MEAN_REV_4H_CONFIG as any;
      cfg.BB_STD_ENTRY = 2.0;
      cfg.RSI_OVERSOLD = 35;
      cfg.RSI_OVERBOUGHT = 65;
    },
    resetOverrides: resetMeanRev4h,
  },
];

// ============================================================================
// LOAD CANDLE DATA
// ============================================================================
function loadSymbolCandles(symbol: string, since: number, end: number): BacktestCandle[] | null {
  const base = symbol.replace('/USDT:USDT', '_USDT');
  const file15m = `${base}_15m.json`;
  const dataDir = path.resolve(process.cwd(), 'data');

  const filepath = path.join(dataDir, file15m);
  if (!fs.existsSync(filepath)) return null;

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
// SET FEE LEVEL (mutate MomentumConfig.COSTS)
// ============================================================================
function setFeeLevel(fee: FeeLevel): void {
  (MomentumConfig as any).COSTS.TRADING_FEE_PCT = fee.tradingPct;
  (MomentumConfig as any).COSTS.SLIPPAGE_PCT = fee.slippagePct;
}

function resetFees(): void {
  (MomentumConfig as any).COSTS.TRADING_FEE_PCT = 0.04;
  (MomentumConfig as any).COSTS.SLIPPAGE_PCT = 0.05;
}

// ============================================================================
// RESULT TYPES
// ============================================================================
interface TestResult {
  strategy: string;
  feeLevel: string;
  year: number;
  trades: number;
  winRate: number;
  pnl: number;
  sharpe: number;
  maxDD: number;
  profitFactor: number;
  totalFees: number;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const INITIAL_CAPITAL = 2000;
  const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'];
  const YEARS = [2024, 2025];

  console.log('='.repeat(90));
  console.log('FEE SENSITIVITY TEST');
  console.log('='.repeat(90));
  console.log(`Strategies: ${STRATEGIES.length} (${STRATEGIES.map(s => s.name).join(', ')})`);
  console.log(`Fee levels: ${FEE_LEVELS.length} (${FEE_LEVELS.map(f => f.name).join(', ')})`);
  console.log(`Years:      ${YEARS.join(', ')}`);
  console.log(`Symbols:    ${SYMBOLS.map(s => s.replace('/USDT:USDT', '')).join(', ')}`);
  console.log(`Capital:    $${INITIAL_CAPITAL}`);
  console.log(`Total runs: ${STRATEGIES.length} x ${FEE_LEVELS.length} x ${YEARS.length} = ${STRATEGIES.length * FEE_LEVELS.length * YEARS.length}`);
  console.log('');

  // Pre-load candle data
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
    const extraBarsMs = 700 * 15 * 60 * 1000; // extra warmup (700 bars for 4h strategy)
    const since = startDate.getTime() - extraBarsMs;
    const end = endDate.getTime();

    const btcCandles = sliceCandlesByTime(btcLocal.candles, since, end);
    console.log(`  ${year} BTC: ${btcCandles.length} candles`);

    const allData: Record<string, BacktestCandle[]> = {};
    for (const sym of SYMBOLS) {
      const candles = loadSymbolCandles(sym, since, end);
      if (!candles || candles.length < 300) {
        console.warn(`  ${year} ${sym}: insufficient data (${candles?.length ?? 0}), skipping`);
        continue;
      }
      allData[sym] = candles;
      console.log(`  ${year} ${sym.replace('/USDT:USDT', '')}: ${candles.length} candles`);
    }

    yearData[year] = { btcCandles, allData, startDate, endDate };
  }

  console.log('\nStarting fee sensitivity tests...\n');

  const allResults: TestResult[] = [];
  let runCount = 0;
  const totalRuns = STRATEGIES.length * FEE_LEVELS.length * YEARS.length;

  for (const stratDef of STRATEGIES) {
    console.log('='.repeat(90));
    console.log(`STRATEGY: ${stratDef.label}`);
    console.log('='.repeat(90));

    for (const fee of FEE_LEVELS) {
      console.log(`\n  Fee: ${fee.name} (trading=${fee.tradingPct}%, slip=${fee.slippagePct}%, RT=${((fee.tradingPct + fee.slippagePct) * 2).toFixed(3)}%)`);

      for (const year of YEARS) {
        runCount++;

        // Reset everything
        stratDef.resetOverrides();
        resetFees();

        // Apply strategy config overrides
        stratDef.applyOverrides();

        // Apply fee level
        setFeeLevel(fee);

        // Create fresh strategy instance AFTER config mutation
        const strategy = stratDef.create();
        const stratConfig = strategy.getConfig();

        const yd = yearData[year];
        const input: BacktestComputationInput = {
          params: {
            startDate: yd.startDate,
            endDate: yd.endDate,
            initialCapital: INITIAL_CAPITAL,
            symbols: Object.keys(yd.allData),
            leverage: stratConfig.leverage || 2,
            strategy,
            skipRuleThreshold: 9999, // disable skip rule for clean comparison
          },
          btcCandles: yd.btcCandles,
          btcCandlesRegime: yd.btcCandles,
          allData: yd.allData,
          CANDLE_REGIME_INTERVAL_MS: 15 * 60 * 1000,
        };

        const result = await runBacktestComputation(input);
        const s = result.summary;

        const tr: TestResult = {
          strategy: stratDef.name,
          feeLevel: fee.name,
          year,
          trades: s.totalTrades,
          winRate: s.winRate,
          pnl: s.totalPnlUsd,
          sharpe: s.sharpeRatio,
          maxDD: s.maxDrawdownPct,
          profitFactor: s.profitFactor,
          totalFees: s.totalFeesUsd,
        };
        allResults.push(tr);

        const f = (v: number, d = 1) => v.toFixed(d);
        console.log(`    [${year}] ${String(s.totalTrades).padStart(4)}t | WR ${f(s.winRate)}% | PnL $${f(s.totalPnlUsd, 2).padStart(9)} | Sharpe ${f(s.sharpeRatio, 2).padStart(6)} | DD ${f(s.maxDrawdownPct).padStart(5)}% | Fees $${f(s.totalFeesUsd, 2)} (${runCount}/${totalRuns})`);
      }
    }
  }

  // Reset fees back to defaults
  resetFees();

  // ============================================================================
  // SUMMARY TABLE 1: PnL by Strategy x Fee Level (combined 2024+2025)
  // ============================================================================
  console.log('\n\n');
  console.log('='.repeat(120));
  console.log('SUMMARY: PnL by Strategy x Fee Level (2024+2025 combined, $2000 capital)');
  console.log('='.repeat(120));

  const feeNames = FEE_LEVELS.map(f => f.name);
  const stratNames = STRATEGIES.map(s => s.name);

  // Header
  const colW = 18;
  let header = 'Strategy'.padEnd(20);
  for (const fn of feeNames) header += fn.padStart(colW);
  console.log(header);
  console.log('-'.repeat(20 + colW * feeNames.length));

  // Combined results
  const combinedPnl: Record<string, Record<string, number>> = {};
  const combinedTrades: Record<string, Record<string, number>> = {};
  const combinedWR: Record<string, Record<string, number>> = {};
  const combinedSharpe: Record<string, Record<string, number>> = {};
  const combinedDD: Record<string, Record<string, number>> = {};

  for (const sn of stratNames) {
    combinedPnl[sn] = {};
    combinedTrades[sn] = {};
    combinedWR[sn] = {};
    combinedSharpe[sn] = {};
    combinedDD[sn] = {};
    for (const fn of feeNames) {
      const rows = allResults.filter(r => r.strategy === sn && r.feeLevel === fn);
      combinedPnl[sn][fn] = rows.reduce((sum, r) => sum + r.pnl, 0);
      combinedTrades[sn][fn] = rows.reduce((sum, r) => sum + r.trades, 0);
      // Weighted average WR by trade count
      const totalTrades = rows.reduce((sum, r) => sum + r.trades, 0);
      combinedWR[sn][fn] = totalTrades > 0
        ? rows.reduce((sum, r) => sum + r.winRate * r.trades, 0) / totalTrades
        : 0;
      // Average sharpe across years
      combinedSharpe[sn][fn] = rows.length > 0
        ? rows.reduce((sum, r) => sum + r.sharpe, 0) / rows.length
        : 0;
      // Worst DD across years
      combinedDD[sn][fn] = Math.max(...rows.map(r => r.maxDD));
    }
  }

  // PnL table
  for (const sn of stratNames) {
    let row = sn.padEnd(20);
    for (const fn of feeNames) {
      const pnl = combinedPnl[sn][fn];
      const str = `$${pnl.toFixed(0)}`;
      const decorated = pnl > 0 ? `+${str}` : str;
      row += decorated.padStart(colW);
    }
    console.log(row);
  }

  // ============================================================================
  // SUMMARY TABLE 2: Detailed per-year breakdown
  // ============================================================================
  console.log('\n');
  console.log('='.repeat(120));
  console.log('DETAIL: PnL per Year (Strategy x Fee Level)');
  console.log('='.repeat(120));

  for (const sn of stratNames) {
    console.log(`\n  ${sn}:`);
    let hdr = '    Fee Level'.padEnd(24);
    hdr += '2024 PnL'.padStart(12) + '2024 WR'.padStart(10) + '2024 Shp'.padStart(10);
    hdr += '2025 PnL'.padStart(12) + '2025 WR'.padStart(10) + '2025 Shp'.padStart(10);
    hdr += 'Combined'.padStart(12);
    console.log(hdr);
    console.log('    ' + '-'.repeat(hdr.length - 4));

    for (const fn of feeNames) {
      const r2024 = allResults.find(r => r.strategy === sn && r.feeLevel === fn && r.year === 2024);
      const r2025 = allResults.find(r => r.strategy === sn && r.feeLevel === fn && r.year === 2025);
      const combined = (r2024?.pnl ?? 0) + (r2025?.pnl ?? 0);

      let row = `    ${fn.padEnd(20)}`;
      if (r2024) row += `$${r2024.pnl.toFixed(0)}`.padStart(12) + `${r2024.winRate.toFixed(1)}%`.padStart(10) + `${r2024.sharpe.toFixed(2)}`.padStart(10);
      else row += 'N/A'.padStart(12) + 'N/A'.padStart(10) + 'N/A'.padStart(10);
      if (r2025) row += `$${r2025.pnl.toFixed(0)}`.padStart(12) + `${r2025.winRate.toFixed(1)}%`.padStart(10) + `${r2025.sharpe.toFixed(2)}`.padStart(10);
      else row += 'N/A'.padStart(12) + 'N/A'.padStart(10) + 'N/A'.padStart(10);
      row += `$${combined.toFixed(0)}`.padStart(12);
      console.log(row);
    }
  }

  // ============================================================================
  // SUMMARY TABLE 3: Trades + WR + Sharpe + DD by Strategy x Fee Level
  // ============================================================================
  console.log('\n');
  console.log('='.repeat(120));
  console.log('METRICS: Trades / WR / Sharpe / MaxDD (combined 2024+2025)');
  console.log('='.repeat(120));

  for (const sn of stratNames) {
    console.log(`\n  ${sn}:`);
    let hdr = '    Fee Level'.padEnd(24) + 'Trades'.padStart(8) + 'WR%'.padStart(8) + 'Sharpe'.padStart(8) + 'MaxDD%'.padStart(8) + 'PF'.padStart(8) + 'PnL'.padStart(12);
    console.log(hdr);
    console.log('    ' + '-'.repeat(68));

    for (const fn of feeNames) {
      const trades = combinedTrades[sn][fn];
      const wr = combinedWR[sn][fn];
      const sharpe = combinedSharpe[sn][fn];
      const dd = combinedDD[sn][fn];
      const pnl = combinedPnl[sn][fn];
      const rows = allResults.filter(r => r.strategy === sn && r.feeLevel === fn);
      const avgPF = rows.length > 0 ? rows.reduce((s, r) => s + r.profitFactor, 0) / rows.length : 0;

      let row = `    ${fn.padEnd(20)}`;
      row += `${trades}`.padStart(8);
      row += `${wr.toFixed(1)}`.padStart(8);
      row += `${sharpe.toFixed(2)}`.padStart(8);
      row += `${dd.toFixed(1)}`.padStart(8);
      row += `${avgPF.toFixed(2)}`.padStart(8);
      row += `$${pnl.toFixed(0)}`.padStart(12);
      console.log(row);
    }
  }

  // ============================================================================
  // PROFITABILITY ANALYSIS
  // ============================================================================
  console.log('\n');
  console.log('='.repeat(120));
  console.log('PROFITABILITY ANALYSIS: Which strategies become profitable at which fee levels?');
  console.log('='.repeat(120));

  for (const sn of stratNames) {
    console.log(`\n  ${sn}:`);
    let foundBreakeven = false;
    for (const fn of feeNames) {
      const pnl = combinedPnl[sn][fn];
      const r2024 = allResults.find(r => r.strategy === sn && r.feeLevel === fn && r.year === 2024);
      const r2025 = allResults.find(r => r.strategy === sn && r.feeLevel === fn && r.year === 2025);
      const both2024 = (r2024?.pnl ?? 0) > 0;
      const both2025 = (r2025?.pnl ?? 0) > 0;
      const combinedProfit = pnl > 0;

      let status = '';
      if (combinedProfit && both2024 && both2025) {
        status = 'PROFITABLE BOTH YEARS';
      } else if (combinedProfit) {
        status = `PROFITABLE combined (${both2024 ? '2024 YES' : '2024 NO'}, ${both2025 ? '2025 YES' : '2025 NO'})`;
      } else {
        status = `UNPROFITABLE ($${pnl.toFixed(0)})`;
      }

      const fee = FEE_LEVELS.find(f => f.name === fn)!;
      const roundTrip = ((fee.tradingPct + fee.slippagePct) * 2).toFixed(3);
      console.log(`    ${fn.padEnd(20)} RT=${roundTrip}% => ${status}`);

      if (!foundBreakeven && combinedProfit) {
        foundBreakeven = true;
      }
    }
  }

  // ============================================================================
  // BREAKEVEN FEE ESTIMATION
  // ============================================================================
  console.log('\n');
  console.log('='.repeat(120));
  console.log('BREAKEVEN FEE ESTIMATE (linear interpolation between fee levels)');
  console.log('='.repeat(120));

  for (const sn of stratNames) {
    // Get PnL at each round-trip fee level
    const points: { rtFee: number; pnl: number }[] = [];
    for (const fn of feeNames) {
      const fee = FEE_LEVELS.find(f => f.name === fn)!;
      const rtFee = (fee.tradingPct + fee.slippagePct) * 2;
      points.push({ rtFee, pnl: combinedPnl[sn][fn] });
    }

    // Find where PnL crosses zero
    let breakevenRt = -1;
    for (let i = 0; i < points.length - 1; i++) {
      if ((points[i].pnl >= 0 && points[i + 1].pnl < 0) || (points[i].pnl < 0 && points[i + 1].pnl >= 0)) {
        // Linear interpolation
        const x0 = points[i].rtFee, y0 = points[i].pnl;
        const x1 = points[i + 1].rtFee, y1 = points[i + 1].pnl;
        breakevenRt = x0 + (0 - y0) * (x1 - x0) / (y1 - y0);
        break;
      }
    }

    // Check edge cases
    const allPositive = points.every(p => p.pnl > 0);
    const allNegative = points.every(p => p.pnl <= 0);

    if (allPositive) {
      console.log(`  ${sn.padEnd(20)} => Profitable at ALL fee levels (even pessimistic)`);
    } else if (allNegative) {
      console.log(`  ${sn.padEnd(20)} => Unprofitable at ALL fee levels (no gross edge)`);
    } else if (breakevenRt >= 0) {
      // Convert RT to one-way
      const oneWayFee = breakevenRt / 2;
      console.log(`  ${sn.padEnd(20)} => Breakeven at ~${(breakevenRt * 100).toFixed(2)} bps round-trip (~${(oneWayFee * 100).toFixed(2)} bps one-way)`);
    } else {
      console.log(`  ${sn.padEnd(20)} => Non-monotonic PnL curve — breakeven unclear`);
    }
  }

  // ============================================================================
  // FEE IMPACT (how much PnL goes to fees)
  // ============================================================================
  console.log('\n');
  console.log('='.repeat(120));
  console.log('FEE IMPACT: Gross PnL (zero_fee) vs Net PnL at each level');
  console.log('='.repeat(120));

  for (const sn of stratNames) {
    const grossPnl = combinedPnl[sn]['zero_fee'];
    console.log(`\n  ${sn}: Gross PnL (zero fee) = $${grossPnl.toFixed(0)}`);
    for (const fn of feeNames) {
      if (fn === 'zero_fee') continue;
      const netPnl = combinedPnl[sn][fn];
      const feeCost = grossPnl - netPnl;
      const feePct = grossPnl !== 0 ? (feeCost / grossPnl * 100).toFixed(1) : 'N/A';
      console.log(`    ${fn.padEnd(20)} Net: $${netPnl.toFixed(0).padStart(8)} | Fees eaten: $${feeCost.toFixed(0).padStart(6)} (${feePct}% of gross)`);
    }
  }

  console.log('\n' + '='.repeat(120));
  console.log('DONE — Fee sensitivity analysis complete');
  console.log('='.repeat(120));
}

main().catch(console.error);
