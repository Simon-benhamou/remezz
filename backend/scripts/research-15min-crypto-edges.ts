/**
 * 🔬 RESEARCH: Best 15-min Crypto Edges (from web research + academic papers)
 *
 * Tests strategies found via web search on our actual 2024 + 2025 data:
 *
 * 1. MACD confirmation — MACD histogram direction matching breakout
 * 2. RSI divergence filter — skip entries when RSI diverges from price
 * 3. Volatility-scaled momentum — scale entry quality by inverse ATR (risk-managed)
 * 4. Time-of-day patterns — certain hours have better breakout reliability
 * 5. Volume spike confirmation — volume at breakout vs rolling average
 * 6. EMA slope momentum — EMA9/21 slope strength as quality filter
 * 7. Multi-timeframe trend — 1h trend alignment (simulated from 15m)
 * 8. Momentum acceleration — ROC of ROC (2nd derivative)
 *
 * Run: npx tsx scripts/research-15min-crypto-edges.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  calcSMA, calcROC, calcBB, calcVolRatio, countConsecUp, countConsecDown,
} from '../src/strategies/momentumSimple.js';

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

function calcATR(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 0;
  let s = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    s += Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
  }
  return s / period;
}

function calcEMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcEMASeries(values: number[], period: number): number[] {
  if (values.length < period) return values.map(() => 0);
  const k = 2 / (period + 1);
  const result: number[] = new Array(values.length).fill(0);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

// MACD: fast EMA - slow EMA, signal = EMA of MACD
function calcMACD(closes: number[], fast = 12, slow = 26, signal = 9): { macd: number; signal: number; hist: number } {
  if (closes.length < slow + signal) return { macd: 0, signal: 0, hist: 0 };
  const fastEma = calcEMASeries(closes, fast);
  const slowEma = calcEMASeries(closes, slow);
  const macdLine: number[] = [];
  for (let i = slow - 1; i < closes.length; i++) {
    macdLine.push(fastEma[i] - slowEma[i]);
  }
  const sigLine = calcEMA(macdLine, signal);
  const macdVal = macdLine[macdLine.length - 1];
  return { macd: macdVal, signal: sigLine, hist: macdVal - sigLine };
}

// RSI
function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function getVolRegime(candles: Candle[]): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (candles.length < 15) return 'MEDIUM';
  const atr = calcATR(candles, 14);
  const p = (atr / candles[candles.length - 1].close) * 100;
  return p < 2 ? 'LOW' : p > 3.5 ? 'HIGH' : 'MEDIUM';
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

interface Trade {
  symbol: string; side: 'long' | 'short'; entryPrice: number; exitPrice: number;
  pnlPct: number; isWin: boolean; exitReason: string; holdBars: number;
  features: Record<string, number>;
}

type FilterFn = (features: Record<string, number>, side: 'long' | 'short') => boolean;

function simulate(
  btcCandles: Candle[],
  allCandles: Record<string, Candle[]>,
  filter?: FilterFn,
): Trade[] {
  const trades: Trade[] = [];
  const btcCloses = btcCandles.map(c => c.close);

  const positions: Record<string, {
    side: 'long' | 'short'; entryPrice: number; entryIdx: number;
    hwm: number; lwm: number; maxPnl: number; features: Record<string, number>;
  } | null> = {};
  const symbolIdx: Record<string, number> = {};
  const cooldowns: Record<string, number> = {};

  const syms = Object.keys(allCandles);
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

      const wc = candles.slice(Math.max(0, idx - 200), idx + 1);
      const closes = wc.map(c => c.close);
      const volumes = wc.map(c => c.volume);

      // ====== EXIT LOGIC ======
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
            features: pos.features,
          });
          positions[symbol] = null; cooldowns[symbol] = 4;
        }
        continue;
      }

      if (cooldowns[symbol] > 0) continue;

      // ====== COMPUTE FEATURES ======
      const bb = calcBB(closes, 20);
      const roc10 = calcROC(closes, 10) * 100;
      const roc5 = calcROC(closes, 5) * 100;
      const volRatio = calcVolRatio(volumes);
      const ma20 = calcSMA(closes, 20);
      const cu = countConsecUp(wc);
      const cd = countConsecDown(wc);

      const btcWin = btcCandles.slice(Math.max(0, btcIdx - 20), btcIdx + 1);
      const btcAtr = calcATR(btcWin, 14);
      if ((btcAtr / btcCandle.close) * 100 < 0.15) continue;

      // --- Baseline signal ---
      let signal: { valid: boolean; side: 'long' | 'short' } = { valid: false, side: 'long' };
      if (isBull) {
        if (current.close > bb.upper && roc10 > 1.75 && volRatio > 1.15 && cu <= 5)
          signal = { valid: true, side: 'long' };
      } else {
        if (roc5 < -1.5 && volRatio > 2.0 && current.close < ma20 && current.close < bb.lower && cd <= 4)
          signal = { valid: true, side: 'short' };
      }
      if (!signal.valid) continue;

      // --- Compute extra features for filters ---
      const macd = calcMACD(closes);
      const rsi = calcRSI(closes, 14);
      const atr14 = calcATR(wc, 14);
      const atrPct = (atr14 / current.close) * 100;

      // EMA slopes
      const ema9 = calcEMA(closes, 9);
      const ema9prev = closes.length > 10 ? calcEMA(closes.slice(0, -1), 9) : ema9;
      const ema9slope = ((ema9 - ema9prev) / current.close) * 10000; // bps
      const ema21 = calcEMA(closes, 21);
      const ema21prev = closes.length > 22 ? calcEMA(closes.slice(0, -1), 21) : ema21;
      const ema21slope = ((ema21 - ema21prev) / current.close) * 10000;

      // Time of day (UTC hour)
      const hour = new Date(current.timestamp).getUTCHours();

      // Volume spike: current bar volume vs 20-bar avg
      const vol20avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
      const volSpike = vol20avg > 0 ? current.volume / vol20avg : 1;

      // Momentum acceleration: ROC of ROC
      const roc10prev = closes.length > 11 ? calcROC(closes.slice(0, -1), 10) * 100 : roc10;
      const momAccel = roc10 - roc10prev;

      // 1h trend: use 4-bar closes to simulate 1h
      const closes1h: number[] = [];
      for (let j = Math.max(0, wc.length - 80); j < wc.length; j += 4) {
        closes1h.push(wc[j].close);
      }
      const ema1h20 = closes1h.length >= 20 ? calcEMA(closes1h, 20) : current.close;
      const trend1h = current.close > ema1h20 ? 1 : -1;

      // BB %B position
      const bbPctB = bb.upper !== bb.lower ? (current.close - bb.lower) / (bb.upper - bb.lower) : 0.5;

      const features: Record<string, number> = {
        macdHist: macd.hist, macdDir: macd.hist > 0 ? 1 : -1,
        rsi, atrPct,
        ema9slope, ema21slope,
        hour, volSpike, momAccel,
        trend1h, bbPctB, roc10, roc5, volRatio,
      };

      // Apply filter
      if (filter && !filter(features, signal.side)) continue;

      positions[symbol] = {
        side: signal.side, entryPrice: current.close, entryIdx: idx,
        hwm: current.high, lwm: current.low, maxPnl: 0, features,
      };
    }
  }
  return trades;
}

function printStats(label: string, trades: Trade[]) {
  if (trades.length === 0) { console.log(`  ${label}: 0 trades`); return; }
  const w = trades.filter(t => t.isWin).length;
  const pnl = trades.reduce((s, t) => s + t.pnlPct, 0);
  const avg = pnl / trades.length;
  const longs = trades.filter(t => t.side === 'long');
  const shorts = trades.filter(t => t.side === 'short');
  console.log(`  ${label}: ${trades.length}tr WR${(w / trades.length * 100).toFixed(1)}% Avg${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% Tot${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}% | L:${longs.length} S:${shorts.length}`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('🔬 15-MIN CRYPTO EDGES RESEARCH (from web + academic papers)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const dataDir = path.resolve(process.cwd(), 'data');
  const dataDir2024 = path.join(dataDir, '2024');

  const loadAll = (dir: string) => {
    const btc = loadCandles(path.join(dir, 'BTC_USDT_15m.json'));
    const all: Record<string, Candle[]> = {};
    for (const sym of SYMBOLS_BASE) {
      const c = loadCandles(path.join(dir, `${sym}_15m.json`));
      if (c.length > 200) all[sym] = c;
    }
    return { btc, all };
  };

  const d24 = loadAll(dataDir2024);
  const d25 = loadAll(dataDir);
  console.log(`2024: BTC ${d24.btc.length} candles, ${Object.keys(d24.all).length} symbols`);
  console.log(`2025: BTC ${d25.btc.length} candles, ${Object.keys(d25.all).length} symbols\n`);

  // ================================================================
  // BASELINE (no extra filter)
  // ================================================================
  console.log('═'.repeat(70));
  console.log('BASELINE (no extra filter)');
  console.log('═'.repeat(70));
  printStats('2024', simulate(d24.btc, d24.all));
  printStats('2025', simulate(d25.btc, d25.all));

  // ================================================================
  // TEST 1: MACD CONFIRMATION
  // ================================================================
  console.log('\n' + '═'.repeat(70));
  console.log('TEST 1: MACD HISTOGRAM CONFIRMATION');
  console.log('  Long: macdHist > 0 | Short: macdHist < 0');
  console.log('═'.repeat(70));
  const macdFilter: FilterFn = (f, side) =>
    side === 'long' ? f.macdHist > 0 : f.macdHist < 0;
  printStats('2024', simulate(d24.btc, d24.all, macdFilter));
  printStats('2025', simulate(d25.btc, d25.all, macdFilter));

  // ================================================================
  // TEST 2: RSI FILTER (avoid overbought/oversold counter-trend)
  // ================================================================
  console.log('\n' + '═'.repeat(70));
  console.log('TEST 2: RSI FILTER');
  console.log('═'.repeat(70));
  for (const [lbl, lo, hi] of [
    ['Long RSI<70, Short RSI>30', 0, 70],
    ['Long RSI<65, Short RSI>35', 35, 65],
    ['Long RSI 40-70, Short RSI 30-60', 0, 0], // handled below
  ] as [string, number, number][]) {
    if (lbl.includes('40-70')) {
      const f: FilterFn = (feat, side) =>
        side === 'long' ? (feat.rsi >= 40 && feat.rsi <= 70) : (feat.rsi >= 30 && feat.rsi <= 60);
      console.log(`  --- ${lbl} ---`);
      printStats('  2024', simulate(d24.btc, d24.all, f));
      printStats('  2025', simulate(d25.btc, d25.all, f));
    } else {
      const f: FilterFn = (feat, side) =>
        side === 'long' ? feat.rsi < hi : feat.rsi > lo;
      console.log(`  --- ${lbl} ---`);
      printStats('  2024', simulate(d24.btc, d24.all, f));
      printStats('  2025', simulate(d25.btc, d25.all, f));
    }
  }

  // ================================================================
  // TEST 3: VOLATILITY REGIME FILTER (risk-managed momentum)
  // ================================================================
  console.log('\n' + '═'.repeat(70));
  console.log('TEST 3: ATR VOLATILITY FILTER');
  console.log('  Skip trades when ATR% is extreme (too calm or too wild)');
  console.log('═'.repeat(70));
  for (const [lbl, minAtr, maxAtr] of [
    ['ATR 0.5-3%', 0.5, 3.0],
    ['ATR 0.5-4%', 0.5, 4.0],
    ['ATR 1-5%', 1.0, 5.0],
    ['ATR >0.8%', 0.8, 99],
  ] as [string, number, number][]) {
    const f: FilterFn = (feat) => feat.atrPct >= minAtr && feat.atrPct <= maxAtr;
    console.log(`  --- ${lbl} ---`);
    printStats('  2024', simulate(d24.btc, d24.all, f));
    printStats('  2025', simulate(d25.btc, d25.all, f));
  }

  // ================================================================
  // TEST 4: TIME OF DAY
  // ================================================================
  console.log('\n' + '═'.repeat(70));
  console.log('TEST 4: TIME OF DAY (UTC hours)');
  console.log('═'.repeat(70));

  // First: show WR by hour bucket
  const baseline24 = simulate(d24.btc, d24.all);
  const baseline25 = simulate(d25.btc, d25.all);
  console.log('  Hour distribution (2024):');
  for (let h = 0; h < 24; h += 4) {
    const t = baseline24.filter(t => t.features.hour >= h && t.features.hour < h + 4);
    if (t.length > 5) {
      const wr = t.filter(x => x.isWin).length / t.length * 100;
      const avg = t.reduce((s, x) => s + x.pnlPct, 0) / t.length;
      console.log(`    ${h}-${h + 3}h: ${t.length}tr WR${wr.toFixed(1)}% Avg${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
    }
  }
  console.log('  Hour distribution (2025):');
  for (let h = 0; h < 24; h += 4) {
    const t = baseline25.filter(t => t.features.hour >= h && t.features.hour < h + 4);
    if (t.length > 5) {
      const wr = t.filter(x => x.isWin).length / t.length * 100;
      const avg = t.reduce((s, x) => s + x.pnlPct, 0) / t.length;
      console.log(`    ${h}-${h + 3}h: ${t.length}tr WR${wr.toFixed(1)}% Avg${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
    }
  }

  // Test: skip worst hours
  for (const skipHours of [[0, 1, 2, 3], [4, 5, 6, 7], [20, 21, 22, 23], [0, 1, 2, 3, 4, 5, 6, 7]]) {
    const f: FilterFn = (feat) => !skipHours.includes(feat.hour);
    console.log(`  --- Skip hours ${skipHours.join(',')} ---`);
    printStats('  2024', simulate(d24.btc, d24.all, f));
    printStats('  2025', simulate(d25.btc, d25.all, f));
  }

  // ================================================================
  // TEST 5: VOLUME SPIKE
  // ================================================================
  console.log('\n' + '═'.repeat(70));
  console.log('TEST 5: VOLUME SPIKE AT ENTRY');
  console.log('═'.repeat(70));
  for (const minSpike of [1.5, 2.0, 2.5, 3.0]) {
    const f: FilterFn = (feat) => feat.volSpike >= minSpike;
    console.log(`  --- volSpike >= ${minSpike} ---`);
    printStats('  2024', simulate(d24.btc, d24.all, f));
    printStats('  2025', simulate(d25.btc, d25.all, f));
  }

  // ================================================================
  // TEST 6: EMA SLOPE MOMENTUM
  // ================================================================
  console.log('\n' + '═'.repeat(70));
  console.log('TEST 6: EMA SLOPE ALIGNMENT');
  console.log('  Long: ema9slope > X & ema21slope > 0 | Short: inverse');
  console.log('═'.repeat(70));
  for (const minSlope of [0, 5, 10, 20]) {
    const f: FilterFn = (feat, side) =>
      side === 'long' ? (feat.ema9slope > minSlope && feat.ema21slope > 0)
        : (feat.ema9slope < -minSlope && feat.ema21slope < 0);
    console.log(`  --- ema9slope >${minSlope}bps, ema21 aligned ---`);
    printStats('  2024', simulate(d24.btc, d24.all, f));
    printStats('  2025', simulate(d25.btc, d25.all, f));
  }

  // ================================================================
  // TEST 7: 1H TREND ALIGNMENT (multi-timeframe)
  // ================================================================
  console.log('\n' + '═'.repeat(70));
  console.log('TEST 7: 1H TREND ALIGNMENT');
  console.log('  Only enter if 1h EMA20 trend matches direction');
  console.log('═'.repeat(70));
  const mtfFilter: FilterFn = (feat, side) =>
    side === 'long' ? feat.trend1h === 1 : feat.trend1h === -1;
  printStats('2024', simulate(d24.btc, d24.all, mtfFilter));
  printStats('2025', simulate(d25.btc, d25.all, mtfFilter));

  // ================================================================
  // TEST 8: MOMENTUM ACCELERATION
  // ================================================================
  console.log('\n' + '═'.repeat(70));
  console.log('TEST 8: MOMENTUM ACCELERATION (ROC of ROC)');
  console.log('  Long: momAccel > X | Short: momAccel < -X');
  console.log('═'.repeat(70));
  for (const minAccel of [0, 0.1, 0.3, 0.5, 1.0]) {
    const f: FilterFn = (feat, side) =>
      side === 'long' ? feat.momAccel > minAccel : feat.momAccel < -minAccel;
    console.log(`  --- momAccel > ${minAccel} ---`);
    printStats('  2024', simulate(d24.btc, d24.all, f));
    printStats('  2025', simulate(d25.btc, d25.all, f));
  }

  // ================================================================
  // TEST 9: COMBINED — BEST FILTERS TOGETHER
  // ================================================================
  console.log('\n' + '═'.repeat(70));
  console.log('TEST 9: COMBINED FILTERS');
  console.log('═'.repeat(70));

  const combos: [string, FilterFn][] = [
    ['MACD + RSI<70/30', (f, s) =>
      (s === 'long' ? f.macdHist > 0 && f.rsi < 70 : f.macdHist < 0 && f.rsi > 30)],
    ['MACD + volSpike>=2', (f, s) =>
      (s === 'long' ? f.macdHist > 0 : f.macdHist < 0) && f.volSpike >= 2.0],
    ['MACD + EMA slope>0', (f, s) =>
      (s === 'long' ? f.macdHist > 0 && f.ema9slope > 0 && f.ema21slope > 0
        : f.macdHist < 0 && f.ema9slope < 0 && f.ema21slope < 0)],
    ['MACD + 1h trend', (f, s) =>
      (s === 'long' ? f.macdHist > 0 && f.trend1h === 1 : f.macdHist < 0 && f.trend1h === -1)],
    ['volSpike>=2 + EMA aligned', (f, s) =>
      f.volSpike >= 2.0 && (s === 'long' ? f.ema21slope > 0 : f.ema21slope < 0)],
    ['RSI<70 + ATR 0.5-4% + MACD', (f, s) =>
      f.atrPct >= 0.5 && f.atrPct <= 4.0 && (s === 'long' ? f.rsi < 70 && f.macdHist > 0 : f.rsi > 30 && f.macdHist < 0)],
    ['KITCHEN SINK: MACD+RSI+EMA+1h+vol>=1.5', (f, s) =>
      f.volSpike >= 1.5 &&
      (s === 'long' ? f.macdHist > 0 && f.rsi < 70 && f.ema21slope > 0 && f.trend1h === 1
        : f.macdHist < 0 && f.rsi > 30 && f.ema21slope < 0 && f.trend1h === -1)],
  ];

  for (const [lbl, f] of combos) {
    console.log(`  --- ${lbl} ---`);
    printStats('  2024', simulate(d24.btc, d24.all, f));
    printStats('  2025', simulate(d25.btc, d25.all, f));
  }

  console.log('\n\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
