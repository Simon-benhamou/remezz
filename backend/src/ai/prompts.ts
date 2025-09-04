export function rankingPrompt(ctx: {
    perps: Array<{ symbol: string; trend: number; rsi: number; volPct: number; atrPct: number; srBias: "nearSupport"|"nearResistance"|"neutral"; lastPrice: number }>;
  }) {
    return `
  You are an intraday crypto quant assistant. Rank symbols for a risk-taking day strategy (aiming +3~4% with leverage).
  Given technical snapshots, score each symbol in [0,1] for *risk-adjusted expectancy today*.
  Return strictly JSON:
  {
    "items": [
      { "symbol": "BTCUSDT", "score": 0.73, "reasons": ["trend up","near support","volatility moderate"] }
    ]
  }
  
  Context:
  ${JSON.stringify(ctx.perps, null, 2)}
  `.trim();
  }
  
  export function strategyPrompt(ctx: {
    symbol: string;
    trigger: string;
    features: { ema20:number; ema50:number; rsi14:number; atrPct:number; volPct:number; last:number; support:number; resistance:number; trend:number ,    pivots:any
      ,srBias:any};
  }) {
    return `
  You are an intraday crypto strategy generator. Create a daily plan targeting +3~4% with mandatory SL/TP and leverage.
  Constraints:
  - Respond STRICT JSON matching this schema:
  {
    "strategyId": "string",
    "symbol": "SYMBOL",
    "bias": "long|short|range",
    "confidence": 0.0-1.0,
    "entry": {
      "type": "limit|market",
      "price": number|null,
      "zone": { "min": number|null, "max": number|null },
      "confirmations": string[]
    },
    "risk": {
      "stop": { "type": "percent|price", "value": number },
      "target": { "type": "percent|price", "value": number },
      "risk_pct_balance": number, 
      "max_leverage": number
    },
    "validity": { "from": "ISO8601", "to": "ISO8601|null" },
    "rationale": "string",
    "trigger": "string"
  }
  - If trend>0 and RSI<65 near support -> bias long; if trend<0 and RSI>35 near resistance -> bias short; else range.
  - Use target ~3.0–4.0% and stop 1.0–2.0% (tighter if ATR% low).
  - Always include confirmations (e.g., "RSI_up","EMA20>EMA50","volume_increase").
  - If using "zone", fill min/max around last price ±0.3–0.7% depending on volatility.
  
  Context:
  ${JSON.stringify(ctx, null, 2)}
  `.trim();
  }