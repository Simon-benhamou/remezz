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
  features: {
    ema20: number;
    ema50: number;
    ema100?: number;
    ema200?: number;
    rsi14: number;
    atrPct: number;
    volPct: number;
    last: number;
    support: number;
    resistance: number;
    trend: number;
    trendStrength?: number;
    trendBias?: string;
    adx14?: number;
    volume?: number;
    volumeMA?: number;
    volume24hChangePct?: number;
    pivots: any;
    srBias: any;
  };
}) {
  const { features } = ctx;
  const trendStrength = Number.isFinite(features.trendStrength)
    ? Math.abs(features.trendStrength || 0)
    : Math.abs((features.trend / Math.max(1e-6, features.last)) * 100);
  const trendDescriptor = (() => {
    const bias = (features.trendBias || '').toLowerCase();
    if (bias === 'bullish' && trendStrength >= 0.9) return 'strong uptrend';
    if (bias === 'bullish' && trendStrength >= 0.4) return 'moderate uptrend';
    if (bias === 'bearish' && trendStrength >= 0.9) return 'strong downtrend';
    if (bias === 'bearish' && trendStrength >= 0.4) return 'moderate downtrend';
    if (trendStrength <= 0.2) return 'range-bound';
    return bias === 'bullish'
      ? 'mild uptrend'
      : bias === 'bearish'
        ? 'mild downtrend'
        : 'mixed/sideways';
  })();

  const momentumCondition = (() => {
    if (!Number.isFinite(features.ema20) || !Number.isFinite(features.ema50)) return 'momentum unclear';
    if (features.ema20 > features.ema50 * 1.003) return 'bullish momentum';
    if (features.ema20 < features.ema50 * 0.997) return 'bearish momentum';
    return 'flat momentum';
  })();

  const volumeTrend = (() => {
    const latest = Number(features.volume ?? NaN);
    const base = Number(features.volumeMA ?? NaN);
    if (!Number.isFinite(latest) || !Number.isFinite(base) || base <= 0) return 'neutral';
    const ratio = latest / base;
    if (ratio >= 1.5) return 'surging';
    if (ratio >= 1.15) return 'rising';
    if (ratio <= 0.6) return 'contracting';
    if (ratio <= 0.85) return 'soft';
    return 'steady';
  })();

  const higherTrend = (() => {
    if (typeof features.trendBias === 'string') {
      if (features.trendBias === 'bullish') return 'higher timeframes support uptrend';
      if (features.trendBias === 'bearish') return 'higher timeframes lean down';
      return 'higher timeframes neutral';
    }
    return 'higher timeframe view unclear';
  })();

  const confidenceScore = (() => {
    const adx = Number(features.adx14 ?? NaN);
    const base = Math.min(100, Math.max(0, trendStrength * 12));
    if (Number.isFinite(adx)) {
      if (adx >= 30) return Math.min(100, Math.round(base + 20));
      if (adx >= 20) return Math.min(100, Math.round(base + 10));
      if (adx <= 12) return Math.max(20, Math.round(base - 10));
    }
    return Math.round(base || 35);
  })();

  return `
You are a trading strategy generator AI. Analyze the market context and respond with a JSON trade plan plus a concise rationale.

Market Data (15m timeframe, with higher context):
- Trend: ${trendDescriptor}.
- srBias: ${features.srBias ?? 'neutral'}.
- Indicators: EMA20=${features.ema20?.toFixed?.(4) ?? features.ema20} vs EMA50=${features.ema50?.toFixed?.(4) ?? features.ema50} (${momentumCondition}); RSI=${features.rsi14?.toFixed?.(2) ?? features.rsi14}; ATR%=${features.atrPct?.toFixed?.(2) ?? features.atrPct} (volatility); Volume ${volumeTrend}.
- Higher Timeframe Trend (4H/1D): ${higherTrend}.
- Confidence Score: ${confidenceScore}% (model’s confidence in bias direction).

Guidelines:
1. Bias Decision – Trend vs Range: strong trends with solid volume should favor continuation longs/shorts. Only fade if momentum is waning with clear reversal signals.
2. Momentum Strategy: for trend-following trades use ~1.5×ATR or logical swing level for stops, go for 2–3R targets, consider partial at 1R then trail. Avoid premature scaling out.
3. Range/Mean-Reversion Strategy: if trend weak or momentum diverging at extremes, use tight stops (~ATR or 1%) and modest targets toward next S/R. Limit to at most two exit tiers.
4. No Trade / Caution: if signals conflict or confidence <70% without confirmation, output a no-trade plan (bias="range" with zero risk) or explain the caution in rationale.
5. Risk Management: default risk ≈1% of balance. If confidence >90% and setup strong you may go up to 1.5% risk and max leverage, otherwise scale risk down when confidence soft.

Output Format (STRICT JSON, no markdown):
{
  "strategyId": "string",
  "symbol": "SYMBOL",
  "bias": "long|short|range",
  "confidence": 0.0–1.0,
  "entry": {
    "type": "limit|market",
    "price": number|null,
    "zone": { "min": number|null, "max": number|null },
    "confirmations": string[]
  },
  "stop": { "type": "percent|price", "value": number },
  "target": { "type": "percent|price", "value": number },
  "risk_pct_balance": number,
  "max_leverage": number,
  "management": {
    "take_profit_scaling": "single|partial|runner",
    "trailing_stop": { "active": boolean, "trigger_multiple": number|null, "step_multiple": number|null } | null
  },
  "validity": { "from": "ISO8601", "to": "ISO8601|null" },
  "rationale": "string",
  "trigger": "string"
}

Always explain why you chose momentum vs range, how stops/targets relate to ATR or structure, and outline any trailing logic.

Context:
${JSON.stringify(ctx, null, 2)}
`.trim();
}
