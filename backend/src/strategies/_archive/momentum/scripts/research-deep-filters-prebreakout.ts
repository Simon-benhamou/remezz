/**
 * 🔬 DEEP FILTER ANALYSIS (LONG + SHORT) + PRE-BREAKOUT DETECTOR
 *
 * Part 1: Test ALL filters on BOTH sides (LONG and SHORT)
 *   - Green ratio, alternation, BB touches, pullback/rally, BB squeeze
 *   - Combined filters per side
 *
 * Part 2: Pre-breakout detection using ONLY past data
 *   - At every candle, compute features from past only
 *   - Check if a breakout happens in the next 1-5 candles
 *   - Find which past-only features predict upcoming breakouts
 *   - This is what we CAN compute in live trading
 *
 * Run: npx tsx scripts/research-deep-filters-prebreakout.ts
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  calcSMA, calcROC, calcBB, calcVolRatio, countConsecUp, countConsecDown,
} from '../src/strategies/momentumSimple.js';

// ============================================================================
// TYPES + HELPERS (reused from validate script)
// ============================================================================

type Candle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number; };

function loadCandles(filePath: string): Candle[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.candles ?? []);
  return arr.map((c: any) => {
    if (Array.isArray(c)) return { timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] };
    return { timestamp: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 };
  }).filter((c: Candle) => Number.isFinite(c.timestamp));
}

function calcATR(candles: { high: number; low: number; close: number }[], period: number): number {
  if (candles.length < period + 1) return 0;
  let s = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    s += Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
  }
  return s / period;
}

function isGreen(c: Candle): boolean { return c.close > c.open; }

function getVolRegime(candles: Candle[]): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (candles.length < 15) return 'MEDIUM';
  const atr = calcATR(candles, 14);
  const p = (atr / candles[candles.length - 1].close) * 100;
  return p < 2 ? 'LOW' : p > 3.5 ? 'HIGH' : 'MEDIUM';
}

function greenRatio(candles: Candle[], lb: number): number {
  const w = candles.slice(-lb);
  if (w.length === 0) return 0.5;
  return w.filter(isGreen).length / w.length;
}

function extractTempo(candles: Candle[]) {
  const n = candles.length;
  const dirs = candles.map(c => c.close > c.open);
  let lastRunLen = 1;
  const lastDir = dirs[n - 1];
  for (let i = n - 2; i >= 0; i--) { if (dirs[i] === lastDir) lastRunLen++; else break; }

  const tail5 = dirs.slice(-5);
  let alt5 = 0;
  for (let i = 1; i < tail5.length; i++) if (tail5[i] !== tail5[i - 1]) alt5++;

  let bodyMom = 0;
  for (const c of candles.slice(-5)) bodyMom += (c.close - c.open) / c.open * 100;

  let volTrend = 1;
  const l5 = candles.slice(-5);
  if (l5.length === 5) {
    const fa = (l5[0].volume + l5[1].volume + l5[2].volume) / 3;
    const la = (l5[3].volume + l5[4].volume) / 2;
    volTrend = fa > 0 ? la / fa : 1;
  }

  return { lastRunLen, alt5, bodyMom, volTrend };
}

function detectSetup(candles: Candle[], endIdx: number) {
  const lookback = 20;
  const start = Math.max(0, endIdx - lookback);
  const window = candles.slice(start, endIdx + 1);
  const closes = window.map(c => c.close);
  const n = closes.length;

  let localHighIdx = 0, localHigh = closes[0];
  for (let i = 1; i < n; i++) if (closes[i] > localHigh) { localHigh = closes[i]; localHighIdx = i; }
  const pullbackDepth = localHighIdx < n - 1 ? ((localHigh - Math.min(...closes.slice(localHighIdx))) / localHigh) * 100 : 0;

  let localLowIdx = 0, localLow = closes[0];
  for (let i = 1; i < n; i++) if (closes[i] < localLow) { localLow = closes[i]; localLowIdx = i; }
  const rallyHeight = localLowIdx < n - 1 ? ((Math.max(...closes.slice(localLowIdx)) - localLow) / localLow) * 100 : 0;

  const allCloses = candles.slice(Math.max(0, endIdx - 50), endIdx + 1).map(c => c.close);
  const bb = calcBB(allCloses, 20);
  const bbWidth = (bb.upper - bb.lower) / bb.middle * 100;
  const recentWidths: number[] = [];
  for (let i = Math.max(20, endIdx - 50); i <= endIdx; i++) {
    const lb = calcBB(candles.slice(Math.max(0, i - 20), i + 1).map(x => x.close), 20);
    recentWidths.push((lb.upper - lb.lower) / lb.middle * 100);
  }
  const bbWidthRank = recentWidths.filter(w => w < bbWidth).length / (recentWidths.length || 1);

  let bbTouchCandles = 0;
  for (let i = Math.max(0, n - 10); i < n; i++) {
    const c = window[i];
    const lb = calcBB(candles.slice(Math.max(0, start + i - 20), start + i + 1).map(x => x.close), 20);
    if (c.high >= lb.upper * 0.998 || c.low <= lb.lower * 1.002) bbTouchCandles++;
  }

  const roc5now = closes.length >= 6 ? ((closes[n - 1] - closes[n - 6]) / closes[n - 6]) * 100 : 0;
  const roc5prev = closes.length >= 11 ? ((closes[n - 6] - closes[n - 11]) / closes[n - 11]) * 100 : 0;
  const rocAccel = roc5now - roc5prev;

  let volumeBuildup = 1;
  const last5 = window.slice(-5);
  if (last5.length === 5) {
    const fa = (last5[0].volume + last5[1].volume + last5[2].volume) / 3;
    const la = (last5[3].volume + last5[4].volume) / 2;
    volumeBuildup = fa > 0 ? la / fa : 1;
  }

  // BB position: where is price relative to BB bands (0=lower, 1=upper)
  const bbPos = bb.upper !== bb.lower ? (closes[n - 1] - bb.lower) / (bb.upper - bb.lower) : 0.5;

  return { pullbackDepth, rallyHeight, bbWidthRank, bbTouchCandles, rocAccel, volumeBuildup, bbPos };
}

// ============================================================================
// TRADE INTERFACE
// ============================================================================

interface Trade {
  symbol: string; side: 'long' | 'short'; entryPrice: number; exitPrice: number;
  pnlPct: number; isWin: boolean; exitReason: string; holdBars: number;
  regime: 'BULL' | 'BEAR'; volatility: 'LOW' | 'MEDIUM' | 'HIGH';
  greenRatio10: number; greenRatio5: number;
  alt5: number; bodyMom: number; volTrend: number; lastRunLen: number;
  pullbackDepth: number; rallyHeight: number; bbWidthRank: number; bbTouchCandles: number;
  rocAccel: number; volumeBuildup: number; bbPos: number;
}

const LEVERAGE = 5;
const FEES_BPS = 7;
const SLIPPAGE_PCT = 0.04;
const STOP_LOSS_PCT = 2.5;
const SYMBOLS_BASE = [
  'BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'DOGE_USDT', 'XRP_USDT', 'SUI_USDT',
  'SEI_USDT', 'IMX_USDT', 'AVAX_USDT', 'LINK_USDT', 'ADA_USDT', 'DOT_USDT',
  'LTC_USDT', 'UNI_USDT', 'FTM_USDT', 'SONIC_USDT', 'APT_USDT', 'ATOM_USDT',
  'BCH_USDT', 'OP_USDT', 'NEAR_USDT', 'ARB_USDT',
];

// ============================================================================
// SIMULATION
// ============================================================================

function simulate(btcCandles: Candle[], allCandles: Record<string, Candle[]>): Trade[] {
  const trades: Trade[] = [];
  const btcCloses = btcCandles.map(c => c.close);
  const syms = Object.keys(allCandles);

  const positions: Record<string, {
    side: 'long' | 'short'; entryPrice: number; entryIdx: number;
    hwm: number; lwm: number; maxPnl: number; regime: 'BULL' | 'BEAR';
    greenRatio10: number; greenRatio5: number;
    tempo: ReturnType<typeof extractTempo>;
    setup: ReturnType<typeof detectSetup>; volatility: 'LOW' | 'MEDIUM' | 'HIGH';
  } | null> = {};
  const symbolIdx: Record<string, number> = {};
  const cooldowns: Record<string, number> = {};
  for (const s of syms) { positions[s] = null; symbolIdx[s] = -1; cooldowns[s] = 0; }

  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx + 1), 200);
    if (!btcSma200) continue;
    const isBull = btcCandle.close > btcSma200;

    for (const symbol of syms) {
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
        const pnl = pos.side === 'long' ? ((current.close - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - current.close) / pos.entryPrice) * 100;
        pos.maxPnl = Math.max(pos.maxPnl, pnl);

        let shouldExit = false; let exitReason = ''; let exitPrice = current.close;
        if (holdBars >= 192) { shouldExit = true; exitReason = 'TIME_EXIT'; }
        const slPnl = pos.side === 'long' ? ((current.low - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - current.high) / pos.entryPrice) * 100;
        if (slPnl <= -STOP_LOSS_PCT) {
          shouldExit = true; exitReason = 'SL';
          exitPrice = pos.side === 'long' ? pos.entryPrice * (1 - STOP_LOSS_PCT / 100) : pos.entryPrice * (1 + STOP_LOSS_PCT / 100);
        }
        const vr = getVolRegime(candles.slice(Math.max(0, idx - 20), idx + 1));
        const ta = vr === 'LOW' ? 0.6 : vr === 'HIGH' ? 1.2 : 0.8;
        const td = vr === 'LOW' ? 0.3 : vr === 'HIGH' ? 0.8 : 0.5;
        if (pos.maxPnl >= ta) {
          const tp = pos.side === 'long' ? pos.hwm * (1 - td / 100) : pos.lwm * (1 + td / 100);
          const hit = pos.side === 'long' ? current.low <= tp : current.high >= tp;
          if (hit && !shouldExit) { shouldExit = true; exitReason = 'TRAIL'; exitPrice = tp; }
        }
        if (!shouldExit && isBull !== (pos.side === 'long') && holdBars > 4) { shouldExit = true; exitReason = 'REGIME_CHANGE'; }

        if (shouldExit) {
          const rawPnl = pos.side === 'long' ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
          const netPnl = rawPnl * LEVERAGE - (FEES_BPS / 10000) * LEVERAGE * 2 * 100 - SLIPPAGE_PCT * 2;

          trades.push({
            symbol, side: pos.side, entryPrice: pos.entryPrice, exitPrice,
            pnlPct: netPnl, isWin: netPnl > 0, exitReason, holdBars,
            regime: pos.regime, volatility: pos.volatility,
            greenRatio10: pos.greenRatio10, greenRatio5: pos.greenRatio5,
            ...pos.tempo, ...pos.setup,
          });
          positions[symbol] = null; cooldowns[symbol] = 4;
        }
        continue;
      }

      if (cooldowns[symbol] > 0) continue;
      const wc = candles.slice(Math.max(0, idx - 200), idx + 1);
      const closes = wc.map(c => c.close);
      const volumes = wc.map(c => c.volume);
      const bb = calcBB(closes, 20);
      const roc10 = calcROC(closes, 10) * 100;
      const roc5 = calcROC(closes, 5) * 100;
      const volRatio = calcVolRatio(volumes);
      const ma20 = calcSMA(closes, 20);
      const cu = countConsecUp(wc);
      const cd = countConsecDown(wc);

      let signal: { valid: boolean; side: 'long' | 'short' } = { valid: false, side: 'long' };
      if (isBull) {
        if (current.close > bb.upper && roc10 > 1.75 && volRatio > 1.15 && cu <= 5)
          signal = { valid: true, side: 'long' };
      } else {
        if (roc5 < -1.5 && volRatio > 2.0 && current.close < ma20 && current.close < bb.lower && cd <= 4)
          signal = { valid: true, side: 'short' };
      }
      if (!signal.valid) continue;

      const btcWin = btcCandles.slice(Math.max(0, btcIdx - 20), btcIdx + 1);
      const btcAtr = calcATR(btcWin, 14);
      if ((btcAtr / btcCandle.close) * 100 < 0.15) continue;

      const pre = candles.slice(Math.max(0, idx - 40), idx);
      const gr10 = greenRatio(pre, 10);
      const gr5 = greenRatio(pre, 5);
      const tempo = extractTempo(pre);
      const setup = detectSetup(candles, idx - 1);
      const vol = getVolRegime(wc);

      positions[symbol] = {
        side: signal.side, entryPrice: current.close, entryIdx: idx,
        hwm: current.high, lwm: current.low, maxPnl: 0,
        regime: isBull ? 'BULL' : 'BEAR', volatility: vol,
        greenRatio10: gr10, greenRatio5: gr5, tempo, setup,
      };
    }
  }
  return trades;
}

// ============================================================================
// PRE-BREAKOUT ANALYSIS (past-only features → future breakout)
// ============================================================================

interface PreBreakoutSample {
  // Features (all computed from PAST data only at candle i)
  bbPos: number;         // BB position 0-1
  bbWidthRank: number;   // squeeze rank
  rocAccel: number;      // ROC acceleration
  volumeBuildup: number; // volume trend
  alt5: number;          // alternation
  bodyMom: number;       // body momentum
  greenRatio5: number;
  greenRatio10: number;
  pullbackDepth: number;
  rallyHeight: number;
  bbTouchCandles: number;
  distToBBUpper: number; // % distance to upper BB
  distToBBLower: number; // % distance to lower BB
  roc5: number;
  roc10: number;
  volRatio: number;

  // Outcome: does a breakout happen in the next N candles?
  breakoutLongIn: number; // 0 = no breakout within 5 candles, else candles until breakout
  breakoutShortIn: number;
  // If breakout happens, what's the PnL of that trade?
  breakoutLongPnl: number;
  breakoutShortPnl: number;
}

function analyzePreBreakout(
  btcCandles: Candle[],
  allCandles: Record<string, Candle[]>,
  label: string
): PreBreakoutSample[] {
  const samples: PreBreakoutSample[] = [];
  const btcCloses = btcCandles.map(c => c.close);
  const syms = Object.keys(allCandles);
  const symbolIdx: Record<string, number> = {};
  for (const s of syms) symbolIdx[s] = -1;

  // Sample every 4th BTC candle to keep dataset manageable
  for (let btcIdx = 200; btcIdx < btcCandles.length; btcIdx += 4) {
    const btcCandle = btcCandles[btcIdx];
    const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx + 1), 200);
    if (!btcSma200) continue;
    const isBull = btcCandle.close > btcSma200;

    for (const symbol of syms) {
      const candles = allCandles[symbol];
      let idx = symbolIdx[symbol];
      while (idx + 1 < candles.length && candles[idx + 1].timestamp < btcCandle.timestamp) idx++;
      symbolIdx[symbol] = idx;
      if (idx < 60 || idx >= candles.length - 6) continue;

      const current = candles[idx];
      const wc = candles.slice(Math.max(0, idx - 200), idx + 1);
      const closes = wc.map(c => c.close);
      const volumes = wc.map(c => c.volume);

      // === PAST-ONLY FEATURES at candle idx ===
      const bb = calcBB(closes, 20);
      const roc10 = calcROC(closes, 10) * 100;
      const roc5v = calcROC(closes, 5) * 100;
      const volRatio = calcVolRatio(volumes);
      const pre = candles.slice(Math.max(0, idx - 40), idx);
      const gr10 = greenRatio(pre, 10);
      const gr5 = greenRatio(pre, 5);
      const tempo = extractTempo(pre);
      const setup = detectSetup(candles, idx);

      const distUpper = ((bb.upper - current.close) / current.close) * 100;
      const distLower = ((current.close - bb.lower) / current.close) * 100;

      // === FUTURE: check if breakout happens in next 1-5 candles ===
      let breakoutLongIn = 0;
      let breakoutShortIn = 0;
      let breakoutLongPnl = 0;
      let breakoutShortPnl = 0;

      for (let ahead = 1; ahead <= 5; ahead++) {
        const fi = idx + ahead;
        if (fi >= candles.length) break;
        const futureSlice = candles.slice(Math.max(0, fi - 200), fi + 1);
        const futCloses = futureSlice.map(c => c.close);
        const futVolumes = futureSlice.map(c => c.volume);
        const futBB = calcBB(futCloses, 20);
        const futRoc10 = calcROC(futCloses, 10) * 100;
        const futRoc5 = calcROC(futCloses, 5) * 100;
        const futVolRatio = calcVolRatio(futVolumes);
        const futMa20 = calcSMA(futCloses, 20);
        const futCu = countConsecUp(futureSlice);
        const futCd = countConsecDown(futureSlice);
        const futCandle = candles[fi];

        // Check LONG breakout condition
        if (breakoutLongIn === 0 && isBull &&
            futCandle.close > futBB.upper && futRoc10 > 1.75 && futVolRatio > 1.15 && futCu <= 5) {
          breakoutLongIn = ahead;
          // Simulate quick PnL: next 10 candles after breakout
          const entryPrice = futCandle.close;
          let maxPnl = 0;
          let finalPnl = 0;
          for (let j = 1; j <= 10 && fi + j < candles.length; j++) {
            const pnl = ((candles[fi + j].close - entryPrice) / entryPrice) * 100;
            maxPnl = Math.max(maxPnl, pnl);
            finalPnl = pnl;
            if (pnl <= -STOP_LOSS_PCT) { finalPnl = -STOP_LOSS_PCT; break; }
          }
          breakoutLongPnl = finalPnl * LEVERAGE - (FEES_BPS / 10000) * LEVERAGE * 2 * 100 - SLIPPAGE_PCT * 2;
        }
        // Check SHORT breakout condition
        if (breakoutShortIn === 0 && !isBull && futMa20 &&
            futRoc5 < -1.5 && futVolRatio > 2.0 && futCandle.close < futMa20 && futCandle.close < futBB.lower && futCd <= 4) {
          breakoutShortIn = ahead;
          const entryPrice = futCandle.close;
          let finalPnl = 0;
          for (let j = 1; j <= 10 && fi + j < candles.length; j++) {
            const pnl = ((entryPrice - candles[fi + j].close) / entryPrice) * 100;
            finalPnl = pnl;
            if (pnl <= -STOP_LOSS_PCT) { finalPnl = -STOP_LOSS_PCT; break; }
          }
          breakoutShortPnl = finalPnl * LEVERAGE - (FEES_BPS / 10000) * LEVERAGE * 2 * 100 - SLIPPAGE_PCT * 2;
        }
      }

      samples.push({
        bbPos: setup.bbPos,
        bbWidthRank: setup.bbWidthRank,
        rocAccel: setup.rocAccel,
        volumeBuildup: setup.volumeBuildup,
        alt5: tempo.alt5,
        bodyMom: tempo.bodyMom,
        greenRatio5: gr5,
        greenRatio10: gr10,
        pullbackDepth: setup.pullbackDepth,
        rallyHeight: setup.rallyHeight,
        bbTouchCandles: setup.bbTouchCandles,
        distToBBUpper: distUpper,
        distToBBLower: distLower,
        roc5: roc5v,
        roc10,
        volRatio,
        breakoutLongIn,
        breakoutShortIn,
        breakoutLongPnl,
        breakoutShortPnl,
      });
    }
  }
  return samples;
}

// ============================================================================
// PRINT HELPERS
// ============================================================================

type DatasetResult = { label: string; trades: Trade[] };

function printSection(title: string) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`📊 ${title}`);
  console.log(`${'═'.repeat(80)}`);
}

function printRow(label: string, trades: Trade[], filter: (t: Trade) => boolean, base?: (t: Trade) => boolean) {
  const pool = base ? trades.filter(base) : trades;
  const f = pool.filter(filter);
  const w = f.filter(t => t.isWin).length;
  const l = f.length - w;
  const pnl = f.reduce((s, t) => s + t.pnlPct, 0);
  const avg = f.length > 0 ? pnl / f.length : 0;
  console.log(`    ${label.padEnd(35)} ${String(f.length).padStart(5)} tr | ${w}W/${l}L | WR ${f.length > 0 ? (w/f.length*100).toFixed(1) : '  0.0'}% | Avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% | Tot ${pnl.toFixed(0)}%`);
}

function printCompare2(label: string, ds1: Trade[], ds2: Trade[], filter: (t: Trade) => boolean, base?: (t: Trade) => boolean) {
  const calc = (trades: Trade[]) => {
    const pool = base ? trades.filter(base) : trades;
    const f = pool.filter(filter);
    const w = f.filter(t => t.isWin).length;
    const pnl = f.reduce((s, t) => s + t.pnlPct, 0);
    return { n: f.length, w, l: f.length - w, wr: f.length > 0 ? w/f.length*100 : 0, avg: f.length > 0 ? pnl/f.length : 0, tot: pnl };
  };
  const r1 = calc(ds1);
  const r2 = calc(ds2);
  const delta = r1.wr - r2.wr;
  const consistent = (r1.wr > 66 && r2.wr > 66) || (r1.wr < 60 && r2.wr < 60);
  const tag = consistent ? '✅' : Math.abs(delta) > 8 ? '❌' : '⚠️';
  console.log(`  ${tag} ${label}`);
  console.log(`      2024: ${r1.n}tr ${r1.w}W/${r1.l}L WR${r1.wr.toFixed(1)}% Avg${r1.avg >= 0 ? '+' : ''}${r1.avg.toFixed(2)}% Tot${r1.tot.toFixed(0)}%`);
  console.log(`      2025: ${r2.n}tr ${r2.w}W/${r2.l}L WR${r2.wr.toFixed(1)}% Avg${r2.avg >= 0 ? '+' : ''}${r2.avg.toFixed(2)}% Tot${r2.tot.toFixed(0)}%`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('🔬 DEEP FILTER ANALYSIS (LONG+SHORT) + PRE-BREAKOUT DETECTOR');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const dataDir = path.resolve(process.cwd(), 'data');
  const dataDir2024 = path.join(dataDir, '2024');

  // Load both datasets
  const btc2025 = loadCandles(path.join(dataDir, 'BTC_USDT_15m.json'));
  const all2025: Record<string, Candle[]> = {};
  const btc2024 = loadCandles(path.join(dataDir2024, 'BTC_USDT_15m.json'));
  const all2024: Record<string, Candle[]> = {};
  for (const sym of SYMBOLS_BASE) {
    const c25 = loadCandles(path.join(dataDir, `${sym}_15m.json`));
    if (c25.length > 200) all2025[sym] = c25;
    const c24 = loadCandles(path.join(dataDir2024, `${sym}_15m.json`));
    if (c24.length > 200) all2024[sym] = c24;
  }

  console.log(`2024: BTC ${btc2024.length} candles, ${Object.keys(all2024).length} symbols`);
  console.log(`2025: BTC ${btc2025.length} candles, ${Object.keys(all2025).length} symbols`);

  console.log('\nSimulating 2024...');
  const t24 = simulate(btc2024, all2024);
  console.log(`  → ${t24.length} trades (${t24.filter(t=>t.side==='long').length} LONG, ${t24.filter(t=>t.side==='short').length} SHORT)`);

  console.log('Simulating 2025...');
  const t25 = simulate(btc2025, all2025);
  console.log(`  → ${t25.length} trades (${t25.filter(t=>t.side==='long').length} LONG, ${t25.filter(t=>t.side==='short').length} SHORT)`);

  // =========================================================================
  // PART 1: DEEP FILTER ANALYSIS — LONG
  // =========================================================================

  printSection('PART 1a: LONG FILTERS (2024 vs 2025)');

  console.log('\n  --- Green Ratio (LONG) ---');
  for (const [lo, hi, label] of [[0, 0.3, 'GR10 0-30%'], [0.3, 0.5, 'GR10 30-50%'], [0.5, 0.7, 'GR10 50-70%'], [0.7, 1.01, 'GR10 70-100%']] as [number,number,string][]) {
    printCompare2(`LONG ${label}`, t24, t25, t => t.greenRatio10 >= lo && t.greenRatio10 < hi, t => t.side === 'long');
  }

  console.log('\n  --- Alternation (LONG) ---');
  for (const a of [0, 1, 2, 3, 4]) {
    printCompare2(`LONG alt5=${a}`, t24, t25, t => t.alt5 === a, t => t.side === 'long');
  }

  console.log('\n  --- BB Touches (LONG) ---');
  for (const n of [0, 1, 2, 3, 4, 5]) {
    printCompare2(`LONG ${n} touches`, t24, t25, t => t.bbTouchCandles === n, t => t.side === 'long');
  }
  printCompare2('LONG 6+ touches', t24, t25, t => t.bbTouchCandles >= 6, t => t.side === 'long');

  console.log('\n  --- Pullback Depth (LONG) ---');
  for (const [lo, hi, label] of [[0, 0.5, '<0.5%'], [0.5, 1, '0.5-1%'], [1, 2, '1-2%'], [2, 3, '2-3%'], [3, 999, '>3%']] as [number,number,string][]) {
    printCompare2(`LONG PB ${label}`, t24, t25, t => t.pullbackDepth >= lo && t.pullbackDepth < hi, t => t.side === 'long');
  }

  console.log('\n  --- BB Squeeze (LONG) ---');
  for (const [lo, hi, label] of [[0, 0.1, '<10%'], [0.1, 0.25, '10-25%'], [0.25, 0.5, '25-50%'], [0.5, 1.01, '>50%']] as [number,number,string][]) {
    printCompare2(`LONG squeeze ${label}`, t24, t25, t => t.bbWidthRank >= lo && t.bbWidthRank < hi, t => t.side === 'long');
  }

  console.log('\n  --- Volume Buildup (LONG) ---');
  for (const [lo, hi, label] of [[0, 0.8, 'volBuild <0.8'], [0.8, 1.2, 'volBuild 0.8-1.2'], [1.2, 1.6, 'volBuild 1.2-1.6'], [1.6, 999, 'volBuild >1.6']] as [number,number,string][]) {
    printCompare2(`LONG ${label}`, t24, t25, t => t.volumeBuildup >= lo && t.volumeBuildup < hi, t => t.side === 'long');
  }

  console.log('\n  --- ROC Acceleration (LONG) ---');
  for (const [lo, hi, label] of [[-999, 0, 'rocAccel <0'], [0, 1, 'rocAccel 0-1'], [1, 3, 'rocAccel 1-3'], [3, 999, 'rocAccel >3']] as [number,number,string][]) {
    printCompare2(`LONG ${label}`, t24, t25, t => t.rocAccel >= lo && t.rocAccel < hi, t => t.side === 'long');
  }

  // =========================================================================
  // PART 1b: DEEP FILTER ANALYSIS — SHORT
  // =========================================================================

  printSection('PART 1b: SHORT FILTERS (2024 vs 2025)');

  console.log('\n  --- Green Ratio (SHORT) ---');
  for (const [lo, hi, label] of [[0, 0.3, 'GR10 0-30%'], [0.3, 0.5, 'GR10 30-50%'], [0.5, 0.7, 'GR10 50-70%'], [0.7, 1.01, 'GR10 70-100%']] as [number,number,string][]) {
    printCompare2(`SHORT ${label}`, t24, t25, t => t.greenRatio10 >= lo && t.greenRatio10 < hi, t => t.side === 'short');
  }

  console.log('\n  --- Alternation (SHORT) ---');
  for (const a of [0, 1, 2, 3, 4]) {
    printCompare2(`SHORT alt5=${a}`, t24, t25, t => t.alt5 === a, t => t.side === 'short');
  }

  console.log('\n  --- BB Touches (SHORT) ---');
  for (const n of [0, 1, 2, 3, 4, 5]) {
    printCompare2(`SHORT ${n} touches`, t24, t25, t => t.bbTouchCandles === n, t => t.side === 'short');
  }
  printCompare2('SHORT 6+ touches', t24, t25, t => t.bbTouchCandles >= 6, t => t.side === 'short');

  console.log('\n  --- Rally Height (SHORT) ---');
  for (const [lo, hi, label] of [[0, 0.5, '<0.5%'], [0.5, 1.5, '0.5-1.5%'], [1.5, 3, '1.5-3%'], [3, 999, '>3%']] as [number,number,string][]) {
    printCompare2(`SHORT Rally ${label}`, t24, t25, t => t.rallyHeight >= lo && t.rallyHeight < hi, t => t.side === 'short');
  }

  console.log('\n  --- BB Squeeze (SHORT) ---');
  for (const [lo, hi, label] of [[0, 0.1, '<10%'], [0.1, 0.25, '10-25%'], [0.25, 0.5, '25-50%'], [0.5, 1.01, '>50%']] as [number,number,string][]) {
    printCompare2(`SHORT squeeze ${label}`, t24, t25, t => t.bbWidthRank >= lo && t.bbWidthRank < hi, t => t.side === 'short');
  }

  console.log('\n  --- Volume Buildup (SHORT) ---');
  for (const [lo, hi, label] of [[0, 0.8, 'volBuild <0.8'], [0.8, 1.2, 'volBuild 0.8-1.2'], [1.2, 1.6, 'volBuild 1.2-1.6'], [1.6, 999, 'volBuild >1.6']] as [number,number,string][]) {
    printCompare2(`SHORT ${label}`, t24, t25, t => t.volumeBuildup >= lo && t.volumeBuildup < hi, t => t.side === 'short');
  }

  console.log('\n  --- ROC Acceleration (SHORT) ---');
  for (const [lo, hi, label] of [[-999, -3, 'rocAccel <-3'], [-3, -1, 'rocAccel -3 to -1'], [-1, 0, 'rocAccel -1 to 0'], [0, 999, 'rocAccel >0']] as [number,number,string][]) {
    printCompare2(`SHORT ${label}`, t24, t25, t => t.rocAccel >= lo && t.rocAccel < hi, t => t.side === 'short');
  }

  console.log('\n  --- Body Momentum (SHORT) ---');
  for (const [lo, hi, label] of [[-999, -1, 'bodyMom <-1%'], [-1, 0, 'bodyMom -1 to 0%'], [0, 1, 'bodyMom 0 to 1%'], [1, 999, 'bodyMom >1%']] as [number,number,string][]) {
    printCompare2(`SHORT ${label}`, t24, t25, t => t.bodyMom >= lo && t.bodyMom < hi, t => t.side === 'short');
  }

  // =========================================================================
  // PART 1c: COMBINED FILTERS (LONG + SHORT)
  // =========================================================================

  printSection('PART 1c: COMBINED FILTERS');

  type Filter = { name: string; fn: (t: Trade) => boolean };
  const combos: Filter[] = [
    { name: 'Baseline (all)', fn: () => true },
    // LONG filters
    { name: 'L1: Skip LONG GR10>=0.70', fn: t => !(t.side === 'long' && t.greenRatio10 >= 0.70) },
    { name: 'L2: L1 + skip LONG alt5>=3', fn: t => !(t.side === 'long' && t.greenRatio10 >= 0.70) && !(t.side === 'long' && t.alt5 >= 3) },
    { name: 'L3: L2 + skip LONG 0-touch', fn: t => !(t.side === 'long' && t.greenRatio10 >= 0.70) && !(t.side === 'long' && t.alt5 >= 3) && !(t.side === 'long' && t.bbTouchCandles === 0) },
    // SHORT filters (tested independently)
    { name: 'S1: Skip SHORT GR10<=0.30', fn: t => !(t.side === 'short' && t.greenRatio10 <= 0.30) },
    { name: 'S2: Skip SHORT alt5>=3', fn: t => !(t.side === 'short' && t.alt5 >= 3) },
    { name: 'S3: Skip SHORT volBuild<0.8', fn: t => !(t.side === 'short' && t.volumeBuildup < 0.8) },
    { name: 'S4: Skip SHORT rocAccel>0', fn: t => !(t.side === 'short' && t.rocAccel > 0) },
    // Combined LONG + SHORT
    { name: 'COMBO1: L3 + S2', fn: t => {
      if (t.side === 'long') return t.greenRatio10 < 0.70 && t.alt5 < 3 && t.bbTouchCandles > 0;
      if (t.side === 'short') return t.alt5 < 3;
      return true;
    }},
    { name: 'COMBO2: L3 + S4', fn: t => {
      if (t.side === 'long') return t.greenRatio10 < 0.70 && t.alt5 < 3 && t.bbTouchCandles > 0;
      if (t.side === 'short') return t.rocAccel <= 0;
      return true;
    }},
    { name: 'COMBO3: L3 + S2 + S4', fn: t => {
      if (t.side === 'long') return t.greenRatio10 < 0.70 && t.alt5 < 3 && t.bbTouchCandles > 0;
      if (t.side === 'short') return t.alt5 < 3 && t.rocAccel <= 0;
      return true;
    }},
  ];

  for (const f of combos) {
    const calc = (trades: Trade[]) => {
      const kept = trades.filter(f.fn);
      const skipped = trades.length - kept.length;
      const w = kept.filter(t => t.isWin).length;
      const pnl = kept.reduce((s, t) => s + t.pnlPct, 0);
      const skW = trades.filter(t => !f.fn(t) && t.isWin).length;
      return { n: kept.length, skipped, skW, skL: skipped - skW, wr: kept.length > 0 ? w/kept.length*100 : 0, avg: kept.length > 0 ? pnl/kept.length : 0, tot: pnl };
    };
    const r24 = calc(t24);
    const r25 = calc(t25);
    console.log(`\n  ${f.name}`);
    console.log(`    2024: ${r24.n}tr (skip ${r24.skipped}: ${r24.skW}W/${r24.skL}L) | WR ${r24.wr.toFixed(1)}% | Avg ${r24.avg >= 0?'+':''}${r24.avg.toFixed(2)}% | Tot ${r24.tot.toFixed(0)}%`);
    console.log(`    2025: ${r25.n}tr (skip ${r25.skipped}: ${r25.skW}W/${r25.skL}L) | WR ${r25.wr.toFixed(1)}% | Avg ${r25.avg >= 0?'+':''}${r25.avg.toFixed(2)}% | Tot ${r25.tot.toFixed(0)}%`);
  }

  // =========================================================================
  // PART 2: PRE-BREAKOUT ANALYSIS (past-only features)
  // =========================================================================

  printSection('PART 2: PRE-BREAKOUT DETECTION (past-only features)');
  console.log('\n  Scanning for pre-breakout patterns using ONLY past data...');
  console.log('  (at each candle, compute features from past, check if breakout in next 1-5 candles)\n');

  console.log('  Analyzing 2024...');
  const pb24 = analyzePreBreakout(btc2024, all2024, '2024');
  console.log(`    ${pb24.length} samples, ${pb24.filter(s=>s.breakoutLongIn>0).length} long breakouts, ${pb24.filter(s=>s.breakoutShortIn>0).length} short breakouts`);

  console.log('  Analyzing 2025...');
  const pb25 = analyzePreBreakout(btc2025, all2025, '2025');
  console.log(`    ${pb25.length} samples, ${pb25.filter(s=>s.breakoutLongIn>0).length} long breakouts, ${pb25.filter(s=>s.breakoutShortIn>0).length} short breakouts`);

  // Analyze which features predict breakouts
  const analyzeFeature = (
    samples: PreBreakoutSample[],
    featureName: string,
    featureFn: (s: PreBreakoutSample) => number,
    buckets: { label: string; min: number; max: number }[],
    side: 'long' | 'short'
  ) => {
    const breakoutKey = side === 'long' ? 'breakoutLongIn' : 'breakoutShortIn';
    const pnlKey = side === 'long' ? 'breakoutLongPnl' : 'breakoutShortPnl';

    for (const b of buckets) {
      const subset = samples.filter(s => featureFn(s) >= b.min && featureFn(s) < b.max);
      if (subset.length < 20) continue;
      const hasBreakout = subset.filter(s => s[breakoutKey] > 0);
      const rate = (hasBreakout.length / subset.length * 100).toFixed(2);
      const avgPnl = hasBreakout.length > 0 ? hasBreakout.reduce((s, x) => s + x[pnlKey], 0) / hasBreakout.length : 0;
      const avgBars = hasBreakout.length > 0 ? hasBreakout.reduce((s, x) => s + x[breakoutKey], 0) / hasBreakout.length : 0;
      console.log(`      ${b.label.padEnd(22)} ${subset.length} samples | ${rate}% breakout rate | avg ${avgBars.toFixed(1)} bars | avg PnL ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%`);
    }
  };

  for (const [ds, label] of [[pb24, '2024'], [pb25, '2025']] as [PreBreakoutSample[], string][]) {
    for (const side of ['long', 'short'] as const) {
      console.log(`\n  === ${label} ${side.toUpperCase()} PRE-BREAKOUT ===`);

      console.log(`\n    BB Position (how close to breakout band):`);
      const bbBuckets = side === 'long'
        ? [{ label: 'bbPos 0.6-0.7', min: 0.6, max: 0.7 }, { label: 'bbPos 0.7-0.8', min: 0.7, max: 0.8 }, { label: 'bbPos 0.8-0.9', min: 0.8, max: 0.9 }, { label: 'bbPos 0.9-1.0', min: 0.9, max: 1.0 }, { label: 'bbPos >1.0', min: 1.0, max: 999 }]
        : [{ label: 'bbPos <0.0', min: -999, max: 0 }, { label: 'bbPos 0.0-0.1', min: 0.0, max: 0.1 }, { label: 'bbPos 0.1-0.2', min: 0.1, max: 0.2 }, { label: 'bbPos 0.2-0.3', min: 0.2, max: 0.3 }, { label: 'bbPos 0.3-0.4', min: 0.3, max: 0.4 }];
      analyzeFeature(ds, 'bbPos', s => s.bbPos, bbBuckets, side);

      console.log(`\n    Distance to BB (% to breakout band):`);
      const distBuckets = side === 'long'
        ? [{ label: 'dist <0.2%', min: -999, max: 0.2 }, { label: 'dist 0.2-0.5%', min: 0.2, max: 0.5 }, { label: 'dist 0.5-1%', min: 0.5, max: 1.0 }, { label: 'dist 1-2%', min: 1.0, max: 2.0 }, { label: 'dist >2%', min: 2.0, max: 999 }]
        : [{ label: 'dist <0.2%', min: -999, max: 0.2 }, { label: 'dist 0.2-0.5%', min: 0.2, max: 0.5 }, { label: 'dist 0.5-1%', min: 0.5, max: 1.0 }, { label: 'dist 1-2%', min: 1.0, max: 2.0 }, { label: 'dist >2%', min: 2.0, max: 999 }];
      analyzeFeature(ds, 'distBB', s => side === 'long' ? s.distToBBUpper : s.distToBBLower, distBuckets, side);

      console.log(`\n    BB Squeeze (width rank):`);
      analyzeFeature(ds, 'squeeze', s => s.bbWidthRank,
        [{ label: '<10% (tight)', min: 0, max: 0.1 }, { label: '10-25%', min: 0.1, max: 0.25 }, { label: '25-50%', min: 0.25, max: 0.5 }, { label: '>50%', min: 0.5, max: 1.01 }], side);

      console.log(`\n    ROC10 (momentum building?):`);
      const rocBuckets = side === 'long'
        ? [{ label: 'roc10 <0', min: -999, max: 0 }, { label: 'roc10 0-1', min: 0, max: 1 }, { label: 'roc10 1-1.75', min: 1, max: 1.75 }, { label: 'roc10 >1.75', min: 1.75, max: 999 }]
        : [{ label: 'roc10 >0', min: 0, max: 999 }, { label: 'roc10 -1 to 0', min: -1, max: 0 }, { label: 'roc10 -2 to -1', min: -2, max: -1 }, { label: 'roc10 <-2', min: -999, max: -2 }];
      analyzeFeature(ds, 'roc10', s => s.roc10, rocBuckets, side);

      console.log(`\n    Volume Ratio (volume already building?):`);
      analyzeFeature(ds, 'volRatio', s => s.volRatio,
        [{ label: 'volR <0.8', min: 0, max: 0.8 }, { label: 'volR 0.8-1.15', min: 0.8, max: 1.15 }, { label: 'volR 1.15-1.5', min: 1.15, max: 1.5 }, { label: 'volR >1.5', min: 1.5, max: 999 }], side);

      console.log(`\n    ROC Acceleration:`);
      analyzeFeature(ds, 'rocAccel', s => s.rocAccel,
        [{ label: 'accel <-1', min: -999, max: -1 }, { label: 'accel -1 to 0', min: -1, max: 0 }, { label: 'accel 0 to 1', min: 0, max: 1 }, { label: 'accel >1', min: 1, max: 999 }], side);

      console.log(`\n    Volume Buildup (last 5 candles trend):`);
      analyzeFeature(ds, 'volBuild', s => s.volumeBuildup,
        [{ label: 'vBuild <0.8', min: 0, max: 0.8 }, { label: 'vBuild 0.8-1.2', min: 0.8, max: 1.2 }, { label: 'vBuild 1.2-1.6', min: 1.2, max: 1.6 }, { label: 'vBuild >1.6', min: 1.6, max: 999 }], side);

      console.log(`\n    Alternation rate (trending vs choppy):`);
      analyzeFeature(ds, 'alt5', s => s.alt5,
        [{ label: 'alt5=0 (trending)', min: 0, max: 1 }, { label: 'alt5=1', min: 1, max: 2 }, { label: 'alt5=2', min: 2, max: 3 }, { label: 'alt5=3+', min: 3, max: 999 }], side);

      console.log(`\n    Green Ratio 10:`);
      analyzeFeature(ds, 'gr10', s => s.greenRatio10,
        [{ label: 'GR10 0-30%', min: 0, max: 0.3 }, { label: 'GR10 30-50%', min: 0.3, max: 0.5 }, { label: 'GR10 50-70%', min: 0.5, max: 0.7 }, { label: 'GR10 70-100%', min: 0.7, max: 1.01 }], side);

      // Combined pre-breakout conditions
      console.log(`\n    🎯 COMBINED PRE-BREAKOUT CONDITIONS:`);
      const allSamples = ds;
      const breakoutKey = side === 'long' ? 'breakoutLongIn' : 'breakoutShortIn';
      const pnlKey = side === 'long' ? 'breakoutLongPnl' : 'breakoutShortPnl';

      const comboPB = [
        { name: 'Close to BB + momentum building',
          fn: (s: PreBreakoutSample) => side === 'long'
            ? s.distToBBUpper < 0.5 && s.roc10 > 1.0 && s.volRatio > 0.8
            : s.distToBBLower < 0.5 && s.roc10 < -1.0 && s.volRatio > 0.8
        },
        { name: 'Close to BB + squeeze + vol building',
          fn: (s: PreBreakoutSample) => side === 'long'
            ? s.distToBBUpper < 0.5 && s.bbWidthRank < 0.25 && s.volumeBuildup > 1.0
            : s.distToBBLower < 0.5 && s.bbWidthRank < 0.25 && s.volumeBuildup > 1.0
        },
        { name: 'Close to BB + trending (alt5<=1)',
          fn: (s: PreBreakoutSample) => side === 'long'
            ? s.distToBBUpper < 0.5 && s.alt5 <= 1
            : s.distToBBLower < 0.5 && s.alt5 <= 1
        },
        { name: 'Close to BB + ROC accel + vol buildup',
          fn: (s: PreBreakoutSample) => side === 'long'
            ? s.distToBBUpper < 0.5 && s.rocAccel > 0.5 && s.volumeBuildup > 1.0
            : s.distToBBLower < 0.5 && s.rocAccel < -0.5 && s.volumeBuildup > 1.0
        },
        { name: 'Very close (<0.2%) + any momentum',
          fn: (s: PreBreakoutSample) => side === 'long'
            ? s.distToBBUpper < 0.2 && s.roc10 > 0.5
            : s.distToBBLower < 0.2 && s.roc10 < -0.5
        },
        { name: 'ALL: close+squeeze+trend+vol+accel',
          fn: (s: PreBreakoutSample) => side === 'long'
            ? s.distToBBUpper < 0.5 && s.bbWidthRank < 0.3 && s.alt5 <= 1 && s.volumeBuildup > 1.0 && s.rocAccel > 0
            : s.distToBBLower < 0.5 && s.bbWidthRank < 0.3 && s.alt5 <= 1 && s.volumeBuildup > 1.0 && s.rocAccel < 0
        },
      ];

      for (const combo of comboPB) {
        const subset = allSamples.filter(combo.fn);
        if (subset.length < 5) { console.log(`      ${combo.name}: too few samples (${subset.length})`); continue; }
        const hasBO = subset.filter(s => s[breakoutKey] > 0);
        const rate = (hasBO.length / subset.length * 100).toFixed(1);
        const avgPnl = hasBO.length > 0 ? hasBO.reduce((s, x) => s + x[pnlKey], 0) / hasBO.length : 0;
        const avgBars = hasBO.length > 0 ? hasBO.reduce((s, x) => s + x[breakoutKey], 0) / hasBO.length : 0;
        const noBO = subset.length - hasBO.length;
        console.log(`      ${combo.name}`);
        console.log(`        ${subset.length} samples | ${hasBO.length} breakouts (${rate}%) | avg ${avgBars.toFixed(1)} bars | avg PnL ${avgPnl >= 0?'+':''}${avgPnl.toFixed(2)}% | ${noBO} false positives`);
      }
    }
  }

  console.log('\n\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
