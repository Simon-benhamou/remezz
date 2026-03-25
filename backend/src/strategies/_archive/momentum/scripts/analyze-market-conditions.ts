/**
 * Analyze Polymarket prediction performance vs BTC market conditions.
 *
 * Works on ALL prediction rows (signal + virtual). Retroactively simulates
 * consensus filter (3+ symbols same direction) on historical data.
 *
 * For each consensus window, computes BTC market context from 1m candles:
 * - Trend strength (ROC 5m, 15m, 30m)
 * - Volume regime (current vs rolling avg)
 * - Volatility (ATR of recent 1m candles)
 * - Choppiness (direction changes in recent candles)
 * - Range (high-low spread over last 30 min)
 *
 * Usage: npx tsx scripts/analyze-market-conditions.ts [--days 30] [--since 2026-01-24T00:00:00Z]
 */

import { PrismaClient } from '@prisma/client';
import ccxt from 'ccxt';

const prisma = new PrismaClient();
const MIN_CONSENSUS = 3;

// ── Types ──────────────────────────────────────────────────────────────
interface Candle1m {
  timestamp: number;
  open: number;
  high: number;
  close: number;
  low: number;
  volume: number;
}

interface MarketContext {
  roc5m: number;
  roc15m: number;
  roc30m: number;
  absRoc5m: number;
  absRoc15m: number;
  absRoc30m: number;
  volRatio: number;    // Volume last 5m / avg last 30m
  atr20: number;       // ATR% of last 20 1m candles
  choppiness: number;  // Direction changes in last 20 candles (0-19)
  range30m: number;    // (high-low)/mid over 30 min (%)
  trendAlign: boolean; // 5m and 15m ROC same sign
  bodyRatio: number;   // Avg body/range of last 10 candles
}

interface WindowResult {
  windowStart: string;
  symbols: string[];
  direction: string;
  consensusSize: number;
  wins: number;
  losses: number;
  wr: number;
  pnl: number;
  avgClob: number;
  context: MarketContext;
}

// ── Fetch BTC 1m candles from Binance ──────────────────────────────────
async function fetchBtc1mCandles(exchange: ccxt.Exchange, since: number, until: number): Promise<Candle1m[]> {
  const all: Candle1m[] = [];
  let cursor = since;
  const limit = 1000;

  while (cursor < until) {
    const raw = await exchange.fetchOHLCV('BTC/USDT', '1m', cursor, limit);
    if (raw.length === 0) break;

    for (const [ts, o, h, l, c, v] of raw) {
      all.push({ timestamp: ts as number, open: o as number, high: h as number, low: l as number, close: c as number, volume: v as number });
    }

    const lastTs = raw[raw.length - 1][0] as number;
    cursor = lastTs + 60_000;
    if (raw.length < limit) break;

    if (all.length % 10_000 < limit) {
      process.stdout.write(`  ${all.length} candles...\r`);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  return all.sort((a, b) => a.timestamp - b.timestamp);
}

// ── Compute market context at a given timestamp ───────────────────────
function computeContext(candles: Candle1m[], atTs: number): MarketContext | null {
  const before = candles.filter(c => c.timestamp < atTs);
  if (before.length < 30) return null;

  const last = before[before.length - 1];
  const last5 = before.slice(-5);
  const last10 = before.slice(-10);
  const last15 = before.slice(-15);
  const last20 = before.slice(-20);
  const last30 = before.slice(-30);

  const roc5m = (last.close - last5[0].open) / last5[0].open * 100;
  const roc15m = (last.close - last15[0].open) / last15[0].open * 100;
  const roc30m = (last.close - last30[0].open) / last30[0].open * 100;

  const vol5 = last5.reduce((s, c) => s + c.volume, 0) / 5;
  const vol30 = last30.reduce((s, c) => s + c.volume, 0) / 30;
  const volRatio = vol30 > 0 ? vol5 / vol30 : 1;

  let atrSum = 0;
  for (let i = 1; i < last20.length; i++) {
    const tr = Math.max(
      last20[i].high - last20[i].low,
      Math.abs(last20[i].high - last20[i - 1].close),
      Math.abs(last20[i].low - last20[i - 1].close)
    );
    atrSum += tr;
  }
  const atr = atrSum / (last20.length - 1);
  const atr20 = (atr / last.close) * 100;

  let changes = 0;
  for (let i = 1; i < last20.length; i++) {
    const prevDir = last20[i - 1].close > last20[i - 1].open ? 1 : -1;
    const currDir = last20[i].close > last20[i].open ? 1 : -1;
    if (prevDir !== currDir) changes++;
  }

  const high30 = Math.max(...last30.map(c => c.high));
  const low30 = Math.min(...last30.map(c => c.low));
  const mid30 = (high30 + low30) / 2;
  const range30m = mid30 > 0 ? (high30 - low30) / mid30 * 100 : 0;

  const trendAlign = Math.sign(roc5m) === Math.sign(roc15m) && roc5m !== 0;

  const bodyRatio = last10.reduce((s, c) => {
    const range = c.high - c.low;
    if (range === 0) return s;
    return s + Math.abs(c.close - c.open) / range;
  }, 0) / last10.length;

  return {
    roc5m, roc15m, roc30m,
    absRoc5m: Math.abs(roc5m), absRoc15m: Math.abs(roc15m), absRoc30m: Math.abs(roc30m),
    volRatio, atr20, choppiness: changes, range30m, trendAlign, bodyRatio,
  };
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf('--since');
  const daysIdx = args.indexOf('--days');

  let since: Date;
  if (sinceIdx >= 0) {
    since = new Date(args[sinceIdx + 1]);
  } else if (daysIdx >= 0) {
    since = new Date(Date.now() - parseInt(args[daysIdx + 1]) * 86400_000);
  } else {
    since = new Date(Date.now() - 86400_000);
  }

  console.log(`\n📊 Polymarket Market Condition Analysis`);
  console.log(`Since: ${since.toISOString()}\n`);

  // ── 1. Get ALL predictions with direction from DB ───────────────────
  // Use signal rows (userId=null, no executionPrice) — one per symbol per window
  // These exist for the full history, not just since V5.125
  const allPreds = await prisma.polymarketPrediction.findMany({
    where: {
      windowStart: { gte: since },
      prediction: { not: null },
      isCorrect: { not: null },
      userId: null,             // shared signal rows
      executionPrice: null,     // signal (not virtual duplicate)
    },
    orderBy: { windowStart: 'asc' },
  });

  if (allPreds.length === 0) {
    console.log('No verified predictions found in this period.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${allPreds.length} verified signal predictions`);

  // ── 2. Group by window, retroactively apply consensus filter ───────
  const byWindowAll = new Map<string, typeof allPreds>();
  for (const p of allPreds) {
    const key = p.windowStart.toISOString();
    if (!byWindowAll.has(key)) byWindowAll.set(key, []);
    byWindowAll.get(key)!.push(p);
  }

  // Apply consensus: only keep windows where 3+ symbols predict same direction
  const byWindow = new Map<string, typeof allPreds>();
  let totalWindows = byWindowAll.size;
  let consensusWindows = 0;
  let noConsensusWindows = 0;

  for (const [ws, windowPreds] of byWindowAll) {
    const upCount = windowPreds.filter(p => p.prediction === 'UP').length;
    const downCount = windowPreds.filter(p => p.prediction === 'DOWN').length;
    const maxDir = upCount >= downCount ? 'UP' : 'DOWN';
    const maxCount = Math.max(upCount, downCount);

    if (maxCount >= MIN_CONSENSUS) {
      // Keep only consensus-direction predictions
      const consensusPreds = windowPreds.filter(p => p.prediction === maxDir);
      byWindow.set(ws, consensusPreds);
      consensusWindows++;
    } else {
      noConsensusWindows++;
    }
  }

  const consensusPreds = [...byWindow.values()].flat();
  console.log(`Total windows: ${totalWindows} | Consensus (${MIN_CONSENSUS}+): ${consensusWindows} | Skipped: ${noConsensusWindows} (${(noConsensusWindows / totalWindows * 100).toFixed(0)}% filtered)`);
  console.log(`Consensus predictions: ${consensusPreds.length}\n`);

  // ── 3. Fetch BTC 1m candles ────────────────────────────────────────
  const firstWindow = consensusPreds[0].windowStart.getTime();
  const lastWindow = consensusPreds[consensusPreds.length - 1].windowStart.getTime();
  const fetchSince = firstWindow - 35 * 60_000;
  const fetchUntil = lastWindow + 10 * 60_000;

  const totalDays = (fetchUntil - fetchSince) / 86400_000;
  console.log(`Fetching BTC 1m candles from Binance (${totalDays.toFixed(1)} days)...`);
  const exchange = new ccxt.binance({ enableRateLimit: true });
  const btcCandles = await fetchBtc1mCandles(exchange, fetchSince, fetchUntil);
  console.log(`Got ${btcCandles.length} BTC 1m candles\n`);

  // ── 4. Compute market context per window ───────────────────────────
  const results: WindowResult[] = [];
  const BET = 5; // $5 per bet

  for (const [ws, trades] of byWindow) {
    const windowTs = new Date(ws).getTime();
    const context = computeContext(btcCandles, windowTs);
    if (!context) continue;

    const wins = trades.filter(t => t.isCorrect === true).length;
    const losses = trades.length - wins;

    // PnL: use entryOdds (Gamma odds ~0.50) for signal rows
    // This simulates buying at Gamma odds, which is the "ideal" PnL
    // For real PnL, we'd need CLOB prices which only exist recently
    const pnl = trades.reduce((s, t) => {
      const odds = t.entryOdds || 0.50;
      return s + (t.isCorrect ? BET * (1 - odds) / odds : -BET);
    }, 0);
    const avgOdds = trades.reduce((s, t) => s + (t.entryOdds || 0.50), 0) / trades.length;
    const direction = trades[0].prediction || '?';
    const symbols = [...new Set(trades.map(t => t.symbol || 'BTC'))];

    results.push({
      windowStart: ws, symbols, direction,
      consensusSize: trades.length,
      wins, losses,
      wr: wins / (wins + losses),
      pnl, avgClob: avgOdds, context,
    });
  }

  if (results.length === 0) {
    console.log('No windows with market context computed.');
    await prisma.$disconnect();
    return;
  }

  // Summary
  const totalTr = results.reduce((s, r) => s + r.wins + r.losses, 0);
  const totalW = results.reduce((s, r) => s + r.wins, 0);
  const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
  console.log(`=== SUMMARY ===`);
  console.log(`Windows: ${results.length} | Trades: ${totalTr} | W: ${totalW} L: ${totalTr - totalW} | WR: ${(totalW / totalTr * 100).toFixed(1)}% | PnL: $${totalPnl.toFixed(2)}\n`);

  // ── 5. Detailed window view (skip if >50 windows) ──────────────────
  if (results.length <= 50) {
    console.log('=== DETAIL PAR FENÊTRE ===');
    console.log('Time  | W/L  | PnL     | Dir  | roc5m   | roc15m  | volR | atr%   | chop | range  | align | body | cumPnL');
    console.log('-'.repeat(120));

    let cumPnl2 = 0;
    for (const r of results) {
      cumPnl2 += r.pnl;
      const time = r.windowStart.substring(11, 16);
      const wl = `${r.wins}W${r.losses}L`;
      const c = r.context;
      console.log(
        `${time} | ${wl.padEnd(4)} | $${r.pnl.toFixed(1).padStart(6)} | ${r.direction.padEnd(4)} | ` +
        `${c.roc5m.toFixed(3).padStart(7)}% | ${c.roc15m.toFixed(3).padStart(7)}% | ` +
        `${c.volRatio.toFixed(1).padStart(4)} | ${c.atr20.toFixed(3).padStart(6)}% | ` +
        `${String(c.choppiness).padStart(4)} | ${c.range30m.toFixed(2).padStart(6)}% | ` +
        `${c.trendAlign ? 'YES' : 'NO '} | ${c.bodyRatio.toFixed(2)} | $${cumPnl2.toFixed(1)}`
      );
    }
  } else {
    console.log(`(Skipping per-window detail — ${results.length} windows too many)`);
  }

  // ── 5. Split into WIN vs LOSS windows ──────────────────────────────
  const winWindows = results.filter(r => r.wins > r.losses);
  const lossWindows = results.filter(r => r.losses >= r.wins);

  console.log('\n\n=== WIN WINDOWS vs LOSS WINDOWS ===');

  for (const [label, group] of [['WIN windows', winWindows], ['LOSS windows', lossWindows]] as const) {
    if (group.length === 0) { console.log(`\n${label}: none`); continue; }

    const avg = (fn: (r: WindowResult) => number) => group.reduce((s, r) => s + fn(r), 0) / group.length;

    console.log(`\n--- ${label} (${group.length} windows, ${group.reduce((s, r) => s + r.wins + r.losses, 0)} trades) ---`);
    console.log(`  Total PnL:      $${group.reduce((s, r) => s + r.pnl, 0).toFixed(2)}`);
    console.log(`  Avg |roc5m|:    ${avg(r => r.context.absRoc5m).toFixed(3)}%`);
    console.log(`  Avg |roc15m|:   ${avg(r => r.context.absRoc15m).toFixed(3)}%`);
    console.log(`  Avg |roc30m|:   ${avg(r => r.context.absRoc30m).toFixed(3)}%`);
    console.log(`  Avg volRatio:   ${avg(r => r.context.volRatio).toFixed(2)}`);
    console.log(`  Avg ATR%:       ${avg(r => r.context.atr20).toFixed(4)}%`);
    console.log(`  Avg choppiness: ${avg(r => r.context.choppiness).toFixed(1)} / 19`);
    console.log(`  Avg range30m:   ${avg(r => r.context.range30m).toFixed(3)}%`);
    console.log(`  Trend aligned:  ${group.filter(r => r.context.trendAlign).length}/${group.length} (${(group.filter(r => r.context.trendAlign).length / group.length * 100).toFixed(0)}%)`);
    console.log(`  Avg bodyRatio:  ${avg(r => r.context.bodyRatio).toFixed(2)}`);
    console.log(`  Avg Gamma odds: ${avg(r => r.avgClob).toFixed(3)}`);
  }

  // ── 6. Bucket analysis ─────────────────────────────────────────────
  console.log('\n\n=== BUCKET ANALYSIS ===');

  function bucketAnalysis(label: string, keyFn: (r: WindowResult) => string) {
    const buckets = new Map<string, WindowResult[]>();
    for (const r of results) {
      const key = keyFn(r);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(r);
    }

    console.log(`\n--- ${label} ---`);
    for (const [bucket, group] of [...buckets.entries()].sort()) {
      const totalTrades = group.reduce((s, r) => s + r.wins + r.losses, 0);
      const totalWins = group.reduce((s, r) => s + r.wins, 0);
      const totalPnl = group.reduce((s, r) => s + r.pnl, 0);
      const wr = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(0) : '?';
      console.log(
        `  ${bucket.padEnd(24)} | ${String(group.length).padStart(2)} win | ${String(totalTrades).padStart(3)} trades | ` +
        `${String(totalWins).padStart(2)}W ${String(totalTrades - totalWins).padStart(2)}L | WR ${wr.padStart(3)}% | PnL $${totalPnl.toFixed(2)}`
      );
    }
  }

  bucketAnalysis('Trend strength (|roc5m|)', r => {
    const abs = r.context.absRoc5m;
    if (abs < 0.02) return '0. Flat (<0.02%)';
    if (abs < 0.05) return '1. Weak (0.02-0.05%)';
    if (abs < 0.10) return '2. Medium (0.05-0.10%)';
    return '3. Strong (>0.10%)';
  });

  bucketAnalysis('Broader trend (|roc15m|)', r => {
    const abs = r.context.absRoc15m;
    if (abs < 0.05) return '0. Flat (<0.05%)';
    if (abs < 0.10) return '1. Weak (0.05-0.10%)';
    if (abs < 0.20) return '2. Medium (0.10-0.20%)';
    return '3. Strong (>0.20%)';
  });

  bucketAnalysis('Volume regime', r => {
    const v = r.context.volRatio;
    if (v < 0.7) return '0. Low (<0.7x)';
    if (v < 1.0) return '1. Below avg (0.7-1x)';
    if (v < 1.5) return '2. Normal (1-1.5x)';
    if (v < 2.5) return '3. High (1.5-2.5x)';
    return '4. Spike (>2.5x)';
  });

  bucketAnalysis('Volatility (ATR%)', r => {
    const a = r.context.atr20;
    if (a < 0.01) return '0. Dead (<0.01%)';
    if (a < 0.02) return '1. Low (0.01-0.02%)';
    if (a < 0.04) return '2. Normal (0.02-0.04%)';
    return '3. High (>0.04%)';
  });

  bucketAnalysis('Choppiness (dir changes/20)', r => {
    const ch = r.context.choppiness;
    if (ch <= 8) return '0. Trending (<=8)';
    if (ch <= 12) return '1. Mixed (9-12)';
    return '2. Choppy (13+)';
  });

  bucketAnalysis('Trend alignment (5m vs 15m)', r => r.context.trendAlign ? 'Aligned' : 'Divergent');

  bucketAnalysis('Body ratio (conviction)', r => {
    const b = r.context.bodyRatio;
    if (b < 0.3) return '0. Wick-heavy (<0.3)';
    if (b < 0.5) return '1. Mixed (0.3-0.5)';
    return '2. Clean bodies (>0.5)';
  });

  bucketAnalysis('Gamma entry odds', r => {
    const c = r.avgClob;
    if (c < 0.49) return '0. Reverse (<0.49)';
    if (c < 0.51) return '1. Coin flip (0.49-0.51)';
    if (c < 0.55) return '2. Slight edge (0.51-0.55)';
    return '3. Strong edge (>0.55)';
  });

  // ── 7. Combined conditions ─────────────────────────────────────────
  console.log('\n\n=== COMBINED CONDITIONS ===');

  function combinedAnalysis(label: string, filterFn: (r: WindowResult) => boolean) {
    const pass = results.filter(filterFn);
    const fail = results.filter(r => !filterFn(r));

    for (const [lbl, group] of [['PASS', pass], ['FAIL', fail]] as const) {
      if (group.length === 0) continue;
      const totalTrades = group.reduce((s, r) => s + r.wins + r.losses, 0);
      const totalWins = group.reduce((s, r) => s + r.wins, 0);
      const totalPnl = group.reduce((s, r) => s + r.pnl, 0);
      const wr = (totalWins / totalTrades * 100).toFixed(1);
      console.log(
        `  ${label.padEnd(35)} ${lbl.padEnd(4)}: ${String(group.length).padStart(2)} win | ` +
        `${String(totalTrades).padStart(3)} trades | ${String(totalWins).padStart(2)}W ${String(totalTrades - totalWins).padStart(2)}L | ` +
        `WR ${wr.padStart(5)}% | PnL $${totalPnl.toFixed(2)}`
      );
    }
  }

  combinedAnalysis('Strong trend (|roc5m| > 0.05%)', r => r.context.absRoc5m > 0.05);
  combinedAnalysis('High volume (volR > 1.5)', r => r.context.volRatio > 1.5);
  combinedAnalysis('Low choppiness (<=10)', r => r.context.choppiness <= 10);
  combinedAnalysis('Trend aligned + strong roc5m', r => r.context.trendAlign && r.context.absRoc5m > 0.05);
  combinedAnalysis('Trend aligned + vol > 1.2', r => r.context.trendAlign && r.context.volRatio > 1.2);
  combinedAnalysis('ATR > 0.02% + aligned', r => r.context.atr20 > 0.02 && r.context.trendAlign);
  combinedAnalysis('Odds < 0.52 (near coin-flip)', r => r.avgClob < 0.52);
  combinedAnalysis('Strong+Aligned+NotChoppy', r =>
    r.context.absRoc5m > 0.05 && r.context.trendAlign && r.context.choppiness <= 12);
  combinedAnalysis('Body > 0.4 + Aligned', r => r.context.bodyRatio > 0.4 && r.context.trendAlign);

  // ── 8. Prediction direction vs market ──────────────────────────────
  console.log('\n\n=== PREDICTION vs MARKET DIRECTION ===');

  combinedAnalysis('Pred aligned with roc5m', r => {
    if (r.direction === 'UP') return r.context.roc5m > 0;
    if (r.direction === 'DOWN') return r.context.roc5m < 0;
    return false;
  });

  combinedAnalysis('Pred aligned with roc15m', r => {
    if (r.direction === 'UP') return r.context.roc15m > 0;
    if (r.direction === 'DOWN') return r.context.roc15m < 0;
    return false;
  });

  combinedAnalysis('Pred AGAINST roc15m (reversal)', r => {
    if (r.direction === 'UP') return r.context.roc15m < -0.02;
    if (r.direction === 'DOWN') return r.context.roc15m > 0.02;
    return false;
  });

  console.log('\nDone.');
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
