import { StrategyZ, StrategyJson } from "./schema.js";
import { rankingPrompt, strategyPrompt } from "./prompts.js";
import { llmJSON } from "./llm.js";
import { buildTechSnapshot } from './tech.js';
import { randomUUID } from "crypto";

function safeParseJSON<T=any>(s: string): T {
  try { return JSON.parse(s) as T; } catch { throw new Error("LLM returned non-JSON"); }
}

// --- 1) Multi-perp ranking --- //
export async function selectBestPerp(
  perps: string[]
): Promise<{ symbol: string; score: number; reasons: string[] }[]> {
  // Build compact features per symbol (in parallel)
  const snapshots = await Promise.all(perps.map(async (symbol) => {
    try {
      const f = await buildTechSnapshot(symbol);
      const { symbol: _, ...rest } = f;
      return { ok: true as const, symbol, ...rest };
    } catch (e: any) {
      return { ok: false as const, symbol, error: String(e?.message || e) };
    }
  }));

  const usable = snapshots.filter(s => s.ok) as any[];
  if (usable.length === 0) {
    // Ultimate fallback if market snapshot fails: randomized ranking
    return perps.map(s => ({ symbol: s, score: Math.random(), reasons: ["fallback-random"] }))
                .sort((a,b)=>b.score-a.score);
  }

  // Prompt LLM
  let items: { symbol: string; score: number; reasons: string[] }[] = [];
  try {
    const prompt = rankingPrompt({
      perps: usable.map(u => ({
        symbol: u.symbol,
        trend: u.trend,
        rsi: u.rsi14,
        volPct: u.volPct,
        atrPct: u.atrPct,
        srBias: u.srBias,
        lastPrice: u.last
      })),
    });
    const out = await llmJSON(prompt);
    const j = safeParseJSON<{ items: { symbol:string; score:number; reasons:string[] }[] }>(out);
    items = (j.items || []).filter(x => perps.includes(x.symbol));
  } catch {
    // Heuristic fallback: trend>0, RSI 45-65, nearSupport => +score
    items = usable.map((u:any) => {
      let score = 0.5;
      if (u.trend > 0) score += 0.2;
      if (u.rsi14 >= 45 && u.rsi14 <= 65) score += 0.15;
      if (u.srBias === "nearSupport") score += 0.1;
      score -= Math.max(0, u.atrPct - 2) * 0.02; // penalize excessive volatility
      return { symbol: u.symbol, score: Math.max(0, Math.min(1, score)), reasons: ["fallback-tech"] };
    });
  }

  // Tri et borne 0..1
  items = items.map(it => ({ ...it, score: Math.max(0, Math.min(1, it.score)) }));
  items.sort((a,b)=>b.score-a.score);
  return items;
}

// --- 2) Daily strategy generation (legacy classic) --- //
export async function generateStrategy(symbol: string, trigger: string): Promise<StrategyJson> {
  const feats = await buildTechSnapshot(symbol);
  const today = new Date().toISOString().slice(0,10);

  // 2.1 Ask LLM (JSON)
  try {
    const raw = await llmJSON(strategyPrompt({
      symbol, trigger,
      features: {
        ema20: feats.ema20, ema50: feats.ema50, rsi14: feats.rsi14,
        atrPct: feats.atrPct, volPct: Math.abs((feats.ema20-feats.ema50)/feats.last)*100,
        last: feats.last, support: feats.support, resistance: feats.resistance, trend: feats.trend,
        pivots: feats.pivots, srBias: feats.srBias
      }
    }));
    // 2.2 Parse & validate
    const draft = safeParseJSON<StrategyJson>(raw);
    // patch fields minimum
    if (!draft.strategyId) draft.strategyId = `${today}:${symbol}:${trigger}:${Date.now()}:${randomUUID()}`; // <-- make unique
    if (!draft.symbol) draft.symbol = symbol;
    if (!draft.trigger) draft.trigger = trigger;
    if (!draft.validity) draft.validity = { from: new Date().toISOString(), to: null as any };
    const parsed = StrategyZ.parse(draft);
    return parsed;
  } catch (e) {
    // 2.3 Fallback rule-based
    const isLong = feats.srBias !== 'nearResistance' && feats.trend > 0;
    const bias = isLong ? 'long' : 'short';

    // Entry: zone around a pertinent level
    const refLevel = isLong
      ? (feats.supports[0]?.price ?? feats.support)
      : (feats.resistances[0]?.price ?? feats.resistance);

    const zonePct = Math.min(0.8, Math.max(0.3, feats.atrPct * 0.6));
    const min = refLevel * (1 - (isLong ? 0.001*zonePct : -0.001*zonePct));
    const max = refLevel * (1 + (isLong ? 0.001*zonePct : -0.001*zonePct));

    const stopPct = Math.min(Math.max(1.0, feats.atrPct * 0.8), 2.0);
    const targetPct = 3.5;

    const draft: StrategyJson = {
      strategyId: `${new Date().toISOString().slice(0,10)}:${symbol}:${trigger}:${Date.now()}:${randomUUID()}`, // <-- make unique
      symbol,
      bias: bias as any,
      confidence: 0.6,
      entry: {
        type: 'limit',
        price: null as any,
        zone: { min, max },
        confirmations: [
          isLong ? 'RSI_up' : 'RSI_down',
          isLong ? 'EMA20>EMA50' : 'EMA20<EMA50',
          'pivot_respect'
        ]
      },
      risk: {
        stop: { type: 'percent', value: stopPct },
        target: { type: 'percent', value: targetPct },
        risk_pct_balance: 1.0,
        max_leverage: 10
      },
      validity: { from: new Date().toISOString(), to: null as any },
      rationale: `Rule-based: bias=${bias} (srBias=${feats.srBias}, trend=${feats.trend.toFixed(2)}), ref=${refLevel.toFixed(2)}`,
      trigger
    };
    return StrategyZ.parse(draft);
  }
}
