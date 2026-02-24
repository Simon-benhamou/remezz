/**
 * Backtest the 5-minute BTC prediction system on historical 1m candles.
 * Replays computeFiveMinScore on every 5-min window and checks actual outcome.
 *
 * Usage:
 *   npx tsx scripts/backtest-polymarket-5m.ts                  # last 7 days
 *   npx tsx scripts/backtest-polymarket-5m.ts --days 30        # last 30 days
 *   npx tsx scripts/backtest-polymarket-5m.ts --days 14 --bet 5
 */
import { computeFiveMinScore } from '../src/services/polymarket/fiveMinScorer.js';
import { getMaxPriceForScore, CLOB_PRICE_TIERS } from '../src/services/polymarket/polymarketTrader.js';
import type { Candle1m } from '../src/services/polymarket/polymarketTypes.js';

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name: string, def: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
}
const SYMBOL_SHORT = getArg('symbol', 'BTC').toUpperCase();
const DAYS = parseInt(getArg('days', '7'));
const BET_AMOUNT = parseFloat(getArg('bet', '5'));
const PRE_WINDOW_COUNT = 20; // number of pre-window 1m candles for context
const DECISION_MINUTE = 1;  // T+1min (2 candles: :00, :01) — matches live DECISION_OFFSET_MS = 1min

// ── Fetch 1m candles from Binance ────────────────────────────────────────────
async function fetchCandles1m(startMs: number, endMs: number): Promise<Candle1m[]> {
  const candles: Candle1m[] = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL_SHORT}USDT&interval=1m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any[];
    if (data.length === 0) break;

    for (const k of data) {
      candles.push({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        isFinal: true,
      });
    }

    cursor = data[data.length - 1][0] + 60_000; // next minute
    // Rate limit: 1200 weight/min, klines = 2 weight
    await new Promise((r) => setTimeout(r, 100));
  }

  return candles;
}

// ── Main ─────────────────────────────────────────────────────────────────────
interface WindowResult {
  windowStart: number;
  score: number;
  direction: 'UP' | 'DOWN';
  actualResult: 'UP' | 'DOWN';
  isCorrect: boolean;
  startPrice: number;
  endPrice: number;
}

async function main() {
  const endMs = Date.now();
  const startMs = endMs - DAYS * 24 * 60 * 60 * 1000;

  console.log(`\n🔄 Fetching ${DAYS} days of 1m ${SYMBOL_SHORT} candles from Binance...`);
  const allCandles = await fetchCandles1m(startMs, endMs);
  console.log(`   Got ${allCandles.length} candles (${(allCandles.length / 1440).toFixed(1)} days)\n`);

  // Index candles by timestamp for O(1) lookup
  const byTs = new Map<number, Candle1m>();
  for (const c of allCandles) byTs.set(c.timestamp, c);

  // Iterate over 5-min windows
  const FIVE_MIN = 5 * 60_000;
  const ONE_MIN = 60_000;

  // Align to 5-min boundary
  const firstWindow = Math.ceil(allCandles[0].timestamp / FIVE_MIN) * FIVE_MIN + PRE_WINDOW_COUNT * ONE_MIN;
  const lastWindow = Math.floor(allCandles[allCandles.length - 1].timestamp / FIVE_MIN) * FIVE_MIN - FIVE_MIN;

  const results: WindowResult[] = [];
  let skippedLowScore = 0;
  let skippedNoData = 0;

  for (let ws = firstWindow; ws <= lastWindow; ws += FIVE_MIN) {
    // Gather window candles (first DECISION_MINUTE+1 candles: T+0, T+1, T+2)
    const windowCandles: Candle1m[] = [];
    for (let i = 0; i <= DECISION_MINUTE; i++) {
      const c = byTs.get(ws + i * ONE_MIN);
      if (c) windowCandles.push(c);
    }
    if (windowCandles.length < 2) {
      skippedNoData++;
      continue;
    }

    // Gather pre-window candles
    const preWindowCandles: Candle1m[] = [];
    for (let i = PRE_WINDOW_COUNT; i >= 1; i--) {
      const c = byTs.get(ws - i * ONE_MIN);
      if (c) preWindowCandles.push(c);
    }

    const windowOpenPrice = windowCandles[0].open;

    // Run scorer
    const prediction = computeFiveMinScore(windowCandles, preWindowCandles, windowOpenPrice);
    if (!prediction) {
      skippedLowScore++;
      continue;
    }

    // Get actual result: compare open of first candle with close of last candle in window
    const endCandle = byTs.get(ws + 4 * ONE_MIN); // T+4 (the 5th candle, closes at T+5)
    if (!endCandle) {
      skippedNoData++;
      continue;
    }
    const endPrice = endCandle.close;
    const actualResult: 'UP' | 'DOWN' = endPrice >= windowOpenPrice ? 'UP' : 'DOWN';

    results.push({
      windowStart: ws,
      score: prediction.confidence,
      direction: prediction.direction,
      actualResult,
      isCorrect: prediction.direction === actualResult,
      startPrice: windowOpenPrice,
      endPrice,
    });
  }

  // ── Analysis ─────────────────────────────────────────────────────────────
  const totalWindows = results.length + skippedLowScore + skippedNoData;
  console.log(`📊 Backtest Results — ${DAYS} days, ${totalWindows} total 5-min windows\n`);
  console.log(`   Predictions made: ${results.length} (${((results.length / totalWindows) * 100).toFixed(1)}%)`);
  console.log(`   Skipped (score < 40): ${skippedLowScore}`);
  console.log(`   Skipped (missing data): ${skippedNoData}\n`);

  // By tier
  const tiers = [
    { name: 'High', range: '60+', min: 60, max: 101, cap: 0.73 },
    { name: 'Mid', range: '50-59', min: 50, max: 60, cap: 0.75 },
    { name: 'Low', range: '40-49', min: 40, max: 50, cap: 0.54 },
  ];

  console.log('┌─────────┬────────────┬───────┬──────┬────────┬──────────────┬──────────────────────────────────────┐');
  console.log('│ Tier    │ Score      │ Count │ W/L  │ WR%    │ Breakeven    │ Simulated PnL ($5/trade @ Gamma 0.50)│');
  console.log('├─────────┼────────────┼───────┼──────┼────────┼──────────────┼──────────────────────────────────────┤');

  let totalWins = 0;
  let totalLosses = 0;

  for (const tier of tiers) {
    const tierResults = results.filter((r) => r.score >= tier.min && r.score < tier.max);
    const wins = tierResults.filter((r) => r.isCorrect).length;
    const losses = tierResults.length - wins;
    const wr = tierResults.length > 0 ? (wins / tierResults.length) * 100 : 0;
    const breakeven = wr / 100;

    totalWins += wins;
    totalLosses += losses;

    // Simulated PnL at Gamma ~0.50 (since most odds are near 50/50)
    const simPnl = wins * BET_AMOUNT * (1 - 0.50) / 0.50 - losses * BET_AMOUNT;
    const pnlStr = simPnl >= 0 ? `+$${simPnl.toFixed(0)}` : `-$${Math.abs(simPnl).toFixed(0)}`;

    console.log(
      `│ ${tier.name.padEnd(7)} │ ${tier.range.padEnd(10)} │ ${String(tierResults.length).padStart(5)} │ ${String(wins).padStart(2)}/${String(losses).padStart(2)} │ ${wr.toFixed(1).padStart(5)}% │ ${breakeven.toFixed(3).padStart(12)} │ ${pnlStr.padStart(36)} │`,
    );
  }

  console.log('└─────────┴────────────┴───────┴──────┴────────┴──────────────┴──────────────────────────────────────┘');

  const overallWR = results.length > 0 ? (totalWins / results.length) * 100 : 0;
  console.log(`\n📈 Overall: ${totalWins}W / ${totalLosses}L = ${overallWR.toFixed(1)}% WR (${results.length} predictions)`);
  console.log(`   Breakeven CLOB price: ${(overallWR / 100).toFixed(3)}`);

  // ── PnL simulation: Main only vs Main + Hedge ──────────────────────────────
  const HEDGE_AMOUNT = parseFloat(getArg('hedge', '1'));

  console.log(`\n💰 Simulated PnL — Main $${BET_AMOUNT} + Hedge $${HEDGE_AMOUNT} at different CLOB prices:`);
  console.log('   (Hedge buys opposite token at ~(1-P). Placed if (1-P) < 0.54)');
  console.log('   CLOB Price │ Main only  │ Main+Hedge │ Hedge cost │ Status');
  console.log('   ───────────┼────────────┼────────────┼────────────┼──────────');

  const wr = overallWR / 100;
  for (const price of [0.50, 0.54, 0.58, 0.63, 0.68, 0.73, 0.75, 0.80, 0.83, 0.85, 0.90]) {
    const hedgePrice = 1 - price; // opposite token ≈ 1 - main price
    const hedgePlaced = hedgePrice <= 0.54; // MAX_CLOB_PRICE for hedge

    // Main only
    const mainWinProfit = BET_AMOUNT * (1 - price) / price;
    const mainEv = wr * mainWinProfit + (1 - wr) * (-BET_AMOUNT);

    // Main + Hedge
    let hedgeEv = 0;
    if (hedgePlaced) {
      // WIN main → hedge loses: -HEDGE_AMOUNT
      // LOSE main → hedge wins: +HEDGE_AMOUNT × (1-hedgePrice)/hedgePrice = +HEDGE_AMOUNT × price/(1-price)
      const hedgeWinProfit = HEDGE_AMOUNT * price / (1 - price);
      hedgeEv = wr * (-HEDGE_AMOUNT) + (1 - wr) * hedgeWinProfit;
    }

    const combinedEv = mainEv + hedgeEv;
    const mainTotal = mainEv * results.length;
    const combinedTotal = combinedEv * results.length;
    const hedgeTotal = hedgeEv * results.length;

    const mainStr = mainTotal >= 0 ? `+$${mainTotal.toFixed(0)}` : `-$${Math.abs(mainTotal).toFixed(0)}`;
    const combStr = combinedTotal >= 0 ? `+$${combinedTotal.toFixed(0)}` : `-$${Math.abs(combinedTotal).toFixed(0)}`;
    const hedgeStr = hedgePlaced ? (hedgeTotal >= 0 ? `+$${hedgeTotal.toFixed(0)}` : `-$${Math.abs(hedgeTotal).toFixed(0)}`) : 'no hedge';
    const marker = combinedEv >= 0 ? '✅' : '❌';
    console.log(`      ${price.toFixed(2)}    │ ${mainStr.padStart(10)} │ ${combStr.padStart(10)} │ ${hedgeStr.padStart(10)} │ ${marker}`);
  }

  // ── By direction ──────────────────────────────────────────────────────────
  console.log('\n📊 By direction:');
  for (const dir of ['UP', 'DOWN'] as const) {
    const dirResults = results.filter((r) => r.direction === dir);
    const wins = dirResults.filter((r) => r.isCorrect).length;
    const wr = dirResults.length > 0 ? (wins / dirResults.length) * 100 : 0;
    console.log(`   ${dir}: ${wins}W / ${dirResults.length - wins}L = ${wr.toFixed(1)}% WR (${dirResults.length} predictions)`);
  }

  // ── By hour of day ────────────────────────────────────────────────────────
  console.log('\n📊 Win rate by hour (UTC):');
  const byHour = new Map<number, { wins: number; total: number }>();
  for (const r of results) {
    const hour = new Date(r.windowStart).getUTCHours();
    const h = byHour.get(hour) ?? { wins: 0, total: 0 };
    h.total++;
    if (r.isCorrect) h.wins++;
    byHour.set(hour, h);
  }
  const sortedHours = [...byHour.entries()].sort((a, b) => a[0] - b[0]);
  for (const [hour, stats] of sortedHours) {
    const wr = (stats.wins / stats.total) * 100;
    const bar = '█'.repeat(Math.round(wr / 5));
    console.log(`   ${String(hour).padStart(2)}:00 │ ${wr.toFixed(0).padStart(3)}% │ ${String(stats.total).padStart(3)} trades │ ${bar}`);
  }

  // ── Daily breakdown ───────────────────────────────────────────────────────
  console.log('\n📊 Daily breakdown:');
  const byDay = new Map<string, { wins: number; total: number }>();
  for (const r of results) {
    const day = new Date(r.windowStart).toISOString().slice(0, 10);
    const d = byDay.get(day) ?? { wins: 0, total: 0 };
    d.total++;
    if (r.isCorrect) d.wins++;
    byDay.set(day, d);
  }
  for (const [day, stats] of [...byDay.entries()].sort()) {
    const wr = (stats.wins / stats.total) * 100;
    console.log(`   ${day} │ ${stats.wins}W/${stats.total - stats.wins}L = ${wr.toFixed(0)}% WR (${stats.total} predictions)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
