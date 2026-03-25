/**
 * 🔬 KELTNER CHANNEL SQUEEZE PRE-BREAKOUT TEST
 *
 * Tests the TTM Squeeze concept: BB inside KC = volatility compression.
 * When BB exits KC = breakout trigger.
 *
 * Approach (all past-only, no look-ahead):
 * 1. Detect when BB is inside KC (squeeze active)
 * 2. Detect when BB exits KC (squeeze fires)
 * 3. Combine with: volume buildup, momentum direction, squeeze duration
 * 4. Enter on squeeze fire + confirmation
 * 5. Compare PnL vs baseline strategy
 *
 * Also tests web suggestions:
 * - Squeeze duration >= 10 candles = more reliable
 * - Volume confirmation on breakout
 * - Multi-timeframe (1h alignment)
 * - BB width < 50% of recent average
 *
 * Run: npx tsx scripts/research-kc-squeeze-breakout.ts
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

// Keltner Channel
function calcKC(candles: Candle[], period: number, atrMult: number): { upper: number; lower: number; middle: number } {
  const closes = candles.map(c => c.close);
  const middle = calcEMA(closes, period);
  const atr = calcATR(candles, period);
  return { upper: middle + atrMult * atr, lower: middle - atrMult * atr, middle };
}

// Check if BB is inside KC (squeeze is ON)
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
  // Squeeze metadata
  squeezeDuration: number;   // how many candles squeeze was active before fire
  bbWidthAtFire: number;     // BB width when squeeze fired
  volBuildAtFire: number;    // volume buildup at fire
  rocAtFire: number;         // ROC at fire
  entryType: 'squeeze_fire' | 'baseline';
}

function simulateWithSqueeze(
  btcCandles: Candle[],
  allCandles: Record<string, Candle[]>,
  params: {
    kcMult: number;       // KC ATR multiplier (1.0, 1.5, 2.0)
    minSqueezeDur: number; // minimum squeeze duration to consider
    requireVolBuild: boolean;
    requireMomentum: boolean;
  }
): Trade[] {
  const trades: Trade[] = [];
  const btcCloses = btcCandles.map(c => c.close);
  const syms = Object.keys(allCandles);

  const positions: Record<string, {
    side: 'long' | 'short'; entryPrice: number; entryIdx: number;
    hwm: number; lwm: number; maxPnl: number;
    squeezeDuration: number; bbWidthAtFire: number; volBuildAtFire: number; rocAtFire: number;
    entryType: 'squeeze_fire' | 'baseline';
  } | null> = {};
  const symbolIdx: Record<string, number> = {};
  const cooldowns: Record<string, number> = {};
  // Track squeeze state per symbol
  const squeezeState: Record<string, { active: boolean; duration: number }> = {};

  for (const s of syms) {
    positions[s] = null; symbolIdx[s] = -1; cooldowns[s] = 0;
    squeezeState[s] = { active: false, duration: 0 };
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

      // Update squeeze state
      const wc = candles.slice(Math.max(0, idx - 200), idx + 1);
      const closes = wc.map(c => c.close);
      const bb = calcBB(closes, 20);
      const kc = calcKC(wc.slice(-21), 20, params.kcMult);
      const squeezed = isSqueezeOn(bb, kc);

      const sq = squeezeState[symbol];
      const prevActive = sq.active;
      if (squeezed) {
        sq.active = true;
        sq.duration++;
      } else {
        if (prevActive) {
          // Squeeze just fired!
          sq.active = false;
        }
        sq.duration = 0;
      }
      const squeezeFired = prevActive && !squeezed;
      const fireDuration = prevActive ? sq.duration : 0; // duration before this candle reset it

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
            squeezeDuration: pos.squeezeDuration, bbWidthAtFire: pos.bbWidthAtFire,
            volBuildAtFire: pos.volBuildAtFire, rocAtFire: pos.rocAtFire,
            entryType: pos.entryType,
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

      // Volume buildup
      let volBuild = 1;
      const last5 = wc.slice(-5);
      if (last5.length === 5) {
        const fa = (last5[0].volume + last5[1].volume + last5[2].volume) / 3;
        const la = (last5[3].volume + last5[4].volume) / 2;
        volBuild = fa > 0 ? la / fa : 1;
      }

      // BB width
      const bbWidth = (bb.upper - bb.lower) / bb.middle * 100;

      // ATR filter
      const btcWin = btcCandles.slice(Math.max(0, btcIdx - 20), btcIdx + 1);
      const btcAtr = calcATR(btcWin, 14);
      if ((btcAtr / btcCandle.close) * 100 < 0.15) continue;

      // ---- Strategy A: Squeeze Fire Entry ----
      if (squeezeFired && fireDuration >= params.minSqueezeDur) {
        // Determine direction from momentum
        let side: 'long' | 'short' | null = null;
        if (isBull && roc10 > 0 && current.close > bb.middle) {
          side = 'long';
        } else if (!isBull && roc5 < 0 && current.close < bb.middle) {
          side = 'short';
        }

        if (side) {
          // Optional filters
          if (params.requireVolBuild && volBuild < 1.0) { /* skip */ }
          else if (params.requireMomentum && side === 'long' && roc10 < 1.0) { /* skip */ }
          else if (params.requireMomentum && side === 'short' && roc5 > -0.8) { /* skip */ }
          else {
            positions[symbol] = {
              side, entryPrice: current.close, entryIdx: idx,
              hwm: current.high, lwm: current.low, maxPnl: 0,
              squeezeDuration: fireDuration, bbWidthAtFire: bbWidth,
              volBuildAtFire: volBuild, rocAtFire: side === 'long' ? roc10 : roc5,
              entryType: 'squeeze_fire',
            };
            continue;
          }
        }
      }

      // ---- Strategy B: Original baseline entry (for comparison) ----
      let signal: { valid: boolean; side: 'long' | 'short' } = { valid: false, side: 'long' };
      if (isBull) {
        if (current.close > bb.upper && roc10 > 1.75 && volRatio > 1.15 && cu <= 5)
          signal = { valid: true, side: 'long' };
      } else {
        if (roc5 < -1.5 && volRatio > 2.0 && current.close < ma20 && current.close < bb.lower && cd <= 4)
          signal = { valid: true, side: 'short' };
      }
      if (!signal.valid) continue;

      positions[symbol] = {
        side: signal.side, entryPrice: current.close, entryIdx: idx,
        hwm: current.high, lwm: current.low, maxPnl: 0,
        squeezeDuration: 0, bbWidthAtFire: bbWidth, volBuildAtFire: volBuild,
        rocAtFire: signal.side === 'long' ? roc10 : roc5,
        entryType: 'baseline',
      };
    }
  }
  return trades;
}

function printStats(label: string, trades: Trade[]) {
  const w = trades.filter(t => t.isWin).length;
  const l = trades.length - w;
  const pnl = trades.reduce((s, t) => s + t.pnlPct, 0);
  const avg = trades.length > 0 ? pnl / trades.length : 0;
  const longs = trades.filter(t => t.side === 'long');
  const shorts = trades.filter(t => t.side === 'short');
  const lw = longs.filter(t => t.isWin).length;
  const sw = shorts.filter(t => t.isWin).length;
  console.log(`  ${label}`);
  console.log(`    Total: ${trades.length}tr ${w}W/${l}L | WR ${trades.length > 0 ? (w/trades.length*100).toFixed(1) : 0}% | Avg ${avg >= 0?'+':''}${avg.toFixed(2)}% | Tot ${pnl.toFixed(0)}%`);
  console.log(`    LONG:  ${longs.length}tr ${lw}W/${longs.length-lw}L | WR ${longs.length > 0 ? (lw/longs.length*100).toFixed(1) : 0}%  |  SHORT: ${shorts.length}tr ${sw}W/${shorts.length-sw}L | WR ${shorts.length > 0 ? (sw/shorts.length*100).toFixed(1) : 0}%`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('🔬 KELTNER CHANNEL SQUEEZE PRE-BREAKOUT TEST');
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

  // ====== TEST 1: KC multiplier grid search ======
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 1: KC MULTIPLIER GRID (squeeze fire entry)');
  console.log('═'.repeat(80));

  for (const kcMult of [1.0, 1.5, 2.0]) {
    for (const minDur of [1, 5, 10, 15]) {
      console.log(`\n  --- kcMult=${kcMult} minSqueezeDuration=${minDur} ---`);
      const params = { kcMult, minSqueezeDur: minDur, requireVolBuild: false, requireMomentum: false };
      const t24 = simulateWithSqueeze(d24.btc, d24.all, params);
      const t25 = simulateWithSqueeze(d25.btc, d25.all, params);

      const sq24 = t24.filter(t => t.entryType === 'squeeze_fire');
      const bl24 = t24.filter(t => t.entryType === 'baseline');
      const sq25 = t25.filter(t => t.entryType === 'squeeze_fire');
      const bl25 = t25.filter(t => t.entryType === 'baseline');

      printStats('2024 Squeeze entries', sq24);
      printStats('2024 Baseline entries', bl24);
      printStats('2025 Squeeze entries', sq25);
      printStats('2025 Baseline entries', bl25);
    }
  }

  // ====== TEST 2: Best KC setting + filters ======
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 2: SQUEEZE + CONFIRMATION FILTERS');
  console.log('═'.repeat(80));

  const filterCombos = [
    { name: 'Squeeze only (no extra filter)', requireVolBuild: false, requireMomentum: false },
    { name: 'Squeeze + volBuild >= 1.0', requireVolBuild: true, requireMomentum: false },
    { name: 'Squeeze + momentum confirm', requireVolBuild: false, requireMomentum: true },
    { name: 'Squeeze + volBuild + momentum', requireVolBuild: true, requireMomentum: true },
  ];

  for (const fc of filterCombos) {
    console.log(`\n  --- ${fc.name} (kcMult=1.5, minDur=5) ---`);
    const params = { kcMult: 1.5, minSqueezeDur: 5, ...fc };
    const t24 = simulateWithSqueeze(d24.btc, d24.all, params);
    const t25 = simulateWithSqueeze(d25.btc, d25.all, params);
    const sq24 = t24.filter(t => t.entryType === 'squeeze_fire');
    const sq25 = t25.filter(t => t.entryType === 'squeeze_fire');
    printStats('2024 Squeeze', sq24);
    printStats('2025 Squeeze', sq25);
  }

  // ====== TEST 3: Squeeze duration analysis ======
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 3: SQUEEZE DURATION IMPACT (kcMult=1.5)');
  console.log('═'.repeat(80));

  const allParams = { kcMult: 1.5, minSqueezeDur: 1, requireVolBuild: false, requireMomentum: false };
  const all24 = simulateWithSqueeze(d24.btc, d24.all, allParams).filter(t => t.entryType === 'squeeze_fire');
  const all25 = simulateWithSqueeze(d25.btc, d25.all, allParams).filter(t => t.entryType === 'squeeze_fire');

  const durBuckets = [
    { label: '1-4 candles', min: 1, max: 5 },
    { label: '5-9 candles', min: 5, max: 10 },
    { label: '10-19 candles', min: 10, max: 20 },
    { label: '20-39 candles', min: 20, max: 40 },
    { label: '40+ candles', min: 40, max: 9999 },
  ];

  for (const db of durBuckets) {
    const f24 = all24.filter(t => t.squeezeDuration >= db.min && t.squeezeDuration < db.max);
    const f25 = all25.filter(t => t.squeezeDuration >= db.min && t.squeezeDuration < db.max);
    console.log(`\n  ${db.label}:`);
    printStats('2024', f24);
    printStats('2025', f25);
  }

  // ====== TEST 4: Squeeze fire PnL by BB width at fire ======
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 4: BB WIDTH AT SQUEEZE FIRE');
  console.log('═'.repeat(80));

  const widthBuckets = [
    { label: 'bbWidth <1%', min: 0, max: 1 },
    { label: 'bbWidth 1-2%', min: 1, max: 2 },
    { label: 'bbWidth 2-4%', min: 2, max: 4 },
    { label: 'bbWidth >4%', min: 4, max: 999 },
  ];

  for (const wb of widthBuckets) {
    const f24 = all24.filter(t => t.bbWidthAtFire >= wb.min && t.bbWidthAtFire < wb.max);
    const f25 = all25.filter(t => t.bbWidthAtFire >= wb.min && t.bbWidthAtFire < wb.max);
    console.log(`\n  ${wb.label}:`);
    printStats('2024', f24);
    printStats('2025', f25);
  }

  // ====== TEST 5: Squeeze vs Baseline head-to-head ======
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST 5: SQUEEZE vs BASELINE HEAD-TO-HEAD (best config)');
  console.log('═'.repeat(80));

  const bestParams = { kcMult: 1.5, minSqueezeDur: 5, requireVolBuild: false, requireMomentum: true };
  const best24 = simulateWithSqueeze(d24.btc, d24.all, bestParams);
  const best25 = simulateWithSqueeze(d25.btc, d25.all, bestParams);

  console.log('\n  2024:');
  printStats('ALL entries', best24);
  printStats('Squeeze fire only', best24.filter(t => t.entryType === 'squeeze_fire'));
  printStats('Baseline only', best24.filter(t => t.entryType === 'baseline'));

  console.log('\n  2025:');
  printStats('ALL entries', best25);
  printStats('Squeeze fire only', best25.filter(t => t.entryType === 'squeeze_fire'));
  printStats('Baseline only', best25.filter(t => t.entryType === 'baseline'));

  console.log('\n\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
