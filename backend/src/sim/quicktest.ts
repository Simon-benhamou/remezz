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
  reason?: 'tp'|'sl'|'time';
  rMultiple?: number;
};

export async function runQuickTest(symbol: string, hours = 72, plan?: PlanJson, opts?: {
  confirmMode?: 'close'|'wick+close';
  rsiFilter?: { longMax?: number; shortMin?: number };
  adxMin?: number;
  targetR?: number; // default 1R or first plan.tp
}) {
  const limit = Math.min(1200, Math.max(200, Math.floor((hours * 60) / 15) + 50));
  const o = await getOHLCV(symbol, '15m', limit);
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
  const maxHoldMs = (vplan.plan.risk.max_hold_hours || 36) * 3600 * 1000;

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
      const rTarget = (opts?.targetR) || (vplan.plan.risk.tp?.[0]?.value || 1.0);
      const tpPrice = entryPrice + dir * rTarget * stopDist; // R target
      const tr: Trade = { side: side as any, entryIndex: i, entryTime: t, entryPrice, stopPrice, tpPrice };

      // Manage forward
      let j = i + 1;
      const endTime = t + maxHoldMs;
      let stop = stopPrice;
      const atrVal = atr14[Math.min(atr14.length - 1, j)] || stopDist;
      const adxArr = [] as number[]; // simplify: not computing ADX here; could add later
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
        // Trailing after > 1R latent
        const upR = dir * (px - tr.entryPrice) / stopDist;
        if (upR > 1) {
          const trailCandidate = side==='long' ? Math.min(ema20[j] || px, px - atrVal) : Math.max(ema20[j] || px, px + atrVal);
          if (side==='long') stop = Math.max(stop, trailCandidate); else stop = Math.min(stop, trailCandidate);
        }
        if (ht >= endTime) {
          tr.exitIndex = j; tr.exitTime = ht; tr.exitPrice = px; tr.reason = 'time';
          tr.rMultiple = (dir * (px - tr.entryPrice)) / stopDist; results.push(tr); break;
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
  const avgR = results.length ? results.reduce((a,b)=> a + (b.rMultiple||0), 0) / results.length : 0;
  const winrate = results.length ? (wins / results.length) * 100 : 0;
  return { symbol, hours, plan: vplan.plan, validated: vplan, opts, trades: results, stats: { count: results.length, wins, losses, winrate, avgR } };
}
