import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';

const { computeSwingTolerancePct, swingLevels } = await import('../../dist/src/ai/tech.js');

function buildSyntheticSeries({ base = 100, amplitudeHigh, amplitudeLow, drift, cycles = 6 }) {
  const highs = [];
  const lows = [];
  const closes = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    const cycleBase = base + cycle * drift;
    const bars = [
      { high: cycleBase + amplitudeHigh, low: cycleBase - amplitudeLow * 0.25 },
      { high: cycleBase + amplitudeHigh * 0.55, low: cycleBase - amplitudeLow * 0.65 },
      { high: cycleBase + amplitudeHigh * 0.35, low: cycleBase - amplitudeLow },
      { high: cycleBase + amplitudeHigh * 0.6, low: cycleBase - amplitudeLow * 0.45 },
    ];
    for (const bar of bars) {
      highs.push(Number(bar.high.toFixed(4)));
      lows.push(Number(bar.low.toFixed(4)));
      closes.push(Number(((bar.high + bar.low) / 2).toFixed(4)));
    }
  }
  return { highs, lows, closes };
}

const lowVolSeries = buildSyntheticSeries({ amplitudeHigh: 0.55, amplitudeLow: 0.5, drift: 0.34 });
const highVolSeries = buildSyntheticSeries({ amplitudeHigh: 3.2, amplitudeLow: 3.0, drift: 0.34 });

const lowTolerance = computeSwingTolerancePct({ atrPct: 0.4, realizedVol: 25 });
const highTolerance = computeSwingTolerancePct({ atrPct: 4.5, realizedVol: 110 });

assert(lowTolerance > 0, 'Low-volatility tolerance should be positive');
assert(highTolerance > lowTolerance, 'High-volatility tolerance should exceed low-volatility tolerance');

const lowVolSwings = swingLevels(lowVolSeries.highs, lowVolSeries.lows, lowVolSeries.closes, 2, lowTolerance);
const highVolSwings = swingLevels(highVolSeries.highs, highVolSeries.lows, highVolSeries.closes, 2, highTolerance);

assert(lowVolSwings.resistances.length > highVolSwings.resistances.length,
  'Lower tolerance should keep more distinct resistance levels');
assert(lowVolSwings.supports.length > highVolSwings.supports.length,
  'Lower tolerance should keep more distinct support levels');

assert(highVolSwings.resistances[0]?.touches >= 2,
  'High-volatility tolerance should merge nearby resistance swings');
assert(highVolSwings.supports[0]?.touches >= 2,
  'High-volatility tolerance should merge nearby support swings');

const overrideTolerance = computeSwingTolerancePct({ atrPct: 4.5, realizedVol: 110, override: 0.3 });
assert.equal(overrideTolerance, 0.3, 'Explicit override should be used when provided');

const clampedOverride = computeSwingTolerancePct({ atrPct: 4.5, realizedVol: 110, override: 2 });
assert.equal(clampedOverride, 0.7, 'Override should respect the configured maximum bound');
