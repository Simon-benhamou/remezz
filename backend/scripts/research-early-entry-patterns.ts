/**
 * 🔬 Research: Early Entry Pattern Detection
 *
 * GOAL: Can we enter BEFORE the BB breakout by detecting the setup pattern?
 *
 * Previous findings showed:
 * - LONG: Pullback (3D) then launch = best entries
 * - SHORT: Rally (2U) then drop (1D) = best entries (+8.77%)
 * - Low alternation (trending) = much better for longs (78% vs 64% WR)
 * - Body momentum opposite to entry direction = strongest signal
 *
 * THIS SCRIPT:
 * 1. For each breakout trade, rewind to find when the "setup" formed
 * 2. Test hypothetical earlier entries (1, 2, 3 candles before breakout)
 * 3. Compare: entry at setup detection vs entry at breakout
 * 4. Analyze: what % of setups actually lead to breakout (hit rate)
 * 5. Analyze: price improvement from early entry
 * 6. Deep dive on best patterns with candle-by-candle anatomy
 *
 * Run: npx tsx scripts/research-early-entry-patterns.ts
 */

import {
  loadLocalJsonCandles,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';

import {
  calcSMA, calcROC, calcBB, calcVolRatio, countConsecUp, countConsecDown,
} from '../src/strategies/momentumSimple.js';

import fs from 'node:fs';
import path from 'node:path';

type Candle = BacktestCandle;

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

function calcATR(candles: { high: number; low: number; close: number }[], period: number): number {
  if (candles.length < period + 1) return 0;
  let s = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    s += Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
  }
  return s / period;
}

function getVolRegime(candles: Candle[]): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (candles.length < 15) return 'MEDIUM';
  const atr = calcATR(candles, 14);
  const p = (atr / candles[candles.length - 1].close) * 100;
  return p < 2 ? 'LOW' : p > 3.5 ? 'HIGH' : 'MEDIUM';
}

function isGreen(c: Candle): boolean { return c.close > c.open; }

// Detect the "setup" pattern in candles ending at `endIdx` (exclusive of breakout candle)
// Returns: description of what happened in the N candles before
function detectSetup(candles: Candle[], endIdx: number): {
  // Pullback detection (for LONG)
  pullbackDepth: number;       // How much did price drop from local high before breakout?
  pullbackCandles: number;     // How many candles was the pullback?
  pullbackEndIdx: number;      // When did the pullback bottom out?
  // Rally detection (for SHORT)
  rallyHeight: number;
  rallyCandles: number;
  rallyEndIdx: number;
  // BB proximity
  bbDistancePct: number;       // How far from BB upper/lower at each candle?
  bbTouchCandles: number;      // How many candles touched/crossed BB in last 10?
  // Momentum buildup
  rocAcceleration: number;     // ROC change rate (accelerating toward breakout?)
  volumeBuildup: number;       // Volume trend in last 5 candles
  // Squeeze detection
  bbWidth: number;             // Current BB bandwidth
  bbWidthRank: number;         // BB width percentile vs last 50 candles
  // Pattern classification
  patternType: string;
} {
  const lookback = 20;
  const start = Math.max(0, endIdx - lookback);
  const window = candles.slice(start, endIdx + 1);
  const closes = window.map(c => c.close);
  const n = closes.length;

  // --- Pullback: find local high then measure drop ---
  let localHighIdx = 0;
  let localHigh = closes[0];
  for (let i = 1; i < n; i++) {
    if (closes[i] > localHigh) { localHigh = closes[i]; localHighIdx = i; }
  }
  const pullbackDepth = localHighIdx < n - 1
    ? ((localHigh - Math.min(...closes.slice(localHighIdx))) / localHigh) * 100
    : 0;
  const pullbackCandles = n - 1 - localHighIdx;

  // --- Rally: find local low then measure rise ---
  let localLowIdx = 0;
  let localLow = closes[0];
  for (let i = 1; i < n; i++) {
    if (closes[i] < localLow) { localLow = closes[i]; localLowIdx = i; }
  }
  const rallyHeight = localLowIdx < n - 1
    ? ((Math.max(...closes.slice(localLowIdx)) - localLow) / localLow) * 100
    : 0;
  const rallyCandles = n - 1 - localLowIdx;

  // --- BB proximity ---
  const allCloses = candles.slice(Math.max(0, endIdx - 50), endIdx + 1).map(c => c.close);
  const bb = calcBB(allCloses, 20);
  const lastClose = closes[n - 1];
  const bbDistancePct = ((bb.upper - lastClose) / lastClose) * 100;

  let bbTouchCandles = 0;
  for (let i = Math.max(0, n - 10); i < n; i++) {
    const c = window[i];
    const localBB = calcBB(candles.slice(Math.max(0, start + i - 20), start + i + 1).map(x => x.close), 20);
    if (c.high >= localBB.upper * 0.998 || c.low <= localBB.lower * 1.002) bbTouchCandles++;
  }

  // --- ROC acceleration ---
  const roc5now = closes.length >= 6 ? ((closes[n - 1] - closes[n - 6]) / closes[n - 6]) * 100 : 0;
  const roc5prev = closes.length >= 11 ? ((closes[n - 6] - closes[n - 11]) / closes[n - 11]) * 100 : 0;
  const rocAcceleration = roc5now - roc5prev;

  // --- Volume buildup ---
  const last5 = window.slice(-5);
  let volumeBuildup = 1;
  if (last5.length === 5) {
    const firstAvg = (last5[0].volume + last5[1].volume + last5[2].volume) / 3;
    const lastAvg = (last5[3].volume + last5[4].volume) / 2;
    volumeBuildup = firstAvg > 0 ? lastAvg / firstAvg : 1;
  }

  // --- BB squeeze ---
  const bbWidth = (bb.upper - bb.lower) / bb.middle * 100;
  // Rank vs last 50 candles
  const recentWidths: number[] = [];
  for (let i = Math.max(20, endIdx - 50); i <= endIdx; i++) {
    const localBB = calcBB(candles.slice(Math.max(0, i - 20), i + 1).map(x => x.close), 20);
    recentWidths.push((localBB.upper - localBB.lower) / localBB.middle * 100);
  }
  const bbWidthRank = recentWidths.filter(w => w < bbWidth).length / recentWidths.length;

  // --- Pattern classification ---
  let patternType = 'unknown';
  if (pullbackCandles >= 2 && pullbackDepth > 0.5) patternType = 'pullback-launch';
  else if (rallyCandles >= 2 && rallyHeight > 0.5) patternType = 'rally-dump';
  else if (bbWidthRank < 0.2) patternType = 'squeeze-breakout';
  else if (rocAcceleration > 1.0) patternType = 'accelerating';
  else if (volumeBuildup > 1.5) patternType = 'volume-buildup';
  else patternType = 'gradual';

  return {
    pullbackDepth, pullbackCandles, pullbackEndIdx: start + localHighIdx,
    rallyHeight, rallyCandles, rallyEndIdx: start + localLowIdx,
    bbDistancePct, bbTouchCandles,
    rocAcceleration, volumeBuildup,
    bbWidth, bbWidthRank,
    patternType,
  };
}

interface Trade {
  symbol: string; side: 'long' | 'short'; entryIdx: number; entryPrice: number;
  exitPrice: number; pnlPct: number; isWin: boolean; exitReason: string; holdBars: number;
  regime: 'BULL' | 'BEAR';
  setup: ReturnType<typeof detectSetup>;
  // Early entry simulation
  earlyEntries: Array<{
    barsEarly: number;    // 1, 2, 3 candles before breakout
    price: number;        // close price at that candle
    priceDiffPct: number; // % better/worse than breakout entry
    wouldHaveWon: boolean;
    earlyPnlPct: number;  // PnL if entered there instead
    bbDistPct: number;    // distance from BB at early point
  }>;
  // Candle anatomy before breakout
  candleAnatomy: Array<{
    barsBack: number;
    isGreen: boolean;
    bodyPct: number;
    upperWickPct: number;
    lowerWickPct: number;
    volRatio: number;
    bbPosition: number;   // 0 = at lower, 0.5 = middle, 1 = at upper
  }>;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔬 DEEP DIVE: Early Entry Pattern Detection');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const btcData = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcData) { console.error('No BTC data'); process.exit(1); }
  const btcCandles = btcData.candles;
  const btcCloses = btcCandles.map(c => c.close);

  const allCandles: Record<string, Candle[]> = {};
  const availableSymbols: string[] = [];
  for (const sym of SYMBOLS) {
    const data = await loadLocalJsonCandles(sym, '15m');
    if (data && data.candles.length > 200) { allCandles[sym] = data.candles; availableSymbols.push(sym); }
  }
  console.log(`Loaded ${availableSymbols.length} symbols\n`);

  const trades: Trade[] = [];
  const positions: Record<string, {
    side: 'long' | 'short'; entryPrice: number; entryIdx: number; entryTime: number;
    hwm: number; lwm: number; maxPnl: number; regime: 'BULL' | 'BEAR';
    setup: ReturnType<typeof detectSetup>;
    earlyEntries: Trade['earlyEntries'];
    candleAnatomy: Trade['candleAnatomy'];
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

      if (positions[symbol]) {
        const pos = positions[symbol]!;
        const holdBars = idx - pos.entryIdx;
        if (pos.side === 'long') pos.hwm = Math.max(pos.hwm, current.high);
        else pos.lwm = Math.min(pos.lwm, current.low);
        const pnlPct = pos.side === 'long' ? ((current.close - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
        pos.maxPnl = Math.max(pos.maxPnl, pnlPct);

        let shouldExit = false; let exitReason = ''; let exitPrice = current.close;
        if (holdBars >= 192) { shouldExit = true; exitReason = 'TIME_EXIT'; }
        const slPnl = pos.side === 'long' ? ((current.low - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - current.high) / pos.entryPrice) * 100;
        if (slPnl <= -STOP_LOSS_PCT) {
          shouldExit = true; exitReason = 'SL';
          exitPrice = pos.side === 'long' ? pos.entryPrice * (1 - STOP_LOSS_PCT / 100) : pos.entryPrice * (1 + STOP_LOSS_PCT / 100);
        }
        const vr = getVolRegime(candles.slice(Math.max(0, idx - 20), idx + 1));
        const trailAct = vr === 'LOW' ? 0.6 : vr === 'HIGH' ? 1.2 : 0.8;
        const trailDist = vr === 'LOW' ? 0.3 : vr === 'HIGH' ? 0.8 : 0.5;
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

          // Calculate early entry PnLs
          const earlyEntries = pos.earlyEntries.map(ee => {
            const earlyRaw = pos.side === 'long' ? ((exitPrice - ee.price) / ee.price) * 100
              : ((ee.price - exitPrice) / ee.price) * 100;
            const earlyNet = earlyRaw * LEVERAGE - (FEES_BPS / 10000) * LEVERAGE * 2 * 100 - SLIPPAGE_PCT * 2;
            return { ...ee, earlyPnlPct: earlyNet, wouldHaveWon: earlyNet > 0 };
          });

          trades.push({
            symbol, side: pos.side, entryIdx: pos.entryIdx, entryPrice: pos.entryPrice,
            exitPrice, pnlPct: netPnl, isWin: netPnl > 0, exitReason,
            holdBars, regime: pos.regime, setup: pos.setup,
            earlyEntries, candleAnatomy: pos.candleAnatomy,
          });
          positions[symbol] = null; cooldowns[symbol] = 4;
        }
        continue;
      }

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

      const btcWin = btcCandles.slice(Math.max(0, btcIdx - 20), btcIdx + 1);
      const btcAtr = calcATR(btcWin, 14);
      if ((btcAtr / btcCandle.close) * 100 < 0.15) continue;

      // ─── SETUP ANALYSIS ───
      const setup = detectSetup(candles, idx - 1); // analyze candles BEFORE breakout

      // ─── EARLY ENTRY SIMULATION ───
      const earlyEntries: Trade['earlyEntries'] = [];
      for (const barsEarly of [1, 2, 3, 4, 5]) {
        const earlyIdx = idx - barsEarly;
        if (earlyIdx < 20) continue;
        const earlyCandle = candles[earlyIdx];
        const earlyCloses = candles.slice(Math.max(0, earlyIdx - 20), earlyIdx + 1).map(c => c.close);
        const earlyBB = calcBB(earlyCloses, 20);
        const bbDist = signal.side === 'long'
          ? ((earlyBB.upper - earlyCandle.close) / earlyCandle.close) * 100
          : ((earlyCandle.close - earlyBB.lower) / earlyCandle.close) * 100;

        earlyEntries.push({
          barsEarly,
          price: earlyCandle.close,
          priceDiffPct: ((current.close - earlyCandle.close) / earlyCandle.close) * 100,
          wouldHaveWon: false, // filled later
          earlyPnlPct: 0,     // filled later
          bbDistPct: bbDist,
        });
      }

      // ─── CANDLE ANATOMY (last 10 candles before breakout) ───
      const candleAnatomy: Trade['candleAnatomy'] = [];
      for (let back = 1; back <= 10; back++) {
        const ci = idx - back;
        if (ci < 20) continue;
        const c = candles[ci];
        const range = c.high - c.low || 0.0001;
        const body = Math.abs(c.close - c.open);
        const localCloses = candles.slice(Math.max(0, ci - 20), ci + 1).map(x => x.close);
        const localBB = calcBB(localCloses, 20);
        const bbRange = localBB.upper - localBB.lower || 0.0001;
        const bbPos = (c.close - localBB.lower) / bbRange;
        const avgVol = candles.slice(Math.max(0, ci - 20), ci).reduce((s, x) => s + x.volume, 0) / 20;

        candleAnatomy.push({
          barsBack: back,
          isGreen: isGreen(c),
          bodyPct: (body / c.open) * 100,
          upperWickPct: ((c.high - Math.max(c.open, c.close)) / range) * 100,
          lowerWickPct: ((Math.min(c.open, c.close) - c.low) / range) * 100,
          volRatio: avgVol > 0 ? c.volume / avgVol : 1,
          bbPosition: bbPos,
        });
      }

      positions[symbol] = {
        side: signal.side, entryPrice: current.close, entryIdx: idx,
        entryTime: current.timestamp, hwm: current.high, lwm: current.low, maxPnl: 0,
        regime: isBull ? 'BULL' : 'BEAR', setup, earlyEntries, candleAnatomy,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════
  const wins = trades.filter(t => t.isWin).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnlPct, 0);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📊 ${trades.length} trades | ${(wins/trades.length*100).toFixed(1)}% WR | Total ${totalPnl.toFixed(0)}%`);
  console.log(`${'═'.repeat(70)}`);

  // ═══════════════════════════════════════════════════════════════════════
  // 1. SETUP PATTERN TYPE BREAKDOWN
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`📊 PART 1: SETUP PATTERN TYPES`);
  console.log(`${'═'.repeat(70)}`);

  for (const side of ['long', 'short'] as const) {
    const subset = trades.filter(t => t.side === side);
    console.log(`\n  ${side.toUpperCase()} (${subset.length} trades):`);
    const types: Record<string, { count: number; wins: number; pnl: number }> = {};
    for (const t of subset) {
      const tp = t.setup.patternType;
      if (!types[tp]) types[tp] = { count: 0, wins: 0, pnl: 0 };
      types[tp].count++;
      if (t.isWin) types[tp].wins++;
      types[tp].pnl += t.pnlPct;
    }
    for (const [tp, s] of Object.entries(types).sort((a, b) => b[1].count - a[1].count)) {
      console.log(`    ${tp.padEnd(20)}: ${String(s.count).padStart(5)} | WR ${(s.wins/s.count*100).toFixed(1).padStart(5)}% | Avg ${(s.pnl/s.count).toFixed(2)}%`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 2. EARLY ENTRY IMPACT
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`📊 PART 2: EARLY ENTRY SIMULATION`);
  console.log(`  "What if we entered X candles before the breakout?"`);
  console.log(`${'═'.repeat(70)}`);

  for (const side of ['long', 'short'] as const) {
    const subset = trades.filter(t => t.side === side);
    console.log(`\n  ${side.toUpperCase()}:`);
    console.log(`    Baseline: WR ${(subset.filter(t=>t.isWin).length/subset.length*100).toFixed(1)}% | Avg ${(subset.reduce((s,t)=>s+t.pnlPct,0)/subset.length).toFixed(2)}%`);

    for (const barsEarly of [1, 2, 3, 4, 5]) {
      const earlyTrades = subset.filter(t => t.earlyEntries.find(e => e.barsEarly === barsEarly));
      const earlyPnls = earlyTrades.map(t => t.earlyEntries.find(e => e.barsEarly === barsEarly)!);
      const earlyWins = earlyPnls.filter(e => e.wouldHaveWon).length;
      const earlyAvg = earlyPnls.reduce((s, e) => s + e.earlyPnlPct, 0) / earlyPnls.length;
      const avgPriceDiff = earlyPnls.reduce((s, e) => s + e.priceDiffPct, 0) / earlyPnls.length;
      const avgBBDist = earlyPnls.reduce((s, e) => s + e.bbDistPct, 0) / earlyPnls.length;
      console.log(`    -${barsEarly} candles (${barsEarly*15}min): WR ${(earlyWins/earlyPnls.length*100).toFixed(1)}% | Avg ${earlyAvg >= 0 ? '+' : ''}${earlyAvg.toFixed(2)}% | Price diff: ${avgPriceDiff >= 0 ? '+' : ''}${avgPriceDiff.toFixed(3)}% | BB dist: ${avgBBDist.toFixed(3)}%`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 3. EARLY ENTRY BY PATTERN TYPE (where early entry helps most)
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`📊 PART 3: EARLY ENTRY BENEFIT BY SETUP TYPE`);
  console.log(`${'═'.repeat(70)}`);

  for (const side of ['long', 'short'] as const) {
    const subset = trades.filter(t => t.side === side);
    console.log(`\n  ${side.toUpperCase()}:`);

    const patternTypes = [...new Set(subset.map(t => t.setup.patternType))];
    for (const pt of patternTypes) {
      const ptTrades = subset.filter(t => t.setup.patternType === pt);
      if (ptTrades.length < 20) continue;

      const baseAvg = ptTrades.reduce((s, t) => s + t.pnlPct, 0) / ptTrades.length;
      const early2 = ptTrades.filter(t => t.earlyEntries.find(e => e.barsEarly === 2));
      if (early2.length < 10) continue;
      const early2Avg = early2.reduce((s, t) => s + t.earlyEntries.find(e => e.barsEarly === 2)!.earlyPnlPct, 0) / early2.length;
      const improvement = early2Avg - baseAvg;
      console.log(`    ${pt.padEnd(20)}: Base ${baseAvg >= 0 ? '+' : ''}${baseAvg.toFixed(2)}% → Early(-2) ${early2Avg >= 0 ? '+' : ''}${early2Avg.toFixed(2)}% (${improvement >= 0 ? '+' : ''}${improvement.toFixed(2)}pp) [n=${ptTrades.length}]`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 4. BB SQUEEZE → BREAKOUT (anticipatory entry)
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`📊 PART 4: BB SQUEEZE BEFORE BREAKOUT`);
  console.log(`  (Lower bbWidthRank = tighter squeeze before breakout)`);
  console.log(`${'═'.repeat(70)}`);

  const squeezeBuckets = [
    { label: '< 10% (tight squeeze)', min: 0, max: 0.10 },
    { label: '10-25%', min: 0.10, max: 0.25 },
    { label: '25-50%', min: 0.25, max: 0.50 },
    { label: '50-75%', min: 0.50, max: 0.75 },
    { label: '> 75% (wide)', min: 0.75, max: 1.01 },
  ];

  for (const side of ['long', 'short'] as const) {
    const subset = trades.filter(t => t.side === side);
    console.log(`\n  ${side.toUpperCase()}:`);
    for (const bucket of squeezeBuckets) {
      const match = subset.filter(t => t.setup.bbWidthRank >= bucket.min && t.setup.bbWidthRank < bucket.max);
      if (match.length < 10) continue;
      const w = match.filter(t => t.isWin).length;
      const avg = match.reduce((s, t) => s + t.pnlPct, 0) / match.length;
      console.log(`    ${bucket.label.padEnd(22)}: ${String(match.length).padStart(5)} | WR ${(w/match.length*100).toFixed(1).padStart(5)}% | Avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 5. PULLBACK DEPTH vs OUTCOME (for LONGS)
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`📊 PART 5: PULLBACK DEPTH BEFORE LONG BREAKOUT`);
  console.log(`${'═'.repeat(70)}`);

  const longTrades = trades.filter(t => t.side === 'long');
  const pullbackBuckets = [
    { label: '< 0.5% (no pullback)', min: 0, max: 0.5 },
    { label: '0.5-1.0%', min: 0.5, max: 1.0 },
    { label: '1.0-2.0%', min: 1.0, max: 2.0 },
    { label: '2.0-3.0%', min: 2.0, max: 3.0 },
    { label: '> 3.0% (deep pull)', min: 3.0, max: 999 },
  ];

  for (const bucket of pullbackBuckets) {
    const match = longTrades.filter(t => t.setup.pullbackDepth >= bucket.min && t.setup.pullbackDepth < bucket.max);
    if (match.length < 10) continue;
    const w = match.filter(t => t.isWin).length;
    const avg = match.reduce((s, t) => s + t.pnlPct, 0) / match.length;
    const avgCandles = match.reduce((s, t) => s + t.setup.pullbackCandles, 0) / match.length;
    console.log(`  ${bucket.label.padEnd(25)}: ${String(match.length).padStart(5)} | WR ${(w/match.length*100).toFixed(1).padStart(5)}% | Avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% | ~${avgCandles.toFixed(0)} candles`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 6. RALLY HEIGHT BEFORE SHORT BREAKDOWN
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`📊 PART 6: RALLY HEIGHT BEFORE SHORT BREAKDOWN`);
  console.log(`${'═'.repeat(70)}`);

  const shortTrades = trades.filter(t => t.side === 'short');
  const rallyBuckets = [
    { label: '< 0.5% (no rally)', min: 0, max: 0.5 },
    { label: '0.5-1.5%', min: 0.5, max: 1.5 },
    { label: '1.5-3.0%', min: 1.5, max: 3.0 },
    { label: '3.0-5.0%', min: 3.0, max: 5.0 },
    { label: '> 5.0% (big rally)', min: 5.0, max: 999 },
  ];

  for (const bucket of rallyBuckets) {
    const match = shortTrades.filter(t => t.setup.rallyHeight >= bucket.min && t.setup.rallyHeight < bucket.max);
    if (match.length < 10) continue;
    const w = match.filter(t => t.isWin).length;
    const avg = match.reduce((s, t) => s + t.pnlPct, 0) / match.length;
    console.log(`  ${bucket.label.padEnd(25)}: ${String(match.length).padStart(5)} | WR ${(w/match.length*100).toFixed(1).padStart(5)}% | Avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 7. CANDLE ANATOMY: Average candle profile before breakout
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`📊 PART 7: CANDLE ANATOMY BEFORE BREAKOUT (avg across all trades)`);
  console.log(`  Candle profile at each position before breakout`);
  console.log(`${'═'.repeat(70)}`);

  for (const side of ['long', 'short'] as const) {
    const subset = trades.filter(t => t.side === side);
    const winSubset = subset.filter(t => t.isWin);
    const loseSubset = subset.filter(t => !t.isWin);
    console.log(`\n  ${side.toUpperCase()} - WINNERS vs LOSERS:`);
    console.log(`  ${'Bar'.padStart(4)} | ${'Green%'.padStart(7)} W/L | ${'Body%'.padStart(6)} W/L | ${'VolR'.padStart(5)} W/L | ${'BBpos'.padStart(6)} W/L`);
    console.log(`  ${'─'.repeat(65)}`);

    for (let back = 1; back <= 8; back++) {
      const wCandles = winSubset.map(t => t.candleAnatomy.find(c => c.barsBack === back)).filter(Boolean);
      const lCandles = loseSubset.map(t => t.candleAnatomy.find(c => c.barsBack === back)).filter(Boolean);
      if (wCandles.length < 10 || lCandles.length < 10) continue;

      const wGreen = (wCandles.filter(c => c!.isGreen).length / wCandles.length * 100).toFixed(0);
      const lGreen = (lCandles.filter(c => c!.isGreen).length / lCandles.length * 100).toFixed(0);
      const wBody = (wCandles.reduce((s, c) => s + c!.bodyPct, 0) / wCandles.length).toFixed(2);
      const lBody = (lCandles.reduce((s, c) => s + c!.bodyPct, 0) / lCandles.length).toFixed(2);
      const wVol = (wCandles.reduce((s, c) => s + c!.volRatio, 0) / wCandles.length).toFixed(2);
      const lVol = (lCandles.reduce((s, c) => s + c!.volRatio, 0) / lCandles.length).toFixed(2);
      const wBB = (wCandles.reduce((s, c) => s + c!.bbPosition, 0) / wCandles.length).toFixed(2);
      const lBB = (lCandles.reduce((s, c) => s + c!.bbPosition, 0) / lCandles.length).toFixed(2);

      console.log(`    -${back} | ${wGreen.padStart(4)}/${lGreen.padStart(3)}% | ${wBody.padStart(5)}/${lBody}% | ${wVol.padStart(4)}/${lVol} | ${wBB.padStart(5)}/${lBB}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 8. ROC ACCELERATION + VOLUME BUILDUP COMBINED
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`📊 PART 8: ROC ACCELERATION + VOLUME BUILDUP`);
  console.log(`${'═'.repeat(70)}`);

  for (const side of ['long', 'short'] as const) {
    const subset = trades.filter(t => t.side === side);
    console.log(`\n  ${side.toUpperCase()}:`);

    const rocBuckets = [
      { label: 'Decelerating (<-1)', min: -999, max: -1 },
      { label: 'Flat (-1 to +1)', min: -1, max: 1 },
      { label: 'Accelerating (>+1)', min: 1, max: 999 },
    ];
    const volBuckets = [
      { label: 'Fading (<0.8x)', min: 0, max: 0.8 },
      { label: 'Stable (0.8-1.5x)', min: 0.8, max: 1.5 },
      { label: 'Building (>1.5x)', min: 1.5, max: 999 },
    ];

    for (const rb of rocBuckets) {
      for (const vb of volBuckets) {
        const match = subset.filter(t =>
          t.setup.rocAcceleration >= rb.min && t.setup.rocAcceleration < rb.max &&
          t.setup.volumeBuildup >= vb.min && t.setup.volumeBuildup < vb.max
        );
        if (match.length < 15) continue;
        const w = match.filter(t => t.isWin).length;
        const avg = match.reduce((s, t) => s + t.pnlPct, 0) / match.length;
        const label = `${rb.label} + ${vb.label}`;
        console.log(`    ${label.padEnd(42)}: ${String(match.length).padStart(4)} | WR ${(w/match.length*100).toFixed(1).padStart(5)}% | Avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 9. BB TOUCH COUNT (support/resistance test before breakout)
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`📊 PART 9: BB BAND TOUCHES IN LAST 10 CANDLES BEFORE BREAKOUT`);
  console.log(`  (More touches = more "testing" the band before breaking through)`);
  console.log(`${'═'.repeat(70)}`);

  for (const side of ['long', 'short'] as const) {
    const subset = trades.filter(t => t.side === side);
    console.log(`\n  ${side.toUpperCase()}:`);
    for (let touches = 0; touches <= 6; touches++) {
      const match = subset.filter(t => t.setup.bbTouchCandles === touches);
      if (match.length < 15) continue;
      const w = match.filter(t => t.isWin).length;
      const avg = match.reduce((s, t) => s + t.pnlPct, 0) / match.length;
      console.log(`    ${touches} touches: ${String(match.length).padStart(5)} | WR ${(w/match.length*100).toFixed(1).padStart(5)}% | Avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
    }
    // 7+
    const match7 = subset.filter(t => t.setup.bbTouchCandles >= 7);
    if (match7.length >= 10) {
      const w = match7.filter(t => t.isWin).length;
      const avg = match7.reduce((s, t) => s + t.pnlPct, 0) / match7.length;
      console.log(`    7+ touches: ${String(match7.length).padStart(4)} | WR ${(w/match7.length*100).toFixed(1).padStart(5)}% | Avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
    }
  }

  // ═══ SAVE ═══
  const outputPath = path.resolve(process.cwd(), 'scripts', 'research-early-entry-results.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalTrades: trades.length,
    summary: { wins, wr: (wins/trades.length*100).toFixed(1), totalPnl: totalPnl.toFixed(1) },
  }, null, 2));
  console.log(`\n💾 Saved to ${outputPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
