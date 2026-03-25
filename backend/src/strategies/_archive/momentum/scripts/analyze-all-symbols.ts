/**
 * analyze-all-symbols.ts — Deep per-symbol analysis on 2025
 *
 * Tests ALL available symbols individually to find the best portfolio.
 * Also loads from data/2024/ directory for symbols not in main data/.
 * Analyzes what makes a crypto work well with our momentum strategy.
 *
 * Usage:
 *   npx tsx scripts/analyze-all-symbols.ts
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

// ============================================================================
// HELPERS
// ============================================================================
function padR(s: string, n: number) { return s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length); }
function padL(s: string, n: number) { return s.length >= n ? s.substring(0, n) : ' '.repeat(n - s.length) + s; }

// ============================================================================
// LOAD DATA (from both data/ and data/2024/)
// ============================================================================
async function loadAllSymbolData(startMs: number, endMs: number) {
  const extraBarsMs = 250 * 15 * 60 * 1000;
  const since = startMs - extraBarsMs;

  // Load BTC
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);

  // Discover ALL symbols from both data/ and data/2024/
  const dataDir = path.resolve(process.cwd(), 'data');
  const data2024Dir = path.resolve(process.cwd(), 'data', '2024');

  const symbolFiles = new Map<string, string>(); // symbol -> filepath

  // Main data/
  for (const f of fs.readdirSync(dataDir)) {
    const m = f.match(/^([A-Z]+_USDT)_15m\.json$/);
    if (m) {
      const sym = m[1].replace('_', '/') + ':USDT';
      symbolFiles.set(sym, path.join(dataDir, f));
    }
  }

  // data/2024/ (only if not already in main)
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

  // Load and slice all symbols
  const allData: Record<string, BacktestCandle[]> = {};
  const available: string[] = [];

  for (const [symbol, filepath] of symbolFiles) {
    if (symbol === 'BTC/USDT:USDT') continue; // Skip BTC (used as regime)

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

      // Slice to period
      const sliced = sliceCandlesByTime(candles, since, endMs);
      if (sliced.length < 300) {
        console.warn(`  ${symbol}: only ${sliced.length} candles in range, skipping`);
        continue;
      }

      allData[symbol] = sliced;
      available.push(symbol);
    } catch (e) {
      console.warn(`  Failed to load ${symbol}: ${(e as Error).message}`);
    }
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  return { btcCandles, allData, available, CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000 };
}

// ============================================================================
// PER-SYMBOL BACKTEST
// ============================================================================
interface SymbolResult {
  symbol: string;
  trades: number;
  longTrades: number;
  shortTrades: number;
  winRate: number;
  longWR: number;
  shortWR: number;
  pnlUsd: number;
  pnlPerTrade: number;
  longPnl: number;
  shortPnl: number;
  maxDD: number;
  sharpe: number;
  profitFactor: number;
  avgHoldMin: number;
  avgVolume: number; // avg daily volume of the asset
}

async function runPerSymbol(data: Awaited<ReturnType<typeof loadAllSymbolData>>): Promise<SymbolResult[]> {
  const startDate = new Date(PERIOD.start + 'T00:00:00.000Z');
  const endDate = new Date(PERIOD.end + 'T23:59:59.999Z');
  const results: SymbolResult[] = [];

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

    // Compute LONG/SHORT split
    const longTrades = result.trades.filter(t => t.side === 'long');
    const shortTrades = result.trades.filter(t => t.side === 'short');
    const longWins = longTrades.filter(t => t.netPnlUsd > 0).length;
    const shortWins = shortTrades.filter(t => t.netPnlUsd > 0).length;
    const longPnl = longTrades.reduce((sum, t) => sum + t.netPnlUsd, 0);
    const shortPnl = shortTrades.reduce((sum, t) => sum + t.netPnlUsd, 0);

    // Avg daily volume (approximate from candle data)
    const candles = data.allData[symbol];
    const recentCandles = candles.slice(-96 * 30); // last 30 days
    const avgVol = recentCandles.reduce((s, c) => s + c.volume * c.close, 0) / recentCandles.length * 96; // daily in USD

    const shortName = symbol.replace('/USDT:USDT', '');
    console.log(`  [${i + 1}/${data.available.length}] ${padR(shortName, 8)} ${s.totalTrades} trades, $${s.totalPnlUsd.toFixed(0)}, ${s.winRate.toFixed(1)}% WR, DD ${s.maxDrawdownPct.toFixed(1)}%`);

    results.push({
      symbol: shortName,
      trades: s.totalTrades,
      longTrades: s.longTrades,
      shortTrades: s.shortTrades,
      winRate: s.winRate,
      longWR: longTrades.length > 0 ? longWins / longTrades.length * 100 : 0,
      shortWR: shortTrades.length > 0 ? shortWins / shortTrades.length * 100 : 0,
      pnlUsd: s.totalPnlUsd,
      pnlPerTrade: s.totalTrades > 0 ? s.totalPnlUsd / s.totalTrades : 0,
      longPnl,
      shortPnl,
      maxDD: s.maxDrawdownPct,
      sharpe: s.sharpeRatio,
      profitFactor: s.profitFactor,
      avgHoldMin: s.avgHoldMinutes,
      avgVolume: avgVol,
    });
  }

  return results;
}

// ============================================================================
// ANALYSIS
// ============================================================================
function analyzeResults(results: SymbolResult[]) {
  // Sort by PnL
  results.sort((a, b) => b.pnlUsd - a.pnlUsd);

  console.log('\n' + '='.repeat(130));
  console.log('FULL SYMBOL RANKING (2025)');
  console.log('='.repeat(130));

  const hdr = [
    padR('Symbol', 8), padL('Trades', 7), padL('L/S', 9), padL('WR%', 6),
    padL('L-WR%', 6), padL('S-WR%', 6),
    padL('PnL $', 10), padL('L-PnL', 9), padL('S-PnL', 9),
    padL('$/tr', 7), padL('DD%', 6), padL('Sharpe', 7), padL('PF', 5),
  ].join(' | ');
  console.log(hdr);
  console.log('-'.repeat(130));

  for (const r of results) {
    const flag = r.sharpe >= 2 && r.profitFactor >= 1.3 ? 'A' :
                 r.sharpe >= 1 && r.profitFactor >= 1.1 ? 'B' :
                 r.pnlUsd < 0 ? 'X' : 'C';
    console.log(`${flag} ${[
      padR(r.symbol, 7),
      padL(String(r.trades), 7),
      padL(`${r.longTrades}/${r.shortTrades}`, 9),
      padL(r.winRate.toFixed(1), 6),
      padL(r.longWR.toFixed(1), 6),
      padL(r.shortWR.toFixed(1), 6),
      padL('$' + r.pnlUsd.toFixed(0), 10),
      padL('$' + r.longPnl.toFixed(0), 9),
      padL('$' + r.shortPnl.toFixed(0), 9),
      padL('$' + r.pnlPerTrade.toFixed(0), 7),
      padL(r.maxDD.toFixed(1), 6),
      padL(r.sharpe.toFixed(2), 7),
      padL(r.profitFactor.toFixed(2), 5),
    ].join(' | ')}`);
  }
  console.log('-'.repeat(130));
  console.log('A = Tier 1 (Sharpe>=2, PF>=1.3), B = Tier 2 (Sharpe>=1, PF>=1.1), C = Marginal, X = Negative PnL');

  // ===  LONG vs SHORT analysis ===
  console.log('\n\n--- LONG vs SHORT Performance Split ---\n');
  const longDominant = results.filter(r => r.longPnl > r.shortPnl && r.longPnl > 0);
  const shortDominant = results.filter(r => r.shortPnl > r.longPnl && r.shortPnl > 0);
  const balanced = results.filter(r => r.longPnl > 0 && r.shortPnl > 0 && Math.abs(r.longPnl - r.shortPnl) / Math.max(r.longPnl, r.shortPnl) < 0.5);

  console.log(`  LONG dominant:  ${longDominant.map(r => `${r.symbol}(L:$${r.longPnl.toFixed(0)} S:$${r.shortPnl.toFixed(0)})`).join(', ')}`);
  console.log(`  SHORT dominant: ${shortDominant.map(r => `${r.symbol}(L:$${r.longPnl.toFixed(0)} S:$${r.shortPnl.toFixed(0)})`).join(', ')}`);
  console.log(`  Balanced:       ${balanced.map(r => r.symbol).join(', ')}`);

  // === What makes a good crypto? ===
  console.log('\n\n--- What Makes a Good Crypto for Our Strategy? ---\n');
  const good = results.filter(r => r.sharpe >= 2 && r.profitFactor >= 1.3);
  const bad = results.filter(r => r.sharpe < 1 || r.profitFactor < 1.1);

  if (good.length > 0 && bad.length > 0) {
    const avg = (arr: SymbolResult[], key: keyof SymbolResult) =>
      arr.reduce((s, r) => s + (r[key] as number), 0) / arr.length;

    const metrics: { name: string; key: keyof SymbolResult }[] = [
      { name: 'Avg Trades', key: 'trades' },
      { name: 'Win Rate %', key: 'winRate' },
      { name: 'LONG WR %', key: 'longWR' },
      { name: 'SHORT WR %', key: 'shortWR' },
      { name: '$/trade', key: 'pnlPerTrade' },
      { name: 'Max DD %', key: 'maxDD' },
      { name: 'Avg Hold (min)', key: 'avgHoldMin' },
      { name: 'Est. Daily Vol $', key: 'avgVolume' },
    ];

    console.log(`  ${padR('Metric', 18)} | ${padL('Good (N=' + good.length + ')', 15)} | ${padL('Bad (N=' + bad.length + ')', 15)} | ${padL('Insight', 30)}`);
    console.log('  ' + '-'.repeat(85));

    for (const m of metrics) {
      const gAvg = avg(good, m.key);
      const bAvg = avg(bad, m.key);
      const diff = gAvg - bAvg;
      let insight = '';
      if (m.key === 'winRate') insight = diff > 5 ? 'WR matters a lot' : 'WR less important';
      if (m.key === 'shortWR') insight = diff > 5 ? 'SHORT edge is key' : 'SHORT similar';
      if (m.key === 'maxDD') insight = diff < 0 ? 'Good = lower DD' : 'Surprising: good has more DD';
      if (m.key === 'avgVolume') insight = gAvg > bAvg * 2 ? 'Higher volume helps' : 'Volume not decisive';
      if (m.key === 'avgHoldMin') insight = diff < 0 ? 'Good exits faster' : 'Good holds longer';
      if (m.key === 'trades') insight = diff > 0 ? 'More opportunities' : 'Fewer but better';

      console.log(`  ${padR(m.name, 18)} | ${padL(gAvg.toFixed(1), 15)} | ${padL(bAvg.toFixed(1), 15)} | ${padL(insight, 30)}`);
    }
  }

  // === Best portfolio recommendation ===
  console.log('\n\n--- Portfolio Recommendations ---\n');

  // Tier 1 only
  const t1 = results.filter(r => r.sharpe >= 2 && r.profitFactor >= 1.3 && r.trades >= 30);
  const t1pnl = t1.reduce((s, r) => s + r.pnlUsd, 0);
  console.log(`  TIER 1 only (${t1.length} symbols): ${t1.map(r => r.symbol).join(', ')}`);
  console.log(`    Combined PnL (individual sum): $${t1pnl.toFixed(0)}`);

  // Tier 1 + 2
  const t12 = results.filter(r => r.sharpe >= 1 && r.profitFactor >= 1.1 && r.trades >= 30);
  const t12pnl = t12.reduce((s, r) => s + r.pnlUsd, 0);
  console.log(`  TIER 1+2 (${t12.length} symbols): ${t12.map(r => r.symbol).join(', ')}`);
  console.log(`    Combined PnL (individual sum): $${t12pnl.toFixed(0)}`);

  // All positive
  const pos = results.filter(r => r.pnlUsd > 0 && r.trades >= 30);
  const posPnl = pos.reduce((s, r) => s + r.pnlUsd, 0);
  console.log(`  All positive (${pos.length} symbols): ${pos.map(r => r.symbol).join(', ')}`);
  console.log(`    Combined PnL (individual sum): $${posPnl.toFixed(0)}`);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('=== Deep Symbol Analysis (2025) ===\n');

  const startDate = new Date(PERIOD.start + 'T00:00:00.000Z');
  const endDate = new Date(PERIOD.end + 'T23:59:59.999Z');

  console.log('Loading ALL available symbol data...');
  const data = await loadAllSymbolData(startDate.getTime(), endDate.getTime());
  console.log(`  BTC 15m: ${data.btcCandles.length} candles`);
  console.log(`  Symbols: ${data.available.length} → ${data.available.map(s => s.replace('/USDT:USDT', '')).join(', ')}\n`);

  console.log('Running per-symbol backtests...\n');
  const results = await runPerSymbol(data);

  analyzeResults(results);

  console.log('\n\nDone.');
}

main().catch(console.error);
