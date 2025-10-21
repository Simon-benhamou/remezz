import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const { computeMultiTimeframeDiagnostics } = await import('../../dist/src/ai/multiTimeframe.js');

const MINUTE = 60 * 1000;
const FIFTEEN_MIN = 15 * MINUTE;
const ONE_HOUR = 60 * MINUTE;
const FOUR_HOUR = 4 * ONE_HOUR;

function makeSeries({ start, step, length, intervalMs }) {
  const out = [];
  const now = Date.now();
  let price = start;
  for (let i = length; i > 0; i--) {
    const ts = now - i * intervalMs;
    const open = price;
    const close = price + step;
    const high = Math.max(open, close) * 1.001;
    const low = Math.min(open, close) * 0.999;
    const volume = 100;
    out.push([ts, open, high, low, close, volume]);
    price = close;
  }
  return out;
}

function momentumPct(series) {
  const last = series.at(-1)?.[4] ?? 0;
  const prev = series.at(-2)?.[4] ?? last;
  if (!prev) return 0;
  return ((last - prev) / prev) * 100;
}

const series4h = makeSeries({ start: 200, step: -1.5, length: 80, intervalMs: FOUR_HOUR });
const series1h = makeSeries({ start: 100, step: 0.8, length: 120, intervalMs: ONE_HOUR });
const series15m = makeSeries({ start: 50, step: 0.2, length: 160, intervalMs: FIFTEEN_MIN });

const expected4h = momentumPct(series4h);
const expected1h = momentumPct(series1h);
const expected15m = momentumPct(series15m);

const diag = await computeMultiTimeframeDiagnostics('TEST/USDT', {
  preloaded: {
    '4h': series4h,
    '1h': series1h,
    '15m': series15m,
  },
});

assert(diag && typeof diag === 'object', 'Diagnostics should be returned');
assert(diag.timeframes['4h'], '4h timeframe metrics missing');
assert(diag.timeframes['1h'], '1h timeframe metrics missing');
assert(diag.timeframes['15m'], '15m timeframe metrics missing');

assert(Math.abs(diag.timeframes['4h'].momentumPct - expected4h) < 1e-9, '4h momentum should use preloaded data');
assert(Math.abs(diag.timeframes['1h'].momentumPct - expected1h) < 1e-9, '1h momentum should use preloaded data');
assert(Math.abs(diag.timeframes['15m'].momentumPct - expected15m) < 1e-9, '15m momentum should use preloaded data');

console.log('✅ multi-timeframe preloaded metrics validated');
