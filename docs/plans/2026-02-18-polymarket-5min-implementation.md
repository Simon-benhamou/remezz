# Polymarket 5-Min Prediction Experiment — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an isolated experimental service within the Remezz backend that predicts 5-minute BTC direction using micro-structure indicators, fetches Polymarket odds, and tracks simulated P&L on a dedicated frontend dashboard.

**Architecture:** New service in `backend/src/services/polymarket/` with 4 files (types, scorer, API client, worker). New route in `backend/src/routes/polymarket.ts`. New Prisma model. New frontend page at `/predictions`. Worker runs as background setInterval, subscribes to BTC 1m klines via existing Binance WS.

**Tech Stack:** TypeScript, Prisma/Postgres, Binance WS (existing), Polymarket Gamma API (REST), React + Recharts + Lightweight Charts (frontend).

---

### Task 1: Prisma Schema — PolymarketPrediction Model

**Files:**
- Modify: `backend/prisma/schema.prisma:355` (after `TradeParityResult` closing brace)

**Step 1: Add the model**

Add before the `enum AgentActionStatus` block (line 357):

```prisma
model PolymarketPrediction {
  id              Int      @id @default(autoincrement())
  createdAt       DateTime @default(now())
  symbol          String   @default("BTC")
  windowStart     DateTime
  windowEnd       DateTime
  startPrice      Float
  endPrice        Float?
  prediction      String?
  confidence      Int?
  actualResult    String?
  entryOdds       Float?
  simulatedPnl    Float?
  scoreBreakdown  Json?
  isCorrect       Boolean?
  skipped         Boolean  @default(false)
  polymarketSlug  String?

  @@index([windowStart])
  @@index([createdAt])
  @@index([symbol, createdAt])
}
```

**Step 2: Generate Prisma client + push schema**

Run:
```bash
cd backend && npx prisma db push && npx prisma generate
```
Expected: Schema synced, client regenerated.

**Step 3: Commit**

```bash
git add backend/prisma/schema.prisma
git commit -m "feat(polymarket): add PolymarketPrediction model"
```

---

### Task 2: Types — polymarketTypes.ts

**Files:**
- Create: `backend/src/services/polymarket/polymarketTypes.ts`

**Step 1: Write types file**

```typescript
// Polymarket 5-min prediction experiment types

export interface Candle1m {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isFinal: boolean;
}

export interface ScoreBreakdown {
  volumeSpike: number;      // 0-25
  microRoc: number;         // 0-20
  bodyRatio: number;        // 0-15
  wickRejection: number;    // -15 to +15
  candleAlignment: number;  // 0-15
  preWindowMomentum: number; // -10 to +10
  total: number;            // sum
}

export interface PredictionResult {
  direction: 'UP' | 'DOWN';
  confidence: number;       // 0-100
  score: ScoreBreakdown;
  microRocPct: number;      // raw ROC %
}

export interface PolymarketOdds {
  slug: string;
  upPrice: number;          // 0-1 USDC
  downPrice: number;        // 0-1 USDC
  found: boolean;
}

export interface WindowState {
  windowStart: number;      // unix ms
  windowEnd: number;        // unix ms
  startPrice: number;
  currentPrice: number;
  elapsed: number;          // ms since window start
  prediction: PredictionResult | null;
  entryOdds: number | null;
  status: 'accumulating' | 'predicted' | 'resolved' | 'skipped';
}

export interface PredictionStats {
  totalWindows: number;
  totalPredictions: number;
  wins: number;
  losses: number;
  skips: number;
  winRate: number;          // 0-100
  cumulativePnl: number;   // USDC
  todayWindows: number;
  todayPredictions: number;
  todayWins: number;
  todayLosses: number;
  todayWinRate: number;
  todayPnl: number;
}
```

**Step 2: Commit**

```bash
git add backend/src/services/polymarket/polymarketTypes.ts
git commit -m "feat(polymarket): add types for prediction experiment"
```

---

### Task 3: Scorer — fiveMinScorer.ts

**Files:**
- Create: `backend/src/services/polymarket/fiveMinScorer.ts`
- Test: `backend/test/unit/fiveMinScorer.test.ts`

**Step 1: Write failing test**

```typescript
import { computeFiveMinScore } from '../../src/services/polymarket/fiveMinScorer.js';
import type { Candle1m } from '../../src/services/polymarket/polymarketTypes.js';

function makeCandle(overrides: Partial<Candle1m> & { close: number }): Candle1m {
  const c = overrides.close;
  return {
    timestamp: Date.now(),
    open: overrides.open ?? c * 0.999,
    high: overrides.high ?? c * 1.001,
    low: overrides.low ?? c * 0.998,
    close: c,
    volume: overrides.volume ?? 100,
    isFinal: overrides.isFinal ?? true,
  };
}

describe('fiveMinScorer', () => {
  const basePrice = 97000;

  test('strong uptrend with volume returns high score and UP direction', () => {
    // 5 pre-window candles trending up
    const preWindow: Candle1m[] = Array.from({ length: 5 }, (_, i) => makeCandle({
      open: basePrice + i * 10,
      close: basePrice + (i + 1) * 10,
      high: basePrice + (i + 1) * 12,
      low: basePrice + i * 8,
      volume: 100,
    }));

    // 3 window candles with strong volume and bodies
    const windowCandles: Candle1m[] = [
      makeCandle({ open: basePrice + 50, close: basePrice + 200, high: basePrice + 210, low: basePrice + 45, volume: 300 }),
      makeCandle({ open: basePrice + 200, close: basePrice + 350, high: basePrice + 360, low: basePrice + 195, volume: 280 }),
      makeCandle({ open: basePrice + 350, close: basePrice + 500, high: basePrice + 510, low: basePrice + 340, volume: 260 }),
    ];

    const result = computeFiveMinScore(windowCandles, preWindow, basePrice);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe('UP');
    expect(result!.confidence).toBeGreaterThanOrEqual(60);
    expect(result!.score.total).toBeGreaterThanOrEqual(60);
    expect(result!.score.volumeSpike).toBeGreaterThan(0);
    expect(result!.score.microRoc).toBeGreaterThan(0);
  });

  test('flat candles with no volume returns null (skip)', () => {
    const preWindow: Candle1m[] = Array.from({ length: 5 }, () => makeCandle({
      open: basePrice,
      close: basePrice + 1,
      high: basePrice + 2,
      low: basePrice - 2,
      volume: 100,
    }));

    const windowCandles: Candle1m[] = Array.from({ length: 3 }, () => makeCandle({
      open: basePrice,
      close: basePrice + 2,
      high: basePrice + 3,
      low: basePrice - 3,
      volume: 100,
    }));

    const result = computeFiveMinScore(windowCandles, preWindow, basePrice);
    expect(result).toBeNull();
  });

  test('strong downtrend returns DOWN direction', () => {
    const preWindow: Candle1m[] = Array.from({ length: 5 }, (_, i) => makeCandle({
      open: basePrice - i * 10,
      close: basePrice - (i + 1) * 10,
      volume: 100,
    }));

    const windowCandles: Candle1m[] = [
      makeCandle({ open: basePrice - 50, close: basePrice - 200, high: basePrice - 45, low: basePrice - 210, volume: 300 }),
      makeCandle({ open: basePrice - 200, close: basePrice - 350, high: basePrice - 195, low: basePrice - 360, volume: 280 }),
      makeCandle({ open: basePrice - 350, close: basePrice - 500, high: basePrice - 340, low: basePrice - 510, volume: 260 }),
    ];

    const result = computeFiveMinScore(windowCandles, preWindow, basePrice);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('DOWN');
    expect(result!.confidence).toBeGreaterThanOrEqual(60);
  });

  test('wick rejection candle penalizes score', () => {
    const preWindow: Candle1m[] = Array.from({ length: 5 }, () => makeCandle({
      close: basePrice, volume: 100,
    }));

    // Window candles going up but with big upper wicks (rejection)
    const windowCandles: Candle1m[] = [
      makeCandle({ open: basePrice, close: basePrice + 100, high: basePrice + 300, low: basePrice - 5, volume: 200 }),
      makeCandle({ open: basePrice + 100, close: basePrice + 150, high: basePrice + 400, low: basePrice + 95, volume: 180 }),
    ];

    const result = computeFiveMinScore(windowCandles, preWindow, basePrice);
    // Wick rejection should reduce score significantly
    if (result) {
      expect(result.score.wickRejection).toBeLessThan(0);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest backend/test/unit/fiveMinScorer.test.ts --verbose --forceExit`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
import type { Candle1m, PredictionResult, ScoreBreakdown } from './polymarketTypes.js';

/**
 * Compute a 5-minute direction prediction score.
 *
 * @param windowCandles - 1m candles within the current 5-min window (2-3 closed + maybe 1 open)
 * @param preWindowCandles - 5+ candles from before the window (context)
 * @param windowOpenPrice - BTC price at T+0:00 of the window
 * @returns PredictionResult if confidence >= 60, null if skip
 */
export function computeFiveMinScore(
  windowCandles: Candle1m[],
  preWindowCandles: Candle1m[],
  windowOpenPrice: number,
): PredictionResult | null {
  if (windowCandles.length < 1) return null;

  const currentPrice = windowCandles[windowCandles.length - 1].close;
  const microRocPct = ((currentPrice - windowOpenPrice) / windowOpenPrice) * 100;
  const direction: 'UP' | 'DOWN' = microRocPct >= 0 ? 'UP' : 'DOWN';
  const absMicroRoc = Math.abs(microRocPct);

  // 1. Volume Spike (0-25)
  const allCandles = [...preWindowCandles, ...windowCandles];
  const avgVolPre = preWindowCandles.length > 0
    ? preWindowCandles.reduce((s, c) => s + c.volume, 0) / preWindowCandles.length
    : 1;
  const avgVolWindow = windowCandles.reduce((s, c) => s + c.volume, 0) / windowCandles.length;
  const volRatio = avgVolPre > 0 ? avgVolWindow / avgVolPre : 1;
  const volumeSpike = volRatio >= 2.0 ? 25 : volRatio >= 1.5 ? 15 : volRatio >= 1.2 ? 8 : 0;

  // 2. Micro-ROC (0-20)
  const microRoc = absMicroRoc >= 0.15 ? 20 : absMicroRoc >= 0.08 ? 12 : absMicroRoc >= 0.04 ? 6 : 0;

  // 3. Body Ratio (0-15)
  const bodyRatios = windowCandles.map(c => {
    const range = c.high - c.low;
    if (range === 0) return 0;
    return Math.abs(c.close - c.open) / range;
  });
  const avgBodyRatio = bodyRatios.reduce((s, r) => s + r, 0) / bodyRatios.length;
  const bodyRatio = avgBodyRatio >= 0.7 ? 15 : avgBodyRatio >= 0.5 ? 10 : avgBodyRatio >= 0.3 ? 5 : 0;

  // 4. Wick Rejection (-15 to +15)
  let wickRejection = 0;
  for (const c of windowCandles) {
    const range = c.high - c.low;
    if (range === 0) continue;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const opposingWick = direction === 'UP' ? upperWick : lowerWick;
    const opposingRatio = opposingWick / range;
    if (opposingRatio >= 0.4) {
      wickRejection -= 5; // penalize per candle
    } else if (opposingRatio < 0.15) {
      wickRejection += 5; // reward clean candles
    }
  }
  wickRejection = Math.max(-15, Math.min(15, wickRejection));

  // 5. Candle Alignment (0-15)
  const aligned = windowCandles.filter(c =>
    direction === 'UP' ? c.close > c.open : c.close < c.open
  ).length;
  const alignmentRatio = windowCandles.length > 0 ? aligned / windowCandles.length : 0;
  const candleAlignment = alignmentRatio >= 0.9 ? 15 : alignmentRatio >= 0.6 ? 10 : alignmentRatio >= 0.4 ? 5 : 0;

  // 6. Pre-window Momentum (-10 to +10)
  let preWindowMomentum = 0;
  if (preWindowCandles.length >= 2) {
    const preFirst = preWindowCandles[0].open;
    const preLast = preWindowCandles[preWindowCandles.length - 1].close;
    const preRoc = ((preLast - preFirst) / preFirst) * 100;
    const preDirection = preRoc >= 0 ? 'UP' : 'DOWN';
    const aligned = preDirection === direction;
    const absPreRoc = Math.abs(preRoc);
    if (aligned) {
      preWindowMomentum = absPreRoc >= 0.1 ? 10 : absPreRoc >= 0.05 ? 5 : 0;
    } else {
      preWindowMomentum = absPreRoc >= 0.1 ? -10 : absPreRoc >= 0.05 ? -5 : 0;
    }
  }

  const total = volumeSpike + microRoc + bodyRatio + wickRejection + candleAlignment + preWindowMomentum;

  const score: ScoreBreakdown = {
    volumeSpike,
    microRoc,
    bodyRatio,
    wickRejection,
    candleAlignment,
    preWindowMomentum,
    total,
  };

  if (total < 60) return null;

  return {
    direction,
    confidence: total,
    score,
    microRocPct,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx jest backend/test/unit/fiveMinScorer.test.ts --verbose --forceExit`
Expected: 4 tests PASS

**Step 5: Commit**

```bash
git add backend/src/services/polymarket/fiveMinScorer.ts backend/test/unit/fiveMinScorer.test.ts
git commit -m "feat(polymarket): add 5-min scorer with tests"
```

---

### Task 4: Polymarket API Client — polymarketClient.ts

**Files:**
- Create: `backend/src/services/polymarket/polymarketClient.ts`

**Step 1: Write the client**

```typescript
import type { PolymarketOdds } from './polymarketTypes.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

/**
 * Build the Polymarket event slug for a 5-min window.
 * Slug format: btc-updown-5m-{unix_timestamp}
 * Timestamp = floor(now / 300) * 300 (aligned to 5-min boundary)
 */
export function buildSlug(symbol: string, windowStartMs: number): string {
  const ts = Math.floor(windowStartMs / 1000 / 300) * 300;
  return `${symbol.toLowerCase()}-updown-5m-${ts}`;
}

/**
 * Fetch current odds for a 5-min prediction market from Polymarket Gamma API.
 * Returns UP/DOWN share prices (0-1 USDC each).
 */
export async function fetchPolymarketOdds(slug: string): Promise<PolymarketOdds> {
  try {
    const url = `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[Polymarket] HTTP ${res.status} for slug ${slug}`);
      return { slug, upPrice: 0.5, downPrice: 0.5, found: false };
    }

    const events = await res.json() as any[];
    if (!events || events.length === 0 || !events[0].markets?.length) {
      return { slug, upPrice: 0.5, downPrice: 0.5, found: false };
    }

    const market = events[0].markets[0];
    const outcomes: string[] = JSON.parse(market.outcomes || '[]');
    const prices: string[] = JSON.parse(market.outcomePrices || '[]');

    let upPrice = 0.5;
    let downPrice = 0.5;

    for (let i = 0; i < outcomes.length; i++) {
      const name = outcomes[i]?.toLowerCase();
      const price = parseFloat(prices[i] || '0.5');
      if (name === 'up') upPrice = price;
      else if (name === 'down') downPrice = price;
    }

    return { slug, upPrice, downPrice, found: true };
  } catch (err) {
    console.warn(`[Polymarket] fetch failed for ${slug}:`, err instanceof Error ? err.message : err);
    return { slug, upPrice: 0.5, downPrice: 0.5, found: false };
  }
}
```

**Step 2: Commit**

```bash
git add backend/src/services/polymarket/polymarketClient.ts
git commit -m "feat(polymarket): add Gamma API client for odds fetching"
```

---

### Task 5: Worker — polymarketWorker.ts

**Files:**
- Create: `backend/src/services/polymarket/polymarketWorker.ts`

**Step 1: Write the worker**

This is the core loop. It:
1. Subscribes to BTC 1m klines via existing Binance WS
2. Every second, checks if we're at a decision point (T+2.5min) or resolution point (T+5min)
3. At T+2.5min: scores, fetches odds, makes prediction
4. At T+5min: resolves, calculates P&L, persists to DB

```typescript
import { PrismaClient } from '@prisma/client';
import { getBinanceWebSocket, getKlinesWithMeta } from '../binanceWebSocket.js';
import { computeFiveMinScore } from './fiveMinScorer.js';
import { buildSlug, fetchPolymarketOdds } from './polymarketClient.js';
import type { Candle1m, WindowState, PredictionResult, PredictionStats } from './polymarketTypes.js';

const WINDOW_MS = 5 * 60 * 1000;         // 5 minutes
const DECISION_OFFSET_MS = 2.5 * 60 * 1000; // 2.5 minutes
const POLL_INTERVAL_MS = 1000;            // check every second
const SYMBOL = 'BTCUSDT';
const SYMBOL_SHORT = 'BTC';

let intervalId: ReturnType<typeof setInterval> | null = null;
let currentWindow: WindowState | null = null;
let decisionMade = false;
let resolutionDone = false;

// In-memory state exposed to route
let liveState: {
  window: WindowState | null;
  klines1m: Candle1m[];
} = { window: null, klines1m: [] };

export function getPolymarketLiveState() {
  return liveState;
}

function getWindowBoundaries(nowMs: number): { start: number; end: number } {
  const start = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  return { start, end: start + WINDOW_MS };
}

function getKlines1m(): Candle1m[] {
  const raw = getKlinesWithMeta(SYMBOL, '1m');
  if (!raw) return [];
  return raw.map(k => ({
    timestamp: k.timestamp,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
    isFinal: k.isFinal,
  }));
}

async function tick(prisma: PrismaClient) {
  const now = Date.now();
  const { start, end } = getWindowBoundaries(now);
  const elapsed = now - start;

  // New window? Reset state
  if (!currentWindow || currentWindow.windowStart !== start) {
    currentWindow = {
      windowStart: start,
      windowEnd: end,
      startPrice: 0,
      currentPrice: 0,
      elapsed: 0,
      prediction: null,
      entryOdds: null,
      status: 'accumulating',
    };
    decisionMade = false;
    resolutionDone = false;

    // Record start price from latest kline
    const klines = getKlines1m();
    if (klines.length > 0) {
      // Find the candle closest to window start
      const startCandle = klines.find(k => k.timestamp >= start) || klines[klines.length - 1];
      currentWindow.startPrice = startCandle.open;
    }
  }

  // Update current price
  const allKlines = getKlines1m();
  if (allKlines.length > 0) {
    currentWindow.currentPrice = allKlines[allKlines.length - 1].close;
  }
  currentWindow.elapsed = elapsed;

  // Update live state for API
  liveState = { window: { ...currentWindow }, klines1m: allKlines };

  // --- DECISION POINT: T+2.5min ---
  if (!decisionMade && elapsed >= DECISION_OFFSET_MS) {
    decisionMade = true;

    // Split candles into pre-window and window
    const windowCandles = allKlines.filter(k => k.isFinal && k.timestamp >= start);
    const preWindowCandles = allKlines.filter(k => k.isFinal && k.timestamp < start).slice(-20);

    if (currentWindow.startPrice === 0 && windowCandles.length > 0) {
      currentWindow.startPrice = windowCandles[0].open;
    }

    const result = computeFiveMinScore(windowCandles, preWindowCandles, currentWindow.startPrice);

    if (result) {
      // Fetch Polymarket odds
      const slug = buildSlug(SYMBOL_SHORT, start);
      const odds = await fetchPolymarketOdds(slug);
      const entryOdds = result.direction === 'UP' ? odds.upPrice : odds.downPrice;

      currentWindow.prediction = result;
      currentWindow.entryOdds = entryOdds;
      currentWindow.status = 'predicted';

      console.log(`[Polymarket] Window ${new Date(start).toISOString()} → ${result.direction} (score: ${result.confidence}, odds: ${entryOdds.toFixed(3)}, slug: ${slug}, found: ${odds.found})`);
    } else {
      currentWindow.status = 'skipped';
      console.log(`[Polymarket] Window ${new Date(start).toISOString()} → SKIP (low confidence)`);
    }

    liveState.window = { ...currentWindow };
  }

  // --- RESOLUTION: T+5min (next window started) ---
  if (!resolutionDone && elapsed >= WINDOW_MS - 500) {
    resolutionDone = true;

    const endPrice = currentWindow.currentPrice;
    const actualResult: 'UP' | 'DOWN' = endPrice >= currentWindow.startPrice ? 'UP' : 'DOWN';

    let simulatedPnl: number | null = null;
    let isCorrect: boolean | null = null;

    if (currentWindow.prediction && currentWindow.entryOdds != null) {
      isCorrect = currentWindow.prediction.direction === actualResult;
      simulatedPnl = isCorrect
        ? (1.0 - currentWindow.entryOdds)
        : -currentWindow.entryOdds;
    }

    currentWindow.status = 'resolved';

    // Persist to DB
    try {
      await prisma.polymarketPrediction.create({
        data: {
          symbol: SYMBOL_SHORT,
          windowStart: new Date(start),
          windowEnd: new Date(end),
          startPrice: currentWindow.startPrice,
          endPrice,
          prediction: currentWindow.prediction?.direction ?? null,
          confidence: currentWindow.prediction?.confidence ?? null,
          actualResult,
          entryOdds: currentWindow.entryOdds,
          simulatedPnl,
          scoreBreakdown: currentWindow.prediction?.score ?? undefined,
          isCorrect,
          skipped: currentWindow.prediction === null,
          polymarketSlug: buildSlug(SYMBOL_SHORT, start),
        },
      });

      const tag = isCorrect === true ? 'WIN' : isCorrect === false ? 'LOSS' : 'SKIP';
      const pnlStr = simulatedPnl != null ? `$${simulatedPnl.toFixed(3)}` : '—';
      console.log(`[Polymarket] Resolved: ${actualResult} | ${tag} | PnL: ${pnlStr} | start: $${currentWindow.startPrice.toFixed(1)} end: $${endPrice.toFixed(1)}`);
    } catch (err) {
      console.error('[Polymarket] DB save failed:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Start the Polymarket prediction worker.
 * Subscribes to BTC 1m klines and runs a 1s polling loop.
 */
export function startPolymarketWorker(prisma: PrismaClient): void {
  if (intervalId) {
    console.warn('[Polymarket] Worker already running');
    return;
  }

  // Subscribe to BTC 1m klines via existing WS
  const ws = getBinanceWebSocket();
  ws.subscribeToKline(SYMBOL, '1m');

  console.log('[Polymarket] Worker started — subscribed to BTCUSDT 1m klines');

  intervalId = setInterval(() => {
    tick(prisma).catch(err => {
      console.error('[Polymarket] tick error:', err instanceof Error ? err.message : err);
    });
  }, POLL_INTERVAL_MS);
}

export function stopPolymarketWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Polymarket] Worker stopped');
  }
}

/**
 * Get aggregated stats from DB.
 */
export async function getPolymarketStats(prisma: PrismaClient): Promise<PredictionStats> {
  const all = await prisma.polymarketPrediction.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const today = all.filter(p => p.createdAt >= todayStart);

  const predicted = all.filter(p => !p.skipped && p.prediction != null);
  const wins = predicted.filter(p => p.isCorrect === true);
  const losses = predicted.filter(p => p.isCorrect === false);
  const cumulativePnl = predicted.reduce((s, p) => s + (p.simulatedPnl ?? 0), 0);

  const todayPredicted = today.filter(p => !p.skipped && p.prediction != null);
  const todayWins = todayPredicted.filter(p => p.isCorrect === true);
  const todayLosses = todayPredicted.filter(p => p.isCorrect === false);
  const todayPnl = todayPredicted.reduce((s, p) => s + (p.simulatedPnl ?? 0), 0);

  return {
    totalWindows: all.length,
    totalPredictions: predicted.length,
    wins: wins.length,
    losses: losses.length,
    skips: all.length - predicted.length,
    winRate: predicted.length > 0 ? (wins.length / predicted.length) * 100 : 0,
    cumulativePnl,
    todayWindows: today.length,
    todayPredictions: todayPredicted.length,
    todayWins: todayWins.length,
    todayLosses: todayLosses.length,
    todayWinRate: todayPredicted.length > 0 ? (todayWins.length / todayPredicted.length) * 100 : 0,
    todayPnl,
  };
}
```

**Step 2: Verify WS function exists**

The worker imports `getKlinesWithMeta` from `binanceWebSocket.ts` (line 3722). Verify signature:
```typescript
export function getKlinesWithMeta(symbol: string, interval: string): { timestamp: number; open: number; high: number; low: number; close: number; volume: number; isFinal: boolean }[] | null
```

Also imports `getBinanceWebSocket` which has `subscribeToKline(symbol, interval)` method.

**Step 3: Commit**

```bash
git add backend/src/services/polymarket/polymarketWorker.ts
git commit -m "feat(polymarket): add background worker with scoring, odds, and DB persistence"
```

---

### Task 6: Backend Route — routes/polymarket.ts

**Files:**
- Create: `backend/src/routes/polymarket.ts`
- Modify: `backend/src/server.ts:32` (add import) and `backend/src/server.ts:309` (register route)

**Step 1: Write route file**

```typescript
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { getPolymarketLiveState, getPolymarketStats } from '../services/polymarket/polymarketWorker.js';

export function createPolymarketRouter(prisma: PrismaClient): Router {
  const router = Router();

  // Live window state (polled every 5s by frontend)
  router.get('/status', (_req, res) => {
    const state = getPolymarketLiveState();
    res.json(state);
  });

  // Aggregated stats for KPI cards
  router.get('/stats', async (_req, res) => {
    try {
      const stats = await getPolymarketStats(prisma);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // History table (recent predictions)
  router.get('/history', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const predictions = await prisma.polymarketPrediction.findMany({
        orderBy: { windowStart: 'desc' },
        take: limit,
      });
      res.json({ predictions });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch history' });
    }
  });

  return router;
}
```

**Step 2: Wire into server.ts**

In `backend/src/server.ts`:

Add import at line ~32 (after backtest import):
```typescript
import { createPolymarketRouter } from "./routes/polymarket.js";
import { startPolymarketWorker } from "./services/polymarket/polymarketWorker.js";
```

Add route registration at line ~309 (after backtest route):
```typescript
app.use("/api/polymarket", createPolymarketRouter(prisma));
```

Start worker in the server startup section (after WS is connected, look for the section where agents are restored — add near the end of startup):
```typescript
// Start Polymarket experiment worker
startPolymarketWorker(prisma);
```

**Step 3: Verify build compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: No new errors (pre-existing ones in scripts/ are OK)

**Step 4: Commit**

```bash
git add backend/src/routes/polymarket.ts backend/src/server.ts
git commit -m "feat(polymarket): add API routes and wire worker into server startup"
```

---

### Task 7: Frontend API Client — api.ts additions

**Files:**
- Modify: `frontend/src/api.ts:358` (add polymarket namespace before closing `}`)

**Step 1: Add API methods**

Add before the closing `};` of the `api` object (around line 358):

```typescript
  // Polymarket experiment API
  polymarket: {
    getStatus: async () =>
      (await client.get('/api/polymarket/status')).data as {
        window: {
          windowStart: number;
          windowEnd: number;
          startPrice: number;
          currentPrice: number;
          elapsed: number;
          prediction: { direction: string; confidence: number; score: Record<string, number>; microRocPct: number } | null;
          entryOdds: number | null;
          status: string;
        } | null;
        klines1m: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number; isFinal: boolean }>;
      },
    getStats: async () =>
      (await client.get('/api/polymarket/stats')).data as {
        totalWindows: number;
        totalPredictions: number;
        wins: number;
        losses: number;
        skips: number;
        winRate: number;
        cumulativePnl: number;
        todayWindows: number;
        todayPredictions: number;
        todayWins: number;
        todayLosses: number;
        todayWinRate: number;
        todayPnl: number;
      },
    getHistory: async (limit = 50) =>
      (await client.get('/api/polymarket/history', { params: { limit } })).data as {
        predictions: Array<{
          id: number;
          createdAt: string;
          symbol: string;
          windowStart: string;
          windowEnd: string;
          startPrice: number;
          endPrice: number | null;
          prediction: string | null;
          confidence: number | null;
          actualResult: string | null;
          entryOdds: number | null;
          simulatedPnl: number | null;
          scoreBreakdown: Record<string, number> | null;
          isCorrect: boolean | null;
          skipped: boolean;
        }>;
      },
  },
```

**Step 2: Commit**

```bash
git add frontend/src/api.ts
git commit -m "feat(polymarket): add frontend API client methods"
```

---

### Task 8: Frontend Page — PolymarketPage.tsx

**Files:**
- Create: `frontend/src/pages/PolymarketPage.tsx`
- Modify: `frontend/src/App.tsx:19` (add import) and `frontend/src/App.tsx:95` (add route)
- Modify: `frontend/src/components/layout/AppShell.tsx:86` (add nav item) and `AppShell.tsx:101` (add active key)

**Step 1: Create the page component**

This is a large file. It contains:
- 3 KPI cards (win rate, P&L, trade ratio)
- Live window widget with progress bar
- Mini 1m candlestick chart (Lightweight Charts)
- History table

```typescript
import React from 'react';
import { api } from '@/api';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown, Timer, Target, DollarSign, BarChart3 } from 'lucide-react';

// ---- Types ----
interface WindowStatus {
  window: {
    windowStart: number;
    windowEnd: number;
    startPrice: number;
    currentPrice: number;
    elapsed: number;
    prediction: { direction: string; confidence: number; score: Record<string, number>; microRocPct: number } | null;
    entryOdds: number | null;
    status: string;
  } | null;
  klines1m: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>;
}

interface Stats {
  totalWindows: number;
  totalPredictions: number;
  wins: number;
  losses: number;
  winRate: number;
  cumulativePnl: number;
  todayWindows: number;
  todayPredictions: number;
  todayWins: number;
  todayLosses: number;
  todayWinRate: number;
  todayPnl: number;
}

interface Prediction {
  id: number;
  windowStart: string;
  prediction: string | null;
  actualResult: string | null;
  confidence: number | null;
  entryOdds: number | null;
  simulatedPnl: number | null;
  isCorrect: boolean | null;
  skipped: boolean;
  startPrice: number;
  endPrice: number | null;
}

// ---- KPI Card ----
function KpiCard({ label, value, sub, icon: Icon, color }: {
  label: string; value: string; sub?: string; icon: React.ComponentType<{ className?: string }>; color: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        <Icon className={cn('h-3.5 w-3.5', color)} />
        {label}
      </div>
      <div className={cn('text-2xl font-bold font-mono', color)}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

// ---- Progress Bar ----
function WindowProgress({ elapsed, total }: { elapsed: number; total: number }) {
  const pct = Math.min(100, (elapsed / total) * 100);
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>T+{mins}:{secs.toString().padStart(2, '0')}</span>
        <span>5:00</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all duration-1000"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ---- Mini Chart ----
function MiniChart({ klines, startPrice, windowStart }: {
  klines: WindowStatus['klines1m']; startPrice: number; windowStart: number;
}) {
  const chartRef = React.useRef<HTMLDivElement>(null);
  const chartInstance = React.useRef<any>(null);
  const seriesRef = React.useRef<any>(null);

  React.useEffect(() => {
    if (!chartRef.current) return;
    let cancelled = false;

    import('lightweight-charts').then(({ createChart, ColorType, CrosshairMode }) => {
      if (cancelled || !chartRef.current) return;

      if (chartInstance.current) {
        chartInstance.current.remove();
      }

      const chart = createChart(chartRef.current, {
        width: chartRef.current.clientWidth,
        height: 180,
        layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8' },
        grid: { vertLines: { visible: false }, horzLines: { color: '#1e293b' } },
        crosshair: { mode: CrosshairMode.Magnet },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      });

      const series = chart.addCandlestickSeries({
        upColor: '#22c55e',
        downColor: '#ef4444',
        borderVisible: false,
        wickUpColor: '#22c55e',
        wickDownColor: '#ef4444',
      });

      // Add start price line
      series.createPriceLine({
        price: startPrice,
        color: '#60a5fa',
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: 'Start',
      });

      chartInstance.current = chart;
      seriesRef.current = series;
    });

    return () => {
      cancelled = true;
      if (chartInstance.current) {
        chartInstance.current.remove();
        chartInstance.current = null;
      }
    };
  }, [startPrice]);

  // Update data
  React.useEffect(() => {
    if (!seriesRef.current || klines.length === 0) return;
    const windowKlines = klines.filter(k => k.timestamp >= windowStart - 5 * 60 * 1000);
    const data = windowKlines.map(k => ({
      time: Math.floor(k.timestamp / 1000) as any,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));
    seriesRef.current.setData(data);
  }, [klines, windowStart]);

  return <div ref={chartRef} className="w-full" />;
}

// ---- Main Page ----
export default function PolymarketPage() {
  const [status, setStatus] = React.useState<WindowStatus | null>(null);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [history, setHistory] = React.useState<Prediction[]>([]);

  // Poll status every 3s
  React.useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const [s, st, h] = await Promise.all([
          api.polymarket.getStatus(),
          api.polymarket.getStats(),
          api.polymarket.getHistory(50),
        ]);
        if (!active) return;
        setStatus(s);
        setStats(st);
        setHistory(h.predictions);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const w = status?.window;

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className={cn(
            'h-2.5 w-2.5 rounded-full',
            w?.status === 'accumulating' || w?.status === 'predicted' ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground'
          )} />
          <h1 className="text-lg font-semibold">Polymarket 5-Min Experiment</h1>
        </div>
        <span className="text-xs text-muted-foreground font-mono">BTC/USD</span>
      </div>

      {/* KPI Cards */}
      {stats && (
        <div className="grid grid-cols-3 gap-3">
          <KpiCard
            label="Win Rate (Today)"
            value={stats.todayPredictions > 0 ? `${stats.todayWinRate.toFixed(1)}%` : '—'}
            sub={`${stats.todayWins}W / ${stats.todayLosses}L (${stats.todayPredictions} trades)`}
            icon={Target}
            color={stats.todayWinRate >= 55 ? 'text-success' : stats.todayWinRate >= 50 ? 'text-yellow-500' : 'text-destructive'}
          />
          <KpiCard
            label="Simulated P&L (Today)"
            value={`$${stats.todayPnl.toFixed(2)}`}
            sub={`All time: $${stats.cumulativePnl.toFixed(2)}`}
            icon={DollarSign}
            color={stats.todayPnl >= 0 ? 'text-success' : 'text-destructive'}
          />
          <KpiCard
            label="Predictions / Windows"
            value={`${stats.todayPredictions} / ${stats.todayWindows}`}
            sub={`All time: ${stats.totalPredictions} / ${stats.totalWindows} (${stats.totalWindows - stats.totalPredictions} skips)`}
            icon={BarChart3}
            color="text-primary"
          />
        </div>
      )}

      {/* Live Window + Chart */}
      <div className="grid grid-cols-2 gap-3">
        {/* Live Window Widget */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Timer className="h-4 w-4 text-muted-foreground" />
              Window en cours
            </div>
            {w && (
              <span className="text-xs text-muted-foreground font-mono">
                {new Date(w.windowStart).toLocaleTimeString()} — {new Date(w.windowEnd).toLocaleTimeString()}
              </span>
            )}
          </div>

          {w ? (
            <>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-muted-foreground">Start:</span>{' '}
                  <span className="font-mono">${w.startPrice.toFixed(1)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Current:</span>{' '}
                  <span className={cn('font-mono', w.currentPrice >= w.startPrice ? 'text-success' : 'text-destructive')}>
                    ${w.currentPrice.toFixed(1)}
                  </span>
                  <span className="text-muted-foreground ml-1">
                    ({((w.currentPrice - w.startPrice) / w.startPrice * 100).toFixed(3)}%)
                  </span>
                </div>
              </div>

              {w.prediction ? (
                <div className={cn(
                  'rounded-lg p-3 text-sm font-medium flex items-center gap-2',
                  w.prediction.direction === 'UP' ? 'bg-green-500/10 text-success' : 'bg-red-500/10 text-destructive'
                )}>
                  {w.prediction.direction === 'UP' ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                  {w.prediction.direction} — Score: {w.prediction.confidence}
                  {w.entryOdds != null && (
                    <span className="ml-auto text-xs font-mono text-muted-foreground">
                      Odds: {w.entryOdds.toFixed(3)} | Potential: +${(1 - w.entryOdds).toFixed(3)} / -${w.entryOdds.toFixed(3)}
                    </span>
                  )}
                </div>
              ) : w.status === 'skipped' ? (
                <div className="rounded-lg p-3 text-sm text-muted-foreground bg-muted/30">
                  SKIP — Confidence insuffisante
                </div>
              ) : (
                <div className="rounded-lg p-3 text-sm text-muted-foreground bg-muted/30 animate-pulse">
                  Accumulation de data...
                </div>
              )}

              <WindowProgress elapsed={w.elapsed} total={5 * 60 * 1000} />
            </>
          ) : (
            <div className="text-sm text-muted-foreground">En attente du worker...</div>
          )}
        </div>

        {/* Mini Chart */}
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-sm font-medium mb-2">BTC 1m Chart</div>
          {status && w ? (
            <MiniChart
              klines={status.klines1m}
              startPrice={w.startPrice}
              windowStart={w.windowStart}
            />
          ) : (
            <div className="h-[180px] flex items-center justify-center text-sm text-muted-foreground">
              En attente...
            </div>
          )}
        </div>
      </div>

      {/* History Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="p-3 border-b border-border text-sm font-medium">
          Historique des pr\u00e9dictions
        </div>
        <div className="overflow-auto max-h-[400px]">
          <div className="grid grid-cols-[100px_60px_60px_50px_60px_70px_70px] gap-2 px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider border-b border-border bg-muted/20">
            <div>Window</div>
            <div>Pred</div>
            <div>Real</div>
            <div>Score</div>
            <div>Odds</div>
            <div>P&L</div>
            <div>Price</div>
          </div>
          {history.map(p => (
            <div
              key={p.id}
              className="grid grid-cols-[100px_60px_60px_50px_60px_70px_70px] gap-2 px-3 py-1.5 text-[11px] font-mono hover:bg-muted/30 border-b border-border/50"
            >
              <div>{new Date(p.windowStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              <div className={cn(
                p.skipped ? 'text-muted-foreground' : p.prediction === 'UP' ? 'text-success' : 'text-destructive'
              )}>
                {p.skipped ? '—' : p.prediction}
                {p.isCorrect === true && ' \u2713'}
                {p.isCorrect === false && ' \u2717'}
              </div>
              <div className={cn(p.actualResult === 'UP' ? 'text-success' : 'text-destructive')}>
                {p.actualResult ?? '...'}
              </div>
              <div>{p.confidence ?? '—'}</div>
              <div>{p.entryOdds?.toFixed(3) ?? '—'}</div>
              <div className={cn(
                p.simulatedPnl != null
                  ? p.simulatedPnl >= 0 ? 'text-success' : 'text-destructive'
                  : 'text-muted-foreground'
              )}>
                {p.simulatedPnl != null ? `$${p.simulatedPnl.toFixed(3)}` : '—'}
              </div>
              <div className="text-muted-foreground">
                ${p.startPrice.toFixed(0)}→{p.endPrice?.toFixed(0) ?? '...'}
              </div>
            </div>
          ))}
          {history.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              Aucune pr\u00e9diction encore. Le worker va d\u00e9marrer au prochain cycle 5 min.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Wire into App.tsx**

In `frontend/src/App.tsx`:

Add import at line ~19 (after BacktestPage):
```typescript
import PolymarketPage from '@/pages/PolymarketPage';
```

Add route at line ~95 (before settings):
```typescript
<Route path="/predictions" element={<PolymarketPage />} />
```

**Step 3: Add nav item in AppShell.tsx**

In `frontend/src/components/layout/AppShell.tsx`:

Add icon import (at line ~10 with other lucide imports):
```typescript
import { Sparkles } from 'lucide-react';
```

Add to `NAV_ITEMS` array at line ~86:
```typescript
{ path: '/predictions', label: 'Predictions', icon: Sparkles },
```

Add to `resolveActiveKey` at line ~101:
```typescript
if (pathname.startsWith('/predictions')) return '/predictions';
```

**Step 4: Verify frontend build**

Run: `cd frontend && npx vite build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add frontend/src/pages/PolymarketPage.tsx frontend/src/App.tsx frontend/src/components/layout/AppShell.tsx
git commit -m "feat(polymarket): add predictions dashboard page with live chart, KPIs, and history table"
```

---

### Task 9: Integration Test — End to End

**Step 1: Verify backend compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: No new errors

**Step 2: Verify frontend builds**

Run: `cd frontend && npx vite build`
Expected: Build succeeds

**Step 3: Run existing unit tests to check no regressions**

Run: `cd backend && npx jest test/unit/ --verbose --forceExit`
Expected: All existing tests pass + new fiveMinScorer tests pass

**Step 4: Manual smoke test**

Start the backend: `cd backend && npm run dev`
- Check console for: `[Polymarket] Worker started — subscribed to BTCUSDT 1m klines`
- Wait ~3 minutes, check console for scoring/prediction logs
- Hit `http://localhost:3001/api/polymarket/status` — should return window state
- Hit `http://localhost:3001/api/polymarket/stats` — should return zeros initially
- After 5 min, hit `http://localhost:3001/api/polymarket/history` — should show 1 prediction

Start the frontend: `cd frontend && npm run dev`
- Navigate to `/predictions`
- Verify KPI cards, live window widget, chart, and table render

**Step 5: Final commit with all files**

```bash
git add -A
git commit -m "feat(polymarket): complete 5-min prediction experiment — worker, scorer, API, dashboard"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Prisma schema | `schema.prisma` |
| 2 | Types | `services/polymarket/polymarketTypes.ts` |
| 3 | Scorer + tests | `services/polymarket/fiveMinScorer.ts`, `test/unit/fiveMinScorer.test.ts` |
| 4 | Polymarket API client | `services/polymarket/polymarketClient.ts` |
| 5 | Background worker | `services/polymarket/polymarketWorker.ts` |
| 6 | Backend route + server wiring | `routes/polymarket.ts`, `server.ts` |
| 7 | Frontend API client | `api.ts` |
| 8 | Frontend page + routing + nav | `PolymarketPage.tsx`, `App.tsx`, `AppShell.tsx` |
| 9 | Integration test | Build + smoke test |

**Total new files:** 6 backend + 1 frontend
**Modified files:** 4 (schema.prisma, server.ts, api.ts, App.tsx, AppShell.tsx)
**Estimated implementation time:** 9 tasks, each 5-15 min
