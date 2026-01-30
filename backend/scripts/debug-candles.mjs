/**
 * Debug script: Verify candle data integrity for chart display
 * Checks for gaps, duplicates, and timestamp consistency
 */

const BINANCE_REST_BASE = 'https://fapi.binance.com';

async function fetchCandles(symbol, interval, limit) {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  });
  const url = `${BINANCE_REST_BASE}/fapi/v1/klines?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.map(row => ({
    openTime: Number(row[0]),
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
    closeTime: Number(row[6]),
  }));
}

function analyzeCandles(candles, interval) {
  const intervalMs = {
    '1m': 60_000,
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '1h': 60 * 60_000,
    '4h': 4 * 60 * 60_000,
  }[interval];

  console.log(`\n=== Analysis: ${candles.length} candles @ ${interval} ===`);
  console.log(`First: ${new Date(candles[0].openTime).toISOString()} price=${candles[0].open}`);
  console.log(`Last:  ${new Date(candles[candles.length - 1].openTime).toISOString()} price=${candles[candles.length - 1].close}`);

  const totalTimeH = (candles[candles.length - 1].openTime - candles[0].openTime) / 3600_000;
  console.log(`Time span: ${totalTimeH.toFixed(1)}h`);

  // Check for gaps
  let gaps = 0;
  let maxGap = 0;
  let maxGapIdx = -1;
  let maxPriceJump = 0;
  let maxPriceJumpIdx = -1;

  for (let i = 1; i < candles.length; i++) {
    const timeDiff = candles[i].openTime - candles[i - 1].openTime;
    const expectedDiff = intervalMs;

    if (timeDiff !== expectedDiff) {
      gaps++;
      const gapCandles = timeDiff / intervalMs;
      if (timeDiff > maxGap) {
        maxGap = timeDiff;
        maxGapIdx = i;
      }
      if (gaps <= 5) {
        console.log(`  GAP at index ${i}: ${new Date(candles[i-1].openTime).toISOString()} -> ${new Date(candles[i].openTime).toISOString()} (${gapCandles.toFixed(1)} candles missing, ${(timeDiff/60000).toFixed(0)}min)`);
      }
    }

    // Check price jumps
    const priceJump = Math.abs(candles[i].open - candles[i - 1].close);
    const jumpPct = (priceJump / candles[i - 1].close) * 100;
    if (jumpPct > maxPriceJump) {
      maxPriceJump = jumpPct;
      maxPriceJumpIdx = i;
    }
    if (jumpPct > 0.5) { // > 0.5% jump between candles
      console.log(`  PRICE JUMP at index ${i}: ${candles[i-1].close.toFixed(2)} -> ${candles[i].open.toFixed(2)} (${jumpPct.toFixed(2)}%) at ${new Date(candles[i].openTime).toISOString()}`);
    }
  }

  console.log(`\nTotal gaps: ${gaps}`);
  if (maxGapIdx >= 0) {
    console.log(`Max gap: ${(maxGap / 60000).toFixed(0)}min at index ${maxGapIdx}`);
  }
  console.log(`Max price jump: ${maxPriceJump.toFixed(2)}% at index ${maxPriceJumpIdx}`);

  // Check if data looks like what the chart shows (90K->82K in few candles)
  const priceRange = candles.reduce((acc, c) => ({
    min: Math.min(acc.min, c.low),
    max: Math.max(acc.max, c.high),
  }), { min: Infinity, max: -Infinity });

  console.log(`Price range: ${priceRange.min.toFixed(2)} - ${priceRange.max.toFixed(2)}`);
}

async function main() {
  console.log('Fetching 200 candles of BTC 15m from Binance REST API directly...');
  const candles = await fetchCandles('BTCUSDT', '15m', 200);
  analyzeCandles(candles, '15m');

  // Now simulate what the backend does: convert timestamps
  console.log('\n=== Simulating backend->frontend conversion ===');
  const backendData = candles.map(c => ({
    timestamp: new Date(c.openTime).toISOString(),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));

  // Frontend conversion
  const frontendData = backendData.map(c => ({
    time: new Date(c.timestamp).getTime() / 1000,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
  }));

  // Check frontend data integrity
  console.log(`Frontend candles: ${frontendData.length}`);
  console.log(`First time: ${frontendData[0].time} = ${new Date(frontendData[0].time * 1000).toISOString()}`);
  console.log(`Last time: ${frontendData[frontendData.length-1].time} = ${new Date(frontendData[frontendData.length-1].time * 1000).toISOString()}`);

  // Check for duplicate times (lightweight-charts will break)
  const timeSet = new Set();
  let dupes = 0;
  for (const c of frontendData) {
    if (timeSet.has(c.time)) {
      dupes++;
      console.log(`  DUPLICATE time: ${c.time} = ${new Date(c.time * 1000).toISOString()}`);
    }
    timeSet.add(c.time);
  }
  console.log(`Duplicate timestamps: ${dupes}`);

  // Now test what the BACKEND OHLCV endpoint would return via WebSocket
  // Simulate: fetch from our backend
  try {
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
    console.log(`\n=== Fetching from backend ${backendUrl} ===`);
    const res = await fetch(`${backendUrl}/api/market/ohlcv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT:USDT', timeframe: '15m', limit: 200 }),
    });
    if (!res.ok) {
      console.log(`Backend returned ${res.status}: ${await res.text()}`);
      return;
    }
    const backendResponse = await res.json();
    console.log(`Backend returned ${backendResponse.count} candles (fromCache: ${backendResponse.fromCache || false})`);

    if (backendResponse.data && backendResponse.data.length > 0) {
      const bd = backendResponse.data;
      console.log(`First: ${bd[0].timestamp} price=${bd[0].open}`);
      console.log(`Last:  ${bd[bd.length-1].timestamp} price=${bd[bd.length-1].close}`);

      // Check gaps in backend data
      const intervalMs = 15 * 60_000;
      let backendGaps = 0;
      for (let i = 1; i < bd.length; i++) {
        const t1 = new Date(bd[i-1].timestamp).getTime();
        const t2 = new Date(bd[i].timestamp).getTime();
        const diff = t2 - t1;
        if (diff !== intervalMs) {
          backendGaps++;
          const missingCandles = Math.round(diff / intervalMs) - 1;
          if (backendGaps <= 10) {
            console.log(`  BACKEND GAP at index ${i}: ${bd[i-1].timestamp} -> ${bd[i].timestamp} (${missingCandles} candles missing, ${(diff/60000).toFixed(0)}min)`);
          }
          // Check price across gap
          const priceBefore = bd[i-1].close;
          const priceAfter = bd[i].open;
          const jumpPct = Math.abs(priceAfter - priceBefore) / priceBefore * 100;
          if (jumpPct > 0.3) {
            console.log(`    Price: ${priceBefore} -> ${priceAfter} (${jumpPct.toFixed(2)}% jump across gap)`);
          }
        }
      }
      console.log(`Total backend gaps: ${backendGaps}`);

      // Compare with Binance direct
      console.log('\n=== Comparison: Binance direct vs Backend ===');
      const directPriceRange = candles.reduce((acc, c) => ({
        min: Math.min(acc.min, c.low),
        max: Math.max(acc.max, c.high),
      }), { min: Infinity, max: -Infinity });

      const backendPriceRange = bd.reduce((acc, c) => ({
        min: Math.min(acc.min, c.low),
        max: Math.max(acc.max, c.high),
      }), { min: Infinity, max: -Infinity });

      console.log(`Direct:  ${directPriceRange.min.toFixed(2)} - ${directPriceRange.max.toFixed(2)} (${candles.length} candles)`);
      console.log(`Backend: ${backendPriceRange.min.toFixed(2)} - ${backendPriceRange.max.toFixed(2)} (${bd.length} candles)`);

      // Check time range
      const directTimeRange = (candles[candles.length-1].openTime - candles[0].openTime) / 3600_000;
      const backendTimeRange = (new Date(bd[bd.length-1].timestamp).getTime() - new Date(bd[0].timestamp).getTime()) / 3600_000;
      console.log(`Direct time span:  ${directTimeRange.toFixed(1)}h`);
      console.log(`Backend time span: ${backendTimeRange.toFixed(1)}h`);

      if (Math.abs(directTimeRange - backendTimeRange) > 1) {
        console.log(`⚠️  TIME SPAN MISMATCH: Backend covers ${backendTimeRange.toFixed(1)}h vs expected ${directTimeRange.toFixed(1)}h`);
        console.log(`   This means the backend has ${Math.round(backendGaps)} gaps = missing candles!`);
        console.log(`   The chart would show price jumps where candles are missing.`);
      }
    }
  } catch (err) {
    console.log(`Cannot connect to backend: ${err.message}`);
    console.log('Run the backend first, or set BACKEND_URL env var');
  }
}

main().catch(console.error);
