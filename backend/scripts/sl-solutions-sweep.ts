/**
 * sl-solutions-sweep.ts — Fast sweep of SL reduction approaches
 *
 * Uses ONE backtest run + MAE/MFE analysis to simulate different configs:
 * 1. Adaptive SL: wider SL in MED/HIGH vol (simulated via MAE)
 * 2. ATR entry filter: block entries when ATR% > threshold
 * 3. Time-of-day filter: block 20-24 UTC entries
 * 4. Breakeven acceleration: move BE trigger from 0.7% to 0.4%
 * 5. Combos of the above
 *
 * METHODOLOGY:
 * - Entry filters: post-filter (caveat: slot replacement effect means real engine results will differ)
 * - SL widening: if trade's MAE > new_SL, it survives. If MAE < new_SL, still dies.
 *   Surviving trades assumed to become STAGNANT exits (conservative estimate).
 * - Breakeven: if MFE >= BE_trigger within first N bars, subsequent MAE limited to ~0.1%
 *
 * Run: npx tsx scripts/sl-solutions-sweep.ts
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

const SYMBOLS = ['AVAX', 'FET', 'WIF', 'DOT', 'IMX', 'STX', 'ADA', 'RENDER', 'XRP'];
const INITIAL_CAPITAL = 2000;
const LEVERAGE = 5;
const DATA_DIR = path.resolve(process.cwd(), 'data');
const GRID = 15 * 60 * 1000;

// ============================================================================
// DATA LOADING + BACKTEST
// ============================================================================

async function loadAndRun(start: string, end: string) {
  const startDate = new Date(start + 'T00:00:00.000Z');
  const endDate = new Date(end + 'T23:59:59.999Z');
  const extraBarsMs = 3200 * GRID;
  const since = startDate.getTime() - extraBarsMs;
  const endMs = endDate.getTime();

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No BTC data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);

  const allData: Record<string, BacktestCandle[]> = {};
  for (const sym of SYMBOLS) {
    const fpath = path.join(DATA_DIR, sym + '_USDT_15m.json');
    if (!fs.existsSync(fpath)) continue;
    const raw = JSON.parse(fs.readFileSync(fpath, 'utf8'));
    const candles: BacktestCandle[] = raw
      .filter((c: any) => c.openTime && c.open && c.close)
      .map((c: any) => ({
        timestamp: c.openTime, open: +c.open, high: +c.high,
        low: +c.low, close: +c.close, volume: +(c.volume || 0),
      }))
      .sort((a: BacktestCandle, b: BacktestCandle) => a.timestamp - b.timestamp);
    const sliced = sliceCandlesByTime(candles, since, endMs);
    if (sliced.length >= 300) allData[sym + '/USDT:USDT'] = sliced;
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  const input: BacktestComputationInput = {
    params: { startDate, endDate, initialCapital: INITIAL_CAPITAL, symbols: Object.keys(allData), leverage: LEVERAGE },
    btcCandles, btcCandlesRegime: btcCandles, allData,
    CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000,
  };

  const result = await runBacktestComputation(input);
  return { trades: result.trades, summary: result.summary, btcCandles, allData };
}

// ============================================================================
// TRADE ENRICHMENT — add MAE/MFE + context
// ============================================================================

interface EnrichedTrade {
  symbol: string;
  side: 'long' | 'short';
  exitReason: string;
  entryPrice: number;
  exitPrice: number;
  netPnlUsd: number;
  holdBars: number;
  isSL: boolean;
  isWin: boolean;
  isStagnant: boolean;

  // MAE/MFE
  mae: number;
  mfe: number;
  barsToMae: number;
  mfeBars: { bar: number; pnlPct: number }[]; // PnL% at each bar

  // Entry context
  hourUtc: number;
  atrPct: number;
  volRegime: 'LOW' | 'MED' | 'HIGH';

  // For SL simulation
  slPct: number; // estimated SL% based on tier + vol regime
}

function calcATR(candles: BacktestCandle[], period: number): number {
  if (candles.length < period + 1) return 0;
  const slice = candles.slice(-period - 1);
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const tr = Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low - slice[i - 1].close),
    );
    sum += tr;
  }
  return sum / period;
}

function getSymbolTier(symbol: string): 1 | 2 | 3 {
  const sym = symbol.replace('/USDT:USDT', '');
  const tier3 = ['IMX', 'OP', 'FTM', 'FET', 'WIF', 'RENDER'];
  const tier1 = ['BTC', 'ETH'];
  if (tier1.includes(sym)) return 1;
  if (tier3.includes(sym)) return 3;
  return 2;
}

function getSlPct(tier: number, volRegime: string): number {
  const slTable: Record<string, Record<string, number>> = {
    '1': { LOW: 1.5, MED: 2.0, HIGH: 2.5 },
    '2': { LOW: 2.0, MED: 2.5, HIGH: 3.0 },
    '3': { LOW: 2.5, MED: 3.0, HIGH: 3.5 },
  };
  return slTable[String(tier)]?.[volRegime] ?? 2.5;
}

function enrichTrade(
  trade: any,
  symCandles: BacktestCandle[],
  symTsMap: Map<number, number>,
): EnrichedTrade | null {
  const entryTs = new Date(trade.entryTime).getTime();
  const exitTs = new Date(trade.exitTime).getTime();
  const signalGridTs = Math.floor((entryTs - GRID) / GRID) * GRID;

  let symIdx = symTsMap.get(signalGridTs);
  if (symIdx === undefined) {
    let best = 0, bestDist = Infinity;
    for (const [ts, idx] of symTsMap) {
      if (Math.abs(ts - signalGridTs) < bestDist) { bestDist = Math.abs(ts - signalGridTs); best = idx; }
    }
    symIdx = best;
  }
  if (symIdx < 20) return null;

  const isLong = trade.side === 'long';
  const entryPrice = trade.entryPrice;
  const holdBars = Math.max(1, Math.round((exitTs - entryTs) / GRID));
  const entryIdx = symIdx + 1;

  // MAE/MFE bar-by-bar
  const maxBars = Math.min(holdBars + 5, symCandles.length - entryIdx);
  let mae = 0, mfe = 0, barsToMae = 0;
  const mfeBars: { bar: number; pnlPct: number }[] = [];

  for (let b = 0; b < maxBars && (entryIdx + b) < symCandles.length; b++) {
    const c = symCandles[entryIdx + b];
    const pnlHigh = isLong
      ? (c.high - entryPrice) / entryPrice * 100
      : (entryPrice - c.low) / entryPrice * 100;
    const pnlLow = isLong
      ? (c.low - entryPrice) / entryPrice * 100
      : (entryPrice - c.high) / entryPrice * 100;
    const pnlClose = isLong
      ? (c.close - entryPrice) / entryPrice * 100
      : (entryPrice - c.close) / entryPrice * 100;

    if (pnlLow < mae) { mae = pnlLow; barsToMae = b + 1; }
    if (pnlHigh > mfe) mfe = pnlHigh;
    mfeBars.push({ bar: b + 1, pnlPct: pnlClose });
  }

  // Entry context
  const signalCandle = symCandles[symIdx];
  const pre20 = symCandles.slice(Math.max(0, symIdx - 20), symIdx + 1);
  const atr = calcATR(pre20, 14);
  const atrPct = signalCandle.close > 0 ? (atr / signalCandle.close) * 100 : 0;
  const volRegime: 'LOW' | 'MED' | 'HIGH' = atrPct < 2 ? 'LOW' : atrPct < 3.5 ? 'MED' : 'HIGH';

  const tier = getSymbolTier(trade.symbol);
  const slPct = getSlPct(tier, volRegime);

  const reason = trade.exitReason || '';
  const isSL = reason.includes('SL') || reason.includes('STOP_LOSS') || reason.includes('stoploss');
  const isStagnant = reason.includes('stagnant') || reason.includes('STAGNANT');

  return {
    symbol: trade.symbol,
    side: trade.side,
    exitReason: reason,
    entryPrice,
    exitPrice: trade.exitPrice,
    netPnlUsd: trade.netPnlUsd,
    holdBars,
    isSL,
    isWin: trade.netPnlUsd > 0,
    isStagnant,
    mae, mfe, barsToMae,
    mfeBars,
    hourUtc: new Date(entryTs).getUTCHours(),
    atrPct,
    volRegime,
    slPct,
  };
}

// ============================================================================
// SIMULATION FUNCTIONS
// ============================================================================

interface SimResult {
  name: string;
  totalTrades: number;
  wins: number;
  pnl: number;
  slCount: number;
  slPnl: number;
  savedFromSl: number;     // trades saved from SL by this config
  savedPnlDelta: number;   // estimated PnL improvement from saved trades
}

function baseline(trades: EnrichedTrade[]): SimResult {
  return {
    name: 'BASELINE',
    totalTrades: trades.length,
    wins: trades.filter(t => t.isWin).length,
    pnl: trades.reduce((s, t) => s + t.netPnlUsd, 0),
    slCount: trades.filter(t => t.isSL).length,
    slPnl: trades.filter(t => t.isSL).reduce((s, t) => s + t.netPnlUsd, 0),
    savedFromSl: 0,
    savedPnlDelta: 0,
  };
}

// Approach 1: Widen SL in MED vol
// If trade's MAE > -newSlPct, it would survive. Conservative: survived trades → $0 PnL (breakeven)
function simWidenSl(trades: EnrichedTrade[], medSlAdd: number, highSlAdd: number): SimResult {
  let savedCount = 0, savedPnl = 0;
  let totalPnl = 0, slCount = 0, slPnl = 0, wins = 0;

  for (const t of trades) {
    let newSlPct = t.slPct;
    if (t.volRegime === 'MED') newSlPct += medSlAdd;
    if (t.volRegime === 'HIGH') newSlPct += highSlAdd;

    if (t.isSL && Math.abs(t.mae) <= newSlPct) {
      // Trade survives SL! Conservative estimate: exits at breakeven ($0)
      // Less conservative: look at where price goes after original SL bar
      savedCount++;
      const originalLoss = t.netPnlUsd;
      savedPnl += Math.abs(originalLoss); // we avoid this loss
      totalPnl += 0; // breakeven estimate
      wins++; // count as win (avoided loss)
    } else if (t.isSL) {
      // Still hits SL but at wider level — worse PnL
      const widthRatio = newSlPct / t.slPct;
      const adjustedPnl = t.netPnlUsd * widthRatio; // proportionally worse
      totalPnl += adjustedPnl;
      slCount++;
      slPnl += adjustedPnl;
    } else {
      totalPnl += t.netPnlUsd;
      slCount += 0;
      if (t.isWin) wins++;
    }
  }

  return {
    name: `SL widen MED+${medSlAdd}% HIGH+${highSlAdd}%`,
    totalTrades: trades.length,
    wins,
    pnl: totalPnl,
    slCount,
    slPnl,
    savedFromSl: savedCount,
    savedPnlDelta: totalPnl - trades.reduce((s, t) => s + t.netPnlUsd, 0),
  };
}

// Approach 2: ATR entry filter — block trades when ATR% > threshold
function simAtrFilter(trades: EnrichedTrade[], maxAtrPct: number): SimResult {
  const kept = trades.filter(t => t.atrPct <= maxAtrPct);
  const filtered = trades.filter(t => t.atrPct > maxAtrPct);
  return {
    name: `ATR filter <${maxAtrPct}%`,
    totalTrades: kept.length,
    wins: kept.filter(t => t.isWin).length,
    pnl: kept.reduce((s, t) => s + t.netPnlUsd, 0),
    slCount: kept.filter(t => t.isSL).length,
    slPnl: kept.filter(t => t.isSL).reduce((s, t) => s + t.netPnlUsd, 0),
    savedFromSl: filtered.filter(t => t.isSL).length,
    savedPnlDelta: kept.reduce((s, t) => s + t.netPnlUsd, 0) - trades.reduce((s, t) => s + t.netPnlUsd, 0),
  };
}

// Approach 3: Time-of-day filter
function simTimeFilter(trades: EnrichedTrade[], blockedHours: number[]): SimResult {
  const kept = trades.filter(t => !blockedHours.includes(t.hourUtc));
  const filtered = trades.filter(t => blockedHours.includes(t.hourUtc));
  return {
    name: `Block hours ${blockedHours.join(',')}`,
    totalTrades: kept.length,
    wins: kept.filter(t => t.isWin).length,
    pnl: kept.reduce((s, t) => s + t.netPnlUsd, 0),
    slCount: kept.filter(t => t.isSL).length,
    slPnl: kept.filter(t => t.isSL).reduce((s, t) => s + t.netPnlUsd, 0),
    savedFromSl: filtered.filter(t => t.isSL).length,
    savedPnlDelta: kept.reduce((s, t) => s + t.netPnlUsd, 0) - trades.reduce((s, t) => s + t.netPnlUsd, 0),
  };
}

// Approach 4: Breakeven acceleration
// If MFE >= beTrigger within first N bars, treat the trade as surviving
// (any adverse move after BE would be limited to ~0.1% offset)
function simBreakeven(trades: EnrichedTrade[], beTrigger: number): SimResult {
  let totalPnl = 0, slCount = 0, slPnl = 0, wins = 0, savedCount = 0;

  for (const t of trades) {
    // Check if MFE reaches beTrigger%
    const reachedBe = t.mfe >= beTrigger;

    if (t.isSL && reachedBe) {
      // Trade would have moved to breakeven before crashing
      // Check: did it reach BE trigger BEFORE MAE?
      // Use mfeBars to check timing
      let beBar = -1;
      for (const mb of t.mfeBars) {
        if (mb.pnlPct >= beTrigger) { beBar = mb.bar; break; }
      }

      if (beBar > 0 && beBar < t.barsToMae) {
        // BE triggered BEFORE MAE → trade exits at ~breakeven (+0.1%)
        savedCount++;
        totalPnl += 0; // breakeven
        wins++;
      } else {
        // MAE happened before BE was reached
        totalPnl += t.netPnlUsd;
        slCount++;
        slPnl += t.netPnlUsd;
      }
    } else {
      totalPnl += t.netPnlUsd;
      if (t.isSL) { slCount++; slPnl += t.netPnlUsd; }
      if (t.isWin) wins++;
    }
  }

  return {
    name: `Breakeven @${beTrigger}%`,
    totalTrades: trades.length,
    wins,
    pnl: totalPnl,
    slCount,
    slPnl,
    savedFromSl: savedCount,
    savedPnlDelta: totalPnl - trades.reduce((s, t) => s + t.netPnlUsd, 0),
  };
}

// Combo: apply multiple filters
function simCombo(
  trades: EnrichedTrade[],
  name: string,
  opts: {
    maxAtrPct?: number;
    blockedHours?: number[];
    beTrigger?: number;
    medSlAdd?: number;
    highSlAdd?: number;
  }
): SimResult {
  let filtered = [...trades];

  // Entry filters
  if (opts.maxAtrPct) filtered = filtered.filter(t => t.atrPct <= opts.maxAtrPct!);
  if (opts.blockedHours) filtered = filtered.filter(t => !opts.blockedHours!.includes(t.hourUtc));

  // Exit simulations on remaining trades
  let totalPnl = 0, slCount = 0, slPnl = 0, wins = 0, savedCount = 0;

  for (const t of filtered) {
    let saved = false;

    // Breakeven check
    if (opts.beTrigger && t.isSL && t.mfe >= opts.beTrigger) {
      let beBar = -1;
      for (const mb of t.mfeBars) {
        if (mb.pnlPct >= opts.beTrigger!) { beBar = mb.bar; break; }
      }
      if (beBar > 0 && beBar < t.barsToMae) {
        saved = true;
        savedCount++;
        totalPnl += 0;
        wins++;
      }
    }

    // SL widening check (if not already saved by BE)
    if (!saved && t.isSL && (opts.medSlAdd || opts.highSlAdd)) {
      let newSlPct = t.slPct;
      if (t.volRegime === 'MED') newSlPct += (opts.medSlAdd ?? 0);
      if (t.volRegime === 'HIGH') newSlPct += (opts.highSlAdd ?? 0);

      if (Math.abs(t.mae) <= newSlPct) {
        saved = true;
        savedCount++;
        totalPnl += 0;
        wins++;
      } else {
        const widthRatio = newSlPct / t.slPct;
        totalPnl += t.netPnlUsd * widthRatio;
        slCount++;
        slPnl += t.netPnlUsd * widthRatio;
      }
    }

    if (!saved) {
      if (t.isSL && !(opts.medSlAdd || opts.highSlAdd)) {
        totalPnl += t.netPnlUsd;
        slCount++;
        slPnl += t.netPnlUsd;
      } else if (!t.isSL) {
        totalPnl += t.netPnlUsd;
        if (t.isWin) wins++;
      } else if (t.isSL) {
        totalPnl += t.netPnlUsd;
        slCount++;
        slPnl += t.netPnlUsd;
      }
    }
  }

  const basePnl = trades.reduce((s, t) => s + t.netPnlUsd, 0);
  return {
    name,
    totalTrades: filtered.length,
    wins,
    pnl: totalPnl,
    slCount,
    slPnl,
    savedFromSl: savedCount,
    savedPnlDelta: totalPnl - basePnl,
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     SL SOLUTIONS SWEEP — Fast simulation via MAE/MFE              ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  for (const { label, start, end } of [
    { label: '2025', start: '2025-01-01', end: '2025-12-31' },
    { label: '2024', start: '2024-01-01', end: '2024-12-31' },
  ]) {
    console.log(`\nRunning ${label} backtest...`);
    const { trades, allData } = await loadAndRun(start, end);
    console.log(`  ${trades.length} trades\n`);

    // Build maps and enrich
    function buildTsMap(candles: BacktestCandle[]) {
      const m = new Map<number, number>();
      for (let i = 0; i < candles.length; i++) m.set(Math.floor(candles[i].timestamp / GRID) * GRID, i);
      return m;
    }

    const symMaps = new Map<string, Map<number, number>>();
    for (const [sym, c] of Object.entries(allData)) symMaps.set(sym, buildTsMap(c));

    const enriched: EnrichedTrade[] = [];
    for (const trade of trades) {
      const symCandles = allData[trade.symbol];
      const symMap = symMaps.get(trade.symbol);
      if (!symCandles || !symMap) continue;
      const e = enrichTrade(trade, symCandles, symMap);
      if (e) enriched.push(e);
    }

    const slTrades = enriched.filter(t => t.isSL);
    console.log(`  Enriched: ${enriched.length} trades (${slTrades.length} SL, ${enriched.filter(t => t.isWin).length} WIN)`);
    console.log(`  Vol regime: LOW=${enriched.filter(t => t.volRegime === 'LOW').length}, MED=${enriched.filter(t => t.volRegime === 'MED').length}, HIGH=${enriched.filter(t => t.volRegime === 'HIGH').length}`);

    // Run all simulations
    const results: SimResult[] = [];

    // Baseline
    results.push(baseline(enriched));

    // 1. SL widening
    results.push(simWidenSl(enriched, 0.5, 0.5));   // MED +0.5%, HIGH +0.5%
    results.push(simWidenSl(enriched, 1.0, 1.0));   // MED +1.0%, HIGH +1.0%
    results.push(simWidenSl(enriched, 1.5, 1.5));   // MED +1.5%, HIGH +1.5%

    // 2. ATR entry filter
    results.push(simAtrFilter(enriched, 1.5));
    results.push(simAtrFilter(enriched, 2.0));
    results.push(simAtrFilter(enriched, 2.5));

    // 3. Time-of-day filter
    results.push(simTimeFilter(enriched, [20, 21, 22, 23]));       // Block 20-24 UTC
    results.push(simTimeFilter(enriched, [0, 1, 2, 3]));           // Block 00-04 UTC
    results.push(simTimeFilter(enriched, [20, 21, 22, 23, 0, 1, 2, 3])); // Block both

    // 4. Breakeven acceleration
    results.push(simBreakeven(enriched, 0.3));
    results.push(simBreakeven(enriched, 0.4));
    results.push(simBreakeven(enriched, 0.5));

    // 5. Best combos
    results.push(simCombo(enriched, 'ATR<2% + BE@0.4%', { maxAtrPct: 2.0, beTrigger: 0.4 }));
    results.push(simCombo(enriched, 'ATR<2% + Block 20-24', { maxAtrPct: 2.0, blockedHours: [20, 21, 22, 23] }));
    results.push(simCombo(enriched, 'Block 20-24 + BE@0.4%', { blockedHours: [20, 21, 22, 23], beTrigger: 0.4 }));
    results.push(simCombo(enriched, 'SL+1% + BE@0.4%', { medSlAdd: 1.0, highSlAdd: 1.0, beTrigger: 0.4 }));
    results.push(simCombo(enriched, 'ATR<2% + Block20-24 + BE@0.4%', { maxAtrPct: 2.0, blockedHours: [20, 21, 22, 23], beTrigger: 0.4 }));
    results.push(simCombo(enriched, 'SL+1% + ATR<2% + BE@0.4%', { medSlAdd: 1.0, highSlAdd: 1.0, maxAtrPct: 2.0, beTrigger: 0.4 }));
    results.push(simCombo(enriched, 'FULL: SL+1%+ATR<2%+20-24+BE@0.4%', { medSlAdd: 1.0, highSlAdd: 1.0, maxAtrPct: 2.0, blockedHours: [20, 21, 22, 23], beTrigger: 0.4 }));

    // Print results
    console.log(`\n${'═'.repeat(120)}`);
    console.log(`  ${label} RESULTS — sorted by PnL delta`);
    console.log(`${'═'.repeat(120)}\n`);

    const basePnl = results[0].pnl;
    const sorted = [...results].sort((a, b) => b.pnl - a.pnl);

    console.log(
      '  ' + 'Config'.padEnd(40) +
      '| Trades | Wins | WR%   | PnL       | SL cnt | SL PnL    | Saved | Delta'
    );
    console.log('  ' + '-'.repeat(115));

    for (const r of sorted) {
      const wr = r.totalTrades > 0 ? (r.wins / r.totalTrades * 100).toFixed(1) : '0.0';
      const delta = r.pnl - basePnl;
      const deltaStr = delta >= 0 ? `+$${delta.toFixed(0)}` : `-$${Math.abs(delta).toFixed(0)}`;
      console.log(
        '  ' + r.name.padEnd(40) +
        '| ' + String(r.totalTrades).padStart(6) +
        ' | ' + String(r.wins).padStart(4) +
        ' | ' + wr.padStart(5) +
        ' | ' + ('$' + r.pnl.toFixed(0)).padStart(9) +
        ' | ' + String(r.slCount).padStart(6) +
        ' | ' + ('$' + r.slPnl.toFixed(0)).padStart(9) +
        ' | ' + String(r.savedFromSl).padStart(5) +
        ' | ' + deltaStr.padStart(8)
      );
    }

    // Highlight insights
    const bestSingle = sorted.filter(r => r.name !== 'BASELINE' && !r.name.includes('+'))[0];
    const bestCombo = sorted.filter(r => r.name.includes('+'))[0];
    console.log(`\n  Best single: ${bestSingle?.name} (${bestSingle ? `$${bestSingle.pnl.toFixed(0)}, delta +$${(bestSingle.pnl - basePnl).toFixed(0)}` : 'none'})`);
    console.log(`  Best combo:  ${bestCombo?.name} (${bestCombo ? `$${bestCombo.pnl.toFixed(0)}, delta +$${(bestCombo.pnl - basePnl).toFixed(0)}` : 'none'})`);
  }

  console.log('\n\n⚠️  CAVEATS:');
  console.log('  - Entry filters (ATR, time) are POST-FILTER → slot replacement effect applies');
  console.log('  - SL widening assumes saved trades exit at $0 (conservative)');
  console.log('  - Breakeven simulation checks MFE timing vs MAE timing (realistic)');
  console.log('  - Best configs should be validated via ENGINE integration');
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
