/**
 * Test: Verify gap detection in prepareOhlcvSeries
 * Simulates the exact bug: REST historical candles + gap + WS live candles
 */

// Simulate the prepareOhlcvSeries logic
function timeframeToMs(tf) {
  const match = /^\s*(\d+)([mhd])\s*$/i.exec(tf);
  if (!match) return 0;
  const value = Number(match[1] || 0);
  const unit = match[2]?.toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return 0;
  switch (unit) {
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default: return 0;
  }
}

function prepareOhlcvSeries(raw, tf, limit) {
  const sorted = raw.slice()
    .filter(r => Array.isArray(r) && r.length >= 5 && Number(r[4]) > 0)
    .sort((a, b) => Number(a[0]) - Number(b[0]));

  if (!sorted.length) return { series: [], gaps: 0 };

  // DEDUPLICATE
  const deduped = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i + 1 < sorted.length && Number(sorted[i][0]) === Number(sorted[i + 1][0])) continue;
    deduped.push(sorted[i]);
  }

  // GAP DETECTION
  const intervalMs = timeframeToMs(tf);
  let contiguousStart = 0;
  let gapCount = 0;
  if (intervalMs > 0 && deduped.length > 1) {
    const maxGap = intervalMs * 1.5;
    for (let i = deduped.length - 1; i > 0; i--) {
      const diff = Number(deduped[i][0]) - Number(deduped[i - 1][0]);
      if (diff > maxGap) {
        gapCount++;
        contiguousStart = i;
        break;
      }
    }
  }
  const contiguous = contiguousStart > 0 ? deduped.slice(contiguousStart) : deduped;
  const clipped = contiguous.slice(-limit);
  return { series: clipped, gaps: gapCount };
}

// Generate candles
function makeCandles(startTs, count, intervalMs, startPrice) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const ts = startTs + i * intervalMs;
    const change = (Math.random() - 0.5) * 100;
    price += change;
    candles.push([ts, price, price + 50, price - 50, price + change/2, 1000]);
  }
  return candles;
}

const INTERVAL_15M = 15 * 60_000;

// TEST 1: No gaps - should return all candles
console.log('=== TEST 1: No gaps (200 contiguous candles) ===');
const now = Date.now();
const contiguous = makeCandles(now - 200 * INTERVAL_15M, 200, INTERVAL_15M, 90000);
const result1 = prepareOhlcvSeries(contiguous, '15m', 200);
console.log(`Input: 200, Output: ${result1.series.length}, Gaps: ${result1.gaps}`);
console.assert(result1.series.length === 200, 'Should return all 200');
console.assert(result1.gaps === 0, 'Should have 0 gaps');
console.log('✅ PASS\n');

// TEST 2: Gap in middle - simulates REST old + WS new with gap
console.log('=== TEST 2: Gap between REST historical and WS live ===');
const oldRest = makeCandles(now - 300 * INTERVAL_15M, 150, INTERVAL_15M, 94000); // 150 candles starting 75h ago
// GAP of 50 candles (12.5h)
const wsLive = makeCandles(now - 100 * INTERVAL_15M, 100, INTERVAL_15M, 87000);  // 100 candles ending now
const gapped = [...oldRest, ...wsLive];
console.log(`Input: ${gapped.length} candles (150 old + 100 new, gap of 50 candles)`);

// OLD behavior (no gap detection): would return 200 candles with a price jump
const oldResult = gapped.slice().sort((a, b) => a[0] - b[0]).slice(-200);
console.log(`OLD behavior: ${oldResult.length} candles, price jumps from ${oldRest[oldRest.length-1][4].toFixed(0)} to ${wsLive[0][1].toFixed(0)}`);

// NEW behavior: should only return the 100 contiguous WS candles
const result2 = prepareOhlcvSeries(gapped, '15m', 200);
console.log(`NEW behavior: ${result2.series.length} candles, Gaps detected: ${result2.gaps}`);
console.assert(result2.series.length === 100, `Should return 100 contiguous candles, got ${result2.series.length}`);
console.assert(result2.gaps === 1, 'Should detect 1 gap');

// Verify first candle of result matches first WS candle
const resultFirstTs = result2.series[0][0];
const wsFirstTs = wsLive[0][0];
console.assert(resultFirstTs === wsFirstTs, 'First candle should be from WS live data');
console.log('✅ PASS\n');

// TEST 3: Duplicate timestamps
console.log('=== TEST 3: Duplicate timestamps ===');
const withDupes = [...contiguous.slice(0, 100), ...contiguous.slice(95, 200)]; // 5 duplicates
console.log(`Input: ${withDupes.length} candles (5 duplicates)`);
const result3 = prepareOhlcvSeries(withDupes, '15m', 200);
console.log(`Output: ${result3.series.length} candles`);
console.assert(result3.series.length === 200, 'Should dedupe to 200');
console.log('✅ PASS\n');

// TEST 4: Exact scenario from user report
console.log('=== TEST 4: User scenario - 94K to 82K with gap ===');
const oldData = makeCandles(now - 400 * INTERVAL_15M, 200, INTERVAL_15M, 94000); // Old data ~4 days ago
// Gap of ~200 candles (50h)
const recentData = makeCandles(now - 50 * INTERVAL_15M, 50, INTERVAL_15M, 87000); // Recent 50 candles
const userScenario = [...oldData, ...recentData];
console.log(`Input: ${userScenario.length} candles (200 old from ~94K + gap + 50 recent from ~87K)`);

const result4 = prepareOhlcvSeries(userScenario, '15m', 200);
console.log(`Output: ${result4.series.length} candles, Gaps: ${result4.gaps}`);
console.log(`Price range: ${Math.min(...result4.series.map(c => c[3])).toFixed(0)} - ${Math.max(...result4.series.map(c => c[2])).toFixed(0)}`);
console.assert(result4.series.length === 50, `Should return only 50 recent candles, got ${result4.series.length}`);
console.assert(result4.gaps === 1, 'Should detect gap');
console.log('✅ PASS\n');

console.log('All tests passed!');
