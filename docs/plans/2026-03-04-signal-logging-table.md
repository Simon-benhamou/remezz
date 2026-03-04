# Signal Logging Table Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist every valid signal with full feature snapshot and link to trade outcome for post-hoc analysis of which signals should have been filtered.

**Architecture:** New `Signal` Prisma model with typed columns for core features + JSON extras. A `signalLogger.ts` service computes features and writes to DB fire-and-forget. Integration at `positionOpener.ts` (7 filter rejection points + trade success) and `orchestrator.ts` (ranking rejection). Signal context (candles, btcCandles, signal result) is passed down from orchestrator to positionOpener via a new `signalContext` field.

**Tech Stack:** Prisma (PostgreSQL), TypeScript

**Design doc:** `docs/plans/2026-03-04-signal-logging-table-design.md`

---

### Task 1: Add Signal model to Prisma schema

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Step 1: Add Signal model after TriggerLog (line 304)**

Add at end of schema:

```prisma
model Signal {
  id              String    @id @default(cuid())
  userId          String
  sessionId       String?
  symbol          String
  candleTs        DateTime

  // Signal result
  side            String
  confidence      Float?
  score           Float?

  // Outcome
  status          String
  tradeId         String?   @unique

  // Timing
  hour            Int
  dayOfWeek       Int

  // BTC context
  btcRegime       String
  btcPrice        Float
  btcSma200       Float
  btcDistSma200   Float
  btcAtr          Float
  btcRoc1h        Float

  // Symbol OHLCV
  candleOpen      Float
  candleHigh      Float
  candleLow       Float
  candleClose     Float
  candleVolume    Float

  // Core features
  roc10           Float
  roc5            Float
  roc1            Float
  volRatio        Float
  bbUpper         Float
  bbLower         Float
  bbMa20          Float
  consecUp        Int
  consecDown      Int
  stochRsi        Float?
  atr14           Float
  atr14Pct        Float
  adx             Float
  greenRatio      Float
  alternation5    Int
  bbTouches       Int
  rangePosition   Float

  // Extensible
  extras          Json?

  createdAt       DateTime  @default(now())

  // Relations
  user            User      @relation(fields: [userId], references: [id])
  trade           Trade?    @relation(fields: [tradeId], references: [id])

  @@index([userId, createdAt])
  @@index([symbol, candleTs])
  @@index([status])
  @@index([tradeId])
}
```

**Step 2: Add reverse relations**

In `User` model (line 10-28), add after `settings` line 24:
```prisma
  signals                Signal[]
```

In `Trade` model (line 210-239), add after `session` relation line 234:
```prisma
  signal          Signal?
```

**Step 3: Run migration**

Run: `cd backend && npx prisma db push`
Expected: Schema synced, Signal table created.

**Step 4: Generate client**

Run: `cd backend && npx prisma generate`
Expected: Prisma client regenerated with Signal model.

**Step 5: Verify types compile**

Run: `cd backend && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors related to Signal.

**Step 6: Commit**

```bash
git add backend/prisma/schema.prisma
git commit -m "feat: add Signal model to Prisma schema for signal logging"
```

---

### Task 2: Create signalLogger.ts service

**Files:**
- Create: `backend/src/strategies/signalLogger.ts`

**Step 1: Create the signalLogger service**

```typescript
import { PrismaClient } from '@prisma/client';
import type { Candle, SignalResult, MarketConditions } from './config/momentumConfig.js';
import {
  calcATR, calcADX, calcGreenRatio, calcAlternation5, calcBBTouchCount,
  calcSMA, calcROC, calcBollingerBands, calcBBPosition, calcTrendStrength, calcVolRatio,
} from './indicators/technicalIndicators.js';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();

export type SignalStatus =
  | 'traded'
  | 'filtered_toxic_hour'
  | 'filtered_capital'
  | 'filtered_ranking'
  | 'filtered_max_positions'
  | 'filtered_blacklist'
  | 'filtered_regime_recheck'
  | 'filtered_notional_too_low'
  | 'filtered_margin_exceeded'
  | 'filtered_reserve_failed';

export interface SignalContext {
  userId: string;
  sessionId?: string;
  symbol: string;
  signal: SignalResult;
  candles: Candle[];
  btcCandles: Candle[];
  score?: number;
}

export function saveSignal(
  ctx: SignalContext,
  status: SignalStatus,
  tradeId?: string,
): void {
  // Fire-and-forget: never block trading
  _saveSignalAsync(ctx, status, tradeId).catch(err => {
    logger.warn(`[signal-logger] Failed to save signal for ${ctx.symbol}: ${err}`);
  });
}

async function _saveSignalAsync(
  ctx: SignalContext,
  status: SignalStatus,
  tradeId?: string,
): Promise<void> {
  const { userId, sessionId, symbol, signal, candles, btcCandles, score } = ctx;

  if (!signal.valid || !signal.side) return; // Safety: only log valid signals

  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) return;

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const btcCloses = btcCandles.map(c => c.close);

  // BTC context
  const btcSma200 = calcSMA(btcCloses, 200);
  const btcNow = btcCloses[btcCloses.length - 1] ?? 0;
  const btcDistSma200 = btcSma200 > 0 ? ((btcNow - btcSma200) / btcSma200) * 100 : 0;
  const btcAtrRaw = calcATR(btcCandles, 14) ?? 0;
  const btcAtr = btcNow > 0 ? (btcAtrRaw / btcNow) * 100 : 0;
  const btcRoc1h = calcROC(btcCloses, 4) * 100; // 4 × 15m = 1h

  // Symbol features
  const atr14Raw = calcATR(candles, 14) ?? 0;
  const atr14Pct = lastCandle.close > 0 ? (atr14Raw / lastCandle.close) * 100 : 0;
  const adx = calcADX(candles, 14);
  const greenRatio = calcGreenRatio(candles, 10);
  const alternation5 = calcAlternation5(candles);
  const bb = calcBollingerBands(closes, 20, 2);
  const bbTouches = calcBBTouchCount(candles, bb.upper, bb.lower, 10);

  // Range position
  const rpLookback = 20;
  const rpCandles = candles.slice(-rpLookback);
  const rpHigh = Math.max(...rpCandles.map(c => c.high));
  const rpLow = Math.min(...rpCandles.map(c => c.low));
  const rangePosition = rpHigh > rpLow ? (lastCandle.close - rpLow) / (rpHigh - rpLow) : 0.5;

  // Extras (secondary features for future analysis)
  const bbPosition = calcBBPosition(candles, 20, 2);
  const trendStrength = calcTrendStrength(closes, 50);
  const rocAcceleration = closes.length >= 15
    ? (calcROC(closes, 5) - calcROC(closes.slice(0, -5), 5)) * 100
    : 0;

  const candleTs = new Date(lastCandle.timestamp);
  const now = new Date();

  await prisma.signal.create({
    data: {
      userId,
      sessionId: sessionId ?? null,
      symbol,
      candleTs,
      side: signal.side,
      confidence: signal.confidence ?? null,
      score: score ?? null,
      status,
      tradeId: tradeId ?? null,
      hour: now.getUTCHours(),
      dayOfWeek: now.getUTCDay(),
      btcRegime: signal.features?.btcInBullRegime ? 'bull' : 'bear',
      btcPrice: btcNow,
      btcSma200,
      btcDistSma200,
      btcAtr,
      btcRoc1h,
      candleOpen: lastCandle.open,
      candleHigh: lastCandle.high,
      candleLow: lastCandle.low,
      candleClose: lastCandle.close,
      candleVolume: lastCandle.volume,
      roc10: (signal.features?.roc ?? 0),
      roc5: (signal.features?.roc5 ?? 0),
      roc1: (signal.features?.roc1 ?? 0),
      volRatio: signal.features?.volRatio ?? 0,
      bbUpper: signal.features?.bbUpper ?? bb.upper,
      bbLower: signal.features?.bbLower ?? bb.lower,
      bbMa20: bb.middle,
      consecUp: signal.features?.consecUp ?? 0,
      consecDown: signal.features?.consecDown ?? 0,
      stochRsi: signal.features?.stochRsi ?? null,
      atr14: atr14Raw,
      atr14Pct,
      adx,
      greenRatio,
      alternation5,
      bbTouches,
      rangePosition,
      extras: {
        trendStrength,
        bbPosition,
        rocAcceleration,
        btcMomentum6h: signal.features?.btcMomentum6h ?? 0,
        signalReason: signal.reason ?? '',
      },
    },
  });
}
```

**Step 2: Verify types compile**

Run: `cd backend && npx tsc --noEmit 2>&1 | grep signalLogger`
Expected: No errors.

**Step 3: Commit**

```bash
git add backend/src/strategies/signalLogger.ts
git commit -m "feat: add signalLogger service — fire-and-forget signal persistence"
```

---

### Task 3: Pass signal context from orchestrator to positionOpener

The problem: `positionOpener.open()` only receives `(side, candles)` but needs the full signal context (signal result, btcCandles, score, userId) to log signals at each rejection point.

**Files:**
- Modify: `backend/src/strategies/positionOpener.ts` (lines 65-75)
- Modify: `backend/src/strategies/orchestrator.ts` (lines 1041, 1076-1077)

**Step 1: Add SignalContext to PositionOpener.open() signature**

In `positionOpener.ts`, add import at top:
```typescript
import { saveSignal, SignalContext, SignalStatus } from './signalLogger.js';
```

Change `open()` method signature at line 75 from:
```typescript
async open(side: 'long' | 'short', candles: Candle[]): Promise<OpenPositionResult> {
```
to:
```typescript
async open(side: 'long' | 'short', candles: Candle[], signalCtx?: SignalContext): Promise<OpenPositionResult> {
```

**Step 2: Pass context from orchestrator**

In `orchestrator.ts` at line 1041, change:
```typescript
await this.openPosition(signal.side, candles);
```
to:
```typescript
await this.openPosition(signal.side, candles, {
  userId: this.config.userId || '',
  sessionId: this.config.sessionId,
  symbol,
  signal,
  candles,
  btcCandles,
  score: qualityScore,
});
```

In `orchestrator.ts`, update `openPosition` wrapper at line 1076 from:
```typescript
private async openPosition(side: 'long' | 'short', candles: Candle[]): Promise<void> {
    const result = await this.positionOpener.open(side, candles);
```
to:
```typescript
private async openPosition(side: 'long' | 'short', candles: Candle[], signalCtx?: SignalContext): Promise<void> {
    const result = await this.positionOpener.open(side, candles, signalCtx);
```

Add import in `orchestrator.ts`:
```typescript
import type { SignalContext } from './signalLogger.js';
```

**Step 3: Verify types compile**

Run: `cd backend && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors.

**Step 4: Commit**

```bash
git add backend/src/strategies/positionOpener.ts backend/src/strategies/orchestrator.ts
git commit -m "feat: pass SignalContext from orchestrator to positionOpener"
```

---

### Task 4: Add saveSignal calls at every rejection/success point in positionOpener

**Files:**
- Modify: `backend/src/strategies/positionOpener.ts`

**Step 1: Add saveSignal at blacklist rejection (line 88-89)**

After `logger.warn(...)` at line 88, before return at line 89:
```typescript
if (signalCtx) saveSignal(signalCtx, 'filtered_blacklist');
```

**Step 2: Add saveSignal at toxic hours rejection (line 98-99)**

After `logger.warn(...)` at line 98, before return at line 99:
```typescript
if (signalCtx) saveSignal(signalCtx, 'filtered_toxic_hour');
```

**Step 3: Add saveSignal at regime re-check rejections (around line 109-120)**

There's a re-validation of BTC regime in positionOpener (line 102-130). At the two return points for regime mismatch:
```typescript
if (signalCtx) saveSignal(signalCtx, 'filtered_regime_recheck');
```

**Step 4: Add saveSignal at max positions (line 170-171)**

After `logger.info(...)` at line 170, before return at line 171:
```typescript
if (signalCtx) saveSignal(signalCtx, 'filtered_max_positions');
```

**Step 5: Add saveSignal at ranking rejection (line 190-194)**

After `if (!shouldExecute)` at line 190, before return at line 194:
```typescript
if (signalCtx) saveSignal(signalCtx, 'filtered_ranking');
```

**Step 6: Add saveSignal at capital/sizing failures**

At line 270 (notional > 10x capital):
```typescript
if (signalCtx) saveSignal(signalCtx, 'filtered_capital');
```

At line 276 (margin > capital):
```typescript
if (signalCtx) saveSignal(signalCtx, 'filtered_margin_exceeded');
```

At line 282 (notional < $20):
```typescript
if (signalCtx) saveSignal(signalCtx, 'filtered_notional_too_low');
```

At line 289 (reserve failed):
```typescript
if (signalCtx) saveSignal(signalCtx, 'filtered_reserve_failed');
```

**Step 7: Add saveSignal at successful trade creation**

In `openPaper()` (after `savePositionToDb` at line 392), we need the tradeId. The tradeId is created inside `savePositionToDb`. We need to retrieve it. Check if `savePositionToDb` returns a trade ID or if we can query it.

Since `savePositionToDb` writes the Position and Trade records, and we know the sessionId + symbol, we can save the signal AFTER position is saved:

After line 397 (paper success path, after `capitalPool.commit`), add:
```typescript
if (signalCtx) {
  // Query tradeId from DB — the trade was just created by savePositionToDb
  try {
    const trade = await prisma.trade.findFirst({
      where: { sessionId: this.ctx.sessionId, symbol, entryTs: { gte: new Date(Date.now() - 60000) } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    saveSignal(signalCtx, 'traded', trade?.id ?? undefined);
  } catch {
    saveSignal(signalCtx, 'traded');
  }
}
```

For `openLive()`, add the same pattern after the successful order placement and DB save.

**Step 8: Verify types compile**

Run: `cd backend && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors.

**Step 9: Commit**

```bash
git add backend/src/strategies/positionOpener.ts
git commit -m "feat: log signals at every filter rejection + trade success in positionOpener"
```

---

### Task 5: Add saveSignal for ranking rejection in orchestrator

When a valid signal is added to the ranker but the symbol loses the slot competition, orchestrator should also log it. However, positionOpener already handles `shouldExecuteSignal` returning false (Task 4, Step 5).

There's another case: when orchestrator has a valid signal but `this.position` is already set (already in a trade). Check if this case needs logging.

**Files:**
- Modify: `backend/src/strategies/orchestrator.ts`

**Step 1: Check the early return for existing position**

In `orchestrator.ts` around line 955, before the signal is added to ranker, there may be an `if (this.position)` check that skips entry. Find this and add signal logging:

```typescript
if (signalCtx) saveSignal(signalCtx, 'filtered_max_positions');
```

Import `saveSignal` at top:
```typescript
import { saveSignal } from './signalLogger.js';
```

**Step 2: Verify types compile**

Run: `cd backend && npx tsc --noEmit 2>&1 | head -20`

**Step 3: Commit**

```bash
git add backend/src/strategies/orchestrator.ts
git commit -m "feat: log valid signals rejected by existing position in orchestrator"
```

---

### Task 6: Integration test — verify signal logging end-to-end

**Files:**
- Create: `backend/test/unit/signalLogger.test.ts`

**Step 1: Write unit test for saveSignal feature computation**

```typescript
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock prisma
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    signal: {
      create: jest.fn().mockResolvedValue({ id: 'test-signal-id' }),
    },
  })),
}));

describe('signalLogger', () => {
  it('should compute all features from candles and signal', async () => {
    // Import after mock
    const { saveSignal } = await import('../../src/strategies/signalLogger.js');

    const candles = generateTestCandles(30); // Helper to generate 30 15m candles
    const btcCandles = generateTestCandles(250); // 250 for SMA200

    const signal = {
      valid: true,
      side: 'long' as const,
      reason: 'v5_confirmed',
      confidence: 0.75,
      features: {
        volRatio: 1.5,
        isBullish: true,
        priceAboveMa20: true,
        btcAboveMa50: true,
        btcMomentum6h: 0.5,
        dayOfWeek: 3,
        roc: 2.1,
        roc5: 1.8,
        roc1: 0.6,
        consecUp: 2,
        consecDown: 0,
        btcInBullRegime: true,
        btcInBearRegime: false,
        bbUpper: 105,
        bbLower: 95,
        stochRsi: undefined,
      },
    };

    const ctx = {
      userId: 'user-1',
      sessionId: 'session-1',
      symbol: 'WIF/USDT:USDT',
      signal,
      candles,
      btcCandles,
      score: 7.5,
    };

    // Should not throw
    saveSignal(ctx, 'traded', 'trade-123');

    // Give fire-and-forget time to execute
    await new Promise(r => setTimeout(r, 100));
  });
});

function generateTestCandles(count: number) {
  const candles = [];
  let price = 100;
  const baseTs = Date.now() - count * 15 * 60 * 1000;
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.48) * 2;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random();
    const low = Math.min(open, close) - Math.random();
    candles.push({
      timestamp: baseTs + i * 15 * 60 * 1000,
      open, high, low, close,
      volume: 1000 + Math.random() * 500,
      isFinal: true,
    });
    price = close;
  }
  return candles;
}
```

**Step 2: Run test**

Run: `cd backend && npx jest test/unit/signalLogger.test.ts --verbose --forceExit`
Expected: PASS

**Step 3: Commit**

```bash
git add backend/test/unit/signalLogger.test.ts
git commit -m "test: add signalLogger unit test"
```

---

### Task 7: Build verification + push

**Step 1: Full type check**

Run: `cd backend && npx tsc --noEmit`
Expected: No new errors (pre-existing script errors OK).

**Step 2: Run existing tests**

Run: `cd backend && npx jest test/unit/ --verbose --forceExit 2>&1 | tail -20`
Expected: All existing tests still pass.

**Step 3: Final commit if any remaining changes**

```bash
git push
```

---

## Summary of changes

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `Signal` model + relations on `User` and `Trade` |
| `src/strategies/signalLogger.ts` | **NEW** — `saveSignal()` fire-and-forget + feature computation |
| `src/strategies/positionOpener.ts` | Add `signalCtx?` param to `open()`, call `saveSignal()` at 9 rejection points + trade success |
| `src/strategies/orchestrator.ts` | Pass `SignalContext` to `openPosition()`, import types, log for existing-position case |
| `test/unit/signalLogger.test.ts` | **NEW** — unit test for feature computation |

**Zero behavioral change** to trading logic. Signal logging is fire-and-forget and never blocks or alters trade decisions.
