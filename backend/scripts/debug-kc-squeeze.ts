/**
 * Debug: why KC squeeze never fires
 */
import fs from 'node:fs';
import path from 'node:path';
import { calcBB } from '../src/strategies/momentumSimple.js';

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

const dataDir = path.resolve(process.cwd(), 'data');
const btcCandles = loadCandles(path.join(dataDir, 'BTC_USDT_15m.json'));
const ethCandles = loadCandles(path.join(dataDir, 'ETH_USDT_15m.json'));

console.log(`BTC: ${btcCandles.length} candles, ETH: ${ethCandles.length} candles`);

// Check a sample of candles
let squeezeCount = 0;
let totalChecked = 0;

for (const [label, candles] of [['BTC', btcCandles], ['ETH', ethCandles]] as [string, Candle[]][]) {
  for (let i = 200; i < Math.min(candles.length, 1000); i++) {
    const wc = candles.slice(Math.max(0, i - 200), i + 1);
    const closes = wc.map(c => c.close);

    // BB calculation (same as in research script)
    const bb = calcBB(closes, 20);

    // KC calculation — BUG CHECK: passing full window vs small window
    // Original script: calcKC(wc.slice(-21), 20, kcMult) — only 21 candles!
    const kcSmall = (() => {
      const small = wc.slice(-21);
      const smallCloses = small.map(c => c.close);
      const middle = calcEMA(smallCloses, 20);
      const atr = calcATR(small, 20);
      return { upper: middle + 1.5 * atr, lower: middle - 1.5 * atr, middle };
    })();

    // KC with full window (correct)
    const kcFull = (() => {
      const fullCloses = closes;
      const middle = calcEMA(fullCloses, 20);
      const atr = calcATR(wc, 20);
      return { upper: middle + 1.5 * atr, lower: middle - 1.5 * atr, middle };
    })();

    const squeezedSmall = bb.upper < kcSmall.upper && bb.lower > kcSmall.lower;
    const squeezedFull = bb.upper < kcFull.upper && bb.lower > kcFull.lower;

    if (i === 200 && label === 'BTC') {
      console.log('\n=== SAMPLE VALUES (BTC candle 200) ===');
      console.log(`  BB: upper=${bb.upper.toFixed(2)} lower=${bb.lower.toFixed(2)} width=${((bb.upper-bb.lower)/bb.middle*100).toFixed(3)}%`);
      console.log(`  KC(small 21): upper=${kcSmall.upper.toFixed(2)} lower=${kcSmall.lower.toFixed(2)} width=${((kcSmall.upper-kcSmall.lower)/kcSmall.middle*100).toFixed(3)}%`);
      console.log(`  KC(full 201): upper=${kcFull.upper.toFixed(2)} lower=${kcFull.lower.toFixed(2)} width=${((kcFull.upper-kcFull.lower)/kcFull.middle*100).toFixed(3)}%`);
      console.log(`  Squeezed(small)? ${squeezedSmall}  Squeezed(full)? ${squeezedFull}`);
      console.log(`  BB width > KC width? BB=${((bb.upper-bb.lower)).toFixed(2)} vs KC_small=${((kcSmall.upper-kcSmall.lower)).toFixed(2)} KC_full=${((kcFull.upper-kcFull.lower)).toFixed(2)}`);
    }

    if (squeezedSmall) squeezeCount++;
    totalChecked++;
  }
}
console.log(`\nChecked ${totalChecked} candles, squeeze detected (small KC): ${squeezeCount} (${(squeezeCount/totalChecked*100).toFixed(2)}%)`);

// Now let's check different ATR multipliers and see the ratio BB_width / KC_width
console.log('\n=== BB WIDTH vs KC WIDTH DISTRIBUTION ===');
for (const mult of [1.0, 1.5, 2.0, 2.5, 3.0]) {
  let narrower = 0;
  let total = 0;
  const ratios: number[] = [];

  for (let i = 200; i < btcCandles.length; i += 10) {
    const wc = btcCandles.slice(Math.max(0, i - 200), i + 1);
    const closes = wc.map(c => c.close);
    const bb = calcBB(closes, 20);
    const bbWidth = bb.upper - bb.lower;

    const ema = calcEMA(closes, 20);
    const atr = calcATR(wc, 20);
    const kcWidth = 2 * mult * atr;

    if (bbWidth < kcWidth) narrower++;
    total++;
    ratios.push(bbWidth / kcWidth);
  }
  ratios.sort((a, b) => a - b);
  const p10 = ratios[Math.floor(ratios.length * 0.1)];
  const p50 = ratios[Math.floor(ratios.length * 0.5)];
  const p90 = ratios[Math.floor(ratios.length * 0.9)];
  console.log(`  kcMult=${mult}: BB narrower than KC: ${narrower}/${total} (${(narrower/total*100).toFixed(1)}%) | BB/KC ratio p10=${p10.toFixed(3)} p50=${p50.toFixed(3)} p90=${p90.toFixed(3)}`);
}

// Check with proper same-window calculation
console.log('\n=== FIX: Both BB and KC on same 20-period window ===');
for (const mult of [1.0, 1.5, 2.0, 2.5, 3.0]) {
  let squeezes = 0;
  let total = 0;

  for (let i = 200; i < btcCandles.length; i += 4) {
    const wc = btcCandles.slice(i - 20, i + 1); // exactly 21 candles for period=20
    const closes = wc.map(c => c.close);

    // BB on same window
    const bb = calcBB(closes, 20);

    // KC on same window
    const ema = calcEMA(closes, 20);
    const atr = calcATR(wc, 20);
    const kcUpper = ema + mult * atr;
    const kcLower = ema - mult * atr;

    if (bb.upper < kcUpper && bb.lower > kcLower) squeezes++;
    total++;
  }
  console.log(`  kcMult=${mult}: ${squeezes}/${total} squeezes (${(squeezes/total*100).toFixed(2)}%)`);
}

// Also check: what if BB is on 200 candles but KC on 20?
// The issue: calcBB uses SMA which averages 200 candles → very smooth → BB bands narrow
// while ATR on 20 candles → reactive → KC bands wide
console.log('\n=== BB(200 window) vs KC(200 window) ===');
for (const mult of [1.0, 1.5, 2.0]) {
  let squeezes = 0;
  let total = 0;

  for (let i = 200; i < btcCandles.length; i += 4) {
    const wc = btcCandles.slice(Math.max(0, i - 200), i + 1);
    const closes = wc.map(c => c.close);

    // BB uses last 20 closes for std dev (that's what calcBB does internally)
    const bb = calcBB(closes, 20);

    // KC uses EMA20 + ATR20 on full window
    const ema = calcEMA(closes, 20);
    const atr = calcATR(wc, 20);
    const kcUpper = ema + mult * atr;
    const kcLower = ema - mult * atr;

    if (bb.upper < kcUpper && bb.lower > kcLower) squeezes++;
    total++;
  }
  console.log(`  kcMult=${mult}: ${squeezes}/${total} squeezes (${(squeezes/total*100).toFixed(2)}%)`);
}

console.log('\nDone.');
