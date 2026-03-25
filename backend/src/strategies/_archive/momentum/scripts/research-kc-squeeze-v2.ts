/**
 * 🔬 KELTNER CHANNEL SQUEEZE PRE-BREAKOUT TEST v2 (bug fixed)
 *
 * Bug in v1: BB calculated on 200 candles, KC on 21 → different scales → 0 squeezes.
 * Fix: Both BB and KC computed on same lookback window.
 *
 * Tests:
 * 1. KC squeeze as standalone signal (enter on squeeze fire)
 * 2. KC squeeze as FILTER on existing breakout signal (only enter breakouts that had prior squeeze)
 * 3. KC squeeze as EARLY WARNING (enter during squeeze when close to band)
 * 4. Different KC multipliers and squeeze durations
 *
 * Run: npx tsx scripts/research-kc-squeeze-v2.ts
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
  if (values.length < period) return values[values.length - 1];
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcKC(candles: Candle[], period: number, atrMult: number): { upper: number; lower: number; middle: number } {
  const closes = candles.map(c => c.close);
  const middle = calcEMA(closes, period);
  const atr = calcATR(candles, period);
  return { upper: middle + atrMult * atr, lower: middle - atrMult * atr, middle };
}

function isSqueezeOn(bb: { upper: number; lower: number }, kc: { upper: number; lower: number }): boolean {
  return bb.upper < kc.upper && bb.lower > kc.lower;
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
  entryType: 'squeeze_fire' | 'squeeze_early' | 'baseline' | 'baseline_with_squeeze' | 'baseline_no_squeeze';
  squeezeDuration: number;
}

function simulate(
  btcCandles: Candle[],
  allCandles: Record<string, Candle[]>,
  kcMult: number,
  minSqueezeDur: number,
): Trade[] {
  const trades: Trade[] = [];
  const btcCloses = btcCandles.map(c => c.close);
  const syms = Object.keys(allCandles);

  const positions: Record<string, {
    side: 'long' | 'short'; entryPrice: number; entryIdx: number;
    hwm: number; lwm: number; maxPnl: number;
    entryType: Trade['entryType']; squeezeDuration: number;
  } | null> = {};
  const symbolIdx: Record<string, number> = {};
  const cooldowns: Record<string, number> = {};
  const squeezeState: Record<string, { active: boolean; duration: number; prevActive: boolean; prevDuration: number }> = {};

  for (const s of syms) {
    positions[s] = null; symbolIdx[s] = -1; cooldowns[s] = 0;
    squeezeState[s] = { active: false, duration: 0, prevActive: false, prevDuration: 0 };
  }

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

      // ====== COMPUTE BB and KC on SAME window ======
      const wc = candles.slice(Math.max(0, idx - 200), idx + 1);
      const closes = wc.map(c => c.close);
      const bb = calcBB(closes, 20);
      // FIX: KC computed on SAME full window as BB
      const kc = calcKC(wc, 20, kcMult);
      const squeezed = isSqueezeOn(bb, kc);

      // Update squeeze state
      const sq = squeezeState[symbol];
      sq.prevActive = sq.active;
      sq.prevDuration = sq.duration;
      if (squeezed) {
        sq.active = true;
        sq.duration++;
      } else {
        sq.active = false;
        if (!sq.prevActive) sq.duration = 0; // reset only if wasn't active before either
      }
      // Squeeze "fires" when it was active last candle and now it's not
      const squeezeFired = sq.prevActive && !sq.active;
      const fireDuration = sq.prevDuration;

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
            entryType: pos.entryType, squeezeDuration: pos.squeezeDuration,
          });
          positions[symbol] = null; cooldowns[symbol] = 4;
        }
        continue;
      }

      if (cooldowns[symbol] > 0) continue;

      // ====== ENTRY LOGIC ======
      const volumes = wc.map(c => c.volume);
      const roc10 = calcROC(closes, 10) * 100;
      const roc5 = calcROC(closes, 5) * 100;
      const volRatio = calcVolRatio(volumes);
      const ma20 = calcSMA(closes, 20);
      const cu = countConsecUp(wc);
      const cd = countConsecDown(wc);

      const btcWin = btcCandles.slice(Math.max(0, btcIdx - 20), btcIdx + 1);
      const btcAtr = calcATR(btcWin, 14);
      if ((btcAtr / btcCandle.close) * 100 < 0.15) continue;

      // ---- Strategy A: Squeeze Fire Entry (squeeze just ended → enter in breakout direction) ----
      if (squeezeFired && fireDuration >= minSqueezeDur) {
        let side: 'long' | 'short' | null = null;
        // Direction from price relative to BB middle + momentum
        if (isBull && current.close > bb.middle && roc10 > 0.5) {
          side = 'long';
        } else if (!isBull && current.close < bb.middle && roc5 < -0.5) {
          side = 'short';
        }

        if (side) {
          positions[symbol] = {
            side, entryPrice: current.close, entryIdx: idx,
            hwm: current.high, lwm: current.low, maxPnl: 0,
            entryType: 'squeeze_fire', squeezeDuration: fireDuration,
          };
          continue;
        }
      }

      // ---- Strategy B: Squeeze Early Entry (during squeeze, close approaching band) ----
      if (sq.active && sq.duration >= minSqueezeDur) {
        const distToUpper = (bb.upper - current.close) / current.close * 100;
        const distToLower = (current.close - bb.lower) / current.close * 100;

        let side: 'long' | 'short' | null = null;
        if (isBull && distToUpper < 0.3 && roc10 > 0.5) {
          side = 'long';
        } else if (!isBull && distToLower < 0.3 && roc5 < -0.5) {
          side = 'short';
        }

        if (side) {
          positions[symbol] = {
            side, entryPrice: current.close, entryIdx: idx,
            hwm: current.high, lwm: current.low, maxPnl: 0,
            entryType: 'squeeze_early', squeezeDuration: sq.duration,
          };
          continue;
        }
      }

      // ---- Strategy C: Baseline entry (tag whether squeeze was recently active) ----
      let signal: { valid: boolean; side: 'long' | 'short' } = { valid: false, side: 'long' };
      if (isBull) {
        if (current.close > bb.upper && roc10 > 1.75 && volRatio > 1.15 && cu <= 5)
          signal = { valid: true, side: 'long' };
      } else {
        if (roc5 < -1.5 && volRatio > 2.0 && current.close < ma20 && current.close < bb.lower && cd <= 4)
          signal = { valid: true, side: 'short' };
      }
      if (!signal.valid) continue;

      // Was there a squeeze in the last 20 candles?
      let recentSqueeze = sq.active;
      if (!recentSqueeze) {
        // Check if squeeze ended recently (within ~20 candles)
        // We can approximate: if prevDuration > 0 and duration == 0, squeeze ended recently
        recentSqueeze = fireDuration > 0 || sq.prevDuration > 0;
      }
      // More thorough: look back manually
      if (!recentSqueeze) {
        for (let lookback = 1; lookback <= 20; lookback++) {
          const li = idx - lookback;
          if (li < 21) break;
          const lwc = candles.slice(Math.max(0, li - 200), li + 1);
          const lcloses = lwc.map(c => c.close);
          const lbb = calcBB(lcloses, 20);
          const lkc = calcKC(lwc, 20, kcMult);
          if (isSqueezeOn(lbb, lkc)) { recentSqueeze = true; break; }
        }
      }

      positions[symbol] = {
        side: signal.side, entryPrice: current.close, entryIdx: idx,
        hwm: current.high, lwm: current.low, maxPnl: 0,
        entryType: recentSqueeze ? 'baseline_with_squeeze' : 'baseline_no_squeeze',
        squeezeDuration: 0,
      };
    }
  }
  return trades;
}

function printStats(label: string, trades: Trade[]) {
  if (trades.length === 0) { console.log(`    ${label}: 0 trades`); return; }
  const w = trades.filter(t => t.isWin).length;
  const pnl = trades.reduce((s, t) => s + t.pnlPct, 0);
  const longs = trades.filter(t => t.side === 'long');
  const shorts = trades.filter(t => t.side === 'short');
  const lw = longs.filter(t => t.isWin).length;
  const sw = shorts.filter(t => t.isWin).length;
  console.log(`    ${label}: ${trades.length}tr ${w}W/${trades.length-w}L | WR ${(w/trades.length*100).toFixed(1)}% | Avg ${(pnl/trades.length) >= 0?'+':''}${(pnl/trades.length).toFixed(2)}% | Tot ${pnl.toFixed(0)}%`);
  console.log(`      L: ${longs.length}tr WR${longs.length > 0 ? (lw/longs.length*100).toFixed(1) : 0}% | S: ${shorts.length}tr WR${shorts.length > 0 ? (sw/shorts.length*100).toFixed(1) : 0}%`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('🔬 KC SQUEEZE PRE-BREAKOUT v2 (fixed BB/KC window)');
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
  console.log(`2025: BTC ${d25.btc.length} candles, ${Object.keys(d25.all).length} symbols`);

  // ====== Grid search ======
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 1: KC MULTIPLIER × MIN SQUEEZE DURATION');
  console.log('═'.repeat(80));

  for (const kcMult of [1.5, 2.0, 2.5]) {
    for (const minDur of [3, 6, 10, 15]) {
      console.log(`\n  --- kcMult=${kcMult} minDur=${minDur} ---`);
      const t24 = simulate(d24.btc, d24.all, kcMult, minDur);
      const t25 = simulate(d25.btc, d25.all, kcMult, minDur);

      for (const [label, trades] of [['2024', t24], ['2025', t25]] as [string, Trade[]][]) {
        const sqFire = trades.filter(t => t.entryType === 'squeeze_fire');
        const sqEarly = trades.filter(t => t.entryType === 'squeeze_early');
        const blSq = trades.filter(t => t.entryType === 'baseline_with_squeeze');
        const blNo = trades.filter(t => t.entryType === 'baseline_no_squeeze');
        console.log(`  ${label}:`);
        printStats('Squeeze FIRE', sqFire);
        printStats('Squeeze EARLY', sqEarly);
        printStats('Baseline+squeeze', blSq);
        printStats('Baseline-no-squeeze', blNo);
      }
    }
  }

  // ====== Best config deep dive ======
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 2: SQUEEZE DURATION BREAKDOWN (kcMult=2.0 minDur=3)');
  console.log('═'.repeat(80));

  const best24 = simulate(d24.btc, d24.all, 2.0, 3);
  const best25 = simulate(d25.btc, d25.all, 2.0, 3);

  const durBuckets = [
    { label: '3-5 candles', min: 3, max: 6 },
    { label: '6-10 candles', min: 6, max: 11 },
    { label: '11-20 candles', min: 11, max: 21 },
    { label: '21-50 candles', min: 21, max: 51 },
    { label: '50+ candles', min: 51, max: 9999 },
  ];

  for (const db of durBuckets) {
    console.log(`\n  ${db.label}:`);
    for (const [label, trades] of [['2024', best24], ['2025', best25]] as [string, Trade[]][]) {
      const sqFire = trades.filter(t => t.entryType === 'squeeze_fire' && t.squeezeDuration >= db.min && t.squeezeDuration < db.max);
      const sqEarly = trades.filter(t => t.entryType === 'squeeze_early' && t.squeezeDuration >= db.min && t.squeezeDuration < db.max);
      printStats(`${label} Fire`, sqFire);
      printStats(`${label} Early`, sqEarly);
    }
  }

  // ====== Filter value: baseline trades WITH vs WITHOUT prior squeeze ======
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 3: BASELINE TRADES — WITH vs WITHOUT PRIOR SQUEEZE');
  console.log('   (Does a prior squeeze make the standard breakout signal better?)');
  console.log('═'.repeat(80));

  for (const kcMult of [1.5, 2.0, 2.5]) {
    console.log(`\n  kcMult=${kcMult}:`);
    const t24 = simulate(d24.btc, d24.all, kcMult, 3);
    const t25 = simulate(d25.btc, d25.all, kcMult, 3);
    for (const [label, trades] of [['2024', t24], ['2025', t25]] as [string, Trade[]][]) {
      const withSq = trades.filter(t => t.entryType === 'baseline_with_squeeze');
      const noSq = trades.filter(t => t.entryType === 'baseline_no_squeeze');
      printStats(`${label} Baseline+squeeze`, withSq);
      printStats(`${label} Baseline-no-squeeze`, noSq);
    }
  }

  console.log('\n\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
