/**
 * Backtest: Polymarket 5-min consensus filter
 *
 * Tests hypothesis: when 3+ symbols predict the same direction in the same
 * 5-min window, win rate is significantly higher.
 *
 * Usage: npx tsx scripts/backtest-polymarket-consensus.ts [--days 30]
 */

import { computeFiveMinScore } from '../src/services/polymarket/fiveMinScorer.js';
import type { Candle1m } from '../src/services/polymarket/polymarketTypes.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const WINDOW_MS = 5 * 60 * 1000;
const DECISION_OFFSET_CANDLES = 1; // Score at T+1:00 (1 candle into window)
const PRE_WINDOW_CANDLES = 5;      // 5 previous candles for context
const MIN_SCORE = 40;

const DAYS = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] ?? '') ||
  parseInt(process.argv[process.argv.indexOf('--days') + 1] ?? '') || 30;

// ─── Binance REST ────────────────────────────────────────────────────────────

interface BinanceKline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      });
    }

    cursor = data[data.length - 1][0] + 60_000;
    if (data.length < 1000) break;

    // Rate limit: Binance allows 1200 req/min, be conservative
    await new Promise(r => setTimeout(r, 100));
  }

  return all;
}

// ─── Main ────────────────────────────────────────────────────────────────────

interface WindowResult {
  windowStart: number;
  symbol: string;
  direction: 'UP' | 'DOWN';
  score: number;
  actualResult: 'UP' | 'DOWN';
  isCorrect: boolean;
}

async function main() {
  const endMs = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS; // Last complete window
  const startMs = endMs - DAYS * 24 * 60 * 60 * 1000;

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Polymarket 5-min Consensus Backtest                        ║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║  Period:  ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)} (${DAYS} days)     ║`);
  console.log(`║  Symbols: ${SYMBOLS.join(', ')}                              ║`);
  console.log(`║  Score threshold: >= ${MIN_SCORE}                                  ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  // 1. Fetch 1m candles for all symbols
  const klinesBySymbol = new Map<string, BinanceKline[]>();

  for (const sym of SYMBOLS) {
    process.stdout.write(`Fetching ${sym} 1m candles...`);
    const klines = await fetchKlines1m(sym, startMs - 10 * 60_000, endMs); // Extra 10min for pre-window context
    klinesBySymbol.set(sym, klines);
    console.log(` ${klines.length} candles`);
  }

  // 2. Build per-symbol candle index by timestamp for fast lookup
  const indexBySymbol = new Map<string, Map<number, BinanceKline>>();
  for (const [sym, klines] of klinesBySymbol) {
    const idx = new Map<number, BinanceKline>();
    for (const k of klines) idx.set(k.timestamp, k);
    indexBySymbol.set(sym, idx);
  }

  // 3. Iterate over all 5-min windows
  const allResults: WindowResult[] = [];
  let windowCount = 0;

  for (let wStart = startMs; wStart < endMs; wStart += WINDOW_MS) {
    windowCount++;
    const wEnd = wStart + WINDOW_MS;

    for (const sym of SYMBOLS) {
      const idx = indexBySymbol.get(sym)!;

      // Get candles in window (T+0:00 to T+0:59 = first candle only for decision at T+1:00)
      const windowCandles: Candle1m[] = [];
      for (let t = wStart; t < wStart + DECISION_OFFSET_CANDLES * 60_000; t += 60_000) {
        const k = idx.get(t);
        if (k) windowCandles.push({ ...k, isFinal: true });
      }

      // Get pre-window candles (5 candles before window)
      const preCandles: Candle1m[] = [];
      for (let t = wStart - PRE_WINDOW_CANDLES * 60_000; t < wStart; t += 60_000) {
        const k = idx.get(t);
        if (k) preCandles.push({ ...k, isFinal: true });
      }

      if (windowCandles.length === 0) continue;

      // Window open price = first candle open
      const openPrice = idx.get(wStart)?.open ?? windowCandles[0].open;

      // Run scorer
      const result = computeFiveMinScore(windowCandles, preCandles, openPrice);
      if (!result) continue; // Score < 40

      // Actual result: compare endPrice vs startPrice
      // endPrice = last 1m candle close in window (T+4:00 candle close)
      const endCandle = idx.get(wEnd - 60_000);
      if (!endCandle) continue;

      const startCandle = idx.get(wStart);
      if (!startCandle) continue;

      const actualResult: 'UP' | 'DOWN' = endCandle.close >= startCandle.open ? 'UP' : 'DOWN';

      allResults.push({
        windowStart: wStart,
        symbol: sym,
        direction: result.direction,
        score: result.confidence,
        actualResult,
        isCorrect: result.direction === actualResult,
      });
    }
  }

  console.log(`\nTotal windows: ${windowCount}`);
  console.log(`Total predictions (score >= ${MIN_SCORE}): ${allResults.length}`);

  // 4. Group by window → find consensus
  const byWindow = new Map<number, WindowResult[]>();
  for (const r of allResults) {
    let arr = byWindow.get(r.windowStart);
    if (!arr) { arr = []; byWindow.set(r.windowStart, arr); }
    arr.push(r);
  }

  // 5. Classify each window by consensus level
  interface ConsensusWindow {
    windowStart: number;
    predictions: WindowResult[];
    consensusDir: 'UP' | 'DOWN' | 'MIXED';
    sameCount: number;    // How many predict the majority direction
    totalPreds: number;
  }

  const consensusWindows: ConsensusWindow[] = [];

  for (const [wStart, preds] of byWindow) {
    const upCount = preds.filter(p => p.direction === 'UP').length;
    const downCount = preds.filter(p => p.direction === 'DOWN').length;

    let consensusDir: 'UP' | 'DOWN' | 'MIXED';
    let sameCount: number;

    if (upCount > downCount) {
      consensusDir = 'UP';
      sameCount = upCount;
    } else if (downCount > upCount) {
      consensusDir = 'DOWN';
      sameCount = downCount;
    } else {
      consensusDir = 'MIXED';
      sameCount = upCount; // equal
    }

    consensusWindows.push({
      windowStart: wStart,
      predictions: preds,
      consensusDir,
      sameCount,
      totalPreds: preds.length,
    });
  }

  // 6. Stats by consensus level
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  CONSENSUS ANALYSIS`);
  console.log(`${'═'.repeat(70)}`);

  // Overall stats per symbol
  console.log(`\n── Per-Symbol Stats ──`);
  for (const sym of SYMBOLS) {
    const symResults = allResults.filter(r => r.symbol === sym);
    const wins = symResults.filter(r => r.isCorrect).length;
    const total = symResults.length;
    const wr = total > 0 ? (wins / total * 100).toFixed(1) : '—';
    const avgScore = total > 0 ? (symResults.reduce((s, r) => s + r.score, 0) / total).toFixed(0) : '—';
    console.log(`  ${sym}: ${total} predictions, WR=${wr}%, avg score=${avgScore}`);
  }

  // Stats by number of concurrent predictions
  console.log(`\n── By Concurrent Predictions Count ──`);
  for (let n = 1; n <= 4; n++) {
    const windows = consensusWindows.filter(w => w.totalPreds === n);
    const allPreds = windows.flatMap(w => w.predictions);
    const wins = allPreds.filter(r => r.isCorrect).length;
    const total = allPreds.length;
    const wr = total > 0 ? (wins / total * 100).toFixed(1) : '—';
    console.log(`  ${n} symbols active: ${windows.length} windows, ${total} predictions, WR=${wr}%`);
  }

  // Stats by consensus level (unanimous vs split)
  console.log(`\n── By Consensus Level ──`);

  // All predictions in consensus windows (3+ same direction)
  const strongConsensus = consensusWindows.filter(w => w.sameCount >= 3 && w.totalPreds >= 3);
  const strongPreds = strongConsensus.flatMap(w =>
    w.predictions.filter(p => p.direction === w.consensusDir)
  );
  const strongWins = strongPreds.filter(r => r.isCorrect).length;

  // 2-sym agreement only
  const medConsensus = consensusWindows.filter(w => w.sameCount >= 2 && w.totalPreds >= 2 && w.sameCount < 3);
  const medPreds = medConsensus.flatMap(w =>
    w.predictions.filter(p => p.direction === w.consensusDir)
  );
  const medWins = medPreds.filter(r => r.isCorrect).length;

  // Solo predictions (only 1 symbol active)
  const soloWindows = consensusWindows.filter(w => w.totalPreds === 1);
  const soloPreds = soloWindows.flatMap(w => w.predictions);
  const soloWins = soloPreds.filter(r => r.isCorrect).length;

  // Against-consensus predictions (predict opposite of majority)
  const againstPreds = consensusWindows
    .filter(w => w.sameCount >= 2 && w.totalPreds >= 2)
    .flatMap(w => w.predictions.filter(p => p.direction !== w.consensusDir));
  const againstWins = againstPreds.filter(r => r.isCorrect).length;

  console.log(`  Solo (1 sym):           ${soloWindows.length} windows, ${soloPreds.length} preds, WR=${soloPreds.length > 0 ? (soloWins / soloPreds.length * 100).toFixed(1) : '—'}%`);
  console.log(`  2-sym consensus:        ${medConsensus.length} windows, ${medPreds.length} preds, WR=${medPreds.length > 0 ? (medWins / medPreds.length * 100).toFixed(1) : '—'}%`);
  console.log(`  3+ sym consensus:       ${strongConsensus.length} windows, ${strongPreds.length} preds, WR=${strongPreds.length > 0 ? (strongWins / strongPreds.length * 100).toFixed(1) : '—'}%`);
  console.log(`  Against consensus:      ${againstPreds.length} preds, WR=${againstPreds.length > 0 ? (againstWins / againstPreds.length * 100).toFixed(1) : '—'}%`);

  // 4-sym unanimous
  const unanimousUp = consensusWindows.filter(w => w.totalPreds === 4 && w.sameCount === 4 && w.consensusDir === 'UP');
  const unanimousDown = consensusWindows.filter(w => w.totalPreds === 4 && w.sameCount === 4 && w.consensusDir === 'DOWN');
  const unanimousPreds = [...unanimousUp, ...unanimousDown].flatMap(w => w.predictions);
  const unanimousWins = unanimousPreds.filter(r => r.isCorrect).length;
  console.log(`  4-sym UNANIMOUS:        ${unanimousUp.length + unanimousDown.length} windows, ${unanimousPreds.length} preds, WR=${unanimousPreds.length > 0 ? (unanimousWins / unanimousPreds.length * 100).toFixed(1) : '—'}%`);

  // 7. Score-based breakdown for consensus windows
  console.log(`\n── Consensus + Score Filter ──`);
  for (const minScore of [40, 50, 55, 60]) {
    const filtered = strongConsensus.flatMap(w =>
      w.predictions.filter(p => p.direction === w.consensusDir && p.score >= minScore)
    );
    const wins = filtered.filter(r => r.isCorrect).length;
    console.log(`  3+ consensus & score >= ${minScore}: ${filtered.length} preds, WR=${filtered.length > 0 ? (wins / filtered.length * 100).toFixed(1) : '—'}%`);
  }

  // 8. Time-of-day breakdown for consensus
  console.log(`\n── Consensus by Hour (UTC) ──`);
  const hourBuckets = new Map<number, { total: number; wins: number }>();
  for (const w of strongConsensus) {
    const hour = new Date(w.windowStart).getUTCHours();
    let bucket = hourBuckets.get(hour);
    if (!bucket) { bucket = { total: 0, wins: 0 }; hourBuckets.set(hour, bucket); }
    const consPreds = w.predictions.filter(p => p.direction === w.consensusDir);
    bucket.total += consPreds.length;
    bucket.wins += consPreds.filter(p => p.isCorrect).length;
  }
  const sortedHours = [...hourBuckets.entries()].sort((a, b) => a[0] - b[0]);
  for (const [hour, b] of sortedHours) {
    const wr = b.total > 0 ? (b.wins / b.total * 100).toFixed(1) : '—';
    const bar = '█'.repeat(Math.round(b.total / 2));
    console.log(`  ${String(hour).padStart(2, '0')}h: ${String(b.total).padStart(4)} preds, WR=${wr}% ${bar}`);
  }

  // 9. Summary
  console.log(`\n${'═'.repeat(70)}`);
  const baseWr = allResults.length > 0 ? (allResults.filter(r => r.isCorrect).length / allResults.length * 100).toFixed(1) : '—';
  const consWr = strongPreds.length > 0 ? (strongWins / strongPreds.length * 100).toFixed(1) : '—';
  const delta = strongPreds.length > 0 && allResults.length > 0
    ? ((strongWins / strongPreds.length * 100) - (allResults.filter(r => r.isCorrect).length / allResults.length * 100)).toFixed(1)
    : '—';

  console.log(`  BASELINE WR (all):     ${baseWr}%`);
  console.log(`  CONSENSUS WR (3+):     ${consWr}%`);
  console.log(`  DELTA:                 ${delta}pp`);
  console.log(`${'═'.repeat(70)}\n`);

  if (parseFloat(delta as string) > 3) {
    console.log(`  ✓ Consensus filter shows +${delta}pp edge — worth implementing as confidence boost`);
  } else if (parseFloat(delta as string) > 0) {
    console.log(`  ~ Consensus filter shows marginal edge (+${delta}pp) — needs more data`);
  } else {
    console.log(`  ✗ Consensus filter shows no edge — correlation doesn't improve WR`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
