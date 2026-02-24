/**
 * Search for Polymarket filter combos that achieve 80%+ WR
 *
 * Given the brutal asymmetry (win +$1-2, loss -$5), we need WR >> 75%.
 * This script sweeps all filter dimensions to find what drives WR above 80%.
 *
 * Usage: npx tsx scripts/polymarket-high-wr-search.ts [--days 30]
 */

import { computeFiveMinScore } from '../src/services/polymarket/fiveMinScorer.js';
import type { Candle1m } from '../src/services/polymarket/polymarketTypes.js';

const DAYS = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] ?? '') ||
  parseInt(process.argv[process.argv.indexOf('--days') + 1] ?? '') || 30;
const BET = 5;

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const WINDOW_MS = 5 * 60_000;
const PRE_WINDOW_CANDLES = 5;

// ─── CLOB model ──────────────────────────────────────────────────────────────
const CLOB_CURVE: [number, number][] = [
  [0.000, 0.55], [0.030, 0.60], [0.060, 0.65], [0.100, 0.70],
  [0.150, 0.76], [0.250, 0.82], [0.400, 0.87],
];

function estimateClob(absRoc: number): number {
  if (absRoc <= CLOB_CURVE[0][0]) return CLOB_CURVE[0][1];
  if (absRoc >= CLOB_CURVE[CLOB_CURVE.length - 1][0]) return CLOB_CURVE[CLOB_CURVE.length - 1][1];
  for (let i = 1; i < CLOB_CURVE.length; i++) {
    if (absRoc <= CLOB_CURVE[i][0]) {
      const [x0, y0] = CLOB_CURVE[i - 1];
      const [x1, y1] = CLOB_CURVE[i];
      return y0 + (y1 - y0) * (absRoc - x0) / (x1 - x0);
    }
  }
  return CLOB_CURVE[CLOB_CURVE.length - 1][1];
}

// ─── Binance ─────────────────────────────────────────────────────────────────
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
    for (const k of data)
      all.push({ timestamp: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    cursor = data[data.length - 1][0] + 60_000;
    if (data.length < 1000) break;
    await new Promise(r => setTimeout(r, 80));
  }
  return all;
}

// ─── BTC context ─────────────────────────────────────────────────────────────
interface Ctx {
  roc5m: number; roc15m: number; bodyRatio: number;
  volRatio: number; choppiness: number; absRoc5m: number;
}

function computeCtx(btcIdx: Map<number, BK>, wStart: number): Ctx | null {
  const candles: BK[] = [];
  for (let t = wStart - 30 * 60_000; t < wStart; t += 60_000) {
    const c = btcIdx.get(t);
    if (c) candles.push(c);
  }
  if (candles.length < 20) return null;

  const last = candles[candles.length - 1];
  const last5 = candles.slice(-5);
  const last10 = candles.slice(-10);
  const last20 = candles.slice(-20);

  const roc5m = (last.close - last5[0].open) / last5[0].open * 100;
  const roc15m = candles.length >= 15
    ? (last.close - candles.slice(-15)[0].open) / candles.slice(-15)[0].open * 100
    : roc5m;

  const bodyRatio = last10.reduce((s, c) => {
    const r = c.high - c.low;
    return r === 0 ? s : s + Math.abs(c.close - c.open) / r;
  }, 0) / last10.length;

  const vol5 = last5.reduce((s, c) => s + c.volume, 0) / 5;
  const vol30 = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  const volRatio = vol30 > 0 ? vol5 / vol30 : 1;

  let changes = 0;
  for (let i = 1; i < last20.length; i++) {
    if ((last20[i].close > last20[i].open) !== (last20[i - 1].close > last20[i - 1].open)) changes++;
  }

  return { roc5m, roc15m, bodyRatio, volRatio, choppiness: changes, absRoc5m: Math.abs(roc5m) };
}

// ─── Prediction ──────────────────────────────────────────────────────────────
interface Pred {
  windowStart: number;
  symbol: string;
  direction: 'UP' | 'DOWN';
  score: number;
  microRocPct: number;
  isCorrect: boolean;
  clob: number;
  ctx: Ctx;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const endMs = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const startMs = endMs - DAYS * 86_400_000;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  HIGH WR SEARCH — ${DAYS} days — $${BET}/bet`);
  console.log(`  ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)}`);
  console.log(`${'═'.repeat(70)}\n`);

  // Fetch
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

  // Score all — 1 candle only, no look-ahead
  const allPreds: Pred[] = [];

  for (let wStart = startMs; wStart < endMs; wStart += WINDOW_MS) {
    const ctx = computeCtx(btcIdx, wStart);
    if (!ctx) continue;

    for (const sym of SYMBOLS) {
      const idx = idxBySym.get(sym)!;
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

      const endCandle = idx.get(wStart + 4 * 60_000);
      if (!endCandle) continue;

      const clob = estimateClob(Math.abs(result.microRocPct));

      allPreds.push({
        windowStart: wStart, symbol: sym,
        direction: result.direction, score: result.confidence,
        microRocPct: result.microRocPct,
        isCorrect: result.direction === (endCandle.close >= c0.open ? 'UP' : 'DOWN'),
        clob, ctx,
      });
    }
  }

  console.log(`\n  Total predictions: ${allPreds.length}\n`);

  // Group by window for consensus
  const byWindow = new Map<number, Pred[]>();
  for (const p of allPreds) {
    if (!byWindow.has(p.windowStart)) byWindow.set(p.windowStart, []);
    byWindow.get(p.windowStart)!.push(p);
  }

  // ─── Helper: run a filter config and return stats ──────────────────────────

  interface Result {
    name: string;
    trades: number; wins: number; wr: number;
    totalPnl: number; avgPnlPerTrade: number;
    perDay: number; avgClob: number;
    profitFactor: number;
    maxDD: number; // max drawdown in $
    maxConsecLoss: number;
  }

  function run(name: string, filter: (p: Pred, windowPreds: Pred[]) => boolean): Result {
    let wins = 0, trades = 0, totalPnl = 0, clobSum = 0;
    let grossWin = 0, grossLoss = 0;

    // Collect filtered trades chronologically for DD calc
    const filtered: { pnl: number; isCorrect: boolean }[] = [];

    for (const [wStart, preds] of byWindow) {
      for (const p of preds) {
        if (!filter(p, preds)) continue;
        trades++;
        clobSum += p.clob;
        const pnl = p.isCorrect ? BET * (1 - p.clob) / p.clob : -BET;
        totalPnl += pnl;
        if (p.isCorrect) { wins++; grossWin += pnl; }
        else { grossLoss += Math.abs(pnl); }
        filtered.push({ pnl, isCorrect: p.isCorrect });
      }
    }

    // Max drawdown from equity curve
    let equity = 0, peak = 0, maxDD = 0;
    let consecLoss = 0, maxConsecLoss = 0;
    for (const t of filtered) {
      equity += t.pnl;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;
      if (!t.isCorrect) { consecLoss++; if (consecLoss > maxConsecLoss) maxConsecLoss = consecLoss; }
      else consecLoss = 0;
    }

    return {
      name, trades, wins,
      wr: trades > 0 ? wins / trades * 100 : 0,
      totalPnl, avgPnlPerTrade: trades > 0 ? totalPnl / trades : 0,
      perDay: trades / DAYS,
      avgClob: trades > 0 ? clobSum / trades : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : 0,
      maxDD, maxConsecLoss,
    };
  }

  // ─── Consensus helper ──────────────────────────────────────────────────────

  function getConsensus(preds: Pred[]): { dir: 'UP' | 'DOWN'; count: number } {
    const up = preds.filter(p => p.direction === 'UP').length;
    const down = preds.filter(p => p.direction === 'DOWN').length;
    return up >= down ? { dir: 'UP', count: up } : { dir: 'DOWN', count: down };
  }

  function isInConsensus(p: Pred, preds: Pred[], minCons: number): boolean {
    const c = getConsensus(preds);
    return c.count >= minCons && p.direction === c.dir;
  }

  // Market filter
  function passesMktF(p: Pred): boolean {
    const flat = Math.abs(p.ctx.roc5m) < 0.02;
    const mr = flat || (p.direction === 'UP' && p.ctx.roc5m < 0) || (p.direction === 'DOWN' && p.ctx.roc5m > 0);
    if (!mr) return false;
    const align = p.ctx.roc5m !== 0 && Math.sign(p.ctx.roc5m) === Math.sign(p.ctx.roc15m);
    if (!align && !flat) return false;
    if (p.ctx.bodyRatio <= 0.5) return false;
    return true;
  }

  // ─── SWEEP: toutes les dimensions qui pourraient booster le WR ─────────────

  console.log(`${'═'.repeat(100)}`);
  console.log(`  SWEEP: quels filtres poussent WR > 80% ?`);
  console.log(`${'═'.repeat(100)}`);
  console.log(`  ${'Config'.padEnd(50)} | ${'Tr'.padStart(6)} | ${'WR%'.padStart(6)} | ${'$/tr'.padStart(7)} | ${'PnL'.padStart(8)} | ${'PF'.padStart(5)} | ${'Tr/d'.padStart(5)} | ${'MaxDD'.padStart(7)} | ${'CL'.padStart(3)}`);
  console.log(`  ${'─'.repeat(112)}`);

  const results: Result[] = [];

  function show(r: Result) {
    const wrColor = r.wr >= 80 ? '\x1b[32m' : r.wr >= 75 ? '\x1b[33m' : '\x1b[31m';
    const pnlColor = r.totalPnl >= 0 ? '\x1b[32m' : '\x1b[31m';
    console.log(
      `  ${r.name.padEnd(50)} | ${String(r.trades).padStart(6)} | ${wrColor}${r.wr.toFixed(1).padStart(5)}%\x1b[0m | ${`$${r.avgPnlPerTrade.toFixed(3)}`.padStart(7)} | ${pnlColor}${`${r.totalPnl >= 0 ? '+' : ''}$${r.totalPnl.toFixed(0)}`.padStart(8)}\x1b[0m | ${r.profitFactor.toFixed(2).padStart(5)} | ${r.perDay.toFixed(0).padStart(5)} | ${`-$${r.maxDD.toFixed(0)}`.padStart(7)} | ${String(r.maxConsecLoss).padStart(3)}`
    );
    results.push(r);
  }

  // === BASELINE ===
  console.log(`\n  --- BASELINES ---`);
  show(run('ALL preds', () => true));
  show(run('Consensus 3+', (p, w) => isInConsensus(p, w, 3)));
  show(run('Consensus 4 (unanimous)', (p, w) => isInConsensus(p, w, 4)));
  show(run('Market filter', (p) => passesMktF(p)));
  show(run('Cons3 + MktF (PRODUCTION)', (p, w) => isInConsensus(p, w, 3) && passesMktF(p)));

  // === SCORE ===
  console.log(`\n  --- SCORE THRESHOLD ---`);
  for (const minScore of [45, 50, 55, 60, 65, 70]) {
    show(run(`Score >= ${minScore}`, (p) => p.score >= minScore));
    show(run(`Cons3 + Score >= ${minScore}`, (p, w) => isInConsensus(p, w, 3) && p.score >= minScore));
  }

  // === CLOB CAP ===
  console.log(`\n  --- CLOB CAP (rejeter prix trop hauts) ---`);
  for (const maxClob of [0.60, 0.65, 0.70, 0.75]) {
    show(run(`CLOB <= ${maxClob}`, (p) => p.clob <= maxClob));
    show(run(`Cons3 + CLOB <= ${maxClob}`, (p, w) => isInConsensus(p, w, 3) && p.clob <= maxClob));
  }

  // === CLOB FLOOR (rejeter prix trop bas = momentum déjà reversé) ===
  console.log(`\n  --- CLOB FLOOR (rejeter prix trop bas) ---`);
  for (const minClob of [0.58, 0.60, 0.63, 0.65, 0.68, 0.70]) {
    show(run(`CLOB >= ${minClob}`, (p) => p.clob >= minClob));
    show(run(`Cons3 + CLOB >= ${minClob}`, (p, w) => isInConsensus(p, w, 3) && p.clob >= minClob));
  }

  // === CLOB BAND ===
  console.log(`\n  --- CLOB BAND (sweet spot) ---`);
  for (const [lo, hi] of [[0.63, 0.75], [0.65, 0.78], [0.68, 0.80], [0.70, 0.82], [0.70, 0.78], [0.63, 0.72]] as const) {
    show(run(`CLOB ${lo}-${hi}`, (p) => p.clob >= lo && p.clob <= hi));
    show(run(`Cons3 + CLOB ${lo}-${hi}`, (p, w) => isInConsensus(p, w, 3) && p.clob >= lo && p.clob <= hi));
  }

  // === BODY RATIO ===
  console.log(`\n  --- BODY RATIO (clean candles) ---`);
  for (const minBody of [0.4, 0.5, 0.6, 0.7]) {
    show(run(`BodyRatio > ${minBody}`, (p) => p.ctx.bodyRatio > minBody));
  }

  // === CHOPPINESS ===
  console.log(`\n  --- CHOPPINESS (trending vs choppy) ---`);
  for (const maxChop of [8, 10, 12]) {
    show(run(`Choppiness <= ${maxChop}`, (p) => p.ctx.choppiness <= maxChop));
    show(run(`Cons3 + Chop <= ${maxChop}`, (p, w) => isInConsensus(p, w, 3) && p.ctx.choppiness <= maxChop));
  }

  // === VOL RATIO ===
  console.log(`\n  --- VOLUME RATIO ---`);
  for (const [lo, hi, label] of [[0, 0.8, 'Low vol'], [0.8, 1.2, 'Normal vol'], [1.2, 10, 'High vol']] as const) {
    show(run(`${label} (${lo}-${hi})`, (p) => p.ctx.volRatio >= lo && p.ctx.volRatio < hi));
  }

  // === TREND vs COUNTER-TREND ===
  console.log(`\n  --- DIRECTION vs BTC ROC ---`);
  show(run('Mean reversion (pred AGAINST roc5m)', (p) => {
    const flat = Math.abs(p.ctx.roc5m) < 0.02;
    return !flat && ((p.direction === 'UP' && p.ctx.roc5m < 0) || (p.direction === 'DOWN' && p.ctx.roc5m > 0));
  }));
  show(run('Trend follow (pred WITH roc5m)', (p) => {
    return (p.direction === 'UP' && p.ctx.roc5m > 0.02) || (p.direction === 'DOWN' && p.ctx.roc5m < -0.02);
  }));
  show(run('Flat market (|roc5m| < 0.02)', (p) => Math.abs(p.ctx.roc5m) < 0.02));
  show(run('Strong trend (|roc5m| > 0.10)', (p) => p.ctx.absRoc5m > 0.10));

  // === COMBINED HIGH-WR ===
  console.log(`\n  --- COMBINED (cherche WR 80%+) ---`);
  show(run('Cons3 + MktF + Score>=50', (p, w) => isInConsensus(p, w, 3) && passesMktF(p) && p.score >= 50));
  show(run('Cons3 + MktF + Score>=60', (p, w) => isInConsensus(p, w, 3) && passesMktF(p) && p.score >= 60));
  show(run('Cons4 + MktF', (p, w) => isInConsensus(p, w, 4) && passesMktF(p)));
  show(run('Cons4 + MktF + Score>=50', (p, w) => isInConsensus(p, w, 4) && passesMktF(p) && p.score >= 50));
  show(run('Cons3 + MktF + CLOB>=0.65', (p, w) => isInConsensus(p, w, 3) && passesMktF(p) && p.clob >= 0.65));
  show(run('Cons3 + MktF + CLOB 0.65-0.80', (p, w) => isInConsensus(p, w, 3) && passesMktF(p) && p.clob >= 0.65 && p.clob <= 0.80));
  show(run('Cons3 + MktF + Body>0.6', (p, w) => isInConsensus(p, w, 3) && passesMktF(p) && p.ctx.bodyRatio > 0.6));
  show(run('Cons3 + MktF + Chop<=10', (p, w) => isInConsensus(p, w, 3) && passesMktF(p) && p.ctx.choppiness <= 10));
  show(run('Cons3 + MktF + Body>0.6 + Chop<=10', (p, w) => isInConsensus(p, w, 3) && passesMktF(p) && p.ctx.bodyRatio > 0.6 && p.ctx.choppiness <= 10));
  show(run('Cons3 + MktF + Score>=50 + CLOB>=0.65', (p, w) => isInConsensus(p, w, 3) && passesMktF(p) && p.score >= 50 && p.clob >= 0.65));
  show(run('Cons4 + Score>=50 + CLOB>=0.65', (p, w) => isInConsensus(p, w, 4) && p.score >= 50 && p.clob >= 0.65));
  show(run('Cons3 + Score>=50 + CLOB 0.65-0.78', (p, w) => isInConsensus(p, w, 3) && p.score >= 50 && p.clob >= 0.65 && p.clob <= 0.78));
  show(run('Cons3 + MktF + Score>=50 + Body>0.6', (p, w) => isInConsensus(p, w, 3) && passesMktF(p) && p.score >= 50 && p.ctx.bodyRatio > 0.6));

  // === HOUR OF DAY ===
  console.log(`\n  --- HOUR OF DAY (UTC) ---`);
  for (let h = 0; h < 24; h += 3) {
    const hrs = [h, h + 1, h + 2];
    const label = `${String(h).padStart(2, '0')}-${String(h + 3).padStart(2, '0')}h UTC`;
    show(run(label, (p) => hrs.includes(new Date(p.windowStart).getUTCHours())));
  }

  // ─── TOP 15 by PnL among those with WR >= 78% ─────────────────────────────

  console.log(`\n${'═'.repeat(100)}`);
  console.log(`  TOP 15 CONFIGS (WR >= 78% ET trades >= 5/jour)`);
  console.log(`${'═'.repeat(100)}`);

  const viable = results
    .filter(r => r.wr >= 78 && r.perDay >= 5)
    .sort((a, b) => b.totalPnl - a.totalPnl)
    .slice(0, 15);

  console.log(`  ${'Config'.padEnd(50)} | ${'Tr'.padStart(6)} | ${'WR%'.padStart(6)} | ${'$/tr'.padStart(7)} | ${'PnL'.padStart(8)} | ${'PF'.padStart(5)} | ${'Tr/d'.padStart(5)} | ${'MaxDD'.padStart(7)} | ${'CL'.padStart(3)}`);
  console.log(`  ${'─'.repeat(112)}`);

  for (const r of viable) {
    console.log(
      `  ${r.name.padEnd(50)} | ${String(r.trades).padStart(6)} | \x1b[32m${r.wr.toFixed(1).padStart(5)}%\x1b[0m | ${`$${r.avgPnlPerTrade.toFixed(3)}`.padStart(7)} | \x1b[32m${`+$${r.totalPnl.toFixed(0)}`.padStart(8)}\x1b[0m | ${r.profitFactor.toFixed(2).padStart(5)} | ${r.perDay.toFixed(0).padStart(5)} | ${`-$${r.maxDD.toFixed(0)}`.padStart(7)} | ${String(r.maxConsecLoss).padStart(3)}`
    );
  }

  if (viable.length === 0) {
    console.log(`  Aucune config atteint WR >= 78% avec 5+ trades/jour`);
    console.log(`  → Le scorer 1-candle ne suffit peut-être pas`);
    console.log(`  → Il faut soit plus de candles au decision time, soit un meilleur scorer`);
  }

  console.log(`\n${'═'.repeat(100)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
