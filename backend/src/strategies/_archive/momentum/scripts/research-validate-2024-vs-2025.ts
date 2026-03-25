/**
 * 🔬 OUT-OF-SAMPLE VALIDATION: 2024 vs 2025
 *
 * Validates ALL findings from previous research on 2024 data (out-of-sample)
 * and compares side-by-side with 2025 results.
 *
 * Findings to validate:
 * 1. Green Ratio filter (skip LONG w/ greenRatio10 >= 0.70)
 * 2. Tempo patterns (3D-1U, 2U-1D, alternation rate)
 * 3. Early entry simulation (-1 to -5 candles)
 * 4. BB Squeeze + Touch Count
 * 5. Pullback depth (LONG) / Rally height (SHORT)
 * 6. ROC Acceleration + Volume Buildup
 *
 * Run: npx tsx scripts/research-validate-2024-vs-2025.ts
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  calcSMA, calcROC, calcBB, calcVolRatio, countConsecUp, countConsecDown,
} from '../src/strategies/momentumSimple.js';

// ============================================================================
// TYPES + HELPERS
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
  const lastRunDir: 'up' | 'down' = lastDir ? 'up' : 'down';

  let prevRunStart = n - lastRunLen - 1;
  let prevRunLen = 0;
  let prevRunDir: 'up' | 'down' | 'flat' = 'flat';
  if (prevRunStart >= 0) {
    const pDir = dirs[prevRunStart];
    prevRunLen = 1; prevRunDir = pDir ? 'up' : 'down';
    for (let i = prevRunStart - 1; i >= 0; i--) { if (dirs[i] === pDir) prevRunLen++; else break; }
  }
  const pLabel = prevRunLen > 0 ? `${prevRunLen}${prevRunDir === 'up' ? 'U' : 'D'}` : '';
  const lLabel = `${lastRunLen}${lastRunDir === 'up' ? 'U' : 'D'}`;
  const pattern = pLabel ? `${pLabel}-${lLabel}` : lLabel;

  const tail5 = dirs.slice(-5);
  let alt5 = 0;
  for (let i = 1; i < tail5.length; i++) if (tail5[i] !== tail5[i - 1]) alt5++;
  const tail10 = dirs.slice(-10);
  let alt10 = 0;
  for (let i = 1; i < tail10.length; i++) if (tail10[i] !== tail10[i - 1]) alt10++;

  let bodyMom = 0;
  for (const c of candles.slice(-5)) bodyMom += (c.close - c.open) / c.open * 100;

  let volTrend = 1;
  const l5 = candles.slice(-5);
  if (l5.length === 5) {
    const fa = (l5[0].volume + l5[1].volume + l5[2].volume) / 3;
    const la = (l5[3].volume + l5[4].volume) / 2;
    volTrend = fa > 0 ? la / fa : 1;
  }

  return { lastRunDir, lastRunLen, prevRunDir, prevRunLen, pattern, alt5, alt10, bodyMom, volTrend };
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

  return { pullbackDepth, rallyHeight, bbWidthRank, bbTouchCandles, rocAccel, volumeBuildup };
}

// ============================================================================
// TRADE INTERFACE
// ============================================================================

interface Trade {
  symbol: string; side: 'long' | 'short'; entryPrice: number; exitPrice: number;
  pnlPct: number; isWin: boolean; exitReason: string; holdBars: number;
  regime: 'BULL' | 'BEAR'; volatility: 'LOW' | 'MEDIUM' | 'HIGH';
  greenRatio10: number; pattern: string; lastRunDir: string; lastRunLen: number;
  alt5: number; alt10: number; bodyMom: number; volTrend: number;
  pullbackDepth: number; rallyHeight: number; bbWidthRank: number; bbTouchCandles: number;
  rocAccel: number; volumeBuildup: number;
  earlyPnl: Record<number, number>; // barsEarly -> pnl
  earlyWR: Record<number, boolean>;
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
// RUN SIMULATION ON A DATASET
// ============================================================================

function simulate(btcCandles: Candle[], allCandles: Record<string, Candle[]>, label: string): Trade[] {
  const trades: Trade[] = [];
  const btcCloses = btcCandles.map(c => c.close);
  const syms = Object.keys(allCandles);

  const positions: Record<string, {
    side: 'long' | 'short'; entryPrice: number; entryIdx: number;
    hwm: number; lwm: number; maxPnl: number; regime: 'BULL' | 'BEAR';
    greenRatio10: number; tempo: ReturnType<typeof extractTempo>;
    setup: ReturnType<typeof detectSetup>; volatility: 'LOW' | 'MEDIUM' | 'HIGH';
    earlyPrices: Record<number, number>;
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

          const earlyPnl: Record<number, number> = {};
          const earlyWR: Record<number, boolean> = {};
          for (const [bStr, price] of Object.entries(pos.earlyPrices)) {
            const b = +bStr;
            const eRaw = pos.side === 'long' ? ((exitPrice - price) / price) * 100 : ((price - exitPrice) / price) * 100;
            const eNet = eRaw * LEVERAGE - (FEES_BPS / 10000) * LEVERAGE * 2 * 100 - SLIPPAGE_PCT * 2;
            earlyPnl[b] = eNet;
            earlyWR[b] = eNet > 0;
          }

          trades.push({
            symbol, side: pos.side, entryPrice: pos.entryPrice, exitPrice,
            pnlPct: netPnl, isWin: netPnl > 0, exitReason, holdBars,
            regime: pos.regime, volatility: pos.volatility,
            greenRatio10: pos.greenRatio10, ...pos.tempo, ...pos.setup,
            earlyPnl, earlyWR,
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
      const tempo = extractTempo(pre);
      const setup = detectSetup(candles, idx - 1);
      const vol = getVolRegime(wc);

      const earlyPrices: Record<number, number> = {};
      for (const b of [1, 2, 3, 4, 5]) {
        if (idx - b >= 20) earlyPrices[b] = candles[idx - b].close;
      }

      positions[symbol] = {
        side: signal.side, entryPrice: current.close, entryIdx: idx,
        hwm: current.high, lwm: current.low, maxPnl: 0,
        regime: isBull ? 'BULL' : 'BEAR', volatility: vol,
        greenRatio10: gr10, tempo, setup, earlyPrices,
      };
    }
  }
  return trades;
}

// ============================================================================
// PRINT COMPARISON TABLE
// ============================================================================

type DatasetResult = { label: string; trades: Trade[] };

function printSection(title: string) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`📊 ${title}`);
  console.log(`${'═'.repeat(80)}`);
}

function printCompare(label: string, datasets: DatasetResult[], filterFn: (t: Trade) => boolean, subsetFn?: (t: Trade) => boolean) {
  const row = datasets.map(ds => {
    const base = subsetFn ? ds.trades.filter(subsetFn) : ds.trades;
    const filtered = base.filter(filterFn);
    const w = filtered.filter(t => t.isWin).length;
    const pnl = filtered.reduce((s, t) => s + t.pnlPct, 0);
    return { n: filtered.length, wr: filtered.length > 0 ? (w / filtered.length * 100) : 0, avg: filtered.length > 0 ? pnl / filtered.length : 0, total: pnl };
  });
  const cols = datasets.map((ds, i) => `${ds.label}: ${row[i].n} tr, ${row[i].wr.toFixed(1)}% WR, ${row[i].avg >= 0 ? '+' : ''}${row[i].avg.toFixed(2)}% avg`);
  console.log(`  ${label}`);
  for (const col of cols) console.log(`    ${col}`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('🔬 OUT-OF-SAMPLE VALIDATION: 2024 vs 2025');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const dataDir = path.resolve(process.cwd(), 'data');
  const dataDir2024 = path.join(dataDir, '2024');

  if (!fs.existsSync(dataDir2024)) {
    console.error('❌ No 2024 data directory. Run download-2024-15m.ts first.');
    process.exit(1);
  }

  // Load 2025 data (current files)
  const btc2025 = loadCandles(path.join(dataDir, 'BTC_USDT_15m.json'));
  const all2025: Record<string, Candle[]> = {};
  for (const sym of SYMBOLS_BASE) {
    const c = loadCandles(path.join(dataDir, `${sym}_15m.json`));
    if (c.length > 200) all2025[sym] = c;
  }

  // Load 2024 data
  const btc2024 = loadCandles(path.join(dataDir2024, 'BTC_USDT_15m.json'));
  const all2024: Record<string, Candle[]> = {};
  for (const sym of SYMBOLS_BASE) {
    const c = loadCandles(path.join(dataDir2024, `${sym}_15m.json`));
    if (c.length > 200) all2024[sym] = c;
  }

  console.log(`2024: BTC ${btc2024.length} candles, ${Object.keys(all2024).length} symbols`);
  console.log(`2025: BTC ${btc2025.length} candles, ${Object.keys(all2025).length} symbols`);

  // Run simulations
  console.log('\nSimulating 2024...');
  const trades2024 = simulate(btc2024, all2024, '2024');
  console.log(`  → ${trades2024.length} trades`);

  console.log('Simulating 2025...');
  const trades2025 = simulate(btc2025, all2025, '2025');
  console.log(`  → ${trades2025.length} trades`);

  const DS: DatasetResult[] = [
    { label: '2024 (OOS)', trades: trades2024 },
    { label: '2025 (IS) ', trades: trades2025 },
  ];

  // ═══ OVERALL ═══
  printSection('OVERALL BASELINE');
  printCompare('All trades', DS, () => true);
  printCompare('LONG only', DS, t => t.side === 'long');
  printCompare('SHORT only', DS, t => t.side === 'short');

  // ═══ GREEN RATIO FILTER ═══
  printSection('FINDING 1: GREEN RATIO FILTER');
  printCompare('Baseline (no filter)', DS, () => true);
  printCompare('Skip LONG GR10 >= 0.70', DS, t => !(t.side === 'long' && t.greenRatio10 >= 0.70));
  printCompare('LONG GR10 >= 0.70 (removed trades)', DS, t => t.side === 'long' && t.greenRatio10 >= 0.70);
  printCompare('LONG GR10 0-30% (best in 2025)', DS, t => t.side === 'long' && t.greenRatio10 < 0.30);
  printCompare('SHORT GR10 70-100% (best in 2025)', DS, t => t.side === 'short' && t.greenRatio10 >= 0.70);

  // ═══ TEMPO PATTERNS ═══
  printSection('FINDING 2: TEMPO PATTERNS');

  // Best patterns from 2025
  for (const pat of ['3D-1U', '2D-4U', '1D-6U', '2U-1D', '4U-2D', '1U-2D']) {
    printCompare(`Pattern "${pat}"`, DS, t => t.pattern === pat);
  }

  // Alternation rate
  printSection('FINDING 2b: ALTERNATION RATE');
  printCompare('LONG alt5=0 (trending)', DS, t => t.alt5 === 0, t => t.side === 'long');
  printCompare('LONG alt5=1', DS, t => t.alt5 === 1, t => t.side === 'long');
  printCompare('LONG alt5=2', DS, t => t.alt5 === 2, t => t.side === 'long');
  printCompare('LONG alt5=3 (choppy)', DS, t => t.alt5 === 3, t => t.side === 'long');
  printCompare('LONG alt5=4 (v.choppy)', DS, t => t.alt5 === 4, t => t.side === 'long');

  // ═══ EARLY ENTRY ═══
  printSection('FINDING 3: EARLY ENTRY SIMULATION');
  for (const side of ['long', 'short'] as const) {
    console.log(`\n  ${side.toUpperCase()}:`);
    const subset = (ds: DatasetResult) => ds.trades.filter(t => t.side === side);
    const baselineRow = DS.map(ds => {
      const s = subset(ds);
      const w = s.filter(t => t.isWin).length;
      return `${ds.label}: WR ${(w/s.length*100).toFixed(1)}% | Avg ${(s.reduce((a,t) => a+t.pnlPct,0)/s.length).toFixed(2)}%`;
    });
    console.log(`    Baseline: ${baselineRow.join(' | ')}`);

    for (const b of [1, 2, 3, 5]) {
      const earlyRow = DS.map(ds => {
        const s = subset(ds).filter(t => t.earlyPnl[b] !== undefined);
        const w = s.filter(t => t.earlyWR[b]).length;
        const avg = s.reduce((a, t) => a + t.earlyPnl[b], 0) / s.length;
        return `WR ${(w/s.length*100).toFixed(1)}% | Avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`;
      });
      console.log(`    -${b} bars: ${DS.map((ds, i) => `${ds.label}: ${earlyRow[i]}`).join(' | ')}`);
    }
  }

  // ═══ BB SQUEEZE ═══
  printSection('FINDING 4: BB SQUEEZE');
  const squeezeBuckets = [
    { label: '< 10% (tight)', min: 0, max: 0.10 },
    { label: '10-25%', min: 0.10, max: 0.25 },
    { label: '25-50%', min: 0.25, max: 0.50 },
    { label: '> 50% (wide)', min: 0.50, max: 1.01 },
  ];
  for (const side of ['long', 'short'] as const) {
    console.log(`\n  ${side.toUpperCase()}:`);
    for (const b of squeezeBuckets) {
      printCompare(b.label, DS, t => t.bbWidthRank >= b.min && t.bbWidthRank < b.max, t => t.side === side);
    }
  }

  // ═══ BB TOUCH COUNT ═══
  printSection('FINDING 5: BB BAND TOUCHES (last 10 candles)');
  for (const side of ['long', 'short'] as const) {
    console.log(`\n  ${side.toUpperCase()}:`);
    for (const touches of [0, 1, 2, 3, 4, 5]) {
      printCompare(`${touches} touches`, DS, t => t.bbTouchCandles === touches, t => t.side === side);
    }
    printCompare('6+ touches', DS, t => t.bbTouchCandles >= 6, t => t.side === side);
  }

  // ═══ PULLBACK / RALLY ═══
  printSection('FINDING 6: PULLBACK DEPTH (LONG) & RALLY HEIGHT (SHORT)');
  console.log('\n  LONG - Pullback Depth:');
  const pbBuckets = [
    { label: '< 0.5% (no PB)', min: 0, max: 0.5 },
    { label: '0.5-1.0%', min: 0.5, max: 1.0 },
    { label: '1.0-2.0%', min: 1.0, max: 2.0 },
    { label: '2.0-3.0%', min: 2.0, max: 3.0 },
    { label: '> 3.0%', min: 3.0, max: 999 },
  ];
  for (const b of pbBuckets) {
    printCompare(b.label, DS, t => t.pullbackDepth >= b.min && t.pullbackDepth < b.max, t => t.side === 'long');
  }
  console.log('\n  SHORT - Rally Height:');
  const rlBuckets = [
    { label: '< 0.5%', min: 0, max: 0.5 },
    { label: '0.5-1.5%', min: 0.5, max: 1.5 },
    { label: '1.5-3.0%', min: 1.5, max: 3.0 },
    { label: '> 3.0%', min: 3.0, max: 999 },
  ];
  for (const b of rlBuckets) {
    printCompare(b.label, DS, t => t.rallyHeight >= b.min && t.rallyHeight < b.max, t => t.side === 'short');
  }

  // ═══ COMBINED FILTERS ═══
  printSection('🎯 COMBINED FILTER IMPACT (realistic filters)');
  const filters = [
    { name: 'Baseline', fn: (_t: Trade) => true },
    { name: 'F1: Skip LONG GR10>=0.70', fn: (t: Trade) => !(t.side === 'long' && t.greenRatio10 >= 0.70) },
    { name: 'F2: F1 + skip LONG alt5>=3', fn: (t: Trade) => !(t.side === 'long' && t.greenRatio10 >= 0.70) && !(t.side === 'long' && t.alt5 >= 3) },
    { name: 'F3: F1 + skip 0-touch LONG', fn: (t: Trade) => !(t.side === 'long' && t.greenRatio10 >= 0.70) && !(t.side === 'long' && t.bbTouchCandles === 0) },
    { name: 'F4: F1 + SHORT 0-2 touches only', fn: (t: Trade) => {
      if (t.side === 'long' && t.greenRatio10 >= 0.70) return false;
      if (t.side === 'short' && t.bbTouchCandles > 2) return false;
      return true;
    }},
    { name: 'F5: LONG pullback 1-3% only', fn: (t: Trade) => {
      if (t.side === 'long') return t.pullbackDepth >= 1.0 && t.pullbackDepth < 3.0;
      return true;
    }},
    { name: 'F6: SHORT rally 0.5-3% only', fn: (t: Trade) => {
      if (t.side === 'short') return t.rallyHeight >= 0.5 && t.rallyHeight < 3.0;
      return true;
    }},
  ];

  for (const f of filters) {
    const results = DS.map(ds => {
      const filtered = ds.trades.filter(f.fn);
      const skipped = ds.trades.length - filtered.length;
      const w = filtered.filter(t => t.isWin).length;
      const pnl = filtered.reduce((s, t) => s + t.pnlPct, 0);
      const skW = ds.trades.filter(t => !f.fn(t) && t.isWin).length;
      return { n: filtered.length, skipped, skW, skL: skipped - skW, wr: (w/filtered.length*100), avg: pnl/filtered.length, total: pnl };
    });
    console.log(`\n  ${f.name}`);
    for (let i = 0; i < DS.length; i++) {
      const r = results[i];
      console.log(`    ${DS[i].label}: ${r.n} tr (skip ${r.skipped}: ${r.skW}W/${r.skL}L) | WR ${r.wr.toFixed(1)}% | Avg ${r.avg >= 0 ? '+' : ''}${r.avg.toFixed(2)}% | Total ${r.total.toFixed(0)}%`);
    }
  }

  console.log('\n\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
