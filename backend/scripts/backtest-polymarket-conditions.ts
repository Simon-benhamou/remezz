/**
 * Backtest: Polymarket consensus + market conditions analysis.
 *
 * Replays fiveMinScorer on historical 1m candles for 4 symbols.
 * Applies consensus filter (3+), then analyzes which BTC market
 * conditions produce the best win rate.
 *
 * Usage: npx tsx scripts/backtest-polymarket-conditions.ts [--days 30]
 */

import { computeFiveMinScore } from '../src/services/polymarket/fiveMinScorer.js';
import type { Candle1m } from '../src/services/polymarket/polymarketTypes.js';

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const WINDOW_MS = 5 * 60 * 1000;
const DECISION_OFFSET_CANDLES = 1;
const PRE_WINDOW_CANDLES = 5;
const MIN_SCORE = 40;
const MIN_CONSENSUS = 3;
const BET = 5;

const DAYS = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] ?? '') ||
  parseInt(process.argv[process.argv.indexOf('--days') + 1] ?? '') || 30;

// ── Binance REST ─────────────────────────────────────────────────────
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
    if (all.length % 10000 < 1000) process.stdout.write(`  ${all.length} candles...\r`);
    await new Promise(r => setTimeout(r, 80));
  }
  return all;
}

// ── Market context from BTC 1m candles ───────────────────────────────
interface MarketContext {
  roc5m: number; roc15m: number; roc30m: number;
  absRoc5m: number; absRoc15m: number; absRoc30m: number;
  volRatio: number; atr20: number; choppiness: number;
  range30m: number; trendAlign: boolean; bodyRatio: number;
}

function computeContext(btcIndex: Map<number, BinanceKline>, atTs: number): MarketContext | null {
  const candles: BinanceKline[] = [];
  for (let t = atTs - 30 * 60_000; t < atTs; t += 60_000) {
    const c = btcIndex.get(t);
    if (c) candles.push(c);
  }
  if (candles.length < 25) return null;

  const last = candles[candles.length - 1];
  const last5 = candles.slice(-5);
  const last10 = candles.slice(-10);
  const last15 = candles.slice(-15);
  const last20 = candles.slice(-20);

  const roc5m = (last.close - last5[0].open) / last5[0].open * 100;
  const roc15m = (last.close - last15[0].open) / last15[0].open * 100;
  const roc30m = (last.close - candles[0].open) / candles[0].open * 100;

  const vol5 = last5.reduce((s, c) => s + c.volume, 0) / 5;
  const vol30 = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  const volRatio = vol30 > 0 ? vol5 / vol30 : 1;

  let atrSum = 0;
  for (let i = 1; i < last20.length; i++) {
    atrSum += Math.max(
      last20[i].high - last20[i].low,
      Math.abs(last20[i].high - last20[i - 1].close),
      Math.abs(last20[i].low - last20[i - 1].close)
    );
  }
  const atr20 = (atrSum / (last20.length - 1)) / last.close * 100;

  let changes = 0;
  for (let i = 1; i < last20.length; i++) {
    if ((last20[i].close > last20[i].open) !== (last20[i - 1].close > last20[i - 1].open)) changes++;
  }

  const high30 = Math.max(...candles.map(c => c.high));
  const low30 = Math.min(...candles.map(c => c.low));
  const mid30 = (high30 + low30) / 2;
  const range30m = mid30 > 0 ? (high30 - low30) / mid30 * 100 : 0;

  const trendAlign = Math.sign(roc5m) === Math.sign(roc15m) && roc5m !== 0;

  const bodyRatio = last10.reduce((s, c) => {
    const range = c.high - c.low;
    return range === 0 ? s : s + Math.abs(c.close - c.open) / range;
  }, 0) / last10.length;

  return {
    roc5m, roc15m, roc30m,
    absRoc5m: Math.abs(roc5m), absRoc15m: Math.abs(roc15m), absRoc30m: Math.abs(roc30m),
    volRatio, atr20, choppiness: changes, range30m, trendAlign, bodyRatio,
  };
}

// ── Window result ────────────────────────────────────────────────────
interface WindowResult {
  windowStart: number;
  direction: string;
  consensusSize: number;
  wins: number; losses: number;
  wr: number; pnl: number;
  context: MarketContext;
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const endMs = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const startMs = endMs - DAYS * 86400_000;

  console.log(`\n📊 Polymarket Conditions Backtest — ${DAYS} days`);
  console.log(`${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)}\n`);

  // 1. Fetch candles
  const klinesBySymbol = new Map<string, BinanceKline[]>();
  const indexBySymbol = new Map<string, Map<number, BinanceKline>>();

  for (const sym of SYMBOLS) {
    process.stdout.write(`Fetching ${sym}...`);
    const klines = await fetchKlines1m(sym, startMs - 35 * 60_000, endMs);
    klinesBySymbol.set(sym, klines);
    const idx = new Map<number, BinanceKline>();
    for (const k of klines) idx.set(k.timestamp, k);
    indexBySymbol.set(sym, idx);
    console.log(` ${klines.length} candles`);
  }

  const btcIndex = indexBySymbol.get('BTC')!;

  // 2. Score all windows
  interface Prediction {
    windowStart: number; symbol: string; direction: 'UP' | 'DOWN';
    score: number; isCorrect: boolean;
  }

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

    if (windowCount % 5000 === 0) {
      process.stdout.write(`  ${windowCount} windows...\r`);
    }
  }

  console.log(`\nTotal windows: ${windowCount} | Predictions: ${allPreds.length}`);

  // 3. Group by window, apply consensus
  const byWindow = new Map<number, Prediction[]>();
  for (const p of allPreds) {
    if (!byWindow.has(p.windowStart)) byWindow.set(p.windowStart, []);
    byWindow.get(p.windowStart)!.push(p);
  }

  const results: WindowResult[] = [];
  let consensusCount = 0;
  let skippedCount = 0;

  for (const [wStart, preds] of byWindow) {
    const upCount = preds.filter(p => p.direction === 'UP').length;
    const downCount = preds.filter(p => p.direction === 'DOWN').length;
    const maxDir = upCount >= downCount ? 'UP' : 'DOWN';
    const maxCount = Math.max(upCount, downCount);

    if (maxCount < MIN_CONSENSUS) { skippedCount++; continue; }

    const consensusPreds = preds.filter(p => p.direction === maxDir);
    const wins = consensusPreds.filter(p => p.isCorrect).length;
    const losses = consensusPreds.length - wins;
    const pnl = consensusPreds.reduce((s, p) => s + (p.isCorrect ? BET * 0.82 : -BET), 0);
    // ~0.82 avg payout assumes ~0.55 avg odds (conservative)

    const context = computeContext(btcIndex, wStart);
    if (!context) continue;

    results.push({
      windowStart: wStart, direction: maxDir,
      consensusSize: consensusPreds.length,
      wins, losses, wr: wins / (wins + losses), pnl, context,
    });
    consensusCount++;
  }

  const totalTr = results.reduce((s, r) => s + r.wins + r.losses, 0);
  const totalW = results.reduce((s, r) => s + r.wins, 0);
  const totalPnl = results.reduce((s, r) => s + r.pnl, 0);

  console.log(`Consensus windows: ${consensusCount} | Skipped: ${skippedCount} (${(skippedCount / (consensusCount + skippedCount) * 100).toFixed(0)}% filtered)`);
  console.log(`\n=== SUMMARY ===`);
  console.log(`Trades: ${totalTr} | W: ${totalW} L: ${totalTr - totalW} | WR: ${(totalW / totalTr * 100).toFixed(1)}% | PnL: $${totalPnl.toFixed(0)}\n`);

  // 4. WIN vs LOSS windows
  const winW = results.filter(r => r.wins > r.losses);
  const lossW = results.filter(r => r.losses >= r.wins);

  console.log('=== WIN vs LOSS WINDOWS ===');
  for (const [label, group] of [['WIN', winW], ['LOSS', lossW]] as const) {
    if (group.length === 0) continue;
    const avg = (fn: (r: WindowResult) => number) => group.reduce((s, r) => s + fn(r), 0) / group.length;
    const tr = group.reduce((s, r) => s + r.wins + r.losses, 0);
    console.log(`\n--- ${label} (${group.length} windows, ${tr} trades, PnL $${group.reduce((s, r) => s + r.pnl, 0).toFixed(0)}) ---`);
    console.log(`  |roc5m|:    ${avg(r => r.context.absRoc5m).toFixed(3)}%`);
    console.log(`  |roc15m|:   ${avg(r => r.context.absRoc15m).toFixed(3)}%`);
    console.log(`  |roc30m|:   ${avg(r => r.context.absRoc30m).toFixed(3)}%`);
    console.log(`  volRatio:   ${avg(r => r.context.volRatio).toFixed(2)}`);
    console.log(`  ATR%:       ${avg(r => r.context.atr20).toFixed(4)}%`);
    console.log(`  choppiness: ${avg(r => r.context.choppiness).toFixed(1)} / 19`);
    console.log(`  range30m:   ${avg(r => r.context.range30m).toFixed(3)}%`);
    console.log(`  aligned:    ${group.filter(r => r.context.trendAlign).length}/${group.length} (${(group.filter(r => r.context.trendAlign).length / group.length * 100).toFixed(0)}%)`);
    console.log(`  bodyRatio:  ${avg(r => r.context.bodyRatio).toFixed(2)}`);
  }

  // 5. Bucket analysis
  console.log('\n\n=== BUCKET ANALYSIS ===');

  function bucket(label: string, keyFn: (r: WindowResult) => string) {
    const buckets = new Map<string, WindowResult[]>();
    for (const r of results) {
      const key = keyFn(r);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(r);
    }
    console.log(`\n--- ${label} ---`);
    for (const [b, group] of [...buckets.entries()].sort()) {
      const tr = group.reduce((s, r) => s + r.wins + r.losses, 0);
      const w = group.reduce((s, r) => s + r.wins, 0);
      const pnl = group.reduce((s, r) => s + r.pnl, 0);
      console.log(`  ${b.padEnd(24)} | ${String(group.length).padStart(4)} win | ${String(tr).padStart(5)} tr | ${String(w).padStart(4)}W ${String(tr - w).padStart(4)}L | WR ${(w / tr * 100).toFixed(0).padStart(3)}% | $${pnl.toFixed(0)}`);
    }
  }

  bucket('Trend strength (|roc5m|)', r => {
    const a = r.context.absRoc5m;
    if (a < 0.02) return '0. Flat (<0.02%)';
    if (a < 0.05) return '1. Weak (0.02-0.05%)';
    if (a < 0.10) return '2. Medium (0.05-0.10%)';
    return '3. Strong (>0.10%)';
  });

  bucket('Broader trend (|roc15m|)', r => {
    const a = r.context.absRoc15m;
    if (a < 0.05) return '0. Flat (<0.05%)';
    if (a < 0.10) return '1. Weak (0.05-0.10%)';
    if (a < 0.20) return '2. Medium (0.10-0.20%)';
    return '3. Strong (>0.20%)';
  });

  bucket('Volume regime', r => {
    const v = r.context.volRatio;
    if (v < 0.7) return '0. Low (<0.7x)';
    if (v < 1.0) return '1. Below avg (0.7-1x)';
    if (v < 1.5) return '2. Normal (1-1.5x)';
    if (v < 2.5) return '3. High (1.5-2.5x)';
    return '4. Spike (>2.5x)';
  });

  bucket('Volatility (ATR%)', r => {
    const a = r.context.atr20;
    if (a < 0.01) return '0. Dead (<0.01%)';
    if (a < 0.02) return '1. Low (0.01-0.02%)';
    if (a < 0.04) return '2. Normal (0.02-0.04%)';
    return '3. High (>0.04%)';
  });

  bucket('Choppiness', r => {
    const ch = r.context.choppiness;
    if (ch <= 8) return '0. Trending (<=8)';
    if (ch <= 12) return '1. Mixed (9-12)';
    return '2. Choppy (13+)';
  });

  bucket('Trend alignment', r => r.context.trendAlign ? 'Aligned' : 'Divergent');

  bucket('Body ratio', r => {
    const b = r.context.bodyRatio;
    if (b < 0.3) return '0. Wicky (<0.3)';
    if (b < 0.5) return '1. Mixed (0.3-0.5)';
    return '2. Clean (>0.5)';
  });

  // 6. Combined conditions
  console.log('\n\n=== COMBINED CONDITIONS ===');

  function combined(label: string, fn: (r: WindowResult) => boolean) {
    const pass = results.filter(fn);
    const fail = results.filter(r => !fn(r));
    for (const [lbl, group] of [['PASS', pass], ['FAIL', fail]] as const) {
      if (group.length === 0) continue;
      const tr = group.reduce((s, r) => s + r.wins + r.losses, 0);
      const w = group.reduce((s, r) => s + r.wins, 0);
      const pnl = group.reduce((s, r) => s + r.pnl, 0);
      console.log(`  ${label.padEnd(35)} ${lbl.padEnd(4)}: ${String(group.length).padStart(4)} win | ${String(tr).padStart(5)} tr | WR ${(w / tr * 100).toFixed(1).padStart(5)}% | $${pnl.toFixed(0)}`);
    }
  }

  combined('Strong trend (|roc5m| > 0.05%)', r => r.context.absRoc5m > 0.05);
  combined('Low volume (volR < 0.7)', r => r.context.volRatio < 0.7);
  combined('Not high vol (volR < 1.5)', r => r.context.volRatio < 1.5);
  combined('Low choppiness (<=10)', r => r.context.choppiness <= 10);
  combined('Trend aligned', r => r.context.trendAlign);
  combined('Trend divergent', r => !r.context.trendAlign);
  combined('Body > 0.5 (clean candles)', r => r.context.bodyRatio > 0.5);
  combined('ATR > 0.03%', r => r.context.atr20 > 0.03);
  combined('Range > 0.5%', r => r.context.range30m > 0.5);
  combined('Low vol + clean body', r => r.context.volRatio < 1.0 && r.context.bodyRatio > 0.5);
  combined('Divergent + clean body', r => !r.context.trendAlign && r.context.bodyRatio > 0.5);
  combined('Not choppy + strong', r => r.context.choppiness <= 10 && r.context.absRoc5m > 0.05);
  combined('Vol spike (>2.5x)', r => r.context.volRatio > 2.5);

  // 7. Prediction vs market direction
  console.log('\n\n=== PRED vs MARKET ===');
  combined('Pred WITH roc5m', r => {
    return (r.direction === 'UP' && r.context.roc5m > 0) || (r.direction === 'DOWN' && r.context.roc5m < 0);
  });
  combined('Pred AGAINST roc5m', r => {
    return (r.direction === 'UP' && r.context.roc5m < -0.02) || (r.direction === 'DOWN' && r.context.roc5m > 0.02);
  });
  combined('Pred WITH roc15m', r => {
    return (r.direction === 'UP' && r.context.roc15m > 0) || (r.direction === 'DOWN' && r.context.roc15m < 0);
  });
  combined('Pred AGAINST roc15m', r => {
    return (r.direction === 'UP' && r.context.roc15m < -0.03) || (r.direction === 'DOWN' && r.context.roc15m > 0.03);
  });

  // 8. Hour breakdown
  console.log('\n\n=== PAR HEURE ===');
  const hourStats: Record<number, { w: number; l: number; pnl: number }> = {};
  for (const r of results) {
    const h = new Date(r.windowStart).getUTCHours();
    if (!hourStats[h]) hourStats[h] = { w: 0, l: 0, pnl: 0 };
    hourStats[h].w += r.wins;
    hourStats[h].l += r.losses;
    hourStats[h].pnl += r.pnl;
  }
  for (let h = 0; h < 24; h++) {
    const s = hourStats[h];
    if (!s) continue;
    const t = s.w + s.l;
    console.log(`${String(h).padStart(2)}h | ${String(t).padStart(4)} tr | ${s.w}W ${s.l}L | WR ${(s.w / t * 100).toFixed(0).padStart(3)}% | $${s.pnl.toFixed(0)}`);
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
