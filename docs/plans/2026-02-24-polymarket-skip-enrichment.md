# Polymarket Skip Data Enrichment — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist skip reasons for Polymarket predictions, enable oracle verification for skips, and display all skip data (direction, result, reason) in the frontend table.

**Architecture:** Add `skipReason String?` to Prisma model. Track skip reason in WindowState during worker lifecycle. Enable oracle verification for skipped predictions. Frontend shows direction/result/skipReason for all rows.

**Tech Stack:** Prisma (migration), TypeScript (backend worker + route), React + TanStack Table (frontend)

---

### Task 1: Add `skipReason` to Prisma schema + migrate

**Files:**
- Modify: `backend/prisma/schema.prisma:382` (after `skipped` field)

**Step 1: Add field to schema**

In `schema.prisma`, add `skipReason` after the `skipped` field (line 382):

```prisma
  skipped         Boolean  @default(false)
  skipReason      String?
  polymarketSlug  String?
```

**Step 2: Generate migration + apply**

Run:
```bash
cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx prisma migrate dev --name add-skip-reason
```

**Step 3: Verify Prisma client**

Run:
```bash
cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx prisma generate
```
Expected: Clean generation, no errors.

**Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/
git commit -m "feat: add skipReason field to PolymarketPrediction model"
```

---

### Task 2: Add `skipReason` to WindowState type

**Files:**
- Modify: `backend/src/services/polymarket/polymarketTypes.ts:56` (WindowState interface)

**Step 1: Add skipReason to WindowState**

After the `status` field (line 56), add:

```typescript
  status: 'accumulating' | 'predicted' | 'resolved' | 'skipped';
  skipReason: string | null;  // 'low_score' | 'no_candles' | 'against_consensus' | 'no_consensus' | 'market_filter' | 'cooldown' | 'toxic_hour'
```

**Step 2: Commit**

```bash
git add backend/src/services/polymarket/polymarketTypes.ts
git commit -m "feat: add skipReason to WindowState type"
```

---

### Task 3: Track skip reasons in polymarketWorker.ts (7 paths)

**Files:**
- Modify: `backend/src/services/polymarket/polymarketWorker.ts`

All 7 skip paths must set `w.skipReason` when setting `w.status = 'skipped'`:

**Step 1: Initialize skipReason in new window creation**

At line ~855 (where newWindow is created), add `skipReason: null` to the object:

```typescript
        observationTrigger: null,
        status: 'accumulating',
        skipReason: null,
```

**Step 2: Skip path 1 — No score (insufficient candles), line ~1144**

After `w.status = 'skipped';` add:
```typescript
          w.skipReason = 'no_candles';
```

**Step 3: Skip path 2 — Low score (below threshold), line ~1150**

After `w.status = 'skipped';` add:
```typescript
          w.skipReason = 'low_score';
```

**Step 4: Skip path 3 — Against consensus, line ~918**

After `if (w) w.status = 'skipped';` change to:
```typescript
        if (w) { w.status = 'skipped'; w.skipReason = 'against_consensus'; }
```

**Step 5: Skip path 4 — No consensus, line ~926**

After `if (w) w.status = 'skipped';` change to:
```typescript
        if (w) { w.status = 'skipped'; w.skipReason = 'no_consensus'; }
```

**Step 6: Skip path 5 — Market filter reject, line ~942-943**

After the existing `if (w) w.status = 'skipped';` in the market filter block, change to:
```typescript
            if (w) { w.status = 'skipped'; w.skipReason = 'market_filter'; }
```

**Step 7: Skip path 6 — Cooldown active, line ~957-958**

After `if (w) w.status = 'skipped';` change to:
```typescript
        if (w) { w.status = 'skipped'; w.skipReason = 'cooldown'; }
```

**Step 8: Skip path 7 — Toxic hour, line ~969-970**

After `if (w) w.status = 'skipped';` change to:
```typescript
          if (w) { w.status = 'skipped'; w.skipReason = 'toxic_hour'; }
```

**Step 9: Persist skipReason in resolveWindow DB create**

In `resolveWindow()` at line ~299 (the `prisma.polymarketPrediction.create` for shared row), add `skipReason` to the `data` object:

```typescript
        skipped,
        skipReason: w.skipReason ?? null,
        polymarketSlug: w.prediction ? slug : null,
```

**Step 10: Also save prediction/scoreBreakdown for low_score skips**

Currently, when `belowThreshold` is true, the scoring result IS computed (`result` exists with direction, score, confidence) but the `w.prediction` is never set (the tradeable path that sets `w.prediction = result` is not reached). We need to save the scoring data even for below-threshold skips.

In the low_score skip path (Step 3, around line ~1147-1155), after setting `w.skipReason = 'low_score'`:

```typescript
      } else if (belowThreshold) {
        const w = windowBySymbol.get(sym);
        if (w) {
          w.status = 'skipped';
          w.skipReason = 'low_score';
          // Save the prediction data even though it's below threshold
          w.prediction = result;
          const { total, volumeSpike, microRoc, bodyRatio, wickRejection, candleAlignment, preWindowMomentum } = result.score;
          log.info(
            `[${sym}] Score ${total}/${MIN_SCORE} ${result.direction} — vol=${volumeSpike} roc=${microRoc} body=${bodyRatio} wick=${wickRejection} align=${candleAlignment} pre=${preWindowMomentum}`
          );
        }
```

Similarly, for `against_consensus` and `no_consensus` skips, the prediction was already computed in the `scored` array (they have `result.direction`). We need to save it on the window:

For **against_consensus** (step 4), modify to:
```typescript
      const rejected = scored.filter(r => r.result!.direction !== consensusDir);
      for (const { sym, result } of rejected) {
        const w = windowBySymbol.get(sym);
        if (w) {
          w.status = 'skipped';
          w.skipReason = 'against_consensus';
          if (result) w.prediction = result;
        }
        log.info(`[${sym}] Skipped — against consensus (${consensusDir} ${consensusCount}/${scored.length})`);
      }
```

For **no_consensus** (step 5), modify to:
```typescript
      for (const { sym, result } of scored) {
        const w = windowBySymbol.get(sym);
        if (w) {
          w.status = 'skipped';
          w.skipReason = 'no_consensus';
          if (result) w.prediction = result;
        }
        log.info(`[${sym}] Skipped — no consensus (UP=${upCount}, DOWN=${downCount}, need 3+)`);
      }
```

For **market_filter**, **cooldown**, **toxic_hour** — the symbols were in `tradeable` which already passed scoring, so they have `result` in the `tradeable` array. We need to save prediction for these too:

For **market_filter** (step 6):
```typescript
          for (const { sym, result } of tradeable) {
            const w = windowBySymbol.get(sym);
            if (w) { w.status = 'skipped'; w.skipReason = 'market_filter'; if (result) w.prediction = result; }
          }
```

For **cooldown** (step 7):
```typescript
      for (const { sym, result } of tradeable) {
        const w = windowBySymbol.get(sym);
        if (w) { w.status = 'skipped'; w.skipReason = 'cooldown'; if (result) w.prediction = result; }
      }
```

For **toxic_hour** (step 8):
```typescript
        for (const { sym, result } of tradeable) {
          const w = windowBySymbol.get(sym);
          if (w) { w.status = 'skipped'; w.skipReason = 'toxic_hour'; if (result) w.prediction = result; }
        }
```

**Step 11: Commit**

```bash
git add backend/src/services/polymarket/polymarketWorker.ts
git commit -m "feat: track skipReason in all 7 skip paths + save prediction data for skips"
```

---

### Task 4: Enable oracle verification for skipped predictions

**Files:**
- Modify: `backend/src/services/polymarket/polymarketWorker.ts:429`

**Step 1: Remove the `if (!skipped)` guard**

Currently at line 429:
```typescript
  if (!skipped) {
    pendingVerifications.push({
```

Change to always push the shared signal verification, regardless of skip status:

```typescript
  // Always verify via oracle — even skipped predictions (for hypothetical WR analysis)
  pendingVerifications.push({
    userId: null,
    symbol: sym,
    windowStart: w.windowStart,
    slug,
    predictionDirection: w.prediction?.direction ?? null,
    entryOdds: w.entryOdds,
    executionPrice: null,
    betAmount: w.betAmount,
    tokenId: null,
    verifyAfterMs: Date.now() + 3 * 60 * 1000,
    giveUpAfterMs: Date.now() + 60 * 60 * 1000,
  });

  if (!skipped) {
    // Per-user live trade verifications (only for non-skipped, traded windows)
    const verifiedUsers = new Set<string>();
    for (const sell of autoSells) {
      ...
    }
    for (const vb of virtualBets) {
      ...
    }
  }
```

The key change: the shared signal row verification (`userId: null`) is pushed for ALL predictions. Per-user verifications (live trades, virtual bets) remain gated by `!skipped` since skipped windows have no user trades.

**Step 2: Verify build**

Run:
```bash
cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add backend/src/services/polymarket/polymarketWorker.ts
git commit -m "feat: enable oracle verification for skipped predictions"
```

---

### Task 5: Add `skipReason` to frontend type + display in table

**Files:**
- Modify: `frontend/src/pages/PolymarketPage.tsx`

**Step 1: Add `skipReason` to PredictionRow interface**

At line 134, after `skipped: boolean;`:
```typescript
  skipped: boolean;
  skipReason: string | null;
  tradeType: 'prediction' | 'virtual' | 'live';
```

**Step 2: Show prediction direction for skipped rows**

In the `prediction` column cell (line ~481-489), change:

```typescript
      cell: ({ row }) => {
        const p = row.original;
        if (p.skipped) return <span className="text-muted-foreground">{'\u2014'}</span>;
```

To:
```typescript
      cell: ({ row }) => {
        const p = row.original;
        if (p.skipped && !p.prediction) return <span className="text-muted-foreground">{'\u2014'}</span>;
```

This way, skips WITH a prediction (low_score, consensus, market_filter, cooldown, toxic_hour) show the arrow; skips WITHOUT prediction (no_candles) show dash.

**Step 3: Show result for skipped rows**

In the `isCorrect` column cell (line ~495-503), change:

```typescript
        if (p.skipped) return <span className="text-muted-foreground">{'\u2014'}</span>;
```

To:
```typescript
        if (p.skipped && p.isCorrect === null && !p.prediction) return <span className="text-muted-foreground">{'\u2014'}</span>;
```

This shows the oracle result (win/loss/pending) for skipped predictions that have a direction.

**Step 4: Add skipReason column**

After the `tradeType` column definition (line ~570), add a new column:

```typescript
    {
      accessorKey: 'skipReason',
      header: 'Skip',
      size: 80,
      cell: ({ row }) => {
        const p = row.original;
        if (!p.skipped || !p.skipReason) return null;
        const labels: Record<string, { label: string; color: string }> = {
          low_score: { label: 'LOW SCORE', color: 'bg-yellow-500/15 text-yellow-500' },
          no_candles: { label: 'NO DATA', color: 'bg-gray-500/15 text-gray-400' },
          against_consensus: { label: 'VS CONS.', color: 'bg-orange-500/15 text-orange-500' },
          no_consensus: { label: 'NO CONS.', color: 'bg-orange-500/15 text-orange-400' },
          market_filter: { label: 'MKT FILT', color: 'bg-purple-500/15 text-purple-500' },
          cooldown: { label: 'COOLDOWN', color: 'bg-red-500/15 text-red-400' },
          toxic_hour: { label: 'TOXIC HR', color: 'bg-red-500/15 text-red-500' },
        };
        const info = labels[p.skipReason] ?? { label: p.skipReason.toUpperCase(), color: 'bg-muted text-muted-foreground' };
        return (
          <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold', info.color)}>
            {info.label}
          </span>
        );
      },
    },
```

**Step 5: Commit**

```bash
git add frontend/src/pages/PolymarketPage.tsx
git commit -m "feat: display skipReason + prediction data for skipped rows in Polymarket table"
```

---

### Task 6: Build verification

**Step 1: Backend type check**

Run:
```bash
cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx tsc --noEmit
```
Expected: Clean (existing script warnings OK).

**Step 2: Frontend build**

Run:
```bash
cd /Users/simon-davidbenhamou/Desktop/remezz/frontend && npx vite build
```
Expected: Clean build.

**Step 3: Commit all together if any fix needed, then push**

---

## Summary of Changes

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `skipReason String?` field |
| `polymarketTypes.ts` | Add `skipReason` to `WindowState` |
| `polymarketWorker.ts` | 7 skip paths set `skipReason` + save `prediction` data + persist to DB + oracle verification for skips |
| `PolymarketPage.tsx` | Add `skipReason` to type, show Dir/Result for skips, add Skip Reason column |

## What this enables

After implementation, every skipped prediction will show:
- **Direction** (UP/DOWN arrow) — what the model predicted
- **Score** — the confidence score (even if below threshold)
- **Result** (checkmark/X) — oracle-verified outcome (was it right?)
- **Skip Reason** — color-coded badge explaining WHY it was skipped
- This allows analysis: "We skipped 40 low_score predictions and 30 were correct — maybe lower the threshold"
