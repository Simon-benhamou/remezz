/**
 * backtest-polymarket-ev.ts — Realistic Polymarket backtest with calibrated CLOB model + market filters
 *
 * Usage:
 *   npx tsx scripts/backtest-polymarket-ev.ts --days 30
 *   npx tsx scripts/backtest-polymarket-ev.ts --days 60
 *   npx tsx scripts/backtest-polymarket-ev.ts --start 2025-09-01 --end 2025-11-01
 *   npx tsx scripts/backtest-polymarket-ev.ts --days 30 --bet 5
 */

import { computeFiveMinScore } from '../src/services/polymarket/fiveMinScorer.js';
import type { Candle1m } from '../src/services/polymarket/polymarketTypes.js';

// ─── CLI ───────────────────────────────────────────────────────────────────────
function parseArg(name: string): string | undefined {
  const eqIdx = process.argv.findIndex(a => a.startsWith(`--${name}=`));
  if (eqIdx >= 0) return process.argv[eqIdx].split('=')[1];
  const spIdx = process.argv.indexOf(`--${name}`);
  if (spIdx >= 0 && spIdx + 1 < process.argv.length) return process.argv[spIdx + 1];
  return undefined;
}

const startArg = parseArg('start');
const endArg = parseArg('end');
const daysArg = parseArg('days');
const BET_AMOUNT = parseFloat(parseArg('bet') ?? '10');

let startMs: number;
let endMs: number;

if (startArg && endArg) {
  startMs = new Date(startArg).getTime();
  endMs = new Date(endArg).getTime();
} else {
  const days = parseInt(daysArg ?? '30', 10);
  const now = Date.now();
  // Align to last complete 5-min window
  endMs = Math.floor(now / 300_000) * 300_000;
  startMs = endMs - days * 86_400_000;
}

// ─── Constants ─────────────────────────────────────────────────────────────────
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const WINDOW_MS = 5 * 60_000;
const DECISION_OFFSET_CANDLES = 1;
const PRE_WINDOW_CANDLES = 5;
const MIN_SCORE = 40;
const MIN_CONSENSUS = 3;
const MIN_CLOB = 0.55;
const PRE_BUFFER_MS = 35 * 60_000;

// ─── CLOB model calibrated on 98 live trades ──────────────────────────────────
// Maps |microRocPct| to estimated CLOB ask price
const CLOB_CURVE: [number, number][] = [
  [0.0000, 0.55],
  [0.0003, 0.60],
  [0.0006, 0.65],
  [0.0010, 0.70],
  [0.0015, 0.76],
  [0.0025, 0.82],
  [0.0040, 0.87],
];

function estimateClobPrice(absMicroRocPct: number): number {
  const x = absMicroRocPct / 100; // convert pct to ratio
  if (x <= CLOB_CURVE[0][0]) return CLOB_CURVE[0][1];
  if (x >= CLOB_CURVE[CLOB_CURVE.length - 1][0]) return CLOB_CURVE[CLOB_CURVE.length - 1][1];
  for (let i = 1; i < CLOB_CURVE.length; i++) {
    if (x <= CLOB_CURVE[i][0]) {
      const [x0, y0] = CLOB_CURVE[i - 1];
      const [x1, y1] = CLOB_CURVE[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return CLOB_CURVE[CLOB_CURVE.length - 1][1];
}

// ─── EV caps (exact copy from live polymarketTrader.ts) ────────────────────────
function getMaxPriceForScore(score: number): number {
  if (score >= 70) return 0.82;
  if (score >= 60) return 0.90;
  if (score >= 50) return 0.85;
  if (score >= 40) return 0.78;
  return 0.50;
}

// ─── Binance fetch ─────────────────────────────────────────────────────────────
interface BinanceKline {
  timestamp: number; open: number; high: number; low: number; close: number; volume: number;
}

async function fetchKlines1m(symbol: string, fetchStart: number, fetchEnd: number): Promise<BinanceKline[]> {
  const pair = `${symbol}USDT`;
  const all: BinanceKline[] = [];
  let cursor = fetchStart;

  while (cursor < fetchEnd) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1m&startTime=${cursor}&endTime=${fetchEnd}&limit=1000`;
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

// ─── Market context (BTC) ──────────────────────────────────────────────────────
interface MarketContext {
  roc5m: number;
  roc15m: number;
  bodyRatio: number;
}

function computeContext(btcIndex: Map<number, BinanceKline>, atTs: number): MarketContext | null {
  const candles: BinanceKline[] = [];
  for (let t = atTs - 15 * 60_000; t < atTs; t += 60_000) {
    const c = btcIndex.get(t);
    if (c) candles.push(c);
  }
  if (candles.length < 10) return null;

  const last = candles[candles.length - 1];
  const last5 = candles.slice(-5);
  const last10 = candles.slice(-10);

  const roc5m = (last.close - last5[0].open) / last5[0].open * 100;
  const roc15m = (last.close - candles[0].open) / candles[0].open * 100;

  const bodyRatio = last10.reduce((s, c) => {
    const range = c.high - c.low;
    return range === 0 ? s : s + Math.abs(c.close - c.open) / range;
  }, 0) / last10.length;

  return { roc5m, roc15m, bodyRatio };
}

// ─── Trade record ──────────────────────────────────────────────────────────────
interface TradeRecord {
  windowStart: number;
  symbol: string;
  direction: 'UP' | 'DOWN';
  score: number;
  microRocPct: number;
  clobEstimated: number;
  evCap: number;
  rejected: boolean;        // true if clob > evCap
  isCorrect: boolean;
  pnl: number;              // binary pnl (0 if rejected)
  // BTC context for filters
  roc5m: number;
  roc15m: number;
  bodyRatio: number;
  // filter flags
  passMeanReversion: boolean;
  passTrendAlign: boolean;
  passBodyRatio: boolean;
}

// ─── Score tier helper ─────────────────────────────────────────────────────────
function scoreTier(s: number): string {
  if (s >= 70) return 'VHIGH';
  if (s >= 60) return 'HIGH';
  if (s >= 50) return 'MID';
  return 'LOW';
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const dayCount = Math.round((endMs - startMs) / 86_400_000);
  console.log(`\n=== POLYMARKET EV BACKTEST (CLOB model calibrated on 98 live trades) ===`);
  console.log(`Period: ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)} (${dayCount} days)`);
  console.log(`Bet size: $${BET_AMOUNT}`);
  console.log(`Min CLOB: ${MIN_CLOB}  |  Consensus: ${MIN_CONSENSUS}+\n`);

  // 1. Fetch candles
  console.log('Fetching 1m candles...');
  const indexBySymbol = new Map<string, Map<number, BinanceKline>>();
  const fetchStart = startMs - PRE_BUFFER_MS;

  for (const sym of SYMBOLS) {
    console.log(`  ${sym}...`);
    const candles = await fetchKlines1m(sym, fetchStart, endMs);
    const idx = new Map<number, BinanceKline>();
    for (const c of candles) idx.set(c.timestamp, c);
    indexBySymbol.set(sym, idx);
    console.log(`  ${sym}: ${candles.length} candles`);
  }

  const btcIndex = indexBySymbol.get('BTC')!;

  // 2. Iterate 5-min windows
  const allTrades: TradeRecord[] = [];
  let windowCount = 0;

  for (let wStart = startMs; wStart < endMs; wStart += WINDOW_MS) {
    windowCount++;

    // Score each symbol
    const predictions: { symbol: string; direction: 'UP' | 'DOWN'; score: number; microRocPct: number }[] = [];

    for (const sym of SYMBOLS) {
      const idx = indexBySymbol.get(sym)!;

      // Build window candles (after DECISION_OFFSET)
      const windowCandles: Candle1m[] = [];
      for (let i = DECISION_OFFSET_CANDLES; i < 5; i++) {
        const ts = wStart + i * 60_000;
        const k = idx.get(ts);
        if (k) windowCandles.push({ ...k, isFinal: true });
      }

      // Build pre-window candles
      const preCandles: Candle1m[] = [];
      for (let i = PRE_WINDOW_CANDLES; i >= 1; i--) {
        const ts = wStart - i * 60_000;
        const k = idx.get(ts);
        if (k) preCandles.push({ ...k, isFinal: true });
      }

      if (windowCandles.length < 2 || preCandles.length < 3) continue;

      const openPrice = idx.get(wStart)?.open ?? windowCandles[0].open;
      const result = computeFiveMinScore(windowCandles, preCandles, openPrice);
      if (!result) continue;

      predictions.push({
        symbol: sym,
        direction: result.direction,
        score: result.confidence,
        microRocPct: result.microRocPct,
      });
    }

    if (predictions.length < MIN_CONSENSUS) continue;

    // Consensus
    const upPreds = predictions.filter(p => p.direction === 'UP');
    const downPreds = predictions.filter(p => p.direction === 'DOWN');
    let consensusDir: 'UP' | 'DOWN' | null = null;

    if (upPreds.length >= MIN_CONSENSUS) consensusDir = 'UP';
    else if (downPreds.length >= MIN_CONSENSUS) consensusDir = 'DOWN';
    if (!consensusDir) continue;

    const consensusPreds = consensusDir === 'UP' ? upPreds : downPreds;

    // Determine actual result: end close vs start open (BTC reference)
    const btcOpen = btcIndex.get(wStart);
    const btcClose = btcIndex.get(wStart + 4 * 60_000);
    if (!btcOpen || !btcClose) continue;
    const actualUp = btcClose.close >= btcOpen.open;

    // BTC context for filters
    const ctx = computeContext(btcIndex, wStart);
    const roc5m = ctx?.roc5m ?? 0;
    const roc15m = ctx?.roc15m ?? 0;
    const bodyRatio = ctx?.bodyRatio ?? 0;

    // Generate trades for each consensus prediction
    for (const pred of consensusPreds) {
      const absMicroRoc = Math.abs(pred.microRocPct);
      const clobEstimated = estimateClobPrice(absMicroRoc);
      const evCap = getMaxPriceForScore(pred.score);
      const rejected = clobEstimated > evCap || clobEstimated < MIN_CLOB;
      const isCorrect = (consensusDir === 'UP' && actualUp) || (consensusDir === 'DOWN' && !actualUp);

      // PnL: binary bet
      let pnl = 0;
      if (!rejected) {
        pnl = isCorrect
          ? BET_AMOUNT * (1 - clobEstimated) / clobEstimated
          : -BET_AMOUNT;
      }

      // Filter flags
      const flatThreshold = 0.02;
      const roc5mFlat = Math.abs(roc5m) < flatThreshold;
      // Mean-reversion: prediction AGAINST roc5m BTC (or roc5m flat)
      const passMeanReversion = roc5mFlat ||
        (consensusDir === 'UP' && roc5m < 0) ||
        (consensusDir === 'DOWN' && roc5m > 0);
      // Trend alignment: roc5m & roc15m same sign
      const passTrendAlign = roc5m !== 0 && Math.sign(roc5m) === Math.sign(roc15m);
      // Body ratio > 0.5
      const passBodyRatio = bodyRatio > 0.5;

      allTrades.push({
        windowStart: wStart,
        symbol: pred.symbol,
        direction: consensusDir,
        score: pred.score,
        microRocPct: pred.microRocPct,
        clobEstimated,
        evCap,
        rejected,
        isCorrect,
        pnl,
        roc5m,
        roc15m,
        bodyRatio,
        passMeanReversion,
        passTrendAlign,
        passBodyRatio,
      });
    }
  }

  console.log(`\nProcessed ${windowCount} windows → ${allTrades.length} consensus trades\n`);

  // ─── ANALYSIS ────────────────────────────────────────────────────────────────

  // Helper: compute stats for a subset
  function computeStats(trades: TradeRecord[], label: string) {
    const accepted = trades.filter(t => !t.rejected);
    const wins = accepted.filter(t => t.isCorrect);
    const totalPnl = accepted.reduce((s, t) => s + t.pnl, 0);
    const avgClob = accepted.length > 0
      ? accepted.reduce((s, t) => s + t.clobEstimated, 0) / accepted.length
      : 0;
    const wr = accepted.length > 0 ? wins.length / accepted.length * 100 : 0;
    const breakeven = avgClob > 0 ? avgClob * 100 : 0;
    const edge = wr - breakeven;

    return { label, total: trades.length, accepted: accepted.length, rejected: trades.length - accepted.length, wins: wins.length, wr, totalPnl, avgClob, breakeven, edge };
  }

  // 5 filter configurations
  const configs = [
    { name: 'Baseline (no filter)', filter: (_t: TradeRecord) => true },
    { name: 'Mean-reversion', filter: (t: TradeRecord) => t.passMeanReversion },
    { name: 'Trend alignment', filter: (t: TradeRecord) => t.passTrendAlign },
    { name: 'Body ratio > 0.5', filter: (t: TradeRecord) => t.passBodyRatio },
    { name: 'All combined', filter: (t: TradeRecord) => t.passMeanReversion && t.passTrendAlign && t.passBodyRatio },
  ];

  const configStats = configs.map(cfg => {
    const filtered = allTrades.filter(cfg.filter);
    return computeStats(filtered, cfg.name);
  });

  // ═══ SECTION 1: SUMMARY ═══
  const baseline = configStats[0];
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' 1. SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total trades:     ${baseline.total}`);
  console.log(`  Accepted:         ${baseline.accepted}  (rejected: ${baseline.rejected}, ${(baseline.rejected / baseline.total * 100).toFixed(1)}%)`);
  console.log(`  Win rate:         ${baseline.wr.toFixed(1)}%`);
  console.log(`  Avg CLOB:         ${baseline.avgClob.toFixed(3)}`);
  console.log(`  Breakeven WR:     ${baseline.breakeven.toFixed(1)}%`);
  console.log(`  Edge:             ${baseline.edge >= 0 ? '+' : ''}${baseline.edge.toFixed(1)}pp`);
  console.log(`  Total PnL:        $${baseline.totalPnl.toFixed(2)} (${BET_AMOUNT}$ bets)`);
  console.log(`  PnL/trade:        $${(baseline.accepted > 0 ? baseline.totalPnl / baseline.accepted : 0).toFixed(3)}`);
  console.log();

  // ═══ SECTION 2: SCORE TIERS ═══
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' 2. SCORE TIERS');
  console.log('═══════════════════════════════════════════════════════════════');
  const tiers = ['LOW', 'MID', 'HIGH', 'VHIGH'];
  console.log(`  ${'Tier'.padEnd(8)} ${'Trades'.padStart(7)} ${'Accept'.padStart(7)} ${'Reject'.padStart(7)} ${'WR%'.padStart(7)} ${'AvgCLOB'.padStart(8)} ${'PnL'.padStart(10)} ${'Cap'.padStart(6)}`);
  console.log(`  ${'─'.repeat(68)}`);
  for (const tier of tiers) {
    const tierTrades = allTrades.filter(t => scoreTier(t.score) === tier);
    const accepted = tierTrades.filter(t => !t.rejected);
    const wins = accepted.filter(t => t.isCorrect);
    const pnl = accepted.reduce((s, t) => s + t.pnl, 0);
    const avgClob = accepted.length > 0 ? accepted.reduce((s, t) => s + t.clobEstimated, 0) / accepted.length : 0;
    const wr = accepted.length > 0 ? wins.length / accepted.length * 100 : 0;
    const cap = tier === 'VHIGH' ? 0.82 : tier === 'HIGH' ? 0.90 : tier === 'MID' ? 0.85 : 0.78;
    console.log(`  ${tier.padEnd(8)} ${String(tierTrades.length).padStart(7)} ${String(accepted.length).padStart(7)} ${String(tierTrades.length - accepted.length).padStart(7)} ${wr.toFixed(1).padStart(7)} ${avgClob.toFixed(3).padStart(8)} ${('$' + pnl.toFixed(2)).padStart(10)} ${cap.toFixed(2).padStart(6)}`);
  }
  console.log();

  // ═══ SECTION 3: FILTER COMPARISON ═══
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' 3. FILTER COMPARISON');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  ${'Config'.padEnd(25)} ${'Trades'.padStart(7)} ${'Accept'.padStart(7)} ${'WR%'.padStart(7)} ${'PnL'.padStart(10)} ${'deltaWR'.padStart(8)} ${'Edge'.padStart(7)}`);
  console.log(`  ${'─'.repeat(74)}`);
  for (const st of configStats) {
    const deltaWr = st.wr - baseline.wr;
    console.log(`  ${st.label.padEnd(25)} ${String(st.total).padStart(7)} ${String(st.accepted).padStart(7)} ${st.wr.toFixed(1).padStart(7)} ${('$' + st.totalPnl.toFixed(2)).padStart(10)} ${(deltaWr >= 0 ? '+' : '') + deltaWr.toFixed(1) + 'pp'.padStart(8)} ${(st.edge >= 0 ? '+' : '') + st.edge.toFixed(1) + 'pp'.padStart(7)}`);
  }
  console.log();

  // ═══ SECTION 4: CLOB DISTRIBUTION ═══
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' 4. CLOB DISTRIBUTION');
  console.log('═══════════════════════════════════════════════════════════════');
  const acceptedTrades = allTrades.filter(t => !t.rejected);
  const clobBuckets = new Map<string, { count: number; wins: number; pnl: number }>();
  for (const t of acceptedTrades) {
    const bucket = (Math.floor(t.clobEstimated / 0.05) * 0.05).toFixed(2);
    const b = clobBuckets.get(bucket) ?? { count: 0, wins: 0, pnl: 0 };
    b.count++;
    if (t.isCorrect) b.wins++;
    b.pnl += t.pnl;
    clobBuckets.set(bucket, b);
  }
  console.log(`  ${'CLOB'.padEnd(8)} ${'Count'.padStart(7)} ${'WR%'.padStart(7)} ${'PnL'.padStart(10)} ${'BE%'.padStart(7)}`);
  console.log(`  ${'─'.repeat(42)}`);
  const sortedBuckets = [...clobBuckets.entries()].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
  for (const [bucket, data] of sortedBuckets) {
    const wr = data.count > 0 ? data.wins / data.count * 100 : 0;
    const be = parseFloat(bucket) * 100;
    console.log(`  ${bucket.padEnd(8)} ${String(data.count).padStart(7)} ${wr.toFixed(1).padStart(7)} ${('$' + data.pnl.toFixed(2)).padStart(10)} ${be.toFixed(0).padStart(7)}`);
  }
  console.log();

  // ═══ SECTION 5: EQUITY CURVE ═══
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' 5. EQUITY CURVE (daily)');
  console.log('═══════════════════════════════════════════════════════════════');
  // Group by day
  const dailyPnl = new Map<string, number>();
  for (const t of acceptedTrades) {
    const day = new Date(t.windowStart).toISOString().slice(0, 10);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl);
  }
  const sortedDays = [...dailyPnl.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let cumPnl = 0;
  let maxCum = 0;
  let maxDrawdown = 0;
  console.log(`  ${'Date'.padEnd(12)} ${'DayPnL'.padStart(10)} ${'CumPnL'.padStart(10)} ${'DD'.padStart(10)}`);
  console.log(`  ${'─'.repeat(45)}`);
  for (const [day, pnl] of sortedDays) {
    cumPnl += pnl;
    maxCum = Math.max(maxCum, cumPnl);
    const dd = maxCum - cumPnl;
    maxDrawdown = Math.max(maxDrawdown, dd);
    console.log(`  ${day.padEnd(12)} ${('$' + pnl.toFixed(2)).padStart(10)} ${('$' + cumPnl.toFixed(2)).padStart(10)} ${('$' + dd.toFixed(2)).padStart(10)}`);
  }
  console.log(`  ${'─'.repeat(45)}`);
  console.log(`  Max drawdown: $${maxDrawdown.toFixed(2)}`);
  console.log();

  // ═══ SECTION 6: HOURLY BREAKDOWN ═══
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' 6. HOURLY BREAKDOWN (UTC)');
  console.log('═══════════════════════════════════════════════════════════════');
  const hourly = new Map<number, { count: number; wins: number; pnl: number }>();
  for (const t of acceptedTrades) {
    const h = new Date(t.windowStart).getUTCHours();
    const b = hourly.get(h) ?? { count: 0, wins: 0, pnl: 0 };
    b.count++;
    if (t.isCorrect) b.wins++;
    b.pnl += t.pnl;
    hourly.set(h, b);
  }
  console.log(`  ${'Hour'.padEnd(6)} ${'Trades'.padStart(7)} ${'WR%'.padStart(7)} ${'PnL'.padStart(10)}`);
  console.log(`  ${'─'.repeat(33)}`);
  for (let h = 0; h < 24; h++) {
    const data = hourly.get(h);
    if (!data) continue;
    const wr = data.count > 0 ? data.wins / data.count * 100 : 0;
    console.log(`  ${String(h).padStart(2).padEnd(6)} ${String(data.count).padStart(7)} ${wr.toFixed(1).padStart(7)} ${('$' + data.pnl.toFixed(2)).padStart(10)}`);
  }
  console.log();

  // ═══ SECTION 7: MONTHLY BREAKDOWN ═══
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' 7. MONTHLY BREAKDOWN');
  console.log('═══════════════════════════════════════════════════════════════');
  const monthly = new Map<string, { count: number; wins: number; pnl: number }>();
  for (const t of acceptedTrades) {
    const m = new Date(t.windowStart).toISOString().slice(0, 7);
    const b = monthly.get(m) ?? { count: 0, wins: 0, pnl: 0 };
    b.count++;
    if (t.isCorrect) b.wins++;
    b.pnl += t.pnl;
    monthly.set(m, b);
  }
  console.log(`  ${'Month'.padEnd(10)} ${'Trades'.padStart(7)} ${'WR%'.padStart(7)} ${'PnL'.padStart(10)}`);
  console.log(`  ${'─'.repeat(37)}`);
  const sortedMonths = [...monthly.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [month, data] of sortedMonths) {
    const wr = data.count > 0 ? data.wins / data.count * 100 : 0;
    console.log(`  ${month.padEnd(10)} ${String(data.count).padStart(7)} ${wr.toFixed(1).padStart(7)} ${('$' + data.pnl.toFixed(2)).padStart(10)}`);
  }
  console.log();

  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
