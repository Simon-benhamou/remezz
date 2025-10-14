import { TechnicalSnapshot } from '../../ai/tech.js';

type StrategyBias = 'long' | 'short' | 'both';

export type RecognizedStrategyId =
  | 'classic_trend_following'
  | 'bollinger_mean_reversion'
  | 'breakout_retest';

export type RecognizedStrategySignal = {
  id: RecognizedStrategyId;
  label: string;
  bias: StrategyBias;
  confidence: number;
  active: boolean;
  reasons: string[];
  metrics: Record<string, number | string | null>;
};

type EvaluateOptions = {
  bias?: 'long' | 'short' | 'none';
  regime?: string | null;
  allowMomentumOverride?: boolean;
  favorMeanReversion?: boolean;
};

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function trendFollowingSignal(
  snap: TechnicalSnapshot,
  opts: EvaluateOptions,
): RecognizedStrategySignal[] {
  const { last: price, ema50, ema100, ema200, adx14, trendBias } = snap;
  const biasHint = opts.bias && opts.bias !== 'none' ? opts.bias : null;
  const ema200SlopeProxy = ema200 !== 0 ? ((ema100 - ema200) / ema200) * 100 : 0;
  const emaAlignmentScore = (() => {
    const distancePct = ema200 !== 0 ? ((price - ema200) / ema200) * 100 : 0;
    const alignment = ema50 >= ema100 && ema100 >= ema200;
    if (!alignment) return -Math.abs(distancePct);
    return distancePct;
  })();
  const distanceToEma200Pct = ema200 !== 0 ? ((price - ema200) / ema200) * 100 : 0;
  const adxScore = clamp((Number(adx14 ?? 0) - 18) / 20);
  const slopeScore = clamp(ema200SlopeProxy / 1.2);
  const distanceScore = clamp(distanceToEma200Pct / 3);
  const alignmentScore = emaAlignmentScore > 0 ? clamp(emaAlignmentScore / 4) : 0;
  const biasScore = trendBias === 'bullish' ? 1 : trendBias === 'bearish' ? 0 : 0.5;
  const confidenceLong = clamp((adxScore + slopeScore + distanceScore + biasScore) / 4);
  const confidenceShort = clamp((adxScore + clamp(-slopeScore, 0, 1) + clamp(-distanceScore, 0, 1) + (1 - biasScore)) / 4);

  const tolerance = Math.max(0.2, Math.min(1.5, (snap.atrPct ?? 0) * 0.75 + 0.2));
  const bullishAligned = price >= ema200 && ema100 >= ema200 && ema50 >= ema100 * 0.99;
  const bearishAligned = price <= ema200 && ema100 <= ema200 && ema50 <= ema100 * 1.01;

  const signals: RecognizedStrategySignal[] = [];

  if (bullishAligned || (biasHint === 'long' && distanceToEma200Pct > -tolerance)) {
    signals.push({
      id: 'classic_trend_following',
      label: 'Classic trend following (EMA200)',
      bias: 'long',
      confidence: confidenceLong,
      active: bullishAligned && Number(adx14 ?? 0) >= 22 && confidenceLong >= 0.45,
      reasons: [
        bullishAligned ? 'price_above_ema200' : 'bias_supports_long',
        ema100 >= ema200 ? 'ema_stack_bullish' : 'ema100_near_ema200',
        Number(adx14 ?? 0) >= 22 ? 'adx_confirms_trend' : 'adx_borderline',
      ],
      metrics: {
        adx: Number(adx14 ?? 0),
        ema200SlopePct: Number(ema200SlopeProxy.toFixed(3)),
        priceDistancePct: Number(distanceToEma200Pct.toFixed(3)),
        trendBias,
        tolerance,
      },
    });
  }

  if (bearishAligned || (biasHint === 'short' && distanceToEma200Pct < tolerance)) {
    signals.push({
      id: 'classic_trend_following',
      label: 'Classic trend following (EMA200)',
      bias: 'short',
      confidence: confidenceShort,
      active: bearishAligned && Number(adx14 ?? 0) >= 22 && confidenceShort >= 0.45,
      reasons: [
        bearishAligned ? 'price_below_ema200' : 'bias_supports_short',
        ema100 <= ema200 ? 'ema_stack_bearish' : 'ema100_near_ema200',
        Number(adx14 ?? 0) >= 22 ? 'adx_confirms_trend' : 'adx_borderline',
      ],
      metrics: {
        adx: Number(adx14 ?? 0),
        ema200SlopePct: Number((-ema200SlopeProxy).toFixed(3)),
        priceDistancePct: Number(distanceToEma200Pct.toFixed(3)),
        trendBias,
        tolerance,
      },
    });
  }

  return signals;
}

function meanReversionSignal(
  snap: TechnicalSnapshot,
  opts: EvaluateOptions,
): RecognizedStrategySignal[] {
  const { last: price, rsi14, support, resistance, srBias, atrPct, adx14 } = snap;
  const tolerancePct = Math.max(0.25, Math.min(1.2, (atrPct ?? 0) * 0.6 + 0.25));
  const signals: RecognizedStrategySignal[] = [];
  const adx = Number(adx14 ?? 0);

  if (support && price > 0) {
    const distPct = Math.abs((price - support) / price) * 100;
    const oversold = Number(rsi14 ?? 50) <= 45;
    const rsiScore = clamp((48 - Number(rsi14 ?? 50)) / 12);
    const distanceScore = clamp(1 - distPct / (tolerancePct * 2));
    const volatilityPenalty = clamp(1 - Math.max(0, adx - 18) / 25);
    const confidence = clamp((rsiScore + distanceScore + volatilityPenalty) / 3);
    const nearSupport = distPct <= tolerancePct * 1.5;
    const srAligned = srBias === 'nearSupport' || nearSupport;

    signals.push({
      id: 'bollinger_mean_reversion',
      label: 'Mean reversion (RSI/support bounce)',
      bias: 'long',
      confidence,
      active: srAligned && oversold && confidence >= 0.4,
      reasons: [
        srAligned ? 'price_near_support' : 'support_far',
        oversold ? 'rsi_oversold' : 'rsi_moderate',
        adx < 25 ? 'range_friendly_adx' : 'high_adx_penalty',
      ],
      metrics: {
        rsi: Number(rsi14 ?? 50),
        distancePct: Number(distPct.toFixed(3)),
        tolerancePct,
        adx,
      },
    });
  }

  if (resistance && price > 0) {
    const distPct = Math.abs((resistance - price) / price) * 100;
    const overbought = Number(rsi14 ?? 50) >= 55;
    const rsiScore = clamp((Number(rsi14 ?? 50) - 52) / 12);
    const distanceScore = clamp(1 - distPct / (tolerancePct * 2));
    const volatilityPenalty = clamp(1 - Math.max(0, adx - 18) / 25);
    const confidence = clamp((rsiScore + distanceScore + volatilityPenalty) / 3);
    const nearResistance = distPct <= tolerancePct * 1.5;
    const srAligned = srBias === 'nearResistance' || nearResistance;

    signals.push({
      id: 'bollinger_mean_reversion',
      label: 'Mean reversion (RSI/resistance fade)',
      bias: 'short',
      confidence,
      active: srAligned && overbought && confidence >= 0.4,
      reasons: [
        srAligned ? 'price_near_resistance' : 'resistance_far',
        overbought ? 'rsi_overbought' : 'rsi_moderate',
        adx < 25 ? 'range_friendly_adx' : 'high_adx_penalty',
      ],
      metrics: {
        rsi: Number(rsi14 ?? 50),
        distancePct: Number(distPct.toFixed(3)),
        tolerancePct,
        adx,
      },
    });
  }

  return signals;
}

function breakoutRetestSignal(
  snap: TechnicalSnapshot,
  opts: EvaluateOptions,
): RecognizedStrategySignal[] {
  const { last: price, support, resistance, adx14, trendBias, srBias, atrPct, cmf20 } = snap;
  const tolerancePct = Math.max(0.3, Math.min(1.5, (atrPct ?? 0) * 0.8 + 0.3));
  const adx = Number(adx14 ?? 0);
  const signals: RecognizedStrategySignal[] = [];
  const allowMomentum = opts.allowMomentumOverride ?? false;
  const breakoutFriendly = opts.regime !== 'range';

  if (resistance && price > 0) {
    const distancePct = ((price - resistance) / resistance) * 100;
    const withinRetest = distancePct >= -tolerancePct && distancePct <= tolerancePct * 0.8;
    const cmfScore = clamp(((cmf20 ?? 0) + 0.2) / 0.6);
    const alignmentScore = trendBias === 'bullish' ? 1 : 0.5;
    const distanceScore = clamp(1 - Math.abs(distancePct) / (tolerancePct * 0.8));
    const confidence = clamp((distanceScore + clamp((adx - 20) / 18, 0, 1) + cmfScore + alignmentScore) / 4);

    signals.push({
      id: 'breakout_retest',
      label: 'Breakout retest (former resistance)',
      bias: 'long',
      confidence,
      active: withinRetest && breakoutFriendly && (adx >= 22 || allowMomentum) && confidence >= 0.45,
      reasons: [
        withinRetest ? 'price_retesting_resistance' : 'price_not_retesting',
        adx >= 22 ? 'adx_supports_breakout' : 'adx_borderline',
        srBias === 'nearSupport' ? 'support_flipped' : 'awaiting_support_flip',
      ],
      metrics: {
        distancePct: Number(distancePct.toFixed(3)),
        tolerancePct,
        adx,
        cmf: cmf20 ?? null,
        trendBias,
      },
    });
  }

  if (support && price > 0) {
    const distancePct = ((support - price) / support) * 100;
    const withinRetest = distancePct >= -tolerancePct && distancePct <= tolerancePct * 0.8;
    const cmfScore = clamp((0.2 - (cmf20 ?? 0)) / 0.6);
    const alignmentScore = trendBias === 'bearish' ? 1 : 0.5;
    const distanceScore = clamp(1 - Math.abs(distancePct) / (tolerancePct * 0.8));
    const confidence = clamp((distanceScore + clamp((adx - 20) / 18, 0, 1) + cmfScore + alignmentScore) / 4);

    signals.push({
      id: 'breakout_retest',
      label: 'Breakout retest (former support)',
      bias: 'short',
      confidence,
      active: withinRetest && breakoutFriendly && (adx >= 22 || allowMomentum) && confidence >= 0.45,
      reasons: [
        withinRetest ? 'price_retesting_support' : 'price_not_retesting',
        adx >= 22 ? 'adx_supports_breakdown' : 'adx_borderline',
        srBias === 'nearResistance' ? 'resistance_flipped' : 'awaiting_resistance_flip',
      ],
      metrics: {
        distancePct: Number(distancePct.toFixed(3)),
        tolerancePct,
        adx,
        cmf: cmf20 ?? null,
        trendBias,
      },
    });
  }

  return signals;
}

export function evaluateRecognizedStrategies(
  snap: TechnicalSnapshot,
  opts: EvaluateOptions = {},
): RecognizedStrategySignal[] {
  const trendSignals = trendFollowingSignal(snap, opts);
  const meanSignals = meanReversionSignal(snap, opts);
  const breakoutSignals = breakoutRetestSignal(snap, opts);
  return [...trendSignals, ...meanSignals, ...breakoutSignals]
    .map(signal => ({
      ...signal,
      confidence: Number(signal.confidence.toFixed(4)),
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

export type { StrategyBias };
