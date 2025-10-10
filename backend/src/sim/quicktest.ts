import { getOHLCV } from '../data/market.js';
import { ema, atr, rsi, adx } from '../data/indicators.js';
import { PlanJson } from '../agent/planSchema.js';
import { validatePlan } from '../agent/validator.js';
import type { ValidatedPlan } from '../agent/validator.js';
import { proposePlan } from '../ai/planOrchestrator.js';

type Trade = {
  side: 'long'|'short';
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  stopPrice: number;
  tpPrice: number;
  exitIndex?: number;
  exitTime?: number;
  exitPrice?: number;
  reason?: 'tp'|'sl'|'time'|'trend_break';
  rMultiple?: number;
  // Added metrics for more realistic evaluation
  netR?: number;   // rMultiple net of fees/slippage
  maeR?: number;   // max adverse excursion in R
  mfeR?: number;   // max favorable excursion in R
};

export type QuickTestStats = {
  count: number;
  wins: number;
  losses: number;
  winrate: number;
  avgR: number;
  avgMAE_R: number;
  avgMFE_R: number;
  expectancyR: number;
  reasonCounts: Record<string, number>;
  rBuckets: Record<string, number>;
  stopDistance: number;
};

export type QuickTestRun = {
  multiplier: number;
  stopDistance: number;
  trades: Trade[];
  stats: QuickTestStats;
};

export type QuickTestResult = {
  symbol: string;
  hours: number;
  plan: PlanJson;
  validated: ValidatedPlan;
  opts?: QuickTestOptions;
  runs: QuickTestRun[];
  stopDistance: number;
  trades: Trade[];
  stats: QuickTestStats;
};

export type QuickTestOptions = {
  tf?: '5m'|'15m'|'1h';
  confirmMode?: 'close'|'wick+close';
  rsiFilter?: { longMax?: number; shortMin?: number };
  adxMin?: number;
  targetR?: number;
  targetMode?: 'R'|'percent';
  targetPercent?: number; // e.g., 3 => 3%
  trailingATRmult?: number; // e.g., 1.0
  exitPolicy?: 'time'|'trend'|'none';
  maxHoldHours?: number;
  feesBps?: number;        // taker fees in bps per fill (entry+exit)
  slippagePct?: number;     // slippage as % of price per fill
  stopDistanceMult?: number;
  stopDistanceSweep?: number[];
};

export async function runQuickTest(symbol: string, hours = 72, plan?: PlanJson, opts?: QuickTestOptions): Promise<QuickTestResult> {
  const tf = opts?.tf || '15m';
  const barMin = tf === '1h' ? 60 : (tf === '5m' ? 5 : 15);
  const limit = Math.min(2000, Math.max(200, Math.floor((hours * 60) / barMin) + 50));
  const o = await getOHLCV(symbol, tf, limit);
  if (!o || o.length < 120) throw new Error('Not enough data');

  const closes = o.map(r=>r[4]);
  const highs = o.map(r=>r[2]);
  const lows = o.map(r=>r[3]);

  // Prepare plan
  const planZ = plan || (await proposePlan(symbol));
  const vplan = await validatePlan(planZ);
  const mid = vplan.zone.mid;
  const from = Math.min(vplan.zone.from, vplan.zone.to);
  const to = Math.max(vplan.zone.from, vplan.zone.to);
  const baseStopDist = Math.max(1e-8, vplan.stopDistance);
  const side = vplan.bias;
  const dir = side === 'long' ? 1 : -1;
  const maxHoldMs = ((opts?.maxHoldHours ?? vplan.plan.risk.max_hold_hours) || 36) * 3600 * 1000;

  // Precompute EMA20 + ATR14
  const ema20 = ema(closes, 20);
  const atr14 = atr(o, 14);
  const rsi14 = rsi(closes, 14);
  const adx14 = adx(o, 14);

  const multipliersRaw = opts?.stopDistanceSweep?.length
    ? opts.stopDistanceSweep
    : [opts?.stopDistanceMult ?? 1];
  const multipliers = multipliersRaw
    .map(mult => (Number.isFinite(mult) && (mult as number) > 0 ? Number(mult) : 1))
    .filter(mult => mult > 0);
  if (!multipliers.length) multipliers.push(1);

  const runs: QuickTestRun[] = multipliers.map((mult) =>
    simulateStopDistance(mult)
  );

  const primary = runs[0];
  return {
    symbol,
    hours,
    plan: vplan.plan,
    validated: vplan,
    opts,
    runs,
    stopDistance: primary.stopDistance,
    trades: primary.trades,
    stats: primary.stats,
  };

  function simulateStopDistance(multiplier: number): QuickTestRun {
    const stopDist = Math.max(1e-8, baseStopDist * multiplier);
    const trades: Trade[] = [];

    let i = 50; // warmup
    while (i < o.length) {
      const t = o[i][0];
      const price = closes[i];
      const inZone = price >= from && price <= to;
      let confirm = vplan.plan.entry_rule.confirm_close ? ((side === 'long' && price > mid) || (side==='short' && price < mid)) : true;
      if ((opts?.confirmMode || 'close') === 'wick+close') {
        const wickTouch = side==='long' ? (lows[i] <= from) : (highs[i] >= to);
        confirm = confirm && wickTouch;
      }
      if (opts?.rsiFilter) {
        const rv = rsi14[Math.min(rsi14.length - 1, i)] || 50;
        if (side==='long' && opts.rsiFilter.longMax != null && rv > opts.rsiFilter.longMax) { i++; continue; }
        if (side==='short' && opts.rsiFilter.shortMin != null && rv < opts.rsiFilter.shortMin) { i++; continue; }
      }
      if (opts?.adxMin != null) {
        const av = adx14[Math.min(adx14.length - 1, i)] || 0;
        if (av < opts.adxMin) { i++; continue; }
      }
      if (inZone && confirm) {
        const slip = Math.max(0, opts?.slippagePct ?? 0) / 100;
        const entryPriceRaw = price;
        const entryPrice = side==='long' ? (entryPriceRaw * (1 + slip)) : (entryPriceRaw * (1 - slip));
        const stopPrice = side === 'long' ? entryPrice - stopDist : entryPrice + stopDist;
        let tpPrice = entryPrice + dir * stopDist; // default 1R
        if ((opts?.targetMode || 'R') === 'percent') {
          const pct = Math.max(0.5, opts?.targetPercent ?? 3) / 100;
          tpPrice = entryPrice + dir * (entryPrice * pct);
        } else {
          const rTarget = (opts?.targetR) || (vplan.plan.risk.tp?.[0]?.value || 1.0);
          tpPrice = entryPrice + dir * rTarget * stopDist;
        }
        const tr: Trade = { side: side as any, entryIndex: i, entryTime: t, entryPrice, stopPrice, tpPrice };

        let j = i + 1;
        const endTime = t + maxHoldMs;
        let stop = stopPrice;
        const trailMult = Math.max(0.5, opts?.trailingATRmult ?? 1.0);
        let maeR = 0; let mfeR = 0;
        while (j < o.length) {
          const ht = o[j][0];
          const hi = highs[j];
          const lo = lows[j];
          const px = closes[j];
          const execHi = side==='long' ? (hi * (1 - slip)) : (hi * (1 + slip));
          const execLo = side==='long' ? (lo * (1 - slip)) : (lo * (1 + slip));
          const hitTP = side==='long' ? (execHi >= tr.tpPrice) : (execLo <= tr.tpPrice);
          const hitSL = side==='long' ? (execLo <= stop) : (execHi >= stop);
          const adverse = side==='long' ? Math.min(0, lo - tr.entryPrice) : Math.min(0, tr.entryPrice - hi);
          const favorable = side==='long' ? Math.max(0, hi - tr.entryPrice) : Math.max(0, tr.entryPrice - lo);
          maeR = Math.min(maeR, adverse / stopDist);
          mfeR = Math.max(mfeR, favorable / stopDist);
          if (hitTP) {
            tr.exitIndex = j; tr.exitTime = ht; tr.exitPrice = tr.tpPrice; tr.reason = 'tp';
            tr.rMultiple = 1; tr.maeR = maeR; tr.mfeR = mfeR; trades.push(tr); break;
          }
          if (hitSL) {
            tr.exitIndex = j; tr.exitTime = ht; tr.exitPrice = stop; tr.reason = 'sl';
            tr.rMultiple = -1; tr.maeR = maeR; tr.mfeR = mfeR; trades.push(tr); break;
          }
          const atrVal = atr14[Math.min(atr14.length - 1, j)] || stopDist;
          const trailCandidate = side==='long' ? Math.min(ema20[j] || px, px - (atrVal * trailMult)) : Math.max(ema20[j] || px, px + (atrVal * trailMult));
          if (side==='long') stop = Math.max(stop, trailCandidate); else stop = Math.min(stop, trailCandidate);

          const upR = dir * (px - tr.entryPrice) / stopDist;
          if ((opts?.exitPolicy || 'time') === 'trend') {
            const trendOK = side==='long' ? (px >= (ema20[j] || px)) : (px <= (ema20[j] || px));
            if (!trendOK && upR > 0) {
              tr.exitIndex = j; tr.exitTime = ht; tr.exitPrice = px; tr.reason = 'trend_break';
              tr.rMultiple = upR; trades.push(tr); break;
            }
          } else if ((opts?.exitPolicy || 'time') === 'time') {
            if (ht >= endTime) {
              tr.exitIndex = j; tr.exitTime = ht; tr.exitPrice = px; tr.reason = 'time';
              tr.rMultiple = upR; trades.push(tr); break;
            }
          }
          j++;
        }
        if (!tr.exitIndex) {
          tr.exitIndex = j-1;
          tr.exitTime = o[j-1][0];
          const exec = side==='long' ? (closes[j-1] * (1 - slip)) : (closes[j-1] * (1 + slip));
          tr.exitPrice = exec;
          tr.reason = 'time';
          tr.rMultiple = (dir * (exec - tr.entryPrice)) / stopDist;
          tr.maeR = maeR;
          tr.mfeR = mfeR;
          trades.push(tr);
        }
        i = Math.max(i + 5, tr.exitIndex! + 1);
        continue;
      }
      i++;
    }

    const feesBps = Math.max(0, opts?.feesBps ?? 5);
    const feeRate = feesBps / 10000;
    let sumMAE = 0, sumMFE = 0;
    for (const r of trades) {
      const notional = Math.abs(r.entryPrice || 0);
      const fees = notional * feeRate * 2;
      const feeR = stopDist > 0 ? (fees / stopDist) : 0;
      (r as any).netR = (r.rMultiple || 0) - feeR;
      sumMAE += (r as any).maeR || 0;
      sumMFE += (r as any).mfeR || 0;
    }
    const wins = trades.filter(r=> (r.netR||0) > 0).length;
    const losses = trades.filter(r=> (r.netR||0) < 0).length;
    const reasonCounts: Record<string, number> = {};
    for (const r of trades) { reasonCounts[r.reason || 'unknown'] = (reasonCounts[r.reason || 'unknown'] || 0) + 1; }
    const rBuckets: Record<string, number> = {};
    for (const r of trades) {
      const v = r.rMultiple ?? 0;
      const key = `${Math.floor(v*2)/2}`;
      rBuckets[key] = (rBuckets[key] || 0) + 1;
    }
    const avgR = trades.length ? trades.reduce((a,b)=> a + (b.netR||0), 0) / trades.length : 0;
    const winrate = trades.length ? (wins / trades.length) * 100 : 0;
    const avgMAE = trades.length ? sumMAE / trades.length : 0;
    const avgMFE = trades.length ? sumMFE / trades.length : 0;
    const stats: QuickTestStats = {
      count: trades.length,
      wins,
      losses,
      winrate,
      avgR,
      avgMAE_R: avgMAE,
      avgMFE_R: avgMFE,
      expectancyR: avgR,
      reasonCounts,
      rBuckets,
      stopDistance: stopDist,
    };

    return { multiplier, stopDistance: stopDist, trades, stats };
  }
}
