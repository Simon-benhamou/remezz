/**
 * Polymarket Choppy-Market Filter Backtest
 *
 * Tests two new filters identified from live trade analysis:
 *   Filter 1 — "Pre-5m Micro-ROC": skip when BTC |ROC| over last 5 minutes < threshold
 *   Filter 2 — "Post-Breakout Cooldown": skip when BTC |ROC| over last 60 minutes > threshold
 *
 * Compares BASELINE (current prod) vs filtered configs across 30+ days of data.
 *
 * Usage:
 *   npx tsx scripts/polymarket-choppy-filter-bt.ts
 *   npx tsx scripts/polymarket-choppy-filter-bt.ts --days 60 --bet 5
 */

import { computeFiveMinScore } from '../src/services/polymarket/fiveMinScorer.js';
import type { Candle1m } from '../src/services/polymarket/polymarketTypes.js';

// ─── CLI ─────────────────────────────────────────────────────────────────────
function parseArg(name: string): string | undefined {
  const eqIdx = process.argv.findIndex(a => a.startsWith(`--${name}=`));
  if (eqIdx >= 0) return process.argv[eqIdx].split('=')[1];
  const spIdx = process.argv.indexOf(`--${name}`);
  if (spIdx >= 0 && spIdx + 1 < process.argv.length) return process.argv[spIdx + 1];
  return undefined;
}

const DAYS = parseInt(parseArg('days') ?? '30');
const BET = parseFloat(parseArg('bet') ?? '5');

// ─── Constants ───────────────────────────────────────────────────────────────
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const WINDOW_MS = 5 * 60_000;
const PRE_WINDOW_CANDLES = 5;
const MIN_SCORE = 50;

// ─── CLOB price model (calibrated on live trades) ───────────────────────────
const CLOB_CURVE: [number, number][] = [
  [0.000, 0.55],
  [0.030, 0.60],
  [0.060, 0.65],
  [0.100, 0.70],
  [0.150, 0.76],
  [0.250, 0.82],
  [0.400, 0.87],
];

function estimateClob(absMicroRocPct: number): number {
  if (absMicroRocPct <= CLOB_CURVE[0][0]) return CLOB_CURVE[0][1];
  if (absMicroRocPct >= CLOB_CURVE[CLOB_CURVE.length - 1][0]) return CLOB_CURVE[CLOB_CURVE.length - 1][1];
  for (let i = 1; i < CLOB_CURVE.length; i++) {
    if (absMicroRocPct <= CLOB_CURVE[i][0]) {
      const [x0, y0] = CLOB_CURVE[i - 1];
      const [x1, y1] = CLOB_CURVE[i];
      return y0 + (y1 - y0) * (absMicroRocPct - x0) / (x1 - x0);
    }
  }
  return CLOB_CURVE[CLOB_CURVE.length - 1][1];
}

// ─── Binance REST ────────────────────────────────────────────────────────────
interface BK { timestamp: number; open: number; high: number; low: number; close: number; volume: number; }

async function fetchKlines1m(symbol: string, startMs: number, endMs: number): Promise<BK[]> {
  const all: BK[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json() as any[];
    if (data.length === 0) break;
    for (const k of data) {
      all.push({ timestamp: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    }
    cursor = data[data.length - 1][0] + 60_000;
    if (data.length < 1000) break;
    await new Promise(r => setTimeout(r, 80));
  }
  return all;
}

// ─── Choppy Market Filters ──────────────────────────────────────────────────

/**
 * Filter 1: Pre-5m Micro-ROC
 * Skip when BTC hasn't moved enough in the last 5 minutes before the window.
 * Rationale: Losses come from flat/choppy markets where direction is random noise.
 */
function calcPre5mAbsRoc(btcIdx: Map<number, BK>, wStart: number): number {
  // Get BTC candles for 5 minutes ending right before window start
  const t5ago = wStart - 5 * 60_000;
  const cStart = btcIdx.get(t5ago);
  const cEnd = btcIdx.get(wStart - 60_000); // last closed 1m candle before window
  if (!cStart || !cEnd) return -1; // no data
  return Math.abs((cEnd.close - cStart.open) / cStart.open * 100);
}

/**
 * Filter 2: Post-Breakout Cooldown
 * Skip when BTC has moved too much in the last 60 minutes (post-breakout exhaustion).
 * Rationale: After a big move, momentum is exhausted and follow-through is unreliable.
 */
function calcPre60mRange(btcIdx: Map<number, BK>, wStart: number): number {
  const candles: BK[] = [];
  for (let t = wStart - 60 * 60_000; t < wStart; t += 60_000) {
    const c = btcIdx.get(t);
    if (c) candles.push(c);
  }
  if (candles.length < 30) return -1; // not enough data
  const high = Math.max(...candles.map(c => c.high));
  const low = Math.min(...candles.map(c => c.low));
  return (high - low) / low * 100;
}

/**
 * Filter 3: Pre-5m Choppiness (range / |ROC|)
 * High ratio = price oscillating in range but going nowhere.
 */
function calcPre5mChoppiness(btcIdx: Map<number, BK>, wStart: number): number {
  const candles: BK[] = [];
  for (let t = wStart - 5 * 60_000; t < wStart; t += 60_000) {
    const c = btcIdx.get(t);
    if (c) candles.push(c);
  }
  if (candles.length < 3) return -1;
  const high = Math.max(...candles.map(c => c.high));
  const low = Math.min(...candles.map(c => c.low));
  const range = (high - low) / low * 100;
  const absRoc = Math.abs((candles[candles.length - 1].close - candles[0].open) / candles[0].open * 100);
  if (absRoc < 0.001) return 99; // effectively flat
  return range / absRoc;
}

// ─── Types ───────────────────────────────────────────────────────────────────
interface Pred {
  windowStart: number;
  symbol: string;
  direction: 'UP' | 'DOWN';
  score: number;
  microRocPct: number;
  isCorrect: boolean;
  pre5mRoc: number;
  pre60mRange: number;
  pre5mChop: number;
}

interface Trade extends Pred {
  clob: number;
  pnl: number;
}

// ─── Scenario Config ─────────────────────────────────────────────────────────
interface Config {
  name: string;
  minScore: number;
  minConsensus: number;
  maxClob: number;
  // Choppy filters
  minPre5mRoc: number;      // 0 = disabled
  maxPre60mRange: number;    // 99 = disabled
  maxPre5mChop: number;      // 99 = disabled
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const endMs = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const startMs = endMs - DAYS * 86_400_000;

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  POLYMARKET CHOPPY-MARKET FILTER BACKTEST`);
  console.log(`  ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)} (${DAYS} days) | $${BET}/trade`);
  console.log(`${'═'.repeat(80)}\n`);

  // 1. Fetch candles (need 65 min extra before start for pre-window + filters)
  const idxBySym = new Map<string, Map<number, BK>>();
  for (const sym of SYMBOLS) {
    process.stdout.write(`  Fetching ${sym} 1m candles...`);
    const klines = await fetchKlines1m(sym, startMs - 65 * 60_000, endMs);
    const idx = new Map<number, BK>();
    for (const k of klines) idx.set(k.timestamp, k);
    idxBySym.set(sym, idx);
    console.log(` ${klines.length} candles`);
  }
  const btcIdx = idxBySym.get('BTC')!;

  // 2. Score all windows and compute filter metrics
  const allPreds: Pred[] = [];

  for (let wStart = startMs; wStart < endMs; wStart += WINDOW_MS) {
    // Compute BTC filter metrics once per window (shared across symbols)
    const pre5mRoc = calcPre5mAbsRoc(btcIdx, wStart);
    const pre60mRange = calcPre60mRange(btcIdx, wStart);
    const pre5mChop = calcPre5mChoppiness(btcIdx, wStart);

    for (const sym of SYMBOLS) {
      const idx = idxBySym.get(sym)!;

      // Only T+0:00 candle (completed at T+1:00 = decision time)
      const c0 = idx.get(wStart);
      if (!c0) continue;
      const windowCandles: Candle1m[] = [{ ...c0, isFinal: true }];

      const preCandles: Candle1m[] = [];
      for (let t = wStart - PRE_WINDOW_CANDLES * 60_000; t < wStart; t += 60_000) {
        const k = idx.get(t);
        if (k) preCandles.push({ ...k, isFinal: true });
      }

      const result = computeFiveMinScore(windowCandles, preCandles, c0.open);
      if (!result) continue;

      // Actual result: T+4:00 candle close vs T+0:00 open
      const endCandle = idx.get(wStart + 4 * 60_000);
      if (!endCandle) continue;

      allPreds.push({
        windowStart: wStart, symbol: sym,
        direction: result.direction, score: result.confidence,
        microRocPct: result.microRocPct,
        isCorrect: result.direction === (endCandle.close >= c0.open ? 'UP' : 'DOWN'),
        pre5mRoc,
        pre60mRange,
        pre5mChop,
      });
    }
  }

  console.log(`\n  Total raw predictions: ${allPreds.length}`);
  console.log(`  With score >= ${MIN_SCORE}: ${allPreds.filter(p => p.score >= MIN_SCORE).length}`);

  // 3. Group by window
  const byWindow = new Map<number, Pred[]>();
  for (const p of allPreds) {
    if (!byWindow.has(p.windowStart)) byWindow.set(p.windowStart, []);
    byWindow.get(p.windowStart)!.push(p);
  }

  // ─── Scenario Definitions ─────────────────────────────────────────────────

  const configs: Config[] = [
    // BASELINE: current prod (no choppy filter)
    { name: 'BASELINE (current prod)',        minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0,    maxPre60mRange: 99, maxPre5mChop: 99 },

    // Filter 1 only: Pre-5m ROC minimum (sweep thresholds)
    { name: 'F1: pre5mROC >= 0.04%',         minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0.04, maxPre60mRange: 99, maxPre5mChop: 99 },
    { name: 'F1: pre5mROC >= 0.06%',         minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0.06, maxPre60mRange: 99, maxPre5mChop: 99 },
    { name: 'F1: pre5mROC >= 0.08%',         minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0.08, maxPre60mRange: 99, maxPre5mChop: 99 },
    { name: 'F1: pre5mROC >= 0.10%',         minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0.10, maxPre60mRange: 99, maxPre5mChop: 99 },
    { name: 'F1: pre5mROC >= 0.12%',         minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0.12, maxPre60mRange: 99, maxPre5mChop: 99 },
    { name: 'F1: pre5mROC >= 0.15%',         minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0.15, maxPre60mRange: 99, maxPre5mChop: 99 },

    // Filter 2 only: Post-Breakout cooldown (sweep thresholds)
    { name: 'F2: pre60mRange <= 0.60%',      minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0,    maxPre60mRange: 0.60, maxPre5mChop: 99 },
    { name: 'F2: pre60mRange <= 0.80%',      minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0,    maxPre60mRange: 0.80, maxPre5mChop: 99 },
    { name: 'F2: pre60mRange <= 1.00%',      minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0,    maxPre60mRange: 1.00, maxPre5mChop: 99 },
    { name: 'F2: pre60mRange <= 1.20%',      minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0,    maxPre60mRange: 1.20, maxPre5mChop: 99 },
    { name: 'F2: pre60mRange <= 1.50%',      minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0,    maxPre60mRange: 1.50, maxPre5mChop: 99 },

    // Filter 1+2 combined (best candidates from each sweep)
    { name: 'F1+F2: ROC>=0.06 + Range<=0.80', minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0.06, maxPre60mRange: 0.80, maxPre5mChop: 99 },
    { name: 'F1+F2: ROC>=0.08 + Range<=1.00', minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0.08, maxPre60mRange: 1.00, maxPre5mChop: 99 },
    { name: 'F1+F2: ROC>=0.06 + Range<=1.00', minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0.06, maxPre60mRange: 1.00, maxPre5mChop: 99 },
    { name: 'F1+F2: ROC>=0.08 + Range<=0.80', minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0.08, maxPre60mRange: 0.80, maxPre5mChop: 99 },
    { name: 'F1+F2: ROC>=0.10 + Range<=1.00', minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0.10, maxPre60mRange: 1.00, maxPre5mChop: 99 },
    { name: 'F1+F2: ROC>=0.04 + Range<=1.20', minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0.04, maxPre60mRange: 1.20, maxPre5mChop: 99 },

    // Filter 3: Choppiness only
    { name: 'F3: pre5mChop <= 3.0',          minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0,    maxPre60mRange: 99,   maxPre5mChop: 3.0 },
    { name: 'F3: pre5mChop <= 5.0',          minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0,    maxPre60mRange: 99,   maxPre5mChop: 5.0 },
    { name: 'F3: pre5mChop <= 8.0',          minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0,    maxPre60mRange: 99,   maxPre5mChop: 8.0 },

    // No consensus requirement (all individual symbol trades)
    { name: 'NO CONS + F1: ROC>=0.08',       minScore: 50, minConsensus: 1, maxClob: 0.90, minPre5mRoc: 0.08, maxPre60mRange: 99,   maxPre5mChop: 99 },
    { name: 'NO CONS baseline',              minScore: 50, minConsensus: 1, maxClob: 0.90, minPre5mRoc: 0,    maxPre60mRange: 99,   maxPre5mChop: 99 },

    // Drop SOL
    { name: 'NO SOL baseline',               minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0,    maxPre60mRange: 99,   maxPre5mChop: 99 },
    { name: 'NO SOL + F1: ROC>=0.08',        minScore: 50, minConsensus: 3, maxClob: 0.90, minPre5mRoc: 0.08, maxPre60mRange: 99,   maxPre5mChop: 99 },
  ];

  // ─── Run Scenarios ─────────────────────────────────────────────────────────

  function runConfig(cfg: Config): Trade[] {
    const trades: Trade[] = [];
    const symbolFilter = cfg.name.startsWith('NO SOL') ? SYMBOLS.filter(s => s !== 'SOL') : SYMBOLS;

    for (const [wStart, preds] of byWindow) {
      // Score filter + symbol filter
      let eligible = preds.filter(p => p.score >= cfg.minScore && symbolFilter.includes(p.symbol));
      if (eligible.length === 0) continue;

      // Choppy market filters (on BTC metrics — shared per window)
      const p0 = eligible[0]; // all preds in same window share filter metrics
      if (cfg.minPre5mRoc > 0 && p0.pre5mRoc >= 0 && p0.pre5mRoc < cfg.minPre5mRoc) continue;
      if (cfg.maxPre60mRange < 99 && p0.pre60mRange >= 0 && p0.pre60mRange > cfg.maxPre60mRange) continue;
      if (cfg.maxPre5mChop < 99 && p0.pre5mChop >= 0 && p0.pre5mChop > cfg.maxPre5mChop) continue;

      // Consensus
      const upCount = eligible.filter(p => p.direction === 'UP').length;
      const downCount = eligible.filter(p => p.direction === 'DOWN').length;
      const maxDir: 'UP' | 'DOWN' = upCount >= downCount ? 'UP' : 'DOWN';

      let tradeable: Pred[];
      if (cfg.minConsensus <= 1) {
        tradeable = [...eligible];
      } else {
        if (Math.max(upCount, downCount) < cfg.minConsensus) continue;
        tradeable = eligible.filter(p => p.direction === maxDir);
      }

      // CLOB + PnL
      for (const p of tradeable) {
        const clob = estimateClob(Math.abs(p.microRocPct));
        if (clob > cfg.maxClob) continue;

        const pnl = p.isCorrect
          ? BET * (1 - clob) / clob
          : -BET;

        trades.push({ ...p, clob, pnl });
      }
    }

    return trades;
  }

  // ─── Output ────────────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(130)}`);
  console.log(`  ${'Scenario'.padEnd(38)} | ${'Trades'.padStart(6)} | ${'W'.padStart(5)} | ${'L'.padStart(5)} | ${'WR%'.padStart(6)} | ${'BE%'.padStart(5)} | ${'Edge'.padStart(7)} | ${'PnL'.padStart(9)} | ${'PnL/d'.padStart(7)} | ${'AvgCLOB'.padStart(7)} | ${'vs BL'.padStart(8)}`);
  console.log(`  ${'─'.repeat(127)}`);

  const results: { cfg: Config; trades: Trade[]; pnl: number }[] = [];

  for (const cfg of configs) {
    const trades = runConfig(cfg);
    const wins = trades.filter(t => t.isCorrect).length;
    const losses = trades.length - wins;
    const wr = trades.length > 0 ? wins / trades.length * 100 : 0;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgClob = trades.length > 0 ? trades.reduce((s, t) => s + t.clob, 0) / trades.length : 0;
    const breakevenWr = avgClob * 100;
    const pnlPerDay = totalPnl / DAYS;

    results.push({ cfg, trades, pnl: totalPnl });

    const baselinePnl = results[0]?.pnl ?? 0;
    const vsBl = results.length === 1 ? '—' : `${totalPnl >= baselinePnl ? '+' : ''}$${(totalPnl - baselinePnl).toFixed(0)}`;

    const row = [
      String(trades.length).padStart(6),
      `${wins}W`.padStart(5),
      `${losses}L`.padStart(5),
      `${wr.toFixed(1)}%`.padStart(6),
      `${breakevenWr.toFixed(0)}%`.padStart(5),
      `${(wr - breakevenWr >= 0 ? '+' : '')}${(wr - breakevenWr).toFixed(1)}pp`.padStart(7),
      `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)}`.padStart(9),
      `${pnlPerDay >= 0 ? '+' : ''}$${pnlPerDay.toFixed(1)}`.padStart(7),
      `${avgClob.toFixed(3)}`.padStart(7),
      vsBl.padStart(8),
    ].join(' | ');

    console.log(`  ${cfg.name.padEnd(38)} | ${row}`);
  }

  console.log(`${'═'.repeat(130)}`);

  // ─── Filter impact analysis ────────────────────────────────────────────────

  const baseline = results[0];
  const blWins = baseline.trades.filter(t => t.isCorrect).length;
  const blLosses = baseline.trades.length - blWins;
  const blWr = blWins / baseline.trades.length * 100;

  console.log(`\n── FILTER IMPACT ANALYSIS (vs BASELINE) ──\n`);
  console.log(`  Baseline: ${baseline.trades.length} trades, ${blWins}W/${blLosses}L, WR=${blWr.toFixed(1)}%, PnL=$${baseline.pnl.toFixed(0)}\n`);

  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    const w = r.trades.filter(t => t.isCorrect).length;
    const l = r.trades.length - w;
    const wr = r.trades.length > 0 ? w / r.trades.length * 100 : 0;

    const tradesDelta = r.trades.length - baseline.trades.length;
    const winsDelta = w - blWins;
    const lossesDelta = l - blLosses;
    const wrDelta = wr - blWr;
    const pnlDelta = r.pnl - baseline.pnl;

    // Only print significant results (> ±$10 PnL difference or > ±2pp WR)
    if (Math.abs(pnlDelta) > 10 || Math.abs(wrDelta) > 2) {
      const tag = pnlDelta > 0 && wrDelta > 0 ? ' *** BETTER ***' :
                  pnlDelta < 0 && wrDelta < 0 ? '     worse' :
                  pnlDelta > 0 ? ' * better PnL *' : ' mixed';
      console.log(`  ${r.cfg.name}`);
      console.log(`    Trades: ${tradesDelta >= 0 ? '+' : ''}${tradesDelta} | Wins: ${winsDelta >= 0 ? '+' : ''}${winsDelta} | Losses: ${lossesDelta >= 0 ? '+' : ''}${lossesDelta}`);
      console.log(`    WR: ${wrDelta >= 0 ? '+' : ''}${wrDelta.toFixed(1)}pp | PnL: ${pnlDelta >= 0 ? '+' : ''}$${pnlDelta.toFixed(0)} ${tag}`);
      console.log('');
    }
  }

  // ─── Daily equity curve for baseline and best filter ──────────────────────

  const best = results.slice(1).reduce((b, r) => r.pnl > b.pnl ? r : b, results[1]);

  console.log(`\n── DAILY EQUITY CURVES ──\n`);

  for (const r of [baseline, best]) {
    const label = r === baseline ? 'BASELINE' : `BEST: ${r.cfg.name}`;
    console.log(`  ${label}`);

    const daily = new Map<string, { pnl: number; trades: number; wins: number }>();
    for (const t of r.trades) {
      const day = new Date(t.windowStart).toISOString().slice(0, 10);
      const d = daily.get(day) ?? { pnl: 0, trades: 0, wins: 0 };
      d.pnl += t.pnl;
      d.trades++;
      if (t.isCorrect) d.wins++;
      daily.set(day, d);
    }

    const sorted = [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    let cumPnl = 0;
    let peak = 0;
    let maxDD = 0;
    let greenDays = 0;
    let redDays = 0;

    console.log(`  ${'Date'.padEnd(12)} ${'Tr'.padStart(4)} ${'WR%'.padStart(5)} ${'DayPnL'.padStart(9)} ${'CumPnL'.padStart(9)} ${'DD'.padStart(8)}`);

    for (const [day, d] of sorted) {
      cumPnl += d.pnl;
      peak = Math.max(peak, cumPnl);
      const dd = peak - cumPnl;
      maxDD = Math.max(maxDD, dd);
      if (d.pnl >= 0) greenDays++; else redDays++;
      const wr = d.trades > 0 ? d.wins / d.trades * 100 : 0;
      const bar = d.pnl >= 0
        ? '\x1b[32m' + '█'.repeat(Math.min(30, Math.round(d.pnl / 3))) + '\x1b[0m'
        : '\x1b[31m' + '█'.repeat(Math.min(30, Math.round(-d.pnl / 3))) + '\x1b[0m';
      console.log(`  ${day} ${String(d.trades).padStart(4)} ${wr.toFixed(0).padStart(4)}% ${`${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2)}`.padStart(9)} ${`$${cumPnl.toFixed(2)}`.padStart(9)} ${`$${dd.toFixed(0)}`.padStart(8)} ${bar}`);
    }

    console.log(`  Max DD: $${maxDD.toFixed(0)} | Green: ${greenDays}/${greenDays + redDays} (${((greenDays / (greenDays + redDays)) * 100).toFixed(0)}%)`);
    console.log(`  Final PnL: $${cumPnl.toFixed(0)} | PnL/day: $${(cumPnl / DAYS).toFixed(1)}\n`);
  }

  // ─── Hourly WR analysis (baseline vs best) ────────────────────────────────

  console.log(`── HOURLY WIN RATE: BASELINE vs BEST ──\n`);
  console.log(`  ${'Hour'.padEnd(6)} | ${'BL Trades'.padStart(9)} ${'BL WR%'.padStart(7)} ${'BL PnL'.padStart(8)} | ${'Best Tr'.padStart(7)} ${'Best WR%'.padStart(8)} ${'Best PnL'.padStart(8)}`);
  console.log(`  ${'─'.repeat(75)}`);

  for (let h = 0; h < 24; h++) {
    const blH = baseline.trades.filter(t => new Date(t.windowStart).getUTCHours() === h);
    const bestH = best.trades.filter(t => new Date(t.windowStart).getUTCHours() === h);
    if (blH.length === 0 && bestH.length === 0) continue;

    const blHW = blH.filter(t => t.isCorrect).length;
    const blHWr = blH.length > 0 ? (blHW / blH.length * 100).toFixed(1) : '—';
    const blHPnl = blH.reduce((s, t) => s + t.pnl, 0);

    const bestHW = bestH.filter(t => t.isCorrect).length;
    const bestHWr = bestH.length > 0 ? (bestHW / bestH.length * 100).toFixed(1) : '—';
    const bestHPnl = bestH.reduce((s, t) => s + t.pnl, 0);

    const improved = bestHPnl > blHPnl ? ' +' : blHPnl > bestHPnl + 5 ? ' -' : '';

    console.log(
      `  ${String(h).padStart(2)}:00  | ${String(blH.length).padStart(9)} ${String(blHWr).padStart(6)}% ${`$${blHPnl.toFixed(0)}`.padStart(8)} | ` +
      `${String(bestH.length).padStart(7)} ${String(bestHWr).padStart(7)}% ${`$${bestHPnl.toFixed(0)}`.padStart(8)}${improved}`
    );
  }

  // ─── Per-symbol WR analysis ────────────────────────────────────────────────

  console.log(`\n── PER-SYMBOL: BASELINE vs BEST ──\n`);
  for (const sym of SYMBOLS) {
    const blS = baseline.trades.filter(t => t.symbol === sym);
    const bestS = best.trades.filter(t => t.symbol === sym);
    const blSW = blS.filter(t => t.isCorrect).length;
    const bestSW = bestS.filter(t => t.isCorrect).length;
    const blSWr = blS.length > 0 ? (blSW / blS.length * 100).toFixed(1) : '—';
    const bestSWr = bestS.length > 0 ? (bestSW / bestS.length * 100).toFixed(1) : '—';
    const blSPnl = blS.reduce((s, t) => s + t.pnl, 0);
    const bestSPnl = bestS.reduce((s, t) => s + t.pnl, 0);

    console.log(`  ${sym.padEnd(4)}: BL=${blS.length}tr WR=${blSWr}% PnL=$${blSPnl.toFixed(0)} | Best=${bestS.length}tr WR=${bestSWr}% PnL=$${bestSPnl.toFixed(0)}`);
  }

  // ─── Final verdict ─────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  BASELINE: $${baseline.pnl.toFixed(0)} | ${baseline.trades.length} trades`);
  console.log(`  BEST:     $${best.pnl.toFixed(0)} | ${best.trades.length} trades | ${best.cfg.name}`);

  const delta = best.pnl - baseline.pnl;
  if (delta > 0) {
    console.log(`  IMPROVEMENT: +$${delta.toFixed(0)} (+${(delta / Math.abs(baseline.pnl) * 100).toFixed(0)}%)`);
  } else {
    console.log(`  NO IMPROVEMENT: filter doesn't help over ${DAYS} days`);
  }
  console.log(`${'═'.repeat(80)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
