import { PlanZ, PlanJson } from '../agent/planSchema.js';
import { buildTechSnapshot } from './tech.js';
import { llmJSON } from './llm.js';

function safeParse<T=any>(s: string): T { try { return JSON.parse(s) as T; } catch { throw new Error('LLM returned non-JSON'); } }

export async function proposePlan(symbol: string): Promise<PlanJson> {
  const snap = await buildTechSnapshot(symbol);
  const sys = `You are a market analyst. You receive a clean technical snapshot (price, RSI, ATR, S/R). Output ONLY a JSON matching this schema: {"name","symbol","timeframe","bias","zone":{"type","price":null,"from":"auto_detect"},"entry_rule":{"type":"rebound|rejection","confirm_close":true,"max_distance_pct":0.4},"risk":{"stop":{"type":"atr","mult":0.9},"tp":[{"type":"R","value":1.0}],"max_hold_hours":36},"position":{"risk_fraction":0.015,"max_leverage":4},"notes":"..."}. Do NOT invent any prices. If unsure, return bias:"none".`;
  const user = {
    symbol, timeframe: '1h',
    summary: {
      last: snap.last,
      ema20: snap.ema20, ema50: snap.ema50,
      rsi14: snap.rsi14, atrPct: snap.atrPct,
      support: snap.support, resistance: snap.resistance,
      srBias: snap.srBias,
    }
  };
  try {
    const out = await llmJSON(`${sys}\nContext: ${JSON.stringify(user)}`);
    const j = safeParse(out);
    const plan = PlanZ.parse(j);
    return plan;
  } catch {
    // Fallback rule-based
    const isLong = snap.srBias !== 'nearResistance' && (snap.ema20 >= snap.ema50);
    const plan: PlanJson = {
      name: isLong ? 'Support_Rebound_v1' : 'Resistance_Rejection_v1',
      symbol,
      timeframe: '1h',
      bias: isLong ? 'long' : 'short',
      zone: { type: isLong ? 'support' : 'resistance', price: null, from: 'auto_detect' },
      entry_rule: { type: isLong ? 'rebound' : 'rejection', confirm_close: true, max_distance_pct: 0.4 },
      risk: { stop: { type: 'atr', mult: 0.9 }, tp: [{ type: 'R', value: 1.0 }, { type: 'R', value: 2.0 }], max_hold_hours: 36 },
      position: { risk_fraction: 0.015, max_leverage: 4 },
      notes: 'Auto plan based on EMA slope and S/R bias.'
    };
    return PlanZ.parse(plan);
  }
}
