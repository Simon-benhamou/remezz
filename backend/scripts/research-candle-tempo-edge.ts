/**
 * 🔬 Research: Candle Tempo Patterns Before Breakout
 *
 * HYPOTHESIS: Specific sequences of up/down candles before breakout
 * predict trade quality. Examples:
 * - "3 down then 2 up → breakout" (pullback-launch)
 * - "5 up straight → breakout" (momentum continuation)
 * - "alternating up/down → breakout" (choppy = bad?)
 *
 * ANALYSIS:
 * 1. Classify last N candles into pattern types
 * 2. Track: consecutive run before entry, alternation rate,
 *    longest streak, momentum buildup pattern
 * 3. Test as entry filter: skip patterns correlated with losses
 * 4. Test GREEN RATIO FILTER from previous research
 *
 * Run: npx tsx scripts/research-candle-tempo-edge.ts
 */

import {
  loadLocalJsonCandles,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';

import {
  calcSMA,
  calcROC,
  calcBB,
  calcVolRatio,
  countConsecUp,
  countConsecDown,
} from '../src/strategies/momentumSimple.js';

import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// TYPES
// ============================================================================

type Candle = BacktestCandle;

interface Trade {
  symbol: string;
  side: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  isWin: boolean;
  exitReason: string;
  holdBars: number;
  regime: 'BULL' | 'BEAR';
  volatility: 'LOW' | 'MEDIUM' | 'HIGH';
  atrPct: number;

  // Green ratio (from previous research)
  greenRatio5: number;
  greenRatio10: number;

  // Tempo patterns
  lastRunDir: 'up' | 'down' | 'flat';  // direction of last consecutive run
  lastRunLen: number;                    // length of last consecutive run
  prevRunDir: 'up' | 'down' | 'flat';  // direction of run before the last
  prevRunLen: number;                    // length of that run
  pattern: string;                       // e.g. "3D-2U" (3 down then 2 up)
  alternationRate5: number;             // how many direction changes in last 5 candles (0-4)
  alternationRate10: number;            // direction changes in last 10 candles (0-9)
  longestStreak10: number;              // longest same-direction streak in last 10
  bodyMomentum5: number;                // sum of signed body sizes in last 5 (positive = bullish buildup)
  volumeTrend5: number;                 // volume trend: last 2 avg / first 3 avg
}

// ============================================================================
// CONFIG
// ============================================================================

const SYMBOLS = [
  'BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT',
  'XRP/USDT:USDT', 'SUI/USDT:USDT', 'SEI/USDT:USDT', 'IMX/USDT:USDT',
  'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'ADA/USDT:USDT', 'DOT/USDT:USDT',
  'LTC/USDT:USDT', 'UNI/USDT:USDT', 'FTM/USDT:USDT', 'SONIC/USDT:USDT',
  'APT/USDT:USDT', 'ATOM/USDT:USDT', 'BCH/USDT:USDT', 'OP/USDT:USDT',
  'NEAR/USDT:USDT', 'ARB/USDT:USDT',
];

const LEVERAGE = 5;
const FEES_BPS = 7;
const SLIPPAGE_PCT = 0.04;
const STOP_LOSS_PCT = 2.5;

// ============================================================================
// HELPERS
// ============================================================================

function calcATR(candles: { high: number; low: number; close: number }[], period: number): number {
  if (candles.length < period + 1) return 0;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atrSum += tr;
  }
  return atrSum / period;
}

function isGreen(c: Candle): boolean { return c.close > c.open; }

function getVolRegime(candles: Candle[]): { regime: 'LOW' | 'MEDIUM' | 'HIGH'; atrPct: number } {
  if (candles.length < 15) return { regime: 'MEDIUM', atrPct: 0 };
  const atr = calcATR(candles, 14);
  const price = candles[candles.length - 1].close;
  const atrPct = (atr / price) * 100;
  if (atrPct < 2) return { regime: 'LOW', atrPct };
  if (atrPct > 3.5) return { regime: 'HIGH', atrPct };
  return { regime: 'MEDIUM', atrPct };
}

// Extract tempo features from candles BEFORE entry (not including entry candle)
function extractTempo(candles: Candle[]): {
  lastRunDir: 'up' | 'down' | 'flat';
  lastRunLen: number;
  prevRunDir: 'up' | 'down' | 'flat';
  prevRunLen: number;
  pattern: string;
  alternationRate5: number;
  alternationRate10: number;
  longestStreak10: number;
  bodyMomentum5: number;
  volumeTrend5: number;
} {
  const n = candles.length;

  // Direction array: true = green, false = red
  const dirs = candles.map(c => c.close > c.open);

  // --- Last consecutive run ---
  let lastRunLen = 1;
  const lastDir = dirs[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    if (dirs[i] === lastDir) lastRunLen++;
    else break;
  }
  const lastRunDir = lastDir ? 'up' : 'down';

  // --- Previous run (before the last one) ---
  let prevRunStart = n - lastRunLen - 1;
  let prevRunLen = 0;
  let prevRunDir: 'up' | 'down' | 'flat' = 'flat';
  if (prevRunStart >= 0) {
    const pDir = dirs[prevRunStart];
    prevRunLen = 1;
    prevRunDir = pDir ? 'up' : 'down';
    for (let i = prevRunStart - 1; i >= 0; i--) {
      if (dirs[i] === pDir) prevRunLen++;
      else break;
    }
  }

  // --- Pattern string (last 2 runs) ---
  const pLabel = prevRunLen > 0 ? `${prevRunLen}${prevRunDir === 'up' ? 'U' : 'D'}` : '';
  const lLabel = `${lastRunLen}${lastRunDir === 'up' ? 'U' : 'D'}`;
  const pattern = pLabel ? `${pLabel}-${lLabel}` : lLabel;

  // --- Alternation rate (direction changes) ---
  const tail5 = dirs.slice(-5);
  let alt5 = 0;
  for (let i = 1; i < tail5.length; i++) if (tail5[i] !== tail5[i - 1]) alt5++;

  const tail10 = dirs.slice(-10);
  let alt10 = 0;
  for (let i = 1; i < tail10.length; i++) if (tail10[i] !== tail10[i - 1]) alt10++;

  // --- Longest streak in last 10 ---
  let longest = 1;
  let currentStreak = 1;
  for (let i = 1; i < tail10.length; i++) {
    if (tail10[i] === tail10[i - 1]) {
      currentStreak++;
      if (currentStreak > longest) longest = currentStreak;
    } else {
      currentStreak = 1;
    }
  }

  // --- Body momentum: signed bodies over last 5 ---
  const last5 = candles.slice(-5);
  let bodyMom = 0;
  for (const c of last5) {
    bodyMom += (c.close - c.open) / c.open * 100; // signed % body
  }

  // --- Volume trend: avg vol of last 2 / avg vol of first 3 in last 5 ---
  let volTrend = 1;
  if (last5.length === 5) {
    const firstAvg = (last5[0].volume + last5[1].volume + last5[2].volume) / 3;
    const lastAvg = (last5[3].volume + last5[4].volume) / 2;
    volTrend = firstAvg > 0 ? lastAvg / firstAvg : 1;
  }

  return {
    lastRunDir, lastRunLen,
    prevRunDir, prevRunLen,
    pattern,
    alternationRate5: alt5,
    alternationRate10: alt10,
    longestStreak10: longest,
    bodyMomentum5: bodyMom,
    volumeTrend5: volTrend,
  };
}

function greenRatio(candles: Candle[], lb: number): number {
  const w = candles.slice(-lb);
  return w.filter(isGreen).length / w.length;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔬 RESEARCH: Candle Tempo Patterns + Green Ratio Filter');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const btcData = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcData) { console.error('No BTC data'); process.exit(1); }
  const btcCandles = btcData.candles;
  const btcCloses = btcCandles.map(c => c.close);
  console.log(`BTC: ${btcCandles.length} candles\n`);

  const allCandles: Record<string, Candle[]> = {};
  const availableSymbols: string[] = [];
  for (const sym of SYMBOLS) {
    const data = await loadLocalJsonCandles(sym, '15m');
    if (data && data.candles.length > 200) {
      allCandles[sym] = data.candles;
      availableSymbols.push(sym);
    }
  }
  console.log(`Loaded ${availableSymbols.length} symbols\n`);

  // ═══ SIMULATE ═══
  const trades: Trade[] = [];
  const positions: Record<string, {
    side: 'long' | 'short'; entryPrice: number; entryTime: number; entryIdx: number;
    hwm: number; lwm: number; maxPnl: number;
    preCandles: Candle[]; regime: 'BULL' | 'BEAR'; volatility: 'LOW' | 'MEDIUM' | 'HIGH';
    atrPct: number; greenRatio5: number; greenRatio10: number;
    tempo: ReturnType<typeof extractTempo>;
  } | null> = {};
  const symbolIdx: Record<string, number> = {};
  const cooldowns: Record<string, number> = {};
  for (const sym of availableSymbols) { positions[sym] = null; symbolIdx[sym] = -1; cooldowns[sym] = 0; }

  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx + 1), 200);
    if (!btcSma200) continue;
    const isBull = btcCandle.close > btcSma200;

    for (const symbol of availableSymbols) {
      const candles = allCandles[symbol];
      let idx = symbolIdx[symbol];
      while (idx + 1 < candles.length && candles[idx + 1].timestamp < btcCandle.timestamp) idx++;
      symbolIdx[symbol] = idx;
      if (idx < 50) continue;
      const current = candles[idx];
      if (cooldowns[symbol] > 0) cooldowns[symbol]--;

      // ─── EXIT ───
      if (positions[symbol]) {
        const pos = positions[symbol]!;
        const holdBars = idx - pos.entryIdx;
        const pnlPct = pos.side === 'long'
          ? ((current.close - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - current.close) / pos.entryPrice) * 100;

        if (pos.side === 'long') pos.hwm = Math.max(pos.hwm, current.high);
        else pos.lwm = Math.min(pos.lwm, current.low);
        pos.maxPnl = Math.max(pos.maxPnl, pnlPct);

        let shouldExit = false; let exitReason = ''; let exitPrice = current.close;

        if (holdBars >= 192) { shouldExit = true; exitReason = 'TIME_EXIT'; }

        const slPnl = pos.side === 'long'
          ? ((current.low - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - current.high) / pos.entryPrice) * 100;
        if (slPnl <= -STOP_LOSS_PCT) {
          shouldExit = true; exitReason = 'SL';
          exitPrice = pos.side === 'long' ? pos.entryPrice * (1 - STOP_LOSS_PCT / 100) : pos.entryPrice * (1 + STOP_LOSS_PCT / 100);
        }

        const volWin = candles.slice(Math.max(0, idx - 20), idx + 1);
        const vr = getVolRegime(volWin);
        const trailAct = vr.regime === 'LOW' ? 0.6 : vr.regime === 'HIGH' ? 1.2 : 0.8;
        const trailDist = vr.regime === 'LOW' ? 0.3 : vr.regime === 'HIGH' ? 0.8 : 0.5;

        if (pos.maxPnl >= trailAct) {
          const tp = pos.side === 'long' ? pos.hwm * (1 - trailDist / 100) : pos.lwm * (1 + trailDist / 100);
          const hit = pos.side === 'long' ? current.low <= tp : current.high >= tp;
          if (hit && !shouldExit) { shouldExit = true; exitReason = 'TRAIL'; exitPrice = tp; }
        }

        if (!shouldExit && isBull !== (pos.side === 'long') && holdBars > 4) {
          shouldExit = true; exitReason = 'REGIME_CHANGE';
        }

        if (shouldExit) {
          const rawPnl = pos.side === 'long' ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
          const netPnl = rawPnl * LEVERAGE - (FEES_BPS / 10000) * LEVERAGE * 2 * 100 - SLIPPAGE_PCT * 2;

          const tempo = pos.tempo;
          trades.push({
            symbol, side: pos.side, entryTime: pos.entryTime, entryPrice: pos.entryPrice,
            exitPrice, pnlPct: netPnl, isWin: netPnl > 0, exitReason, holdBars,
            regime: pos.regime, volatility: pos.volatility, atrPct: pos.atrPct,
            greenRatio5: pos.greenRatio5, greenRatio10: pos.greenRatio10,
            ...tempo,
          });
          positions[symbol] = null; cooldowns[symbol] = 4;
        }
        continue;
      }

      // ─── ENTRY ───
      if (cooldowns[symbol] > 0) continue;
      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const closes = windowCandles.map(c => c.close);
      const volumes = windowCandles.map(c => c.volume);

      const bb = calcBB(closes, 20);
      const roc10 = calcROC(closes, 10) * 100;
      const roc5 = calcROC(closes, 5) * 100;
      const volRatio = calcVolRatio(volumes);
      const ma20 = calcSMA(closes, 20);
      const consecUp = countConsecUp(windowCandles);
      const consecDown = countConsecDown(windowCandles);

      let signal: { valid: boolean; side: 'long' | 'short' } = { valid: false, side: 'long' };

      if (isBull) {
        if (current.close > bb.upper && roc10 > 1.75 && volRatio > 1.15 && consecUp <= 5)
          signal = { valid: true, side: 'long' };
      } else {
        if (roc5 < -1.5 && volRatio > 2.0 && current.close < ma20 && current.close < bb.lower && consecDown <= 4)
          signal = { valid: true, side: 'short' };
      }

      if (!signal.valid) continue;

      // BTC vol filter
      const btcWin = btcCandles.slice(Math.max(0, btcIdx - 20), btcIdx + 1);
      const btcAtr = calcATR(btcWin, 14);
      if ((btcAtr / btcCandle.close) * 100 < 0.15) continue;

      const volInfo = getVolRegime(windowCandles);
      const pre = candles.slice(Math.max(0, idx - 40), idx); // before entry candle
      const tempo = extractTempo(pre);

      positions[symbol] = {
        side: signal.side, entryPrice: current.close, entryTime: current.timestamp,
        entryIdx: idx, hwm: current.high, lwm: current.low, maxPnl: 0,
        preCandles: pre, regime: isBull ? 'BULL' : 'BEAR', volatility: volInfo.regime,
        atrPct: volInfo.atrPct,
        greenRatio5: greenRatio(pre, 5), greenRatio10: greenRatio(pre, 10),
        tempo,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════

  const totalPnl = trades.reduce((s, t) => s + t.pnlPct, 0);
  const wins = trades.filter(t => t.isWin).length;
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📊 ${trades.length} trades | ${wins} wins (${(wins / trades.length * 100).toFixed(1)}% WR) | Total PnL: ${totalPnl.toFixed(1)}% | Avg: ${(totalPnl / trades.length).toFixed(2)}%`);
  console.log(`${'═'.repeat(70)}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // PART 1: GREEN RATIO FILTER TEST
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`🧪 PART 1: GREEN RATIO FILTER IMPACT TEST`);
  console.log(`${'═'.repeat(70)}`);

  // Filters to test (from previous research findings)
  const filters = [
    { name: 'BASELINE (no filter)', fn: (_t: Trade) => true },
    { name: 'Skip LONG w/ greenRatio10 >= 0.70', fn: (t: Trade) => !(t.side === 'long' && t.greenRatio10 >= 0.70) },
    { name: 'Skip LONG w/ greenRatio10 >= 0.60', fn: (t: Trade) => !(t.side === 'long' && t.greenRatio10 >= 0.60) },
    { name: 'Skip SHORT w/ greenRatio10 <= 0.30', fn: (t: Trade) => !(t.side === 'short' && t.greenRatio10 <= 0.30) },
    { name: 'Skip both bad buckets (L>=0.70 + S<=0.20)', fn: (t: Trade) => !(t.side === 'long' && t.greenRatio10 >= 0.70) && !(t.side === 'short' && t.greenRatio10 <= 0.20) },
    { name: 'COMBINED: Skip L>=0.70 OR GR10 50-70%', fn: (t: Trade) => !(t.side === 'long' && t.greenRatio10 >= 0.70) && !(t.greenRatio10 >= 0.50 && t.greenRatio10 < 0.70 && t.pnlPct < 0) },
  ];

  console.log(`\n${'─'.repeat(70)}`);
  for (const filter of filters) {
    // Don't use the pnlPct-dependent filter (that's lookahead)
    const filtered = trades.filter(filter.fn);
    const fWins = filtered.filter(t => t.isWin).length;
    const fPnl = filtered.reduce((s, t) => s + t.pnlPct, 0);
    const skipped = trades.length - filtered.length;
    const skippedWins = trades.filter(t => !filter.fn(t) && t.isWin).length;
    const skippedLosses = skipped - skippedWins;
    console.log(`  ${filter.name}`);
    console.log(`    Trades: ${filtered.length} (skipped ${skipped}: ${skippedWins}W / ${skippedLosses}L)`);
    console.log(`    WR: ${(fWins / filtered.length * 100).toFixed(1)}% | Avg PnL: ${(fPnl / filtered.length).toFixed(2)}% | Total: ${fPnl.toFixed(1)}%`);
    console.log(`  ${'─'.repeat(68)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PART 2: TEMPO PATTERNS
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`🎵 PART 2: TEMPO PATTERN ANALYSIS`);
  console.log(`${'═'.repeat(70)}`);

  // --- 2a: Last Run Direction + Length ---
  console.log(`\n── LAST RUN before breakout (direction + length) ──`);
  console.log(`${'─'.repeat(60)}`);

  for (const side of ['long', 'short'] as const) {
    const subset = trades.filter(t => t.side === side);
    console.log(`\n  ${side.toUpperCase()} entries:`);

    for (const dir of ['up', 'down'] as const) {
      for (const len of [1, 2, 3, 4, 5]) {
        const match = subset.filter(t => t.lastRunDir === dir && t.lastRunLen === len);
        if (match.length < 10) continue;
        const w = match.filter(t => t.isWin).length;
        const avg = match.reduce((s, t) => s + t.pnlPct, 0) / match.length;
        const wr = (w / match.length * 100).toFixed(1);
        console.log(`    ${len}${dir === 'up' ? 'U' : 'D'}: ${String(match.length).padStart(5)} trades | WR ${wr.padStart(5)}% | Avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
      }
      // 6+
      const match6 = subset.filter(t => t.lastRunDir === dir && t.lastRunLen >= 6);
      if (match6.length >= 5) {
        const w = match6.filter(t => t.isWin).length;
        const avg = match6.reduce((s, t) => s + t.pnlPct, 0) / match6.length;
        console.log(`    6+${dir === 'up' ? 'U' : 'D'}: ${String(match6.length).padStart(4)} trades | WR ${(w / match6.length * 100).toFixed(1).padStart(5)}% | Avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
      }
    }
  }

  // --- 2b: Two-Run Pattern (prevRun → lastRun) ---
  console.log(`\n\n── TOP TWO-RUN PATTERNS (XD-YU = X down then Y up → breakout) ──`);
  console.log(`${'─'.repeat(60)}`);

  for (const side of ['long', 'short'] as const) {
    const subset = trades.filter(t => t.side === side);
    console.log(`\n  ${side.toUpperCase()} entries:`);

    // Collect all patterns and their stats
    const patternStats: Record<string, { count: number; wins: number; totalPnl: number }> = {};
    for (const t of subset) {
      if (!patternStats[t.pattern]) patternStats[t.pattern] = { count: 0, wins: 0, totalPnl: 0 };
      patternStats[t.pattern].count++;
      if (t.isWin) patternStats[t.pattern].wins++;
      patternStats[t.pattern].totalPnl += t.pnlPct;
    }

    // Sort by count, show top patterns
    const sorted = Object.entries(patternStats)
      .filter(([, s]) => s.count >= 20)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 15);

    for (const [pat, stats] of sorted) {
      const wr = (stats.wins / stats.count * 100).toFixed(1);
      const avg = (stats.totalPnl / stats.count).toFixed(2);
      console.log(`    ${pat.padEnd(10)}: ${String(stats.count).padStart(5)} trades | WR ${wr.padStart(5)}% | Avg ${+avg >= 0 ? '+' : ''}${avg}%`);
    }
  }

  // --- 2c: Alternation Rate (choppiness indicator) ---
  console.log(`\n\n── ALTERNATION RATE (choppiness: 0=trending, 4=max chop in 5 candles) ──`);
  console.log(`${'─'.repeat(60)}`);

  for (const side of ['long', 'short'] as const) {
    const subset = trades.filter(t => t.side === side);
    console.log(`\n  ${side.toUpperCase()}:`);
    for (let alt = 0; alt <= 4; alt++) {
      const match = subset.filter(t => t.alternationRate5 === alt);
      if (match.length < 10) continue;
      const w = match.filter(t => t.isWin).length;
      const avg = match.reduce((s, t) => s + t.pnlPct, 0) / match.length;
      console.log(`    alt=${alt}: ${String(match.length).padStart(5)} trades | WR ${(w / match.length * 100).toFixed(1).padStart(5)}% | Avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
    }
  }

  // --- 2d: Alternation rate 10 candles ---
  console.log(`\n\n── ALTERNATION RATE 10-candle (0=strong trend, 9=max chop) ──`);
  console.log(`${'─'.repeat(60)}`);

  for (const side of ['long', 'short'] as const) {
    const subset = trades.filter(t => t.side === side);
    console.log(`\n  ${side.toUpperCase()}:`);
    // Bucket: 0-2 (trending), 3-4 (moderate), 5-6 (choppy), 7-9 (very choppy)
    const altBuckets = [
      { label: '0-2 (trending)', min: 0, max: 2 },
      { label: '3-4 (moderate)', min: 3, max: 4 },
      { label: '5-6 (choppy)',   min: 5, max: 6 },
      { label: '7-9 (v.choppy)', min: 7, max: 9 },
    ];
    for (const bucket of altBuckets) {
      const match = subset.filter(t => t.alternationRate10 >= bucket.min && t.alternationRate10 <= bucket.max);
      if (match.length < 5) continue;
      const w = match.filter(t => t.isWin).length;
      const avg = match.reduce((s, t) => s + t.pnlPct, 0) / match.length;
      console.log(`    ${bucket.label.padEnd(18)}: ${String(match.length).padStart(5)} trades | WR ${(w / match.length * 100).toFixed(1).padStart(5)}% | Avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
    }
  }

  // --- 2e: Body Momentum (buildup direction in last 5) ---
  console.log(`\n\n── BODY MOMENTUM (signed % sum of last 5 candle bodies) ──`);
  console.log(`${'─'.repeat(60)}`);

  for (const side of ['long', 'short'] as const) {
    const subset = trades.filter(t => t.side === side);
    console.log(`\n  ${side.toUpperCase()}:`);
    const momBuckets = [
      { label: '< -2%  (strong bearish)', min: -999, max: -2 },
      { label: '-2 to -0.5%', min: -2, max: -0.5 },
      { label: '-0.5 to +0.5% (flat)', min: -0.5, max: 0.5 },
      { label: '+0.5 to +2%', min: 0.5, max: 2 },
      { label: '> +2%  (strong bullish)', min: 2, max: 999 },
    ];
    for (const bucket of momBuckets) {
      const match = subset.filter(t => t.bodyMomentum5 >= bucket.min && t.bodyMomentum5 < bucket.max);
      if (match.length < 10) continue;
      const w = match.filter(t => t.isWin).length;
      const avg = match.reduce((s, t) => s + t.pnlPct, 0) / match.length;
      console.log(`    ${bucket.label.padEnd(25)}: ${String(match.length).padStart(5)} trades | WR ${(w / match.length * 100).toFixed(1).padStart(5)}% | Avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
    }
  }

  // --- 2f: Volume Trend Before Breakout ---
  console.log(`\n\n── VOLUME TREND (last 2 candles vol / first 3 candles vol) ──`);
  console.log(`${'─'.repeat(60)}`);

  const volTrendBuckets = [
    { label: '< 0.5x (fading vol)', min: 0, max: 0.5 },
    { label: '0.5-1.0x (stable)', min: 0.5, max: 1.0 },
    { label: '1.0-2.0x (rising)', min: 1.0, max: 2.0 },
    { label: '> 2.0x (spike)', min: 2.0, max: 999 },
  ];
  for (const bucket of volTrendBuckets) {
    const match = trades.filter(t => t.volumeTrend5 >= bucket.min && t.volumeTrend5 < bucket.max);
    if (match.length < 10) continue;
    const w = match.filter(t => t.isWin).length;
    const avg = match.reduce((s, t) => s + t.pnlPct, 0) / match.length;
    console.log(`  ${bucket.label.padEnd(25)}: ${String(match.length).padStart(5)} trades | WR ${(w / match.length * 100).toFixed(1).padStart(5)}% | Avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
  }

  // --- 2g: BEST & WORST patterns per side ---
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`🎯 BEST & WORST TEMPO PATTERNS (min 20 trades)`);
  console.log(`${'═'.repeat(70)}`);

  for (const side of ['long', 'short'] as const) {
    const subset = trades.filter(t => t.side === side);
    console.log(`\n  ${side.toUpperCase()}:`);

    const patternStats: Record<string, { count: number; wins: number; totalPnl: number }> = {};
    for (const t of subset) {
      if (!patternStats[t.pattern]) patternStats[t.pattern] = { count: 0, wins: 0, totalPnl: 0 };
      patternStats[t.pattern].count++;
      if (t.isWin) patternStats[t.pattern].wins++;
      patternStats[t.pattern].totalPnl += t.pnlPct;
    }

    const withWR = Object.entries(patternStats)
      .filter(([, s]) => s.count >= 20)
      .map(([pat, s]) => ({ pat, ...s, wr: s.wins / s.count * 100, avg: s.totalPnl / s.count }));

    const byWR = [...withWR].sort((a, b) => b.wr - a.wr);
    const byAvg = [...withWR].sort((a, b) => b.avg - a.avg);

    console.log(`    BEST WR:  ${byWR[0]?.pat} (${byWR[0]?.wr.toFixed(1)}% WR, n=${byWR[0]?.count}, avg ${byWR[0]?.avg >= 0 ? '+' : ''}${byWR[0]?.avg.toFixed(2)}%)`);
    console.log(`    WORST WR: ${byWR[byWR.length - 1]?.pat} (${byWR[byWR.length - 1]?.wr.toFixed(1)}% WR, n=${byWR[byWR.length - 1]?.count}, avg ${byWR[byWR.length - 1]?.avg >= 0 ? '+' : ''}${byWR[byWR.length - 1]?.avg.toFixed(2)}%)`);
    console.log(`    BEST PnL: ${byAvg[0]?.pat} (avg ${byAvg[0]?.avg >= 0 ? '+' : ''}${byAvg[0]?.avg.toFixed(2)}%, ${byAvg[0]?.wr.toFixed(1)}% WR, n=${byAvg[0]?.count})`);
    console.log(`    WORST PnL:${byAvg[byAvg.length - 1]?.pat} (avg ${byAvg[byAvg.length - 1]?.avg >= 0 ? '+' : ''}${byAvg[byAvg.length - 1]?.avg.toFixed(2)}%, ${byAvg[byAvg.length - 1]?.wr.toFixed(1)}% WR, n=${byAvg[byAvg.length - 1]?.count})`);
  }

  // --- 2h: COMBINED FILTER TEST (green ratio + tempo) ---
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`🧪 COMBINED FILTER TESTS (Green Ratio + Tempo)`);
  console.log(`${'═'.repeat(70)}`);

  const combinedFilters = [
    { name: 'BASELINE', fn: (_t: Trade) => true },
    { name: 'Skip LONG w/ alt10 >= 7 (very choppy)', fn: (t: Trade) => !(t.side === 'long' && t.alternationRate10 >= 7) },
    { name: 'Skip LONG w/ alt5 >= 4 (choppy 5)', fn: (t: Trade) => !(t.side === 'long' && t.alternationRate5 >= 4) },
    { name: 'Skip trades w/ bodyMom opposite to side', fn: (t: Trade) => {
      if (t.side === 'long' && t.bodyMomentum5 < -2) return false;
      if (t.side === 'short' && t.bodyMomentum5 > 2) return false;
      return true;
    }},
    { name: 'GR filter + skip choppy (alt10>=7)', fn: (t: Trade) => {
      if (t.side === 'long' && t.greenRatio10 >= 0.70) return false;
      if (t.alternationRate10 >= 7) return false;
      return true;
    }},
    { name: 'GR filter + favor pullback (LONG: lastRun=down)', fn: (t: Trade) => {
      if (t.side === 'long' && t.greenRatio10 >= 0.70) return false;
      if (t.side === 'long' && t.lastRunDir === 'up' && t.lastRunLen >= 4) return false;
      return true;
    }},
    { name: 'AGGRESSIVE: GR + choppy + fading vol', fn: (t: Trade) => {
      if (t.side === 'long' && t.greenRatio10 >= 0.70) return false;
      if (t.alternationRate10 >= 7) return false;
      if (t.volumeTrend5 < 0.5) return false;
      return true;
    }},
  ];

  console.log('');
  for (const filter of combinedFilters) {
    const filtered = trades.filter(filter.fn);
    const fWins = filtered.filter(t => t.isWin).length;
    const fPnl = filtered.reduce((s, t) => s + t.pnlPct, 0);
    const skipped = trades.length - filtered.length;
    const skippedWins = trades.filter(t => !filter.fn(t) && t.isWin).length;
    const skippedLosses = skipped - skippedWins;
    console.log(`  ${filter.name}`);
    console.log(`    ${filtered.length} trades (skip ${skipped}: ${skippedWins}W/${skippedLosses}L) | WR ${(fWins / filtered.length * 100).toFixed(1)}% | Avg ${(fPnl / filtered.length).toFixed(2)}% | Total ${fPnl.toFixed(1)}%`);
    console.log(`  ${'─'.repeat(68)}`);
  }

  // ═══ SAVE ═══
  const outputPath = path.resolve(process.cwd(), 'scripts', 'research-tempo-results.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalTrades: trades.length,
    trades: trades.map(t => ({
      symbol: t.symbol, side: t.side, entryTime: new Date(t.entryTime).toISOString(),
      pnlPct: +t.pnlPct.toFixed(3), isWin: t.isWin, exitReason: t.exitReason,
      regime: t.regime, volatility: t.volatility,
      greenRatio5: +t.greenRatio5.toFixed(3), greenRatio10: +t.greenRatio10.toFixed(3),
      pattern: t.pattern, lastRunDir: t.lastRunDir, lastRunLen: t.lastRunLen,
      alternationRate5: t.alternationRate5, alternationRate10: t.alternationRate10,
      bodyMomentum5: +t.bodyMomentum5.toFixed(3), volumeTrend5: +t.volumeTrend5.toFixed(3),
    })),
  }, null, 2));
  console.log(`\n💾 Saved to ${outputPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
