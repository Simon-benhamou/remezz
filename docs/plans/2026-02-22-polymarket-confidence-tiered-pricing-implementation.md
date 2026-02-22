# Confidence-Tiered Pricing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fixed MAX_CLOB_PRICE=0.55 cap and observation phase with confidence-tiered pricing (score-based dynamic cap + GTC limit fallback), increasing trade rate from ~41% to ~82-100% of predictions.

**Architecture:** The scorer produces a confidence score (40-100). Higher scores justify paying higher CLOB prices. At T+1:00, if the CLOB ask is under the tier cap, place an immediate GTC buy at ask. If above the tier cap, place a GTC limit at the tier cap price and cancel at T+4:00 if unfilled. The observation phase (per-second dip polling) is removed entirely.

**Tech Stack:** TypeScript, Prisma, @polymarket/clob-client (GTC orders)

---

### Task 1: Add `getMaxPriceForScore()` to polymarketTrader.ts

**Files:**
- Modify: `backend/src/services/polymarket/polymarketTrader.ts:49-53`

**Step 1: Replace MAX_CLOB_PRICE constant with tier config + helper function**

In `polymarketTrader.ts`, replace lines 49-53:

```typescript
// OLD:
export const MAX_CLOB_PRICE = 0.55;
```

With:

```typescript
// Confidence-tiered pricing: higher score → accept higher CLOB price.
// Data-driven (3-day DB sample, 17 predictions, 76.5% overall WR):
//   Score 40-49: 60% WR → breakeven at 0.60 → cap 0.58
//   Score 50-59: 87.5% WR → breakeven at 0.63 → cap 0.63
//   Score 60+:   75% WR → breakeven at 0.68 → cap 0.68
export const CLOB_PRICE_TIERS = [
  { minScore: 60, maxPrice: 0.68 },
  { minScore: 50, maxPrice: 0.63 },
  { minScore: 40, maxPrice: 0.58 },
] as const;

/** Get the maximum acceptable CLOB price for a given confidence score. */
export function getMaxPriceForScore(score: number): number {
  for (const tier of CLOB_PRICE_TIERS) {
    if (score >= tier.minScore) return tier.maxPrice;
  }
  return 0.50; // fallback — should never hit (scorer returns null for score < 40)
}

// Keep MAX_CLOB_PRICE for hedge bets (they don't have a score — use the lowest tier)
export const MAX_CLOB_PRICE = CLOB_PRICE_TIERS[CLOB_PRICE_TIERS.length - 1].maxPrice; // 0.58
```

**Step 2: Update placePolymarketBet to accept optional score parameter**

In `polymarketTrader.ts`, modify the function signature at line 423:

```typescript
// OLD:
export async function placePolymarketBet(
  prisma: PrismaClient,
  direction: 'UP' | 'DOWN',
  tokenId: string,
  amount: number,
  price: number,
  skipEvCheck = false,
): Promise<{ success: boolean; orderId?: string; executionPrice?: number; error?: string }> {

// NEW:
export async function placePolymarketBet(
  prisma: PrismaClient,
  direction: 'UP' | 'DOWN',
  tokenId: string,
  amount: number,
  price: number,
  skipEvCheck = false,
  confidenceScore?: number,
): Promise<{ success: boolean; orderId?: string; executionPrice?: number; error?: string }> {
```

Then update the EV cap check at lines 445-450:

```typescript
// OLD:
if (!skipEvCheck && clobAsk > MAX_CLOB_PRICE) {
  log.warn(`EV too low: CLOB ask=${clobAsk.toFixed(3)} > cap=${MAX_CLOB_PRICE} — skipping`);
  return { success: false, error: `EV too low (CLOB=${clobAsk.toFixed(3)} > cap=${MAX_CLOB_PRICE})` };
}

// NEW:
const maxPrice = confidenceScore ? getMaxPriceForScore(confidenceScore) : MAX_CLOB_PRICE;
if (!skipEvCheck && clobAsk > maxPrice) {
  log.warn(`EV too low: CLOB ask=${clobAsk.toFixed(3)} > cap=${maxPrice.toFixed(2)} (score=${confidenceScore ?? 'n/a'}) — skipping`);
  return { success: false, error: `EV too low (CLOB=${clobAsk.toFixed(3)} > cap=${maxPrice.toFixed(2)})` };
}
```

Also update the log at line 458:

```typescript
// OLD:
log.info(`Price OK: CLOB ask=${clobAsk.toFixed(3)}, Gamma=${price.toFixed(3)}, cap=${MAX_CLOB_PRICE}`);

// NEW:
log.info(`Price OK: CLOB ask=${clobAsk.toFixed(3)}, Gamma=${price.toFixed(3)}, cap=${maxPrice.toFixed(2)} (score=${confidenceScore ?? 'n/a'})`);
```

**Step 3: Build and verify no type errors**

Run: `npx tsc --noEmit 2>&1 | grep -i polymarket`
Expected: No new errors (existing pre-existing warnings OK)

**Step 4: Commit**

```bash
git add backend/src/services/polymarket/polymarketTrader.ts
git commit -m "feat(polymarket): add confidence-tiered pricing — getMaxPriceForScore()"
```

---

### Task 2: Add GTC limit order placement function to polymarketTrader.ts

**Files:**
- Modify: `backend/src/services/polymarket/polymarketTrader.ts` (after `placePolymarketBet`, around line 523)

**Step 1: Add `placeGtcLimitBuy()` function**

This is a non-blocking variant — places the order and returns immediately (no 30s poll). The worker will track the orderId and cancel at T+4:00.

```typescript
/**
 * Place a GTC limit BUY order at a specific price (non-blocking).
 * Returns immediately after order placement — caller manages polling/cancellation.
 * Used as fallback when CLOB ask exceeds tier cap: place limit at cap and wait.
 */
export async function placeGtcLimitBuy(
  prisma: PrismaClient,
  tokenId: string,
  amount: number,
  limitPrice: number,
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  const creds = await loadCredentials(prisma);
  if (!creds) return { success: false, error: 'No credentials' };

  try {
    const client = buildClient(creds);
    const tokenSize = amount / limitPrice;
    const order = {
      tokenID: tokenId,
      price: limitPrice,
      size: tokenSize,
      side: Side.BUY,
    };

    const result = await client.createAndPostOrder(order, undefined, OrderType.GTC);

    if (result?.error) {
      const errMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
      throw new Error(`Limit order rejected: ${errMsg}`);
    }

    const orderId = result?.orderID ?? result?.id ?? 'unknown';
    log.info(`GTC LIMIT placed: BUY $${amount} @ ${limitPrice.toFixed(3)} | orderId=${orderId}`);
    return { success: true, orderId };
  } catch (err: any) {
    log.error(`Failed to place GTC limit: ${err?.message}`);
    return { success: false, error: err?.message };
  }
}
```

**Step 2: Build and verify**

Run: `npx tsc --noEmit 2>&1 | grep -i polymarket`
Expected: No new errors

**Step 3: Commit**

```bash
git add backend/src/services/polymarket/polymarketTrader.ts
git commit -m "feat(polymarket): add placeGtcLimitBuy() for passive limit fallback"
```

---

### Task 3: Add GTC limit tracking state to polymarketWorker.ts

**Files:**
- Modify: `backend/src/services/polymarket/polymarketWorker.ts:104-123`

**Step 1: Replace observation state variables with GTC limit state**

Replace lines 104-123 (observation state + resetObservation):

```typescript
// OLD: observation phase state (lines 104-123)
let observationActive = false;
let observationTokenId: string | null = null;
let observationDirection: 'UP' | 'DOWN' | null = null;
let observationAmount = 0;
let observationEntryOdds = 0;
let observationInitialAsk = 0;
let observationBestAsk = 0;
let observationDeadlineMs = 0;

function resetObservation(): void {
  observationActive = false;
  observationTokenId = null;
  observationDirection = null;
  observationAmount = 0;
  observationEntryOdds = 0;
  observationInitialAsk = 0;
  observationBestAsk = 0;
  observationDeadlineMs = 0;
}
```

With:

```typescript
// ─── GTC limit fallback state (replaces observation phase) ──────────────────
// When CLOB ask exceeds tier cap at T+1:00, a passive GTC limit is placed at the cap price.
// The order sits in the book until filled or cancelled at T+4:00.
let pendingLimitOrderId: string | null = null;
let pendingLimitDeadlineMs = 0;
let pendingLimitTokenId: string | null = null;
let pendingLimitDirection: 'UP' | 'DOWN' | null = null;
let pendingLimitAmount = 0;
let pendingLimitEntryOdds = 0;
let pendingLimitPrice = 0;

function resetPendingLimit(): void {
  pendingLimitOrderId = null;
  pendingLimitDeadlineMs = 0;
  pendingLimitTokenId = null;
  pendingLimitDirection = null;
  pendingLimitAmount = 0;
  pendingLimitEntryOdds = 0;
  pendingLimitPrice = 0;
}
```

**Step 2: Build — expect errors (observation references are stale)**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Errors referencing `observationActive`, `executeObservationBuy`, etc. — these will be fixed in Task 4.

**Step 3: Commit (WIP)**

```bash
git add backend/src/services/polymarket/polymarketWorker.ts
git commit -m "wip(polymarket): replace observation state with GTC limit state"
```

---

### Task 4: Rewrite the live entry logic in polymarketWorker.ts (the big one)

**Files:**
- Modify: `backend/src/services/polymarket/polymarketWorker.ts:788-918`
- Import: `placeGtcLimitBuy`, `getMaxPriceForScore` from `./polymarketTrader.js`

**Step 1: Update imports at top of file (line 11)**

```typescript
// OLD:
import { getLiveTradingConfig, placePolymarketBet, getPolymarketBalance, getPolymarketConfig, sellWinningTokens, redeemWinningTokens, getClobAskPrice, placeTakeProfitSell, checkOrderStatus, cancelClobOrder, MAX_CLOB_PRICE } from './polymarketTrader.js';

// NEW:
import { getLiveTradingConfig, placePolymarketBet, placeGtcLimitBuy, getPolymarketBalance, getPolymarketConfig, sellWinningTokens, redeemWinningTokens, getClobAskPrice, placeTakeProfitSell, checkOrderStatus, cancelClobOrder, MAX_CLOB_PRICE, getMaxPriceForScore } from './polymarketTrader.js';
```

**Step 2: Remove `executeObservationBuy()` function (lines 125-188)**

Delete the entire `executeObservationBuy` function.

**Step 3: Rewrite live entry block (lines 788-868)**

Replace the block from `// ── Live trading: enter observation phase if enabled` through the observation setup and the virtual mode block. The new logic is:

```typescript
      // ── Live trading: immediate entry or GTC limit fallback ─────────────
      const liveConfig = await getLiveTradingConfig(prisma);
      if (liveConfig && tokenId) {
        if (activeLiveBetWindow !== null && activeLiveBetWindow !== start) {
          log.warn(`LIVE MODE: skipping bet — previous window ${activeLiveBetWindow} still has an active bet`);
        } else {
          activeLiveBetWindow = start;

          const { balance } = await getPolymarketBalance(prisma);
          if (balance < liveConfig.amount) {
            log.warn(`LIVE MODE: insufficient balance $${balance.toFixed(2)} < $${liveConfig.amount} — skipping bet`);
            activeLiveBetWindow = null;
          } else {
            const score = result.confidence;
            const tierMax = getMaxPriceForScore(score);

            // Try immediate entry — placePolymarketBet fetches CLOB ask and checks tier cap
            const betResult = await placePolymarketBet(
              prisma, result.direction, tokenId, liveConfig.amount, entryOdds, false, score,
            );

            if (betResult.success) {
              log.info(`LIVE BET OK: orderId=${betResult.orderId} @ CLOB ${betResult.executionPrice?.toFixed(3)} (score=${score}, cap=${tierMax})`);
              if (betResult.executionPrice) {
                currentWindow.executionPrice = betResult.executionPrice;
                const sell: PendingAutoSell = {
                  tokenId,
                  betAmount: liveConfig.amount,
                  executionPrice: betResult.executionPrice,
                  direction: result.direction,
                  isHedge: false,
                  sold: false,
                  tpOrderId: null,
                  tpTargetPrice: null,
                };
                pendingAutoSells.push(sell);

                // Place take-profit GTC sell for entries below 50c
                if (betResult.executionPrice < TP_MAX_ENTRY_PRICE) {
                  const tpPrice = Math.min(betResult.executionPrice * TP_MULTIPLIER, 0.95);
                  const tpResult = await placeTakeProfitSell(prisma, tokenId, liveConfig.amount, betResult.executionPrice, tpPrice);
                  if (tpResult.success && tpResult.orderId) {
                    sell.tpOrderId = tpResult.orderId;
                    sell.tpTargetPrice = tpPrice;
                    log.info(`TP ORDER placed: sell @ ${(tpPrice * 100).toFixed(0)}c (entry ${(betResult.executionPrice * 100).toFixed(0)}c, ${TP_MULTIPLIER}x)`);
                  }
                }
              }
              currentWindow.observationStatus = 'filled';
            } else if (betResult.error?.startsWith('EV too low')) {
              // CLOB ask > tier cap → place passive GTC limit at cap price
              log.info(`CLOB above cap — placing GTC LIMIT at ${tierMax.toFixed(2)} (score=${score})`);
              const limitResult = await placeGtcLimitBuy(prisma, tokenId, liveConfig.amount, tierMax);
              if (limitResult.success && limitResult.orderId) {
                pendingLimitOrderId = limitResult.orderId;
                pendingLimitDeadlineMs = start + OBS_DEADLINE_OFFSET_MS;
                pendingLimitTokenId = tokenId;
                pendingLimitDirection = result.direction;
                pendingLimitAmount = liveConfig.amount;
                pendingLimitEntryOdds = entryOdds;
                pendingLimitPrice = tierMax;
                currentWindow.observationStatus = 'observing'; // reuse for display
              } else {
                log.error(`GTC LIMIT failed: ${limitResult.error}`);
                activeLiveBetWindow = null;
                currentWindow.observationStatus = 'skipped_ev';
              }
            } else {
              log.error(`LIVE BET FAILED: ${betResult.error}`);
              activeLiveBetWindow = null;
              currentWindow.observationStatus = 'idle';
            }
          }
        }
      } else if (liveConfig && !tokenId) {
        log.warn('Live mode active but no token ID available for this market');
      }

      // Virtual mode: mark observation fields for display
      if (!liveConfig || !tokenId) {
        currentWindow.observationStatus = 'idle';
      }
```

**Step 4: Replace observation polling block (lines 877-918) with GTC limit monitoring**

Replace the entire `// ── Observation phase: poll CLOB and check triggers` block with:

```typescript
  // ── GTC limit fallback: check fill status or cancel at deadline ──────────
  if (pendingLimitOrderId && currentWindow) {
    const now = Date.now();

    if (now >= pendingLimitDeadlineMs) {
      // Deadline reached — cancel unfilled limit order
      log.info(`GTC LIMIT deadline: cancelling orderId=${pendingLimitOrderId}`);
      try {
        await cancelClobOrder(prisma, pendingLimitOrderId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to cancel GTC limit: ${msg}`);
      }
      currentWindow.observationStatus = 'skipped_ev';
      activeLiveBetWindow = null;
      resetPendingLimit();
    } else {
      // Check if order filled
      try {
        const status = await checkOrderStatus(prisma, pendingLimitOrderId);
        if (status === 'MATCHED' || status === 'FILLED') {
          log.info(`GTC LIMIT FILLED: ${pendingLimitDirection} $${pendingLimitAmount} @ ${pendingLimitPrice.toFixed(3)}`);
          currentWindow.executionPrice = pendingLimitPrice;
          currentWindow.observationStatus = 'filled';

          // Track for pre-sell
          if (pendingLimitTokenId && pendingLimitDirection) {
            const sell: PendingAutoSell = {
              tokenId: pendingLimitTokenId,
              betAmount: pendingLimitAmount,
              executionPrice: pendingLimitPrice,
              direction: pendingLimitDirection,
              isHedge: false,
              sold: false,
              tpOrderId: null,
              tpTargetPrice: null,
            };
            pendingAutoSells.push(sell);

            // TP for cheap limit fills
            if (pendingLimitPrice < TP_MAX_ENTRY_PRICE) {
              const tpPrice = Math.min(pendingLimitPrice * TP_MULTIPLIER, 0.95);
              const tpResult = await placeTakeProfitSell(prisma, pendingLimitTokenId, pendingLimitAmount, pendingLimitPrice, tpPrice);
              if (tpResult.success && tpResult.orderId) {
                sell.tpOrderId = tpResult.orderId;
                sell.tpTargetPrice = tpPrice;
                log.info(`TP ORDER placed: sell @ ${(tpPrice * 100).toFixed(0)}c (limit entry ${(pendingLimitPrice * 100).toFixed(0)}c)`);
              }
            }
          }

          resetPendingLimit();
        } else if (status === 'CANCELED' || status === 'CANCELLED' || status === 'EXPIRED') {
          log.warn(`GTC LIMIT ${status} externally — orderId=${pendingLimitOrderId}`);
          currentWindow.observationStatus = 'skipped_ev';
          activeLiveBetWindow = null;
          resetPendingLimit();
        }
        // else: still LIVE — continue waiting
      } catch (err: unknown) {
        // Poll error — will retry next tick
      }
    }
  }
```

**Step 5: Update the reversal/hedge block at line 925**

The guard `!observationActive` becomes `!pendingLimitOrderId`:

```typescript
// OLD (line 925):
if (elapsed >= REVERSAL_OFFSET_MS && !reversalChecked && currentWindow && !observationActive) {

// NEW:
if (elapsed >= REVERSAL_OFFSET_MS && !reversalChecked && currentWindow && !pendingLimitOrderId) {
```

**Step 6: Update window reset (where resetObservation was called)**

Search for all `resetObservation()` calls and replace with `resetPendingLimit()`. These occur in:
- The window-end resolution block (around line 701 — reset on new window)
- Any error paths

Check by searching: `grep -n 'resetObservation\|observationActive' polymarketWorker.ts`

In the new-window detection block, there should be a state reset. Find where `resetObservation()` was called in the window lifecycle and replace with `resetPendingLimit()`.

Also cancel pending limit on window transition (add before `resetPendingLimit()`):
```typescript
if (pendingLimitOrderId) {
  try { await cancelClobOrder(prisma, pendingLimitOrderId); } catch {}
  activeLiveBetWindow = null;
}
resetPendingLimit();
```

**Step 7: Remove unused observation constants**

Delete these constants (no longer needed):
- `OBS_DIP_THRESHOLD` (line 29)
- `OBS_BOUNCE_THRESHOLD` (line 30)
- `OBS_RISING_THRESHOLD` (line 31)

Keep `OBS_DEADLINE_OFFSET_MS` — still used for GTC limit deadline.

**Step 8: Build and verify**

Run: `npx tsc --noEmit 2>&1 | grep -i polymarket`
Expected: No new errors. If there are remaining references to old observation variables, fix them.

**Step 9: Commit**

```bash
git add backend/src/services/polymarket/polymarketWorker.ts
git commit -m "feat(polymarket): replace observation phase with tiered entry + GTC limit fallback"
```

---

### Task 5: Update TP constants

**Files:**
- Modify: `backend/src/services/polymarket/polymarketWorker.ts:49-50`

**Step 1: Adjust TP thresholds for new price range**

```typescript
// OLD:
const TP_MULTIPLIER = 2.5;                        // Sell at 2.5x the entry price
const TP_MAX_ENTRY_PRICE = 0.40;                  // Only TP on cheap entries (< 40c)

// NEW:
const TP_MULTIPLIER = 2.0;                        // Sell at 2.0x the entry price
const TP_MAX_ENTRY_PRICE = 0.50;                  // TP on entries below 50c (widened from 40c for tiered pricing)
```

**Step 2: Commit**

```bash
git add backend/src/services/polymarket/polymarketWorker.ts
git commit -m "feat(polymarket): widen TP eligibility (50c cap, 2.0x multiplier)"
```

---

### Task 6: Verify build + manual smoke test

**Files:** None (verification only)

**Step 1: Full build**

Run: `npm run build`
Expected: Clean build (or only pre-existing warnings)

**Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: No new errors in polymarket files

**Step 3: Review the full diff**

Run: `git diff HEAD~5 -- backend/src/services/polymarket/`
Verify:
- `MAX_CLOB_PRICE` is still exported (used by hedge logic)
- `getMaxPriceForScore()` is exported and used
- `placeGtcLimitBuy()` is exported
- No references to `observationActive`, `observationBestAsk`, `OBS_DIP_THRESHOLD`, etc.
- `pendingLimitOrderId` is properly reset in all paths (window transition, fill, cancel, deadline)

**Step 4: Commit final cleanup if needed**

```bash
git add -A && git commit -m "chore(polymarket): cleanup after tiered pricing migration"
```

---

### Task 7: Cleanup temp files and squash commits

**Files:**
- Delete: `backend/scripts/pm-stats.ts` (temp analysis script)

**Step 1: Delete temp script**

```bash
rm backend/scripts/pm-stats.ts
git add backend/scripts/pm-stats.ts
git commit -m "chore: remove temp pm-stats script"
```

**Step 2: Verify final state**

Run: `git log --oneline -7`
Expected: Clean commit history showing the progression.
