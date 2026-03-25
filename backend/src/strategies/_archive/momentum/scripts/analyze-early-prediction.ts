/**
 * Analyze if we can predict 5-min BTC direction BEFORE the window opens,
 * using only pre-window data (past results, momentum, patterns).
 * If yes → we can buy at T+0 when CLOB ≈ 0.50 instead of T+2.5min when CLOB ≈ 0.83.
 *
 * Usage: npx tsx scripts/analyze-early-prediction.ts --days 30
 */

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name: string, def: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
}
const DAYS = parseInt(getArg('days', '30'));

interface Candle1m {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Fetch 1m candles from Binance ────────────────────────────────────────────
async function fetchCandles1m(startMs: number, endMs: number): Promise<Candle1m[]> {
  const candles: Candle1m[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance API ${res.status}`);
    const data = (await res.json()) as any[];
    if (data.length === 0) break;
    for (const k of data) {
      candles.push({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      });
    }
    cursor = data[data.length - 1][0] + 60_000;
    await new Promise((r) => setTimeout(r, 100));
  }
  return candles;
}

// ── Window result ────────────────────────────────────────────────────────────
interface Window5m {
  start: number;
  openPrice: number;
  closePrice: number;
  result: 'UP' | 'DOWN';
  candles: Candle1m[];      // 5 candles within window
  preCandles: Candle1m[];   // 20 candles before window
}

async function main() {
  const endMs = Date.now();
  const startMs = endMs - DAYS * 24 * 60 * 60 * 1000;

  console.log(`\n🔄 Fetching ${DAYS} days of 1m BTC candles...`);
  const allCandles = await fetchCandles1m(startMs, endMs);
  console.log(`   Got ${allCandles.length} candles\n`);

  const byTs = new Map<number, Candle1m>();
  for (const c of allCandles) byTs.set(c.timestamp, c);

  // Build all 5-min windows
  const FIVE_MIN = 5 * 60_000;
  const ONE_MIN = 60_000;
  const firstWindow = Math.ceil(allCandles[0].timestamp / FIVE_MIN) * FIVE_MIN + 20 * ONE_MIN;
  const lastWindow = Math.floor(allCandles[allCandles.length - 1].timestamp / FIVE_MIN) * FIVE_MIN - FIVE_MIN;

  const windows: Window5m[] = [];
  for (let ws = firstWindow; ws <= lastWindow; ws += FIVE_MIN) {
    const candles: Candle1m[] = [];
    for (let i = 0; i < 5; i++) {
      const c = byTs.get(ws + i * ONE_MIN);
      if (c) candles.push(c);
    }
    if (candles.length < 5) continue;

    const preCandles: Candle1m[] = [];
    for (let i = 20; i >= 1; i--) {
      const c = byTs.get(ws - i * ONE_MIN);
      if (c) preCandles.push(c);
    }

    const openPrice = candles[0].open;
    const closePrice = candles[4].close;

    windows.push({
      start: ws,
      openPrice,
      closePrice,
      result: closePrice >= openPrice ? 'UP' : 'DOWN',
      candles,
      preCandles,
    });
  }

  console.log(`📊 ${windows.length} complete 5-min windows over ${DAYS} days\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 1: Previous window continuation (if last was UP → bet UP)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═══ Strategy 1: Previous window continuation ═══');
  let s1wins = 0, s1total = 0;
  for (let i = 1; i < windows.length; i++) {
    const prediction = windows[i - 1].result; // bet same as last window
    s1total++;
    if (prediction === windows[i].result) s1wins++;
  }
  console.log(`   Bet same direction as previous window`);
  console.log(`   ${s1wins}W / ${s1total - s1wins}L = ${((s1wins / s1total) * 100).toFixed(1)}% WR\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 2: Previous window reversal (if last was UP → bet DOWN)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═══ Strategy 2: Previous window reversal ═══');
  const s2wins = s1total - s1wins; // opposite of strategy 1
  console.log(`   Bet opposite of previous window`);
  console.log(`   ${s2wins}W / ${s1total - s2wins}L = ${((s2wins / s1total) * 100).toFixed(1)}% WR\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 3: Streak continuation (after N same results, bet same)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═══ Strategy 3: Streak analysis ═══');
  console.log('   After N consecutive same results, what happens next?');
  console.log('   Streak │ Continuation │ Reversal │ Cont. WR');
  console.log('   ───────┼──────────────┼──────────┼─────────');

  for (const streakLen of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    let cont = 0, rev = 0;
    for (let i = streakLen; i < windows.length; i++) {
      // Check if last N windows had same result
      const streakDir = windows[i - 1].result;
      let isStreak = true;
      for (let j = 1; j < streakLen; j++) {
        if (windows[i - 1 - j].result !== streakDir) { isStreak = false; break; }
      }
      if (!isStreak) continue;
      if (windows[i].result === streakDir) cont++;
      else rev++;
    }
    const total = cont + rev;
    if (total === 0) continue;
    const contWr = ((cont / total) * 100).toFixed(1);
    console.log(`     ${String(streakLen).padStart(3)}x  │ ${String(cont).padStart(12)} │ ${String(rev).padStart(8)} │ ${contWr.padStart(6)}%`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 4: Pre-window momentum (use ROC of last 5/10/20 candles)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══ Strategy 4: Pre-window momentum ═══');
  console.log('   Use ROC of last N 1m candles before window to predict direction');

  for (const lookback of [3, 5, 10, 20]) {
    let wins = 0, total = 0, skipped = 0;
    for (const w of windows) {
      if (w.preCandles.length < lookback) { skipped++; continue; }
      const recent = w.preCandles.slice(-lookback);
      const roc = (recent[recent.length - 1].close - recent[0].open) / recent[0].open;
      if (Math.abs(roc) < 0.0001) { skipped++; continue; } // flat → skip
      const prediction: 'UP' | 'DOWN' = roc > 0 ? 'UP' : 'DOWN'; // continuation
      total++;
      if (prediction === w.result) wins++;
    }
    console.log(`   Last ${String(lookback).padStart(2)} candles ROC: ${wins}W / ${total - wins}L = ${((wins / total) * 100).toFixed(1)}% WR (${skipped} flat skipped)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 5: Pre-window momentum with THRESHOLD (only bet if strong signal)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══ Strategy 5: Pre-window momentum with MIN ROC threshold ═══');
  console.log('   Only bet when pre-window ROC exceeds threshold (stronger signal)');
  console.log('   Lookback │ Min ROC │ Count │ W/L       │ WR%');
  console.log('   ─────────┼─────────┼───────┼───────────┼────────');

  for (const lookback of [5, 10, 20]) {
    for (const minRoc of [0.02, 0.05, 0.08, 0.10, 0.15, 0.20]) {
      let wins = 0, total = 0;
      for (const w of windows) {
        if (w.preCandles.length < lookback) continue;
        const recent = w.preCandles.slice(-lookback);
        const rocPct = ((recent[recent.length - 1].close - recent[0].open) / recent[0].open) * 100;
        if (Math.abs(rocPct) < minRoc) continue;
        const prediction: 'UP' | 'DOWN' = rocPct > 0 ? 'UP' : 'DOWN';
        total++;
        if (prediction === w.result) wins++;
      }
      if (total < 10) continue;
      const wr = ((wins / total) * 100).toFixed(1);
      console.log(`       ${String(lookback).padStart(2)}    │ ${(minRoc).toFixed(2)}%  │ ${String(total).padStart(5)} │ ${String(wins).padStart(4)}/${String(total - wins).padStart(4)} │ ${wr.padStart(5)}%`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 6: Volume spike in pre-window predicts momentum
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══ Strategy 6: Volume spike + momentum (pre-window only) ═══');
  console.log('   High volume + clear direction in last 5 candles → bet continuation');
  console.log('   Vol ratio │ Min ROC │ Count │ W/L       │ WR%');
  console.log('   ──────────┼─────────┼───────┼───────────┼────────');

  for (const volThresh of [1.2, 1.5, 2.0]) {
    for (const minRoc of [0.03, 0.05, 0.10]) {
      let wins = 0, total = 0;
      for (const w of windows) {
        if (w.preCandles.length < 20) continue;
        const last5 = w.preCandles.slice(-5);
        const prev15 = w.preCandles.slice(0, 15);

        const avgVol5 = last5.reduce((s, c) => s + c.volume, 0) / 5;
        const avgVol15 = prev15.reduce((s, c) => s + c.volume, 0) / Math.max(prev15.length, 1);
        const volRatio = avgVol15 > 0 ? avgVol5 / avgVol15 : 0;
        if (volRatio < volThresh) continue;

        const rocPct = ((last5[4].close - last5[0].open) / last5[0].open) * 100;
        if (Math.abs(rocPct) < minRoc) continue;

        const prediction: 'UP' | 'DOWN' = rocPct > 0 ? 'UP' : 'DOWN';
        total++;
        if (prediction === w.result) wins++;
      }
      if (total < 10) continue;
      const wr = ((wins / total) * 100).toFixed(1);
      console.log(`      ${volThresh.toFixed(1)}x   │ ${minRoc.toFixed(2)}%  │ ${String(total).padStart(5)} │ ${String(wins).padStart(4)}/${String(total - wins).padStart(4)} │ ${wr.padStart(5)}%`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 7: Combined score (momentum + volume + alignment) pre-window
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══ Strategy 7: Combined pre-window scorer ═══');
  console.log('   Score = momentum(25) + volume(25) + alignment(25) + body(25)');
  console.log('   Only bet if score >= threshold');
  console.log('   Threshold │ Count │ W/L         │ WR%    │ EV@0.50  │ EV@0.55');
  console.log('   ──────────┼───────┼─────────────┼────────┼──────────┼────────');

  for (const threshold of [30, 40, 50, 60, 70, 80]) {
    let wins = 0, total = 0;
    for (const w of windows) {
      if (w.preCandles.length < 10) continue;
      const last5 = w.preCandles.slice(-5);
      const prev = w.preCandles.slice(0, -5);

      // Direction from pre-window
      const roc = ((last5[4].close - last5[0].open) / last5[0].open) * 100;
      if (Math.abs(roc) < 0.01) continue;
      const dir: 'UP' | 'DOWN' = roc > 0 ? 'UP' : 'DOWN';

      // Score components (0-25 each)
      const absRoc = Math.abs(roc);
      const momentum = absRoc >= 0.15 ? 25 : absRoc >= 0.08 ? 18 : absRoc >= 0.04 ? 10 : 0;

      const avgVol5 = last5.reduce((s, c) => s + c.volume, 0) / 5;
      const avgVolPrev = prev.length > 0 ? prev.reduce((s, c) => s + c.volume, 0) / prev.length : 0;
      const volRatio = avgVolPrev > 0 ? avgVol5 / avgVolPrev : 0;
      const volume = volRatio >= 2 ? 25 : volRatio >= 1.5 ? 18 : volRatio >= 1.2 ? 10 : 0;

      const aligned = last5.filter((c) => dir === 'UP' ? c.close >= c.open : c.close <= c.open).length;
      const alignment = aligned >= 4 ? 25 : aligned >= 3 ? 15 : aligned >= 2 ? 5 : 0;

      const bodies = last5.map((c) => {
        const range = c.high - c.low;
        return range > 0 ? Math.abs(c.close - c.open) / range : 0;
      });
      const avgBody = bodies.reduce((s, b) => s + b, 0) / 5;
      const body = avgBody >= 0.7 ? 25 : avgBody >= 0.5 ? 15 : avgBody >= 0.3 ? 8 : 0;

      const score = momentum + volume + alignment + body;
      if (score < threshold) continue;

      total++;
      if (dir === w.result) wins++;
    }
    if (total < 5) continue;
    const wr = (wins / total) * 100;
    const ev50 = (wr / 100) * 5 - (1 - wr / 100) * 5;
    const ev55 = (wr / 100) * (5 * 0.45 / 0.55) - (1 - wr / 100) * 5;
    console.log(
      `       ${String(threshold).padStart(3)}    │ ${String(total).padStart(5)} │ ${String(wins).padStart(4)}/${String(total - wins).padStart(4)}    │ ${wr.toFixed(1).padStart(5)}% │ ${(ev50 >= 0 ? '+' : '') + ev50.toFixed(2).padStart(5)} │ ${(ev55 >= 0 ? '+' : '') + ev55.toFixed(2).padStart(5)}`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTOCORRELATION
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══ Autocorrelation (lag 1-10 windows) ═══');
  console.log('   How correlated is each window with N windows back?');
  for (let lag = 1; lag <= 10; lag++) {
    let same = 0, total = 0;
    for (let i = lag; i < windows.length; i++) {
      total++;
      if (windows[i].result === windows[i - lag].result) same++;
    }
    const pct = ((same / total) * 100).toFixed(1);
    const bar = same / total > 0.5 ? '█'.repeat(Math.round((same / total - 0.5) * 100)) : '░'.repeat(Math.round((0.5 - same / total) * 100));
    console.log(`   Lag ${String(lag).padStart(2)}: ${pct}% same direction ${bar}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
