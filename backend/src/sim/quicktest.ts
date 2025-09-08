import { getOHLCV } from '../data/market.js';
import { ema, atr, rsi, adx } from '../data/indicators.js';
import { PlanJson } from '../agent/planSchema.js';
import { validatePlan } from '../agent/validator.js';
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
};

export async function runQuickTest(symbol: string, hours = 72, plan?: PlanJson, opts?: {
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
}) {
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
  const stopDist = vplan.stopDistance;
  const side = vplan.bias;
  const dir = side === 'long' ? 1 : -1;
  const maxHoldMs = ((opts?.maxHoldHours ?? vplan.plan.risk.max_hold_hours) || 36) * 3600 * 1000;

  // Precompute EMA20 + ATR14
  const ema20 = ema(closes, 20);
  const atr14 = atr(o, 14);
  const rsi14 = rsi(closes, 14);
  const adx14 = adx(o, 14);

  const results: Trade[] = [];
  const reasons: string[] = [];

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
      // Enter
      const entryPrice = price;
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

      // Manage forward
      let j = i + 1;
      const endTime = t + maxHoldMs;
      let stop = stopPrice;
      const trailMult = Math.max(0.5, opts?.trailingATRmult ?? 1.0);
      const adxArr = adx14;
      while (j < o.length) {
        const ht = o[j][0];
        const hi = highs[j];
        const lo = lows[j];
        const px = closes[j];
        // TP/SL check with H/L
        const hitTP = side==='long' ? (hi >= tr.tpPrice) : (lo <= tr.tpPrice);
        const hitSL = side==='long' ? (lo <= stop) : (hi >= stop);
        if (hitTP) {
          tr.exitIndex = j; tr.exitTime = ht; tr.exitPrice = tr.tpPrice; tr.reason = 'tp';
          tr.rMultiple = 1; results.push(tr); break;
        }
        if (hitSL) {
          tr.exitIndex = j; tr.exitTime = ht; tr.exitPrice = stop; tr.reason = 'sl';
          tr.rMultiple = -1; results.push(tr); break;
        }
        // Trailing stop on every step using ATR and EMA20
        const atrVal = atr14[Math.min(atr14.length - 1, j)] || stopDist;
        const trailCandidate = side==='long' ? Math.min(ema20[j] || px, px - (atrVal * trailMult)) : Math.max(ema20[j] || px, px + (atrVal * trailMult));
        if (side==='long') stop = Math.max(stop, trailCandidate); else stop = Math.min(stop, trailCandidate);

        // Exit policy
        const upR = dir * (px - tr.entryPrice) / stopDist;
        if ((opts?.exitPolicy || 'time') === 'trend') {
          const trendOK = side==='long' ? (px >= (ema20[j] || px)) : (px <= (ema20[j] || px));
          if (!trendOK && upR > 0) {
            tr.exitIndex = j; tr.exitTime = ht; tr.exitPrice = px; tr.reason = 'trend_break';
            tr.rMultiple = upR; results.push(tr); break;
          }
        } else if ((opts?.exitPolicy || 'time') === 'time') {
          if (ht >= endTime) {
            tr.exitIndex = j; tr.exitTime = ht; tr.exitPrice = px; tr.reason = 'time';
            tr.rMultiple = upR; results.push(tr); break;
          }
        }
        j++;
      }
      if (!tr.exitIndex) { tr.exitIndex = j-1; tr.exitTime = o[j-1][0]; tr.exitPrice = closes[j-1]; tr.reason = 'time'; tr.rMultiple = (dir * (closes[j-1] - tr.entryPrice)) / stopDist; results.push(tr); }
      // continue after exit
      i = Math.max(i + 5, tr.exitIndex! + 1);
      continue;
    }
    i++;
  }

  const wins = results.filter(r=> (r.rMultiple||0) > 0).length;
  const losses = results.filter(r=> (r.rMultiple||0) < 0).length;
  const reasonCounts: Record<string, number> = {};
  for (const r of results) { reasonCounts[r.reason || 'unknown'] = (reasonCounts[r.reason || 'unknown'] || 0) + 1; }
  const rBuckets: Record<string, number> = {};
  for (const r of results) {
    const v = r.rMultiple ?? 0;
    const key = `${Math.floor(v*2)/2}`; // 0.5 increments
    rBuckets[key] = (rBuckets[key] || 0) + 1;
  }
  const avgR = results.length ? results.reduce((a,b)=> a + (b.rMultiple||0), 0) / results.length : 0;
  const winrate = results.length ? (wins / results.length) * 100 : 0;
  return { symbol, hours, plan: vplan.plan, validated: vplan, opts, trades: results, stats: { count: results.length, wins, losses, winrate, avgR, reasonCounts, rBuckets } };
}
