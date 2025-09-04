// backend/src/ai/tech.ts
import { getOHLCV } from '../data/market.js';
import { ema, rsi, atr } from '../data/indicators.js';

export type TechnicalSnapshot = {
  symbol: string;
  last: number;
  ema20: number;
  ema50: number;
  rsi14: number;
  atr14: number;
  atrPct: number;
  support: number;          // primaire (le plus pertinent/près)
  resistance: number;       // primaire
  supports: { price: number; label: string; touches: number; strength: number }[];
  resistances: { price: number; label: string; touches: number; strength: number }[];
  pivots: null | { P: number; S1: number; S2: number; R1: number; R2: number; refDay: string };
  trend: number;
  srBias: 'nearSupport'|'nearResistance'|'neutral';
  meta: { tf: string; windowBars: number; recentBarsFor24h: number };
};

/**
 * Utilitaires
 */
function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}
function pct(a: number, b: number) {
  return (a - b) / b * 100;
}
function near(a: number, b: number, pPct: number) {
  return Math.abs(a - b) <= Math.abs(b) * (pPct / 100);
}

/**
 * Calcule les points pivots journaliers à partir des OHLCV (timeframe 1h ou 15m).
 * On prend le jour civil précédent (UTC) : High/Low/Close de la veille.
 */
function dailyPivotsFromOHLCV(ohlcv: number[][]) {
  // ohlcv: [ ts(ms), open, high, low, close, volume ]
  if (!ohlcv?.length) return null;

  // Grouper par jour (UTC)
  const byDay: Record<string, { high: number; low: number; close: number }> = {};
  for (const [ts, , , , close, ] of ohlcv) {
    const d = new Date(ts);
    const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
    if (!byDay[key]) byDay[key] = { high: -Infinity, low: Infinity, close };
    const o = byDay[key];
    // on met à jour high/low/close par itération  — mais on a besoin de high/low ! Il faut lire ohlcv[i][2]/[3]
  }
  // On doit re-parcourir avec high/low
  for (const [ts, , high, low, close] of ohlcv) {
    const key = new Date(ts).toISOString().slice(0, 10);
    const o = byDay[key];
    if (!o) continue;
    if (high > o.high) o.high = high;
    if (low < o.low) o.low = low;
    o.close = close; // last close of that day
  }

  // jours triés
  const days = Object.keys(byDay).sort();
  if (days.length < 2) return null; // pas de "veille"
  const prev = byDay[days[days.length - 2]];
  const H = prev.high, L = prev.low, C = prev.close;
  const P = (H + L + C) / 3;
  const R1 = 2 * P - L;
  const S1 = 2 * P - H;
  const R2 = P + (H - L);
  const S2 = P - (H - L);

  return { P, R1, R2, S1, S2, refDay: days[days.length - 2] };
}

/**
 * Détection de swings (fractal highs/lows).
 * Un swing high au point i si high[i] > high[i-k..i-1] et > high[i+1..i+k]
 * On compte aussi les "touches" proches par tolérance (tolerancePct).
 */
function swingLevels(
  highs: number[], lows: number[], closes: number[], lookback = 2, tolerancePct = 0.15
) {
  type Lvl = { price: number; touches: number; strength: number; idx: number };
  const swingHighs: Lvl[] = [];
  const swingLows: Lvl[] = [];

  const n = highs.length;
  for (let i = lookback; i < n - lookback; i++) {
    const h = highs[i], l = lows[i];
    // swing high
    let isHigh = true;
    for (let k = 1; k <= lookback; k++) {
      if (!(h > highs[i - k] && h > highs[i + k])) { isHigh = false; break; }
    }
    if (isHigh) swingHighs.push({ price: h, touches: 1, strength: 1, idx: i });

    // swing low
    let isLow = true;
    for (let k = 1; k <= lookback; k++) {
      if (!(l < lows[i - k] && l < lows[i + k])) { isLow = false; break; }
    }
    if (isLow) swingLows.push({ price: l, touches: 1, strength: 1, idx: i });
  }

  // regrouper les niveaux proches (tolerancePct)
  function cluster(levels: Lvl[]): Lvl[] {
    const out: Lvl[] = [];
    for (const lvl of levels) {
      const found = out.find(x => near(x.price, lvl.price, tolerancePct));
      if (!found) out.push({ ...lvl });
      else {
        // fusion simple: moyenne pondérée
        found.price = (found.price * found.touches + lvl.price) / (found.touches + 1);
        found.touches += 1;
        found.strength += 1;
        found.idx = Math.max(found.idx, lvl.idx);
      }
    }
    return out;
  }

  const clusteredHighs = cluster(swingHighs)
    .sort((a, b) => b.touches - a.touches || b.price - a.price);
  const clusteredLows = cluster(swingLows)
    .sort((a, b) => b.touches - a.touches || a.price - b.price);

  // convertir en tableau de prix + meta
  return {
    resistances: clusteredHighs.map(l => ({ price: l.price, touches: l.touches, strength: l.strength })),
    supports: clusteredLows.map(l => ({ price: l.price, touches: l.touches, strength: l.strength })),
  };
}

/**
 * Snapshot technique complet pour un symbole :
 * - EMA20/50, RSI14, ATR14 & ATR%
 * - S/R 24h (min/max) + S/R par swings (multi-touch)
 * - Pivots journaliers (P, S1, S2, R1, R2)
 * - srBias: nearSupport | nearResistance | neutral (fenêtre 0.6%)
 */
export async function buildTechSnapshot(symbol: string): Promise<TechnicalSnapshot>{
  // 15m pour réactivité (2 jours ≈ 192 bougies), et 1h pour pivots/journalier
  const o15 = await getOHLCV(symbol, '15m', 300); // [ts, o, h, l, c, v]
  if (!o15 || o15.length < 100) throw new Error('Not enough data (15m)');

  const closes15 = o15.map(r => r[4]);
  const highs15  = o15.map(r => r[2]);
  const lows15   = o15.map(r => r[3]);
  const lastPrice:any = last(closes15);

  // Indicateurs
  const ema20Arr = ema(closes15, 20);
  const ema50Arr = ema(closes15, 50);
  const ema20v = last(ema20Arr);
  const ema50v = last(ema50Arr);
  const rsi14Arr = rsi(closes15, 14);
  const rsi14v = rsi14Arr[rsi14Arr.length - 1] ?? 50;
  const atr14Arr = atr(o15, 14);
  const atr14v = atr14Arr[atr14Arr.length - 1] ?? 0;
  const atrPct = (atr14v / lastPrice) * 100;

  // S/R simples 24h (≈ 24h = 96 bougies 15m)
  const recent = closes15.length >= 96 ? o15.slice(-96) : o15;
  const support24h = Math.min(...recent.map(r => r[3]));
  const resistance24h = Math.max(...recent.map(r => r[2]));

  // Swings (fractal)
  const swings = swingLevels(highs15, lows15, closes15, 2, 0.15); // tolérance 0.15% pour regrouper
  const supports = [
    { price: support24h, label: '24h-low', touches: 1, strength: 1 },
    ...swings.supports.slice(0, 5).map(s => ({ price: s.price, label: 'swing', touches: s.touches, strength: s.strength })),
  ].sort((a, b) => Math.abs(lastPrice - a.price) - Math.abs(lastPrice - b.price));

  const resistances = [
    { price: resistance24h, label: '24h-high', touches: 1, strength: 1 },
    ...swings.resistances.slice(0, 5).map(s => ({ price: s.price, label: 'swing', touches: s.touches, strength: s.strength })),
  ].sort((a, b) => Math.abs(lastPrice - a.price) - Math.abs(lastPrice - b.price));

  // Pivots journaliers depuis 1h (ou 15m si tu préfères)
  const o1h = await getOHLCV(symbol, '1h', 600); // ~25 jours
  const pivots = dailyPivotsFromOHLCV(o1h || o15);

  // Choix d’un support/résistance "primaire" (le plus proche du prix actuel)
  const primarySupport = supports[0]?.price ?? support24h;
  const primaryResistance = resistances[0]?.price ?? resistance24h;

  // srBias
  let srBias: 'nearSupport' | 'nearResistance' | 'neutral' = 'neutral';
  if (near(lastPrice, primarySupport, 0.6)) srBias = 'nearSupport';
  if (near(lastPrice, primaryResistance, 0.6)) srBias = 'nearResistance';

  // Trend proxy
  const trend = ema20v - ema50v;

  return {
    symbol,
    last: lastPrice,
    ema20: ema20v,
    ema50: ema50v,
    rsi14: rsi14v,
    atr14: atr14v,
    atrPct,
    support: primarySupport,
    resistance: primaryResistance,
    supports,       // [{ price, label, touches, strength }, ...] trié par proximité
    resistances,    // idem
    pivots,         // { P,S1,S2,R1,R2,refDay } | null
    trend,
    srBias,
    meta: {
      tf: '15m',
      windowBars: o15.length,
      recentBarsFor24h: recent.length,
    },
  } as TechnicalSnapshot;
}
