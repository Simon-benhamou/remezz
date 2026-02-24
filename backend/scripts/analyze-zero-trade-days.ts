/**
 * Analyze zero-trade periods in V5.129 production config
 *
 * Questions answered:
 * 1. How many days have 0 trades? (filter doing its job or overfiltering?)
 * 2. What scores are produced on 0-trade days? (near-misses at 55-64?)
 * 3. Is PnL concentrated on a few volatile days? (feast or famine?)
 * 4. What's the WR on low-vol vs high-vol days?
 * 5. Does lowering threshold to 50 help on dead days without hurting overall?
 *
 * Usage:
 *   npx tsx scripts/analyze-zero-trade-days.ts --days 30
 *   npx tsx scripts/analyze-zero-trade-days.ts --days 60
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
const BET = 5;
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const WINDOW_MS = 5 * 60_000;
const PRE_WINDOW_CANDLES = 5;
const FLAT_THRESHOLD = 0.02;

// ─── CLOB price model ────────────────────────────────────────────────────────
const CLOB_CURVE: [number, number][] = [
  [0.000, 0.55], [0.030, 0.60], [0.060, 0.65], [0.100, 0.70],
  [0.150, 0.76], [0.250, 0.82], [0.400, 0.87],
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

// ─── Market filter ───────────────────────────────────────────────────────────
function computeBtcCtx(btcIdx: Map<number, BK>, wStart: number) {
  const candles: BK[] = [];
  for (let t = wStart - 15 * 60_000; t < wStart; t += 60_000) {
    const c = btcIdx.get(t);
    if (c) candles.push(c);
  }
  if (candles.length < 10) return null;
  const last = candles[candles.length - 1];
  const last5 = candles.slice(-5);
  const roc5m = (last.close - last5[0].open) / last5[0].open * 100;
  const roc15m = (last.close - candles[0].open) / candles[0].open * 100;
  const bodyRatio = candles.slice(-10).reduce((s, c) => {
    const r = c.high - c.low;
    return r === 0 ? s : s + Math.abs(c.close - c.open) / r;
  }, 0) / 10;
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
  vol: number;    // volume spike component
  roc: number;    // micro-ROC component
  body: number;   // body ratio component
  wick: number;   // wick rejection component
  align: number;  // candle alignment component
  pre: number;    // pre-window momentum component
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const endMs = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const startMs = endMs - DAYS * 86_400_000;

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  ZERO-TRADE DAY ANALYSIS (V5.129 production config)`);
  console.log(`  ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)} (${DAYS} days)`);
  console.log(`${'═'.repeat(80)}\n`);

  // 1. Fetch candles
  const idxBySym = new Map<string, Map<number, BK>>();
  for (const sym of SYMBOLS) {
    process.stdout.write(`  Fetching ${sym}...`);
    const klines = await fetchKlines1m(sym, startMs - 35 * 60_000, endMs);
    const idx = new Map<number, BK>();
    for (const k of klines) idx.set(k.timestamp, k);
    idxBySym.set(sym, idx);
    console.log(` ${klines.length} candles`);
  }
  const btcIdx = idxBySym.get('BTC')!;

  // 2. Score ALL windows (score >= 0, no filter)
  const allPreds: Pred[] = [];

  for (let wStart = startMs; wStart < endMs; wStart += WINDOW_MS) {
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

      allPreds.push({
        windowStart: wStart, symbol: sym,
        direction: result.direction, score: result.confidence,
        microRocPct: result.microRocPct,
        isCorrect: result.direction === (endCandle.close >= c0.open ? 'UP' : 'DOWN'),
        vol: result.score.volumeSpike,
        roc: result.score.microRoc,
        body: result.score.bodyRatio,
        wick: result.score.wickRejection,
        align: result.score.candleAlignment,
        pre: result.score.preWindowMomentum,
      });
    }
  }

  // 3. Group by window
  const byWindow = new Map<number, Pred[]>();
  for (const p of allPreds) {
    if (!byWindow.has(p.windowStart)) byWindow.set(p.windowStart, []);
    byWindow.get(p.windowStart)!.push(p);
  }

  // 4. Simulate trades with V5.129 config at different score thresholds
  const TOXIC_HOURS = new Set([21]);
  const COOLDOWN_TRIGGER = 2;
  const COOLDOWN_SKIP = 2;

  function simulateConfig(minScore: number) {
    const trades: { windowStart: number; symbol: string; dir: string; score: number; clob: number; isCorrect: boolean; pnl: number }[] = [];
    let consecutiveLosses = 0;
    let cooldownRemaining = 0;
    let lastWindowResult: boolean | null = null;

    const sortedWindows = [...byWindow.entries()].sort((a, b) => a[0] - b[0]);

    // Track per-window stats
    const windowStats: { ts: number; maxScore: number; avgScore: number; scored: number; traded: boolean; skipReason: string }[] = [];

    for (const [wStart, preds] of sortedWindows) {
      const hour = new Date(wStart).getUTCHours();
      const scores = preds.map(p => p.score);
      const maxScore = Math.max(...scores);
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

      // Toxic hour
      if (TOXIC_HOURS.has(hour)) {
        windowStats.push({ ts: wStart, maxScore, avgScore, scored: preds.length, traded: false, skipReason: 'toxic_hour' });
        continue;
      }

      // Cooldown
      if (cooldownRemaining > 0) {
        cooldownRemaining--;
        windowStats.push({ ts: wStart, maxScore, avgScore, scored: preds.length, traded: false, skipReason: 'cooldown' });
        continue;
      }

      // Score filter
      const eligible = preds.filter(p => p.score >= minScore);
      if (eligible.length === 0) {
        windowStats.push({ ts: wStart, maxScore, avgScore, scored: preds.length, traded: false, skipReason: `score<${minScore}` });
        continue;
      }

      // Consensus (3+)
      const upCount = eligible.filter(p => p.direction === 'UP').length;
      const downCount = eligible.filter(p => p.direction === 'DOWN').length;
      const maxDir: 'UP' | 'DOWN' = upCount >= downCount ? 'UP' : 'DOWN';
      if (Math.max(upCount, downCount) < 3) {
        windowStats.push({ ts: wStart, maxScore, avgScore, scored: eligible.length, traded: false, skipReason: `consensus<3(${upCount}U/${downCount}D)` });
        continue;
      }
      const tradeable = eligible.filter(p => p.direction === maxDir);

      // Market filter
      const ctx = computeBtcCtx(btcIdx, wStart);
      if (!ctx || !passesMarketFilter(ctx, maxDir)) {
        windowStats.push({ ts: wStart, maxScore, avgScore, scored: eligible.length, traded: false, skipReason: 'market_filter' });
        continue;
      }

      // CLOB price check + execute
      let windowTraded = false;
      let windowWin = true;
      for (const p of tradeable) {
        const clob = estimateClob(Math.abs(p.microRocPct));
        // V5.129 CLOB tiers
        const maxClob = p.score >= 80 ? 0.85 : p.score >= 70 ? 0.82 : 0.78;
        if (clob < 0.55 || clob > maxClob) continue;

        const pnl = p.isCorrect ? BET * (1 - clob) / clob : -BET;
        trades.push({ windowStart: wStart, symbol: p.symbol, dir: p.direction, score: p.score, clob, isCorrect: p.isCorrect, pnl });
        windowTraded = true;
        if (!p.isCorrect) windowWin = false;
      }

      if (windowTraded) {
        windowStats.push({ ts: wStart, maxScore, avgScore, scored: eligible.length, traded: true, skipReason: '' });
        // Cooldown tracking
        if (!windowWin) {
          consecutiveLosses++;
          if (consecutiveLosses >= COOLDOWN_TRIGGER) {
            cooldownRemaining = COOLDOWN_SKIP;
            consecutiveLosses = 0;
          }
        } else {
          consecutiveLosses = 0;
        }
      } else {
        windowStats.push({ ts: wStart, maxScore, avgScore, scored: eligible.length, traded: false, skipReason: 'clob_price' });
      }
    }

    return { trades, windowStats };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYSIS 1: V5.129 production (score >= 65)
  // ═══════════════════════════════════════════════════════════════════════════

  const prod = simulateConfig(65);
  const prodTrades = prod.trades;

  // Group by day
  const tradesByDay = new Map<string, typeof prodTrades>();
  for (const t of prodTrades) {
    const day = new Date(t.windowStart).toISOString().slice(0, 10);
    if (!tradesByDay.has(day)) tradesByDay.set(day, []);
    tradesByDay.get(day)!.push(t);
  }

  // All days in range
  const allDays: string[] = [];
  for (let d = new Date(startMs); d.getTime() < endMs; d.setDate(d.getDate() + 1)) {
    allDays.push(d.toISOString().slice(0, 10));
  }

  const zeroDays = allDays.filter(d => !tradesByDay.has(d) || tradesByDay.get(d)!.length === 0);
  const tradeDays = allDays.filter(d => tradesByDay.has(d) && tradesByDay.get(d)!.length > 0);

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  SECTION 1: DAILY TRADE DISTRIBUTION (score >= 65, V5.129)`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`  Total days: ${allDays.length} | Trade days: ${tradeDays.length} | Zero-trade days: ${zeroDays.length} (${(zeroDays.length / allDays.length * 100).toFixed(0)}%)`);
  console.log(`  Total trades: ${prodTrades.length} | Avg per trade-day: ${tradeDays.length > 0 ? (prodTrades.length / tradeDays.length).toFixed(0) : 0}`);

  // Per-day detail
  console.log(`\n  ${'Day'.padEnd(12)} ${'Trades'.padStart(6)} ${'WR%'.padStart(6)} ${'PnL'.padStart(9)} ${'CumPnL'.padStart(9)} | ${'Notes'.padEnd(20)}`);
  console.log(`  ${'─'.repeat(75)}`);

  let cumPnl = 0;
  const dailyPnls: { day: string; pnl: number; trades: number }[] = [];

  for (const day of allDays) {
    const dayTrades = tradesByDay.get(day) ?? [];
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    const dayWins = dayTrades.filter(t => t.isCorrect).length;
    cumPnl += dayPnl;
    dailyPnls.push({ day, pnl: dayPnl, trades: dayTrades.length });

    const wr = dayTrades.length > 0 ? (dayWins / dayTrades.length * 100).toFixed(0) : '-';
    const notes = dayTrades.length === 0 ? '⬜ ZERO TRADES' :
                  dayPnl > 50 ? '🟢 GREAT' :
                  dayPnl > 0 ? '🟢' :
                  dayPnl > -20 ? '🔴' : '🔴 BAD';
    console.log(`  ${day} ${String(dayTrades.length).padStart(6)} ${String(wr).padStart(5)}% ${`${dayPnl >= 0 ? '+' : ''}$${dayPnl.toFixed(1)}`.padStart(9)} ${`$${cumPnl.toFixed(1)}`.padStart(9)} | ${notes}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYSIS 2: PnL concentration
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  SECTION 2: PnL CONCENTRATION`);
  console.log(`${'═'.repeat(80)}`);

  const sortedByPnl = [...dailyPnls].filter(d => d.trades > 0).sort((a, b) => b.pnl - a.pnl);
  const totalPnl = sortedByPnl.reduce((s, d) => s + d.pnl, 0);

  if (sortedByPnl.length > 0) {
    const top3 = sortedByPnl.slice(0, 3);
    const top3Pnl = top3.reduce((s, d) => s + d.pnl, 0);
    const bottom3 = sortedByPnl.slice(-3);
    const bottom3Pnl = bottom3.reduce((s, d) => s + d.pnl, 0);

    console.log(`  Total PnL: $${totalPnl.toFixed(0)}`);
    console.log(`  Top 3 days: $${top3Pnl.toFixed(0)} (${(top3Pnl / totalPnl * 100).toFixed(0)}% of total)`);
    for (const d of top3) console.log(`    ${d.day}: +$${d.pnl.toFixed(1)} (${d.trades} trades)`);
    console.log(`  Worst 3 days: $${bottom3Pnl.toFixed(0)}`);
    for (const d of bottom3) console.log(`    ${d.day}: $${d.pnl.toFixed(1)} (${d.trades} trades)`);

    const greenDays = sortedByPnl.filter(d => d.pnl >= 0).length;
    console.log(`  Green days: ${greenDays}/${sortedByPnl.length} (${(greenDays / sortedByPnl.length * 100).toFixed(0)}%)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYSIS 3: Score distribution on zero-trade windows
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  SECTION 3: SCORE DISTRIBUTION ON ALL WINDOWS`);
  console.log(`${'═'.repeat(80)}`);

  // Get max score per window
  const windowMaxScores: { ts: number; maxScore: number; day: string; hour: number }[] = [];
  for (const [wStart, preds] of byWindow) {
    const max = Math.max(...preds.map(p => p.score));
    windowMaxScores.push({
      ts: wStart,
      maxScore: max,
      day: new Date(wStart).toISOString().slice(0, 10),
      hour: new Date(wStart).getUTCHours(),
    });
  }

  const scoreBuckets = [
    [0, 19, '0-19'],
    [20, 34, '20-34'],
    [35, 49, '35-49'],
    [50, 54, '50-54'],
    [55, 59, '55-59'],
    [60, 64, '60-64'],  // <-- near-misses!
    [65, 69, '65-69'],
    [70, 79, '70-79'],
    [80, 100, '80-100'],
  ] as const;

  console.log(`\n  Max score per window (across all 4 symbols):`);
  console.log(`  ${'Range'.padEnd(10)} ${'Count'.padStart(6)} ${'%'.padStart(6)} | ${'Bar'}`);
  console.log(`  ${'─'.repeat(50)}`);

  for (const [lo, hi, label] of scoreBuckets) {
    const count = windowMaxScores.filter(w => w.maxScore >= lo && w.maxScore <= hi).length;
    const pct = (count / windowMaxScores.length * 100);
    const bar = '█'.repeat(Math.round(pct));
    const marker = lo === 60 && hi === 64 ? ' ← NEAR MISS' : lo === 65 ? ' ← THRESHOLD' : '';
    console.log(`  ${label.padEnd(10)} ${String(count).padStart(6)} ${pct.toFixed(1).padStart(5)}% | ${bar}${marker}`);
  }

  // Near-misses: windows with max score 50-64 (would trade at lower threshold)
  const nearMisses = windowMaxScores.filter(w => w.maxScore >= 50 && w.maxScore <= 64);
  console.log(`\n  Near-misses (score 50-64): ${nearMisses.length} windows (${(nearMisses.length / windowMaxScores.length * 100).toFixed(1)}%)`);

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYSIS 4: Skip reason breakdown
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  SECTION 4: WHY WINDOWS ARE SKIPPED (score >= 65)`);
  console.log(`${'═'.repeat(80)}`);

  const skipReasons = new Map<string, number>();
  for (const ws of prod.windowStats) {
    if (!ws.traded) {
      const reason = ws.skipReason || 'unknown';
      skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
    }
  }

  const traded = prod.windowStats.filter(w => w.traded).length;
  const total = prod.windowStats.length;
  console.log(`  Windows traded: ${traded}/${total} (${(traded / total * 100).toFixed(1)}%)`);
  console.log(`  Windows skipped: ${total - traded} (${((total - traded) / total * 100).toFixed(1)}%)\n`);

  const sortedReasons = [...skipReasons.entries()].sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sortedReasons) {
    console.log(`  ${reason.padEnd(30)} ${String(count).padStart(6)} (${(count / (total - traded) * 100).toFixed(1)}%)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYSIS 5: Component analysis — what kills the score?
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  SECTION 5: COMPONENT ANALYSIS — WHAT KILLS THE SCORE?`);
  console.log(`${'═'.repeat(80)}`);

  // Average component values for ALL predictions vs just high-score ones
  const allScored = allPreds;
  const highScored = allPreds.filter(p => p.score >= 65);

  function avgComp(preds: Pred[]) {
    if (preds.length === 0) return { vol: 0, roc: 0, body: 0, wick: 0, align: 0, pre: 0 };
    return {
      vol: preds.reduce((s, p) => s + p.vol, 0) / preds.length,
      roc: preds.reduce((s, p) => s + p.roc, 0) / preds.length,
      body: preds.reduce((s, p) => s + p.body, 0) / preds.length,
      wick: preds.reduce((s, p) => s + p.wick, 0) / preds.length,
      align: preds.reduce((s, p) => s + p.align, 0) / preds.length,
      pre: preds.reduce((s, p) => s + p.pre, 0) / preds.length,
    };
  }

  const avgAll = avgComp(allScored);
  const avgHigh = avgComp(highScored);

  console.log(`\n  ${'Component'.padEnd(14)} ${'Max'.padStart(4)} | ${'Avg ALL'.padStart(8)} ${'Avg ≥65'.padStart(8)} | ${'Gap'.padStart(6)} | ${'% of max lost'.padStart(14)}`);
  console.log(`  ${'─'.repeat(65)}`);

  const comps: [string, number, number, number][] = [
    ['Volume', 25, avgAll.vol, avgHigh.vol],
    ['MicroROC', 20, avgAll.roc, avgHigh.roc],
    ['BodyRatio', 15, avgAll.body, avgHigh.body],
    ['WickReject', 15, avgAll.wick, avgHigh.wick],
    ['Alignment', 15, avgAll.align, avgHigh.align],
    ['PreMomentum', 10, avgAll.pre, avgHigh.pre],
  ];

  for (const [name, max, all, high] of comps) {
    const lost = max - all;
    const lostPct = (lost / max * 100);
    console.log(`  ${name.padEnd(14)} ${String(max).padStart(4)} | ${all.toFixed(1).padStart(8)} ${high.toFixed(1).padStart(8)} | ${(high - all).toFixed(1).padStart(6)} | ${lostPct.toFixed(0).padStart(3)}% lost`);
  }

  // Volume = 0 analysis
  const volZero = allPreds.filter(p => p.vol === 0);
  const volZeroPct = (volZero.length / allPreds.length * 100);
  console.log(`\n  Volume = 0 in ${volZeroPct.toFixed(0)}% of all predictions`);
  console.log(`  Pre-momentum = negative in ${(allPreds.filter(p => p.pre < 0).length / allPreds.length * 100).toFixed(0)}% of predictions`);
  console.log(`  When vol=0 AND pre<0: max possible score = 55 (IMPOSSIBLE to reach 65)`);
  console.log(`  When vol=0 AND pre=0: max possible score = 65 (needs PERFECT everything else)`);
  console.log(`  When vol=0 AND pre>0: max possible score = 75 (reachable with good signals)`);

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYSIS 6: DETAILED THRESHOLD COMPARISON WITH CLOB ECONOMICS + EQUITY CURVE
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`\n${'═'.repeat(100)}`);
  console.log(`  SECTION 6: CLOB ECONOMICS + EQUITY CURVES PER THRESHOLD`);
  console.log(`${'═'.repeat(100)}`);

  for (const threshold of [65, 55, 50, 45]) {
    const sim = simulateConfig(threshold);
    const t = sim.trades;
    const wins = t.filter(x => x.isCorrect);
    const losses = t.filter(x => !x.isCorrect);
    const wr = t.length > 0 ? wins.length / t.length * 100 : 0;
    const totalPnlT = t.reduce((s, x) => s + x.pnl, 0);

    // CLOB economics
    const avgClob = t.length > 0 ? t.reduce((s, x) => s + x.clob, 0) / t.length : 0;
    const avgWinClob = wins.length > 0 ? wins.reduce((s, x) => s + x.clob, 0) / wins.length : 0;
    const avgLossClob = losses.length > 0 ? losses.reduce((s, x) => s + x.clob, 0) / losses.length : 0;
    const avgWinPnl = wins.length > 0 ? wins.reduce((s, x) => s + x.pnl, 0) / wins.length : 0;
    const avgLossPnl = losses.length > 0 ? losses.reduce((s, x) => s + x.pnl, 0) / losses.length : 0;
    const breakevenWR = avgClob * 100; // breakeven WR = CLOB price
    const edge = wr - breakevenWR;
    const winsPerLoss = avgLossPnl !== 0 ? Math.abs(avgLossPnl / avgWinPnl) : 0;

    console.log(`\n  ┌─── Score >= ${threshold} ─────────────────────────────────────────────────────────┐`);
    console.log(`  │ Trades: ${String(t.length).padStart(4)} (${(t.length/DAYS).toFixed(0)}/day)  W: ${wins.length}  L: ${losses.length}  WR: ${wr.toFixed(1)}%`);
    console.log(`  │ Avg CLOB: ${avgClob.toFixed(3)}  →  Breakeven WR: ${breakevenWR.toFixed(1)}%  →  EDGE: ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}pp`);
    console.log(`  │ Avg win:  +$${avgWinPnl.toFixed(2)} (at CLOB ${avgWinClob.toFixed(3)})  →  need ${winsPerLoss.toFixed(1)} wins per loss`);
    console.log(`  │ Avg loss: -$${BET.toFixed(2)} (at CLOB ${avgLossClob.toFixed(3)})`);
    console.log(`  │ Total PnL: ${totalPnlT >= 0 ? '+' : ''}$${totalPnlT.toFixed(0)}  |  PnL per trade: ${(totalPnlT / (t.length || 1)).toFixed(2)}`);
    console.log(`  └───────────────────────────────────────────────────────────────────────────────────┘`);

    // CLOB bucket breakdown
    console.log(`  CLOB buckets:`);
    console.log(`    ${'Range'.padEnd(12)} ${'N'.padStart(5)} ${'WR%'.padStart(6)} ${'BE%'.padStart(5)} ${'Edge'.padStart(7)} ${'AvgWin'.padStart(8)} ${'PnL'.padStart(8)}`);
    for (const [lo, hi] of [[0.55, 0.60], [0.60, 0.65], [0.65, 0.70], [0.70, 0.78], [0.78, 0.85]] as const) {
      const bucket = t.filter(x => x.clob >= lo && x.clob < hi);
      if (bucket.length === 0) continue;
      const bw = bucket.filter(x => x.isCorrect).length;
      const bwr = bw / bucket.length * 100;
      const be = bucket.reduce((s, x) => s + x.clob, 0) / bucket.length * 100;
      const bPnl = bucket.reduce((s, x) => s + x.pnl, 0);
      const bAvgWin = bw > 0 ? bucket.filter(x => x.isCorrect).reduce((s, x) => s + x.pnl, 0) / bw : 0;
      const verdict = bPnl > 0 ? '\x1b[32m+EV\x1b[0m' : '\x1b[31m-EV\x1b[0m';
      console.log(`    ${`${lo.toFixed(2)}-${hi.toFixed(2)}`.padEnd(12)} ${String(bucket.length).padStart(5)} ${bwr.toFixed(0).padStart(5)}% ${be.toFixed(0).padStart(4)}% ${(bwr-be >= 0 ? '+' : '') + (bwr-be).toFixed(0) + 'pp'.padStart(7)} ${`+$${bAvgWin.toFixed(2)}`.padStart(8)} ${`${bPnl>=0?'+':''}$${bPnl.toFixed(0)}`.padStart(8)} ${verdict}`);
    }

    // EQUITY CURVE — day by day
    const dayMap = new Map<string, { pnl: number; trades: number; wins: number; losses: number }>();
    for (const tr of t) {
      const d = new Date(tr.windowStart).toISOString().slice(0, 10);
      const day = dayMap.get(d) ?? { pnl: 0, trades: 0, wins: 0, losses: 0 };
      day.pnl += tr.pnl;
      day.trades++;
      if (tr.isCorrect) day.wins++; else day.losses++;
      dayMap.set(d, day);
    }

    console.log(`\n  Equity curve (score >= ${threshold}):`);
    console.log(`    ${'Day'.padEnd(12)} ${'T'.padStart(3)} ${'W'.padStart(3)} ${'L'.padStart(3)} ${'WR%'.padStart(5)} ${'DayPnL'.padStart(9)} ${'Cum'.padStart(9)} ${'MaxDD'.padStart(7)} | Bar`);

    let cumPnlT = 0;
    let peakT = 0;
    let maxDDt = 0;
    let maxConsecLoss = 0;
    let curConsecLoss = 0;
    let greenDaysT = 0;
    let redDaysT = 0;

    // Sort trades by time for consecutive loss tracking
    const sortedT = [...t].sort((a, b) => a.windowStart - b.windowStart);
    for (const tr of sortedT) {
      if (!tr.isCorrect) { curConsecLoss++; maxConsecLoss = Math.max(maxConsecLoss, curConsecLoss); }
      else curConsecLoss = 0;
    }

    for (const day of allDays) {
      const d = dayMap.get(day);
      if (!d) {
        // zero trade day
        console.log(`    ${day} ${'–'.padStart(3)} ${'–'.padStart(3)} ${'–'.padStart(3)} ${'–'.padStart(5)} ${'$0'.padStart(9)} ${`$${cumPnlT.toFixed(0)}`.padStart(9)} ${`$${(peakT-cumPnlT).toFixed(0)}`.padStart(7)} | ⬜`);
        continue;
      }
      cumPnlT += d.pnl;
      peakT = Math.max(peakT, cumPnlT);
      const dd = peakT - cumPnlT;
      maxDDt = Math.max(maxDDt, dd);
      if (d.pnl >= 0) greenDaysT++; else redDaysT++;
      const wrD = d.trades > 0 ? (d.wins / d.trades * 100) : 0;
      const bar = d.pnl >= 0
        ? '\x1b[32m' + '▓'.repeat(Math.min(30, Math.max(1, Math.round(d.pnl / 2)))) + '\x1b[0m'
        : '\x1b[31m' + '▓'.repeat(Math.min(30, Math.max(1, Math.round(-d.pnl / 2)))) + '\x1b[0m';
      console.log(`    ${day} ${String(d.trades).padStart(3)} ${String(d.wins).padStart(3)} ${String(d.losses).padStart(3)} ${wrD.toFixed(0).padStart(4)}% ${`${d.pnl>=0?'+':''}$${d.pnl.toFixed(1)}`.padStart(9)} ${`$${cumPnlT.toFixed(0)}`.padStart(9)} ${`$${dd.toFixed(0)}`.padStart(7)} | ${bar}`);
    }

    console.log(`    ── MaxDD: $${maxDDt.toFixed(0)} | MaxConsecLoss: ${maxConsecLoss} | Green: ${greenDaysT}/${greenDaysT+redDaysT} (${greenDaysT+redDaysT > 0 ? (greenDaysT/(greenDaysT+redDaysT)*100).toFixed(0) : 0}%) | CURVE ${cumPnlT > 0 ? 'GROWING' : 'NEGATIVE'} ──`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYSIS 7: Hourly pattern — when does the strategy work?
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  SECTION 7: HOURLY WR PATTERN (score >= 65, V5.129)`);
  console.log(`${'═'.repeat(80)}`);

  const byHour = new Map<number, typeof prodTrades>();
  for (const t of prodTrades) {
    const h = new Date(t.windowStart).getUTCHours();
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h)!.push(t);
  }

  console.log(`  ${'Hour'.padStart(4)} ${'Trades'.padStart(7)} ${'WR%'.padStart(6)} ${'PnL'.padStart(9)} | ${'Bar'}`);
  console.log(`  ${'─'.repeat(50)}`);

  for (let h = 0; h < 24; h++) {
    const hourTrades = byHour.get(h) ?? [];
    if (hourTrades.length === 0) {
      console.log(`  ${String(h).padStart(4)}h ${String(0).padStart(7)} ${'  -'.padStart(6)} ${'$0'.padStart(9)} |`);
      continue;
    }
    const wins = hourTrades.filter(t => t.isCorrect).length;
    const wr = wins / hourTrades.length * 100;
    const pnl = hourTrades.reduce((s, t) => s + t.pnl, 0);
    const bar = pnl >= 0
      ? '\x1b[32m' + '█'.repeat(Math.min(20, Math.round(pnl / 3))) + '\x1b[0m'
      : '\x1b[31m' + '█'.repeat(Math.min(20, Math.round(-pnl / 3))) + '\x1b[0m';
    console.log(`  ${String(h).padStart(4)}h ${String(hourTrades.length).padStart(7)} ${wr.toFixed(0).padStart(5)}% ${`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`.padStart(9)} | ${bar}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL VERDICT
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  VERDICT`);
  console.log(`${'═'.repeat(80)}`);

  const pct0 = zeroDays.length / allDays.length * 100;
  if (pct0 > 50) {
    console.log(`  ⚠️  ${pct0.toFixed(0)}% zero-trade days = STRATEGY IS FEAST-OR-FAMINE`);
    console.log(`  The filter DOES protect against bad trades on quiet days.`);
    console.log(`  But if PnL is concentrated on few days, you need PATIENCE.`);
  } else if (pct0 > 20) {
    console.log(`  ℹ️  ${pct0.toFixed(0)}% zero-trade days = some dead periods, acceptable`);
  } else {
    console.log(`  ✅ ${pct0.toFixed(0)}% zero-trade days = strategy trades most days`);
  }

  console.log(`\n  KEY QUESTION: Are zero-trade days also LOW-WR days?`);
  // Check WR of predictions on zero-trade days (at lower thresholds)
  const zeroTradeDayPreds = allPreds.filter(p => {
    const day = new Date(p.windowStart).toISOString().slice(0, 10);
    return zeroDays.includes(day);
  });
  const zeroTradeCorrect = zeroTradeDayPreds.filter(p => p.isCorrect).length;
  const zeroTradeWr = zeroTradeDayPreds.length > 0 ? zeroTradeCorrect / zeroTradeDayPreds.length * 100 : 0;

  const tradeDayPreds = allPreds.filter(p => {
    const day = new Date(p.windowStart).toISOString().slice(0, 10);
    return tradeDays.includes(day);
  });
  const tradeCorrect = tradeDayPreds.filter(p => p.isCorrect).length;
  const tradeWr = tradeDayPreds.length > 0 ? tradeCorrect / tradeDayPreds.length * 100 : 0;

  console.log(`  WR of ALL predictions (score >= 0) on zero-trade days: ${zeroTradeWr.toFixed(1)}% (${zeroTradeDayPreds.length} preds)`);
  console.log(`  WR of ALL predictions (score >= 0) on trade days:      ${tradeWr.toFixed(1)}% (${tradeDayPreds.length} preds)`);
  console.log(`  → If zero-trade day WR is lower, the filter IS protecting you.`);
  console.log(`  → If WR is similar, the filter is possibly too aggressive.`);

  console.log(`\n${'═'.repeat(80)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
