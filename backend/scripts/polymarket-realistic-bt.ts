/**
 * Realistic Polymarket backtest — NO look-ahead bias
 *
 * Uses correct scoring (1 candle at T+1:00), CLOB model from 98 live trades,
 * binary PnL ($BET on loss, variable win based on CLOB price).
 *
 * Tests all filter combinations to find what produces a positive equity curve
 * despite 100% loss on wrong bets.
 *
 * Usage:
 *   npx tsx scripts/polymarket-realistic-bt.ts --days 30
 *   npx tsx scripts/polymarket-realistic-bt.ts --days 60 --bet 5
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
const MIN_SCORE = 40;
const FLAT_THRESHOLD = 0.02;

// ─── CLOB price model (calibrated on 98 live virtual trades) ─────────────────
// Maps |microRocPct| → estimated CLOB ask price
// At decision time (T+1:00), microRocPct is computed from 1 candle only
const CLOB_CURVE: [number, number][] = [
  [0.000, 0.55],  // flat → CLOB ~55c
  [0.030, 0.60],  // small move → 60c
  [0.060, 0.65],  // moderate → 65c
  [0.100, 0.70],  // solid → 70c
  [0.150, 0.76],  // strong → 76c
  [0.250, 0.82],  // very strong → 82c
  [0.400, 0.87],  // extreme → 87c
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

// ─── Market filter (same as polymarketWorker.ts V5.128) ──────────────────────
function computeBtcCtx(btcIdx: Map<number, BK>, wStart: number) {
  const candles: BK[] = [];
  for (let t = wStart - 15 * 60_000; t < wStart; t += 60_000) {
    const c = btcIdx.get(t);
    if (c) candles.push(c);
  }
  if (candles.length < 10) return null;
  const last = candles[candles.length - 1];
  const last5 = candles.slice(-5);
  const last10 = candles.slice(-10);
  const roc5m = (last.close - last5[0].open) / last5[0].open * 100;
  const roc15m = (last.close - candles[0].open) / candles[0].open * 100;
  const bodyRatio = last10.reduce((s, c) => {
    const r = c.high - c.low;
    return r === 0 ? s : s + Math.abs(c.close - c.open) / r;
  }, 0) / last10.length;
  return { roc5m, roc15m, bodyRatio };
}

function passesMarketFilter(ctx: { roc5m: number; roc15m: number; bodyRatio: number }, dir: 'UP' | 'DOWN'): boolean {
  const flat = Math.abs(ctx.roc5m) < FLAT_THRESHOLD;
  const mr = flat || (dir === 'UP' && ctx.roc5m < 0) || (dir === 'DOWN' && ctx.roc5m > 0);
  if (!mr) return false;
  const align = ctx.roc5m !== 0 && Math.sign(ctx.roc5m) === Math.sign(ctx.roc15m);
  if (!align && !flat) return false;
  if (ctx.bodyRatio <= 0.5) return false;
  return true;
}

// ─── Types ───────────────────────────────────────────────────────────────────
interface Pred {
  windowStart: number;
  symbol: string;
  direction: 'UP' | 'DOWN';
  score: number;
  microRocPct: number;
  isCorrect: boolean;
}

interface Trade {
  windowStart: number;
  symbol: string;
  direction: 'UP' | 'DOWN';
  score: number;
  clob: number;
  isCorrect: boolean;
  pnl: number;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const endMs = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const startMs = endMs - DAYS * 86_400_000;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  REALISTIC POLYMARKET BACKTEST (no look-ahead)`);
  console.log(`  ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)} (${DAYS} days) | $${BET}/trade`);
  console.log(`${'═'.repeat(70)}\n`);

  // 1. Fetch candles
  const idxBySym = new Map<string, Map<number, BK>>();
  for (const sym of SYMBOLS) {
    process.stdout.write(`  ${sym}...`);
    const klines = await fetchKlines1m(sym, startMs - 35 * 60_000, endMs);
    const idx = new Map<number, BK>();
    for (const k of klines) idx.set(k.timestamp, k);
    idxBySym.set(sym, idx);
    console.log(` ${klines.length}`);
  }
  const btcIdx = idxBySym.get('BTC')!;

  // 2. Score all windows — CORRECT: only 1 candle at T+0:00
  const allPreds: Pred[] = [];

  for (let wStart = startMs; wStart < endMs; wStart += WINDOW_MS) {
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

      // Actual result: T+5:00 close vs T+0:00 open
      const endCandle = idx.get(wStart + 4 * 60_000); // T+4:00 candle (closes at T+4:59)
      if (!endCandle) continue;

      allPreds.push({
        windowStart: wStart, symbol: sym,
        direction: result.direction, score: result.confidence,
        microRocPct: result.microRocPct,
        isCorrect: result.direction === (endCandle.close >= c0.open ? 'UP' : 'DOWN'),
      });
    }
  }

  console.log(`\n  Raw predictions (score>=${MIN_SCORE}): ${allPreds.length}`);

  // 3. Group by window
  const byWindow = new Map<number, Pred[]>();
  for (const p of allPreds) {
    if (!byWindow.has(p.windowStart)) byWindow.set(p.windowStart, []);
    byWindow.get(p.windowStart)!.push(p);
  }

  // ─── Run scenarios ─────────────────────────────────────────────────────────

  type Config = {
    name: string;
    minConsensus: number;
    marketFilter: boolean;
    minClob: number;
    maxClob: number;
    minScore: number;
  };

  const configs: Config[] = [
    { name: 'A) Tout (prod: cons3+mktF)',   minConsensus: 3, marketFilter: true,  minClob: 0.55, maxClob: 0.90, minScore: 40 },
    { name: 'B) Cons3 only',                minConsensus: 3, marketFilter: false, minClob: 0.55, maxClob: 0.90, minScore: 40 },
    { name: 'C) MktFilter only',            minConsensus: 1, marketFilter: true,  minClob: 0.55, maxClob: 0.90, minScore: 40 },
    { name: 'D) Score only',                minConsensus: 1, marketFilter: false, minClob: 0.55, maxClob: 0.90, minScore: 40 },
    { name: 'E) Prod + CLOB max 0.72',      minConsensus: 3, marketFilter: true,  minClob: 0.55, maxClob: 0.72, minScore: 40 },
    { name: 'F) Prod + CLOB max 0.65',      minConsensus: 3, marketFilter: true,  minClob: 0.55, maxClob: 0.65, minScore: 40 },
    { name: 'G) Prod + score>=50',          minConsensus: 3, marketFilter: true,  minClob: 0.55, maxClob: 0.90, minScore: 50 },
    { name: 'H) Prod + score>=60',          minConsensus: 3, marketFilter: true,  minClob: 0.55, maxClob: 0.90, minScore: 60 },
    { name: 'I) Cons3 + CLOB max 0.65',     minConsensus: 3, marketFilter: false, minClob: 0.55, maxClob: 0.65, minScore: 40 },
    { name: 'J) MktF + CLOB max 0.65',      minConsensus: 1, marketFilter: true,  minClob: 0.55, maxClob: 0.65, minScore: 40 },
    { name: 'K) Score only + CLOB max 0.65', minConsensus: 1, marketFilter: false, minClob: 0.55, maxClob: 0.65, minScore: 40 },
    { name: 'L) Cons3 + CLOB 0.55-0.60',    minConsensus: 3, marketFilter: false, minClob: 0.55, maxClob: 0.60, minScore: 40 },
  ];

  function runConfig(cfg: Config): { trades: Trade[]; summary: string } {
    const trades: Trade[] = [];

    for (const [wStart, preds] of byWindow) {
      // Score filter
      let eligible = preds.filter(p => p.score >= cfg.minScore);
      if (eligible.length === 0) continue;

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

      // Market filter
      if (cfg.marketFilter) {
        const ctx = computeBtcCtx(btcIdx, wStart);
        if (!ctx) continue;
        if (cfg.minConsensus > 1) {
          // Apply to consensus direction
          if (!passesMarketFilter(ctx, maxDir)) continue;
        } else {
          // Per-prediction
          tradeable = tradeable.filter(p => passesMarketFilter(ctx, p.direction));
        }
      }

      // CLOB + PnL
      for (const p of tradeable) {
        const clob = estimateClob(Math.abs(p.microRocPct));
        if (clob < cfg.minClob || clob > cfg.maxClob) continue;

        const pnl = p.isCorrect
          ? BET * (1 - clob) / clob  // Win: tokens → $1 each
          : -BET;                     // Loss: 100% of bet

        trades.push({
          windowStart: p.windowStart, symbol: p.symbol,
          direction: p.direction, score: p.score,
          clob, isCorrect: p.isCorrect, pnl,
        });
      }
    }

    const wins = trades.filter(t => t.isCorrect).length;
    const wr = trades.length > 0 ? wins / trades.length * 100 : 0;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgClob = trades.length > 0 ? trades.reduce((s, t) => s + t.clob, 0) / trades.length : 0;
    const avgWinPnl = wins > 0 ? trades.filter(t => t.isCorrect).reduce((s, t) => s + t.pnl, 0) / wins : 0;
    const avgLoss = trades.length - wins > 0 ? -BET : 0;
    const breakevenWr = avgClob * 100;

    const summary = [
      String(trades.length).padStart(6),
      `${wins}W`.padStart(5),
      `${trades.length - wins}L`.padStart(5),
      `${wr.toFixed(1)}%`.padStart(7),
      `${breakevenWr.toFixed(0)}%`.padStart(5),
      `${(wr - breakevenWr).toFixed(1)}pp`.padStart(7),
      `${avgClob.toFixed(2)}`.padStart(5),
      `+$${avgWinPnl.toFixed(2)}`.padStart(8),
      `-$${BET.toFixed(2)}`.padStart(8),
      `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)}`.padStart(8),
      `${(trades.length / DAYS).toFixed(0)}/d`.padStart(5),
    ].join(' | ');

    return { trades, summary };
  }

  // ─── Output ────────────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(120)}`);
  console.log(`  ${'Scenario'.padEnd(33)} | ${'Trades'.padStart(6)} | ${'W'.padStart(5)} | ${'L'.padStart(5)} | ${'WR'.padStart(7)} | ${'BE'.padStart(5)} | ${'Edge'.padStart(7)} | ${'CLOB'.padStart(5)} | ${'AvgWin'.padStart(8)} | ${'AvgLoss'.padStart(8)} | ${'PnL'.padStart(8)} | ${'Vol'.padStart(5)}`);
  console.log(`  ${'─'.repeat(117)}`);

  const results: { cfg: Config; trades: Trade[] }[] = [];

  for (const cfg of configs) {
    const { trades, summary } = runConfig(cfg);
    results.push({ cfg, trades });
    console.log(`  ${cfg.name.padEnd(33)} | ${summary}`);
  }

  console.log(`${'═'.repeat(120)}`);

  // ─── CLOB price bucket analysis (scenario A = production) ──────────────────

  const prodTrades = results[0].trades;
  console.log(`\n── CLOB BUCKET ANALYSIS (Production: ${prodTrades.length} trades) ──\n`);
  console.log(`  ${'CLOB range'.padEnd(14)} | ${'Trades'.padStart(6)} | ${'W'.padStart(4)} ${'L'.padStart(4)} | ${'WR%'.padStart(6)} | ${'BE%'.padStart(5)} | ${'Edge'.padStart(7)} | ${'AvgWin'.padStart(8)} | ${'TotPnL'.padStart(9)} | ${'Verdict'.padStart(8)}`);
  console.log(`  ${'─'.repeat(95)}`);

  const clobBuckets: [number, number][] = [[0.55, 0.60], [0.60, 0.65], [0.65, 0.70], [0.70, 0.75], [0.75, 0.80], [0.80, 0.90]];
  for (const [lo, hi] of clobBuckets) {
    const bucket = prodTrades.filter(t => t.clob >= lo && t.clob < hi);
    if (bucket.length === 0) continue;
    const w = bucket.filter(t => t.isCorrect).length;
    const l = bucket.length - w;
    const wr = w / bucket.length * 100;
    const be = (lo + hi) / 2 * 100;
    const edge = wr - be;
    const avgWin = w > 0 ? bucket.filter(t => t.isCorrect).reduce((s, t) => s + t.pnl, 0) / w : 0;
    const totPnl = bucket.reduce((s, t) => s + t.pnl, 0);
    const verdict = edge > 5 ? 'EDGE' : edge > 0 ? 'slim' : 'TOXIC';
    console.log(`  ${`${lo.toFixed(2)}-${hi.toFixed(2)}`.padEnd(14)} | ${String(bucket.length).padStart(6)} | ${String(w).padStart(4)} ${String(l).padStart(4)} | ${wr.toFixed(1).padStart(6)} | ${be.toFixed(0).padStart(5)} | ${(edge >= 0 ? '+' : '') + edge.toFixed(1) + 'pp'.padStart(7)} | ${`+$${avgWin.toFixed(2)}`.padStart(8)} | ${`${totPnl >= 0 ? '+' : ''}$${totPnl.toFixed(0)}`.padStart(9)} | ${verdict.padStart(8)}`);
  }

  // ─── Equity curve for top 3 configs ────────────────────────────────────────

  // Sort by PnL to find top configs
  const ranked = results
    .map(r => ({ name: r.cfg.name, pnl: r.trades.reduce((s, t) => s + t.pnl, 0), trades: r.trades }))
    .sort((a, b) => b.pnl - a.pnl);

  console.log(`\n── DAILY EQUITY CURVES (top 3 by PnL) ──\n`);

  for (const r of ranked.slice(0, 3)) {
    console.log(`  ${r.name} — $${r.pnl.toFixed(0)} total`);

    // Daily PnL
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
        ? '\x1b[32m' + '█'.repeat(Math.min(20, Math.round(d.pnl / 5))) + '\x1b[0m'
        : '\x1b[31m' + '█'.repeat(Math.min(20, Math.round(-d.pnl / 5))) + '\x1b[0m';
      console.log(`  ${day} ${String(d.trades).padStart(4)} ${wr.toFixed(0).padStart(4)}% ${`${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2)}`.padStart(9)} ${`$${cumPnl.toFixed(2)}`.padStart(9)} ${`$${dd.toFixed(0)}`.padStart(8)} ${bar}`);
    }

    console.log(`  Max DD: $${maxDD.toFixed(0)} | Green days: ${greenDays}/${greenDays + redDays} (${(greenDays / (greenDays + redDays) * 100).toFixed(0)}%)\n`);
  }

  // ─── Score distribution for production trades ──────────────────────────────

  console.log(`── SCORE DISTRIBUTION (Production) ──\n`);
  for (const [lo, hi, label] of [[40, 49, 'LOW'], [50, 59, 'MID'], [60, 69, 'HIGH'], [70, 100, 'VHIGH']] as const) {
    const tier = prodTrades.filter(t => t.score >= lo && t.score <= hi);
    if (tier.length === 0) continue;
    const w = tier.filter(t => t.isCorrect).length;
    const pnl = tier.reduce((s, t) => s + t.pnl, 0);
    const avgClob = tier.reduce((s, t) => s + t.clob, 0) / tier.length;
    console.log(`  ${label.padEnd(6)} (${lo}-${hi}): ${String(tier.length).padStart(5)} trades | WR ${(w / tier.length * 100).toFixed(1)}% | avgCLOB ${avgClob.toFixed(2)} | PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`);
  }

  // ─── Final verdict ─────────────────────────────────────────────────────────

  const best = ranked[0];
  const prod = ranked.find(r => r.name.startsWith('A'))!;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  BEST PnL:  ${best.name}`);
  console.log(`             $${best.pnl.toFixed(0)} | ${best.trades.length} trades | ${(best.trades.length / DAYS).toFixed(0)}/day`);
  console.log(`  PROD (A):  $${prod.pnl.toFixed(0)} | ${prod.trades.length} trades | ${(prod.trades.length / DAYS).toFixed(0)}/day`);

  if (prod.pnl < 0) {
    console.log(`\n  ⚠ PRODUCTION CONFIG IS -EV ! Recalibrate EV caps urgently.`);
  } else if (best.pnl > prod.pnl * 1.5) {
    console.log(`\n  → Config "${best.name}" fait ${((best.pnl / prod.pnl - 1) * 100).toFixed(0)}% de plus`);
  }
  console.log(`${'═'.repeat(70)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
