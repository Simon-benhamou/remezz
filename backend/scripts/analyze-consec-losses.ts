/**
 * Analyze consecutive loss patterns in Polymarket predictions.
 *
 * Goal: find what causes losing streaks and how to prevent them.
 * Analyses:
 *   1. Loss clustering by hour of day
 *   2. Loss persistence: P(loss | last N were losses)
 *   3. Per-symbol breakdown during loss streaks
 *   4. Market conditions during loss streaks vs normal
 *   5. Cooldown strategies: skip N trades after M losses
 *
 * Usage: npx tsx scripts/analyze-consec-losses.ts [--days 30] [--score 65]
 */

import { computeFiveMinScore } from '../src/services/polymarket/fiveMinScorer.js';
import type { Candle1m } from '../src/services/polymarket/polymarketTypes.js';

const DAYS = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] ?? '') ||
  parseInt(process.argv[process.argv.indexOf('--days') + 1] ?? '') || 30;
const MIN_SCORE = parseInt(process.argv.find(a => a.startsWith('--score='))?.split('=')[1] ?? '') ||
  parseInt(process.argv[process.argv.indexOf('--score') + 1] ?? '') || 65;
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
  hour: number;
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

  return { roc5m, roc15m, bodyRatio, volRatio, choppiness: changes, absRoc5m: Math.abs(roc5m), hour: new Date(wStart).getUTCHours() };
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

// ─── Consensus ───────────────────────────────────────────────────────────────
function getConsensus(preds: Pred[]): { dir: 'UP' | 'DOWN'; count: number } {
  const up = preds.filter(p => p.direction === 'UP').length;
  const down = preds.filter(p => p.direction === 'DOWN').length;
  return up >= down ? { dir: 'UP', count: up } : { dir: 'DOWN', count: down };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const endMs = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const startMs = endMs - DAYS * 86_400_000;

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  CONSECUTIVE LOSS ANALYSIS — ${DAYS} days — Score >= ${MIN_SCORE} — $${BET}/bet`);
  console.log(`  ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)}`);
  console.log(`${'═'.repeat(80)}\n`);

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

  // Score all windows
  const allPreds: Pred[] = [];
  const byWindow = new Map<number, Pred[]>();

  for (let wStart = startMs; wStart < endMs; wStart += WINDOW_MS) {
    const ctx = computeCtx(btcIdx, wStart);
    if (!ctx) continue;

    const windowPreds: Pred[] = [];
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
      if (!result || result.confidence < MIN_SCORE) continue;

      const endCandle = idx.get(wStart + 4 * 60_000);
      if (!endCandle) continue;

      const clob = estimateClob(Math.abs(result.microRocPct));
      const pred: Pred = {
        windowStart: wStart, symbol: sym,
        direction: result.direction, score: result.confidence,
        microRocPct: result.microRocPct,
        isCorrect: result.direction === (endCandle.close >= c0.open ? 'UP' : 'DOWN'),
        clob, ctx,
      };
      allPreds.push(pred);
      windowPreds.push(pred);
    }
    if (windowPreds.length > 0) byWindow.set(wStart, windowPreds);
  }

  // Sort chronologically
  allPreds.sort((a, b) => a.windowStart - b.windowStart || a.symbol.localeCompare(b.symbol));

  const wins = allPreds.filter(p => p.isCorrect).length;
  console.log(`\n  Total: ${allPreds.length} trades, ${wins} wins (${(wins / allPreds.length * 100).toFixed(1)}% WR)\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. LOSS STREAKS DISTRIBUTION
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`${'═'.repeat(80)}`);
  console.log(`  1. LOSS STREAK DISTRIBUTION`);
  console.log(`${'═'.repeat(80)}`);

  const streaks: number[] = [];
  let currentStreak = 0;
  for (const p of allPreds) {
    if (!p.isCorrect) {
      currentStreak++;
    } else {
      if (currentStreak > 0) streaks.push(currentStreak);
      currentStreak = 0;
    }
  }
  if (currentStreak > 0) streaks.push(currentStreak);

  const streakDist = new Map<number, number>();
  for (const s of streaks) streakDist.set(s, (streakDist.get(s) ?? 0) + 1);

  console.log(`  Streak | Count | Cumul$ loss`);
  console.log(`  ${'─'.repeat(40)}`);
  for (const len of [...streakDist.keys()].sort((a, b) => a - b)) {
    const count = streakDist.get(len)!;
    console.log(`  ${String(len).padStart(6)} | ${String(count).padStart(5)} | -$${(len * BET * count).toFixed(0)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. LOSS PERSISTENCE: P(loss | last N were losses)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  2. LOSS PERSISTENCE — P(next loss | last N losses)`);
  console.log(`${'═'.repeat(80)}`);

  for (const lookback of [1, 2, 3, 4, 5]) {
    let afterLossStreak = 0, afterLossStreakLoss = 0;
    let afterWinStreak = 0, afterWinStreakLoss = 0;

    for (let i = lookback; i < allPreds.length; i++) {
      const prevN = allPreds.slice(i - lookback, i);
      const allLost = prevN.every(p => !p.isCorrect);
      const allWon = prevN.every(p => p.isCorrect);

      if (allLost) {
        afterLossStreak++;
        if (!allPreds[i].isCorrect) afterLossStreakLoss++;
      }
      if (allWon) {
        afterWinStreak++;
        if (!allPreds[i].isCorrect) afterWinStreakLoss++;
      }
    }

    const lossRate = afterLossStreak > 0 ? afterLossStreakLoss / afterLossStreak * 100 : 0;
    const winRate = afterWinStreak > 0 ? (1 - afterWinStreakLoss / afterWinStreak) * 100 : 0;
    console.log(
      `  After ${lookback}L: ${lossRate.toFixed(1)}% lose again (${afterLossStreakLoss}/${afterLossStreak})` +
      `  |  After ${lookback}W: ${winRate.toFixed(1)}% win again (${afterWinStreak - afterWinStreakLoss}/${afterWinStreak})`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. LOSS STREAKS BY HOUR
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  3. WIN RATE BY HOUR (UTC) — Score >= ${MIN_SCORE}`);
  console.log(`${'═'.repeat(80)}`);

  const hourStats = new Map<number, { wins: number; total: number; pnl: number }>();
  for (const p of allPreds) {
    const h = p.ctx.hour;
    const s = hourStats.get(h) ?? { wins: 0, total: 0, pnl: 0 };
    s.total++;
    if (p.isCorrect) { s.wins++; s.pnl += BET * (1 - p.clob) / p.clob; }
    else s.pnl -= BET;
    hourStats.set(h, s);
  }

  console.log(`  Hour | Trades |    WR% |      PnL`);
  console.log(`  ${'─'.repeat(45)}`);
  for (let h = 0; h < 24; h++) {
    const s = hourStats.get(h);
    if (!s) continue;
    const wr = s.wins / s.total * 100;
    const wrColor = wr >= 83 ? '\x1b[32m' : wr >= 78 ? '\x1b[33m' : '\x1b[31m';
    const pnlColor = s.pnl >= 0 ? '\x1b[32m' : '\x1b[31m';
    console.log(`  ${String(h).padStart(4)} | ${String(s.total).padStart(6)} | ${wrColor}${wr.toFixed(1).padStart(5)}%\x1b[0m | ${pnlColor}${(s.pnl >= 0 ? '+$' : '-$') + Math.abs(s.pnl).toFixed(0)}\x1b[0m`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. LOSSES BY SYMBOL
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  4. WIN RATE BY SYMBOL — Score >= ${MIN_SCORE}`);
  console.log(`${'═'.repeat(80)}`);

  for (const sym of SYMBOLS) {
    const symPreds = allPreds.filter(p => p.symbol === sym);
    const symWins = symPreds.filter(p => p.isCorrect).length;
    const symPnl = symPreds.reduce((s, p) => s + (p.isCorrect ? BET * (1 - p.clob) / p.clob : -BET), 0);
    const wr = symPreds.length > 0 ? symWins / symPreds.length * 100 : 0;
    const wrColor = wr >= 83 ? '\x1b[32m' : wr >= 78 ? '\x1b[33m' : '\x1b[31m';
    console.log(`  ${sym.padEnd(5)} | ${String(symPreds.length).padStart(5)} trades | ${wrColor}${wr.toFixed(1)}% WR\x1b[0m | PnL: ${symPnl >= 0 ? '+' : ''}$${symPnl.toFixed(0)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. MARKET CONDITIONS: losses vs wins
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  5. MARKET CONDITIONS — Losses vs Wins`);
  console.log(`${'═'.repeat(80)}`);

  const lossPreds = allPreds.filter(p => !p.isCorrect);
  const winPreds = allPreds.filter(p => p.isCorrect);

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  console.log(`  Metric          |  Wins avg  | Losses avg |  Delta`);
  console.log(`  ${'─'.repeat(55)}`);

  const metrics: [string, (p: Pred) => number][] = [
    ['absRoc5m (%)', p => p.ctx.absRoc5m],
    ['choppiness', p => p.ctx.choppiness],
    ['bodyRatio', p => p.ctx.bodyRatio],
    ['volRatio', p => p.ctx.volRatio],
    ['score', p => p.score],
    ['clob', p => p.clob],
  ];

  for (const [name, fn] of metrics) {
    const wAvg = avg(winPreds.map(fn));
    const lAvg = avg(lossPreds.map(fn));
    console.log(`  ${name.padEnd(16)} | ${wAvg.toFixed(3).padStart(10)} | ${lAvg.toFixed(3).padStart(10)} | ${((lAvg - wAvg) >= 0 ? '+' : '') + (lAvg - wAvg).toFixed(3).padStart(7)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. COOLDOWN STRATEGIES — skip N trades after M consecutive losses
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  6. COOLDOWN STRATEGIES — Skip N after M consec losses`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`  Strategy                   |     Tr |    WR% |      PnL | MaxDD  | MaxCL | Saved$`);
  console.log(`  ${'─'.repeat(80)}`);

  // Baseline (no cooldown)
  function simulate(cooldownM: number, cooldownN: number, label: string) {
    let consecLosses = 0;
    let skipRemaining = 0;
    let trades = 0, tradeWins = 0, pnl = 0;
    let equity = 0, peak = 0, maxDD = 0;
    let cl = 0, maxCL = 0;

    for (const p of allPreds) {
      if (skipRemaining > 0) {
        skipRemaining--;
        // Reset consec counter if we see a window pass
        continue;
      }

      const tradePnl = p.isCorrect ? BET * (1 - p.clob) / p.clob : -BET;
      trades++;
      pnl += tradePnl;
      equity += tradePnl;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;

      if (p.isCorrect) {
        tradeWins++;
        consecLosses = 0;
        cl = 0;
      } else {
        consecLosses++;
        cl++;
        if (cl > maxCL) maxCL = cl;
        if (consecLosses >= cooldownM) {
          skipRemaining = cooldownN;
          consecLosses = 0; // reset after triggering cooldown
        }
      }
    }

    // Baseline PnL for comparison
    const baselinePnl = allPreds.reduce((s, p) => s + (p.isCorrect ? BET * (1 - p.clob) / p.clob : -BET), 0);
    const saved = pnl - baselinePnl;

    const wr = trades > 0 ? tradeWins / trades * 100 : 0;
    const wrColor = wr >= 83 ? '\x1b[32m' : wr >= 80 ? '\x1b[33m' : '\x1b[31m';
    console.log(
      `  ${label.padEnd(28)} | ${String(trades).padStart(6)} | ${wrColor}${wr.toFixed(1).padStart(5)}%\x1b[0m | ${(pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(0).padStart(6)} | -$${maxDD.toFixed(0).padStart(4)} | ${String(maxCL).padStart(5)} | ${(saved >= 0 ? '+$' : '-$') + Math.abs(saved).toFixed(0)}`
    );
  }

  simulate(999, 0, 'No cooldown (baseline)');
  console.log(`  ${'─'.repeat(80)}`);

  // Test different cooldown parameters
  for (const m of [2, 3, 4, 5]) {
    for (const n of [1, 2, 3, 5, 10]) {
      simulate(m, n, `After ${m}L → skip ${n}`);
    }
    console.log(`  ${'─'.repeat(80)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. HOUR EXCLUSION strategies
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  7. HOUR EXCLUSION — Skip toxic hours`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`  Strategy                   |     Tr |    WR% |      PnL | MaxDD  | MaxCL`);
  console.log(`  ${'─'.repeat(70)}`);

  function simHours(excludeHours: number[], label: string) {
    const filtered = allPreds.filter(p => !excludeHours.includes(p.ctx.hour));
    let tradeWins = 0, pnl = 0;
    let equity = 0, peak = 0, maxDD = 0;
    let cl = 0, maxCL = 0;

    for (const p of filtered) {
      const tradePnl = p.isCorrect ? BET * (1 - p.clob) / p.clob : -BET;
      pnl += tradePnl;
      equity += tradePnl;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;

      if (p.isCorrect) { tradeWins++; cl = 0; }
      else { cl++; if (cl > maxCL) maxCL = cl; }
    }

    const wr = filtered.length > 0 ? tradeWins / filtered.length * 100 : 0;
    const wrColor = wr >= 83 ? '\x1b[32m' : wr >= 80 ? '\x1b[33m' : '\x1b[31m';
    console.log(
      `  ${label.padEnd(28)} | ${String(filtered.length).padStart(6)} | ${wrColor}${wr.toFixed(1).padStart(5)}%\x1b[0m | ${(pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(0).padStart(6)} | -$${maxDD.toFixed(0).padStart(4)} | ${String(maxCL).padStart(5)}`
    );
  }

  simHours([], 'All hours (baseline)');
  simHours([15, 16, 17], 'Skip 15-18h UTC');
  simHours([18, 19, 20], 'Skip 18-21h UTC');
  simHours([15, 16, 17, 18, 19, 20], 'Skip 15-21h UTC');
  simHours([17, 18, 19], 'Skip 17-20h UTC');
  simHours([16, 17, 18, 19], 'Skip 16-20h UTC');

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. COMBINED: Best cooldown + hour exclusion
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  8. COMBINED — Cooldown + Hour exclusion`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`  Strategy                            |     Tr |    WR% |      PnL | MaxDD  | MaxCL`);
  console.log(`  ${'─'.repeat(78)}`);

  function simCombined(cooldownM: number, cooldownN: number, excludeHours: number[], label: string) {
    const hourFiltered = allPreds.filter(p => !excludeHours.includes(p.ctx.hour));
    let consecLosses = 0, skipRemaining = 0;
    let trades = 0, tradeWins = 0, pnl = 0;
    let equity = 0, peak = 0, maxDD = 0;
    let cl = 0, maxCL = 0;

    for (const p of hourFiltered) {
      if (skipRemaining > 0) { skipRemaining--; continue; }

      const tradePnl = p.isCorrect ? BET * (1 - p.clob) / p.clob : -BET;
      trades++;
      pnl += tradePnl;
      equity += tradePnl;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;

      if (p.isCorrect) { tradeWins++; consecLosses = 0; cl = 0; }
      else {
        consecLosses++; cl++;
        if (cl > maxCL) maxCL = cl;
        if (consecLosses >= cooldownM) { skipRemaining = cooldownN; consecLosses = 0; }
      }
    }

    const wr = trades > 0 ? tradeWins / trades * 100 : 0;
    const wrColor = wr >= 83 ? '\x1b[32m' : wr >= 80 ? '\x1b[33m' : '\x1b[31m';
    console.log(
      `  ${label.padEnd(38)} | ${String(trades).padStart(6)} | ${wrColor}${wr.toFixed(1).padStart(5)}%\x1b[0m | ${(pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(0).padStart(6)} | -$${maxDD.toFixed(0).padStart(4)} | ${String(maxCL).padStart(5)}`
    );
  }

  simCombined(999, 0, [], 'Baseline');
  simCombined(3, 2, [], 'Cooldown 3L→skip2');
  simCombined(3, 2, [15, 16, 17, 18, 19, 20], 'Cooldown 3L→skip2 + no 15-21h');
  simCombined(3, 3, [15, 16, 17, 18, 19, 20], 'Cooldown 3L→skip3 + no 15-21h');
  simCombined(2, 2, [15, 16, 17, 18, 19, 20], 'Cooldown 2L→skip2 + no 15-21h');
  simCombined(2, 3, [15, 16, 17, 18, 19, 20], 'Cooldown 2L→skip3 + no 15-21h');
  simCombined(3, 2, [17, 18, 19], 'Cooldown 3L→skip2 + no 17-20h');
  simCombined(2, 2, [17, 18, 19], 'Cooldown 2L→skip2 + no 17-20h');

  console.log(`\n${'═'.repeat(80)}\n`);
}

main().catch(console.error);
