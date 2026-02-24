import type { Candle1m, PredictionResult, ScoreBreakdown } from './polymarketTypes.js';

/**
 * Compute a 5-minute direction prediction score from 1m candles.
 *
 * @param windowCandles   - 1m candles within the current 5-min window
 * @param preWindowCandles - 1m candles preceding the window (context)
 * @param windowOpenPrice  - price at the start of the 5-min window
 * @returns PredictionResult always (null only if no candles). Threshold filtering done in worker.
 */
export function computeFiveMinScore(
  windowCandles: Candle1m[],
  preWindowCandles: Candle1m[],
  windowOpenPrice: number,
): PredictionResult | null {
  if (windowCandles.length < 1) return null;

  const currentClose = windowCandles[windowCandles.length - 1].close;
  const microRocPct = ((currentClose - windowOpenPrice) / windowOpenPrice) * 100;
  const direction: 'UP' | 'DOWN' = microRocPct >= 0 ? 'UP' : 'DOWN';

  // --- 1. Volume Spike (0-25) ---
  const avgWindowVol =
    windowCandles.reduce((s, c) => s + c.volume, 0) / windowCandles.length;
  const avgPreVol =
    preWindowCandles.length > 0
      ? preWindowCandles.reduce((s, c) => s + c.volume, 0) / preWindowCandles.length
      : 0;
  const volRatio = avgPreVol > 0 ? avgWindowVol / avgPreVol : 0;
  const volumeSpike =
    volRatio >= 2 ? 25 : volRatio >= 1.5 ? 15 : volRatio >= 1.2 ? 8 : 0;

  // --- 2. Micro-ROC (0-20) ---
  const absRoc = Math.abs(microRocPct);
  const microRoc =
    absRoc >= 0.15 ? 20 : absRoc >= 0.08 ? 12 : absRoc >= 0.04 ? 6 : 0;

  // --- 3. Body Ratio (0-15) ---
  const bodyRatios = windowCandles.map((c) => {
    const range = c.high - c.low;
    if (range === 0) return 0;
    return Math.abs(c.close - c.open) / range;
  });
  const avgBodyRatio =
    bodyRatios.reduce((s, r) => s + r, 0) / bodyRatios.length;
  const bodyRatio =
    avgBodyRatio >= 0.7 ? 15 : avgBodyRatio >= 0.5 ? 10 : avgBodyRatio >= 0.3 ? 5 : 0;

  // --- 4. Wick Rejection (-15 to +15) ---
  let wickRaw = 0;
  for (const c of windowCandles) {
    const range = c.high - c.low;
    if (range === 0) continue;

    // "Opposing wick" = wick on the side opposite to the predicted direction
    // For UP prediction: opposing wick is the UPPER wick (sellers rejecting highs)
    // For DOWN prediction: opposing wick is the LOWER wick (buyers rejecting lows)
    const opposingWick =
      direction === 'UP'
        ? (c.high - Math.max(c.open, c.close)) / range
        : (Math.min(c.open, c.close) - c.low) / range;

    if (opposingWick >= 0.4) {
      wickRaw -= 5;
    } else if (opposingWick < 0.15) {
      wickRaw += 5;
    }
  }
  const wickRejection = Math.max(-15, Math.min(15, wickRaw));

  // --- 5. Candle Alignment (0-15) ---
  const aligned = windowCandles.filter((c) =>
    direction === 'UP' ? c.close >= c.open : c.close <= c.open,
  ).length;
  const alignPct = (aligned / windowCandles.length) * 100;
  const candleAlignment =
    alignPct >= 90 ? 15 : alignPct >= 60 ? 10 : alignPct >= 40 ? 5 : 0;

  // --- 6. Pre-window Momentum (-10 to +10) ---
  let preWindowMomentum = 0;
  if (preWindowCandles.length >= 2) {
    const preFirst = preWindowCandles[0].open;
    const preLast = preWindowCandles[preWindowCandles.length - 1].close;
    const preRocPct = ((preLast - preFirst) / preFirst) * 100;
    const preAligned =
      (direction === 'UP' && preRocPct >= 0) ||
      (direction === 'DOWN' && preRocPct < 0);

    const absPreRoc = Math.abs(preRocPct);
    if (preAligned) {
      preWindowMomentum = absPreRoc >= 0.1 ? 10 : absPreRoc >= 0.05 ? 5 : 0;
    } else {
      preWindowMomentum = absPreRoc >= 0.1 ? -10 : absPreRoc >= 0.05 ? -5 : 0;
    }
  }

  // --- Total ---
  const total =
    volumeSpike + microRoc + bodyRatio + wickRejection + candleAlignment + preWindowMomentum;

  const score: ScoreBreakdown = {
    volumeSpike,
    microRoc,
    bodyRatio,
    wickRejection,
    candleAlignment,
    preWindowMomentum,
    total,
  };

  return {
    direction,
    confidence: total,
    score,
    microRocPct,
  };
}
