/**
 * Compare Polymarket prediction performance WITH vs WITHOUT consensus filter.
 *
 * Scenarios tested:
 *   A) Score only (no consensus, no market filter)
 *   B) Score + market filter (no consensus)
 *   C) Score + consensus 3+ (no market filter)
 *   D) Score + consensus 3+ + market filter (current production)
 *
 * Usage: npx tsx scripts/compare-consensus-impact.ts [--days 30]
 */

import { computeFiveMinScore } from '../src/services/polymarket/fiveMinScorer.js';
import type { Candle1m } from '../src/services/polymarket/polymarketTypes.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const WINDOW_MS = 5 * 60 * 1000;
const DECISION_OFFSET_CANDLES = 1;
const PRE_WINDOW_CANDLES = 5;
const MIN_SCORE = 40;
const BET = 5;
const FLAT_THRESHOLD = 0.02;

// EV cap tiers (from polymarketTrader.ts)
const CLOB_TIERS = [
  { minScore: 60, maxPrice: 0.90 },
  { minScore: 50, maxPrice: 0.85 },
  { minScore: 40, maxPrice: 0.78 },
];
// Simulated CLOB prices by score tier (conservative estimates)
const SIMULATED_CLOB: Record<string, number> = {
  high: 0.58, // score 60+ avg CLOB
  mid: 0.55,  // score 50-59 avg CLOB
  low: 0.52,  // score 40-49 avg CLOB
};

const DAYS = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] ?? '') ||
  parseInt(process.argv[process.argv.indexOf('--days') + 1] ?? '') || 30;

// ─── Binance REST ────────────────────────────────────────────────────────────

interface BinanceKline {
  timestamp: number; open: number; high: number; low: number; close: number; volume: number;
}

async function fetchKlines1m(symbol: string, startMs: number, endMs: number): Promise<BinanceKline[]> {
  const pair = `${symbol}USDT`;
  const all: BinanceKline[] = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
    const data = await res.json() as any[];
    if (data.length === 0) break;

    for (const k of data) {
      all.push({
        timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      });
    }

    cursor = data[data.length - 1][0] + 60_000;
    if (data.length < 1000) break;
    if (all.length % 10000 < 1000) process.stdout.write(`  ${all.length}...\r`);
    await new Promise(r => setTimeout(r, 80));
  }
  return all;
}

// ─── Market condition filter (same as polymarketWorker.ts) ───────────────────

function computeBtcContext(btcIndex: Map<number, BinanceKline>, atTs: number): {
  roc5m: number; roc15m: number; bodyRatio: number;
} | null {
  const candles: BinanceKline[] = [];
  for (let t = atTs - 15 * 60_000; t < atTs; t += 60_000) {
    const c = btcIndex.get(t);
    if (c) candles.push(c);
  }
  if (candles.length < 10) return null;

  const last15 = candles.slice(-15);
  const last10 = candles.slice(-10);
  const last5 = candles.slice(-5);
  const last = candles[candles.length - 1];

  const roc5m = (last.close - last5[0].open) / last5[0].open * 100;
  const roc15m = last15.length >= 15
    ? (last.close - last15[0].open) / last15[0].open * 100
    : roc5m;

  const bodyRatio = last10.reduce((s, c) => {
    const range = c.high - c.low;
    return range === 0 ? s : s + Math.abs(c.close - c.open) / range;
  }, 0) / last10.length;

  return { roc5m, roc15m, bodyRatio };
}

function passesMarketFilter(ctx: { roc5m: number; roc15m: number; bodyRatio: number }, dir: 'UP' | 'DOWN'): boolean {
  const roc5mFlat = Math.abs(ctx.roc5m) < FLAT_THRESHOLD;
  const meanReversion = roc5mFlat ||
    (dir === 'UP' && ctx.roc5m < 0) ||
    (dir === 'DOWN' && ctx.roc5m > 0);
  if (!meanReversion) return false;

  const trendAlign = ctx.roc5m !== 0 && Math.sign(ctx.roc5m) === Math.sign(ctx.roc15m);
  if (!trendAlign && !roc5mFlat) return false;

  if (ctx.bodyRatio <= 0.5) return false;

  return true;
}

// ─── Simulated PnL ───────────────────────────────────────────────────────────

function simPnl(isCorrect: boolean, score: number): number {
  const clobPrice = score >= 60 ? SIMULATED_CLOB.high : score >= 50 ? SIMULATED_CLOB.mid : SIMULATED_CLOB.low;
  if (isCorrect) {
    return BET * (1 - clobPrice) / clobPrice; // Win: tokens pay $1
  } else {
    return -BET; // Lose: lose entire stake
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface Prediction {
  windowStart: number;
  symbol: string;
  direction: 'UP' | 'DOWN';
  score: number;
  isCorrect: boolean;
}

interface ScenarioResult {
  name: string;
  trades: number;
  wins: number;
  losses: number;
  wr: number;
  pnl: number;
  tradesPerDay: number;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const endMs = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const startMs = endMs - DAYS * 86400_000;

  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  Consensus Impact Comparison — ${DAYS} days                        ║`);
  console.log(`╠══════════════════════════════════════════════════════════════════╣`);
  console.log(`║  ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)}                                      ║`);
  console.log(`║  Symbols: ${SYMBOLS.join(', ')}  |  Bet: $${BET}  |  Score >= ${MIN_SCORE}           ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝\n`);

  // 1. Fetch candles
  const indexBySymbol = new Map<string, Map<number, BinanceKline>>();

  for (const sym of SYMBOLS) {
    process.stdout.write(`Fetching ${sym}...`);
    const klines = await fetchKlines1m(sym, startMs - 35 * 60_000, endMs);
    const idx = new Map<number, BinanceKline>();
    for (const k of klines) idx.set(k.timestamp, k);
    indexBySymbol.set(sym, idx);
    console.log(` ${klines.length} candles`);
  }

  const btcIndex = indexBySymbol.get('BTC')!;

  // 2. Score all windows for all symbols
  const allPreds: Prediction[] = [];
  let windowCount = 0;

  for (let wStart = startMs; wStart < endMs; wStart += WINDOW_MS) {
    windowCount++;

    for (const sym of SYMBOLS) {
      const idx = indexBySymbol.get(sym)!;

      const windowCandles: Candle1m[] = [];
      for (let t = wStart; t < wStart + DECISION_OFFSET_CANDLES * 60_000; t += 60_000) {
        const k = idx.get(t);
        if (k) windowCandles.push({ ...k, isFinal: true });
      }

      const preCandles: Candle1m[] = [];
      for (let t = wStart - PRE_WINDOW_CANDLES * 60_000; t < wStart; t += 60_000) {
        const k = idx.get(t);
        if (k) preCandles.push({ ...k, isFinal: true });
      }

      if (windowCandles.length === 0) continue;

      const openPrice = idx.get(wStart)?.open ?? windowCandles[0].open;
      const result = computeFiveMinScore(windowCandles, preCandles, openPrice);
      if (!result) continue;

      const endCandle = idx.get(wStart + WINDOW_MS - 60_000);
      const startCandle = idx.get(wStart);
      if (!endCandle || !startCandle) continue;

      const actualResult = endCandle.close >= startCandle.open ? 'UP' : 'DOWN';

      allPreds.push({
        windowStart: wStart, symbol: sym,
        direction: result.direction, score: result.confidence,
        isCorrect: result.direction === actualResult,
      });
    }
  }

  console.log(`\nWindows: ${windowCount} | Raw predictions (score>=${MIN_SCORE}): ${allPreds.length}\n`);

  // 3. Group by window
  const byWindow = new Map<number, Prediction[]>();
  for (const p of allPreds) {
    if (!byWindow.has(p.windowStart)) byWindow.set(p.windowStart, []);
    byWindow.get(p.windowStart)!.push(p);
  }

  // ─── Scenario A: Score only (no consensus, no market filter) ───────────────

  function runScenario(
    name: string,
    opts: { minConsensus: number; marketFilter: boolean },
  ): ScenarioResult {
    let trades = 0, wins = 0, pnl = 0;

    for (const [wStart, preds] of byWindow) {
      const upCount = preds.filter(p => p.direction === 'UP').length;
      const downCount = preds.filter(p => p.direction === 'DOWN').length;
      const maxDir: 'UP' | 'DOWN' = upCount >= downCount ? 'UP' : 'DOWN';
      const maxCount = Math.max(upCount, downCount);

      // Consensus check
      let tradeable: Prediction[];
      if (opts.minConsensus <= 1) {
        // No consensus — trade ALL predictions
        tradeable = [...preds];
      } else {
        if (maxCount < opts.minConsensus) continue;
        tradeable = preds.filter(p => p.direction === maxDir);
      }

      // Market filter (applied to consensus direction)
      if (opts.marketFilter) {
        const dir = opts.minConsensus > 1 ? maxDir : null;
        if (dir) {
          const ctx = computeBtcContext(btcIndex, wStart);
          if (!ctx || !passesMarketFilter(ctx, dir)) continue;
        } else {
          // No consensus → check market filter per prediction direction
          const ctx = computeBtcContext(btcIndex, wStart);
          if (ctx) {
            tradeable = tradeable.filter(p => passesMarketFilter(ctx, p.direction));
          }
        }
      }

      for (const p of tradeable) {
        trades++;
        if (p.isCorrect) wins++;
        pnl += simPnl(p.isCorrect, p.score);
      }
    }

    const losses = trades - wins;
    return {
      name, trades, wins, losses,
      wr: trades > 0 ? wins / trades * 100 : 0,
      pnl,
      tradesPerDay: trades / DAYS,
    };
  }

  // ─── Run all scenarios ─────────────────────────────────────────────────────

  const scenarios: ScenarioResult[] = [
    runScenario('A) Score only',                    { minConsensus: 1, marketFilter: false }),
    runScenario('B) Score + market filter',         { minConsensus: 1, marketFilter: true }),
    runScenario('C) Score + consensus 3+',          { minConsensus: 3, marketFilter: false }),
    runScenario('D) Score + consensus + mktFilter', { minConsensus: 3, marketFilter: true }),
    runScenario('E) Score + consensus 2+',          { minConsensus: 2, marketFilter: false }),
    runScenario('F) Score + consensus 2+ + mktF',   { minConsensus: 2, marketFilter: true }),
  ];

  // ─── Output ────────────────────────────────────────────────────────────────

  console.log('═'.repeat(90));
  console.log(`  ${'Scenario'.padEnd(38)} | ${'Trades'.padStart(6)} | ${'W'.padStart(4)} ${'L'.padStart(4)} | ${'WR%'.padStart(6)} | ${'PnL'.padStart(9)} | ${'Tr/day'.padStart(6)}`);
  console.log('─'.repeat(90));

  for (const s of scenarios) {
    const wrStr = s.wr.toFixed(1) + '%';
    const pnlStr = (s.pnl >= 0 ? '+' : '') + '$' + s.pnl.toFixed(0);
    console.log(
      `  ${s.name.padEnd(38)} | ${String(s.trades).padStart(6)} | ${String(s.wins).padStart(4)} ${String(s.losses).padStart(4)} | ${wrStr.padStart(6)} | ${pnlStr.padStart(9)} | ${s.tradesPerDay.toFixed(1).padStart(6)}`,
    );
  }

  console.log('═'.repeat(90));

  // ─── Delta analysis ────────────────────────────────────────────────────────

  const baseline = scenarios[0]; // A
  console.log(`\n── Impact vs Baseline (A: Score only) ──\n`);

  for (const s of scenarios.slice(1)) {
    const wrDelta = s.wr - baseline.wr;
    const pnlDelta = s.pnl - baseline.pnl;
    const volDelta = ((s.trades - baseline.trades) / baseline.trades * 100);
    console.log(
      `  ${s.name.padEnd(38)} | WR ${wrDelta >= 0 ? '+' : ''}${wrDelta.toFixed(1)}pp | PnL ${pnlDelta >= 0 ? '+' : ''}$${pnlDelta.toFixed(0)} | Vol ${volDelta.toFixed(0)}%`,
    );
  }

  // ─── Score tier breakdown per scenario ─────────────────────────────────────

  console.log(`\n── WR by Score Tier ──\n`);
  console.log(`  ${'Scenario'.padEnd(38)} | ${'40-49'.padStart(8)} | ${'50-59'.padStart(8)} | ${'60+'.padStart(8)}`);
  console.log('  ' + '─'.repeat(70));

  for (const s of scenarios) {
    // Recalculate per tier (simplified — rerun with tier filter)
    const tiers: string[] = [];
    for (const [lo, hi] of [[40, 49], [50, 59], [60, 100]] as const) {
      const tierPreds = allPreds.filter(p => p.score >= lo && p.score <= hi);
      const w = tierPreds.filter(p => p.isCorrect).length;
      const t = tierPreds.length;
      tiers.push(t > 0 ? `${(w / t * 100).toFixed(0)}%/${t}` : '—');
    }
    console.log(`  ${s.name.padEnd(38)} | ${tiers[0].padStart(8)} | ${tiers[1].padStart(8)} | ${tiers[2].padStart(8)}`);
  }

  // ─── Conclusion ────────────────────────────────────────────────────────────

  const best = scenarios.reduce((a, b) => a.pnl > b.pnl ? a : b);
  const bestWr = scenarios.reduce((a, b) => a.wr > b.wr ? a : b);

  console.log(`\n${'═'.repeat(90)}`);
  console.log(`  BEST PnL:     ${best.name} → $${best.pnl.toFixed(0)} (WR ${best.wr.toFixed(1)}%, ${best.tradesPerDay.toFixed(0)} tr/day)`);
  console.log(`  BEST WR:      ${bestWr.name} → ${bestWr.wr.toFixed(1)}% (PnL $${bestWr.pnl.toFixed(0)}, ${bestWr.tradesPerDay.toFixed(0)} tr/day)`);

  // Key question: does removing consensus hurt?
  const withCons = scenarios.find(s => s.name.startsWith('D'))!;
  const noCons = scenarios.find(s => s.name.startsWith('B'))!;
  const wrGap = withCons.wr - noCons.wr;
  const pnlGap = withCons.pnl - noCons.pnl;

  console.log(`\n  CONSENSUS VALUE: D vs B`);
  console.log(`    WR delta:   ${wrGap >= 0 ? '+' : ''}${wrGap.toFixed(1)}pp`);
  console.log(`    PnL delta:  ${pnlGap >= 0 ? '+' : ''}$${pnlGap.toFixed(0)}`);
  console.log(`    Vol delta:  ${withCons.trades} vs ${noCons.trades} trades (${((withCons.trades - noCons.trades) / noCons.trades * 100).toFixed(0)}%)`);

  if (wrGap < 1 && pnlGap < 0) {
    console.log(`\n  → Consensus COSTS PnL sans améliorer WR → envisager suppression`);
  } else if (wrGap > 3) {
    console.log(`\n  → Consensus apporte +${wrGap.toFixed(1)}pp WR → garder`);
  } else {
    console.log(`\n  → Consensus marginal — tester sur plus de données`);
  }

  console.log(`${'═'.repeat(90)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
