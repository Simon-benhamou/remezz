/**
 * Download historical positioning data from Binance Futures for BTC, ETH, SOL, XRP.
 *
 * IMPORTANT — Binance API limitations discovered:
 *   - fundingRate:                startTime supported, full history available (2020+)
 *   - openInterestHist:           NO startTime/endTime support. Rolling window only.
 *                                 Max lookback: ~5 days (15m), ~30 days (1h), ~28 days (1d)
 *   - globalLongShortAccountRatio: same rolling-window limitation as OI
 *
 * Strategy:
 *   1. Funding rate: paginate from 2024-01-01 → now (full history)
 *   2. OI:          fetch max available with 1h period (best depth/granularity tradeoff)
 *   3. L/S ratio:   fetch max available with 1h period
 *
 * For OI and L/S ratio we fetch all 500 records (max limit) without startTime,
 * giving ~30 days of 1h data from today.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const FUNDING_START = new Date('2024-01-01T00:00:00Z');
const DELAY_MS = 350;

const DATA_DIR = path.join(__dirname, '..', 'data', 'positioning');

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortSym(symbol) {
  return symbol.replace('USDT', '');
}

function isoDate(ts) {
  return new Date(Number(ts)).toISOString();
}

/**
 * HTTPS GET → parsed JSON with retry on 429.
 */
function fetchJSON(url, retries = 5) {
  return new Promise((resolve, reject) => {
    const attempt = (left, waitMs) => {
      https
        .get(url, (res) => {
          if (res.statusCode === 429) {
            if (left <= 0) return reject(new Error(`Rate limited (429): ${url}`));
            console.warn(`  [429] rate limit — waiting ${waitMs}ms…`);
            res.resume();
            setTimeout(() => attempt(left - 1, waitMs * 2), waitMs);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          }
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(raw);
              // Binance API errors come back as 200 with {code, msg}
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.code) {
                return reject(new Error(`Binance error ${parsed.code}: ${parsed.msg} — ${url}`));
              }
              resolve(parsed);
            } catch (e) {
              reject(new Error(`JSON parse error: ${e.message}`));
            }
          });
        })
        .on('error', (err) => {
          if (left <= 0) return reject(err);
          setTimeout(() => attempt(left - 1, waitMs * 2), waitMs);
        });
    };
    attempt(retries, 2000);
  });
}

// ── 1. Funding Rate (full history via pagination) ─────────────────────────────

async function downloadFundingRate(symbol) {
  const LIMIT = 1000;
  const results = [];
  let startTime = FUNDING_START.getTime();
  const endTime = Date.now();

  console.log(
    `  [${symbol}] funding rate — from ${new Date(startTime).toISOString()} paginating…`,
  );

  while (startTime < endTime) {
    const url =
      `https://fapi.binance.com/fapi/v1/fundingRate` +
      `?symbol=${symbol}&startTime=${startTime}&limit=${LIMIT}`;

    const data = await fetchJSON(url);
    await sleep(DELAY_MS);

    if (!Array.isArray(data) || data.length === 0) break;

    for (const row of data) {
      results.push({
        symbol: row.symbol,
        fundingTime: Number(row.fundingTime),
        fundingRate: Number(row.fundingRate),
        markPrice: Number(row.markPrice),
      });
    }

    const last = data[data.length - 1];
    const newStart = Number(last.fundingTime) + 1;
    if (newStart <= startTime) break;
    startTime = newStart;
    if (data.length < LIMIT) break;
  }

  return results;
}

// ── 2. Open Interest (rolling window, max limit, 1h period) ──────────────────

async function downloadOI(symbol) {
  // Binance only stores ~30 days of OI history regardless of period.
  // 1h gives best depth: 500 records ≈ 20 days.
  const url =
    `https://fapi.binance.com/futures/data/openInterestHist` +
    `?symbol=${symbol}&period=1h&limit=500`;

  console.log(`  [${symbol}] OI (1h, rolling window, max 500 records)…`);

  const data = await fetchJSON(url);
  await sleep(DELAY_MS);

  if (!Array.isArray(data)) return [];

  return data.map((row) => ({
    symbol: row.symbol,
    timestamp: Number(row.timestamp),
    sumOpenInterest: Number(row.sumOpenInterest),
    sumOpenInterestValue: Number(row.sumOpenInterestValue),
  }));
}

// ── 3. Long/Short Account Ratio (rolling window, max limit, 1h period) ────────

async function downloadLSRatio(symbol) {
  const url =
    `https://fapi.binance.com/futures/data/globalLongShortAccountRatio` +
    `?symbol=${symbol}&period=1h&limit=500`;

  console.log(`  [${symbol}] L/S ratio (1h, rolling window, max 500 records)…`);

  const data = await fetchJSON(url);
  await sleep(DELAY_MS);

  if (!Array.isArray(data)) return [];

  return data.map((row) => ({
    symbol: row.symbol,
    timestamp: Number(row.timestamp),
    longShortRatio: Number(row.longShortRatio),
    longAccount: Number(row.longAccount),
    shortAccount: Number(row.shortAccount),
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`Created directory: ${DATA_DIR}`);
  }

  const summary = [];

  for (const symbol of SYMBOLS) {
    const sym = shortSym(symbol);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing ${symbol} (${sym})`);
    console.log('='.repeat(60));

    // ── Funding Rate ────────────────────────────────────────────────
    {
      const records = await downloadFundingRate(symbol);
      const filePath = path.join(DATA_DIR, `${sym}_funding.json`);
      fs.writeFileSync(filePath, JSON.stringify(records, null, 2));

      const first = records.length ? isoDate(records[0].fundingTime) : 'n/a';
      const last = records.length ? isoDate(records[records.length - 1].fundingTime) : 'n/a';
      console.log(`  Saved ${records.length} funding records → ${path.basename(filePath)}`);
      console.log(`    Range: ${first} → ${last}`);
      summary.push({ symbol, type: 'funding', count: records.length, first, last });
    }

    // ── Open Interest ───────────────────────────────────────────────
    {
      const records = await downloadOI(symbol);
      const filePath = path.join(DATA_DIR, `${sym}_oi_1h.json`);
      fs.writeFileSync(filePath, JSON.stringify(records, null, 2));

      const first = records.length ? isoDate(records[0].timestamp) : 'n/a';
      const last = records.length ? isoDate(records[records.length - 1].timestamp) : 'n/a';
      console.log(`  Saved ${records.length} OI records → ${path.basename(filePath)}`);
      console.log(`    Range: ${first} → ${last}`);
      summary.push({ symbol, type: 'oi_1h', count: records.length, first, last });
    }

    // ── Long/Short Ratio ────────────────────────────────────────────
    {
      const records = await downloadLSRatio(symbol);
      const filePath = path.join(DATA_DIR, `${sym}_ls_ratio_1h.json`);
      fs.writeFileSync(filePath, JSON.stringify(records, null, 2));

      const first = records.length ? isoDate(records[0].timestamp) : 'n/a';
      const last = records.length ? isoDate(records[records.length - 1].timestamp) : 'n/a';
      console.log(`  Saved ${records.length} L/S ratio records → ${path.basename(filePath)}`);
      console.log(`    Range: ${first} → ${last}`);
      summary.push({ symbol, type: 'ls_ratio_1h', count: records.length, first, last });
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(
    `${'Symbol'.padEnd(10)} ${'Type'.padEnd(16)} ${'Count'.padStart(7)}   ${'First'.padEnd(26)} Last`,
  );
  console.log('-'.repeat(105));
  for (const row of summary) {
    console.log(
      `${row.symbol.padEnd(10)} ${row.type.padEnd(16)} ${String(row.count).padStart(7)}   ${row.first.padEnd(26)} ${row.last}`,
    );
  }

  console.log(`
NOTE: openInterestHist and globalLongShortAccountRatio endpoints do NOT support
historical startTime/endTime queries. They only expose a rolling ~30-day window.
Funding rate history is full from 2024-01-01.
`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
