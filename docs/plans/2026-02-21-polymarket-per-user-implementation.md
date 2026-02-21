# Polymarket Per-User Credentials + Delete Account Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate Polymarket credentials from global `SystemSetting` to per-user `PolymarketCredential` table, add per-user worker instances, and implement the missing delete account endpoint.

**Architecture:** New `PolymarketCredential` Prisma model with `userId` FK replaces global SystemSetting storage. Worker becomes a `Map<userId, WorkerState>` instead of module-level singletons. All trader functions take `userId` as first param. Delete account endpoint cascades through Prisma.

**Tech Stack:** Prisma (PostgreSQL), Express routes, ethers v5/v6, @polymarket/clob-client

---

### Task 1: Add `PolymarketCredential` Model to Prisma Schema

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Step 1: Add PolymarketCredential model after SystemSetting (line 329)**

Add to `schema.prisma` after the `SystemSetting` model (line 329):

```prisma
model PolymarketCredential {
  id            String   @id @default(cuid())
  userId        String   @unique
  privateKey    String
  proxyAddress  String?
  apiKey        String
  apiSecret     String
  apiPassphrase String
  address       String
  mode          String   @default("virtual")
  amount        Float    @default(5.0)
  hedgeAmount   Float    @default(5.0)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}
```

**Step 2: Add userId to PolymarketPrediction model (line 358-386)**

Add after the `polymarketSlug` field (line 381):

```prisma
  userId          String?
```

Add index (before the closing `}`):

```prisma
  @@index([userId, createdAt])
```

**Step 3: Add relation on User model (line 10-28)**

Add after `settings UserSetting[]` (line 24):

```prisma
  polymarketCred  PolymarketCredential?
```

**Step 4: Run migration**

Run: `cd backend && npx prisma migrate dev --name add-polymarket-credential`
Expected: Migration creates `PolymarketCredential` table and adds `userId` column to `PolymarketPrediction`.

**Step 5: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/
git commit -m "feat: add PolymarketCredential model + userId on predictions"
```

---

### Task 2: Refactor `polymarketTrader.ts` to Per-User

**Files:**
- Modify: `backend/src/services/polymarket/polymarketTrader.ts` (lines 59-752)

This task transforms all functions from global SystemSetting to per-user PolymarketCredential.

**Step 1: Replace credential cache (lines 88-101)**

Replace the singleton cache + balance cache:

```typescript
// old (lines 88-101):
let _credCache: StoredCreds | null = null;
function clearCredCache(): void { _credCache = null; }
let _lastGoodBalance: number | null = null;
let _lastGoodBalanceAt = 0;
const BALANCE_CACHE_TTL_MS = 60_000;
```

With per-user maps:

```typescript
// ─── Per-user credential cache ──────────────────────────────────────────────
const _credCacheMap = new Map<string, StoredCreds>();

function clearCredCache(userId: string): void {
  _credCacheMap.delete(userId);
}

export function clearAllCredCaches(): void {
  _credCacheMap.clear();
}

// ─── Per-user balance cache ─────────────────────────────────────────────────
interface BalanceCache {
  balance: number;
  at: number;
}
const _balanceCacheMap = new Map<string, BalanceCache>();
const BALANCE_CACHE_TTL_MS = 60_000;
```

**Step 2: Delete SETTING_KEYS constant (lines 59-70)**

Remove the entire `SETTING_KEYS` block — no longer needed (we read from PolymarketCredential table directly).

**Step 3: Rewrite `getPolymarketConfig` (lines 136-149)**

```typescript
export async function getPolymarketConfig(
  prisma: PrismaClient,
  userId: string,
): Promise<PolymarketConfig> {
  const cred = await prisma.polymarketCredential.findUnique({
    where: { userId },
    select: { mode: true, amount: true, hedgeAmount: true, apiKey: true },
  });
  return {
    mode: (cred?.mode as 'virtual' | 'live') || 'virtual',
    amount: cred?.amount ?? 5,
    hedgeAmount: cred?.hedgeAmount ?? 1,
    hasCredentials: !!cred?.apiKey,
  };
}
```

**Step 4: Rewrite `savePolymarketConfig` (lines 154-177)**

```typescript
export async function savePolymarketConfig(
  prisma: PrismaClient,
  userId: string,
  mode: 'virtual' | 'live',
  amount: number,
  hedgeAmount: number,
): Promise<void> {
  await prisma.polymarketCredential.updateMany({
    where: { userId },
    data: { mode, amount, hedgeAmount },
  });
}
```

**Step 5: Rewrite `savePolymarketCredentials` (lines 183-262)**

Add `userId` param. Replace all `prisma.systemSetting.upsert` calls with a single `prisma.polymarketCredential.upsert`:

```typescript
export async function savePolymarketCredentials(
  prisma: PrismaClient,
  userId: string,
  rawPrivateKey: string,
  rawProxyAddress?: string,
): Promise<{ address: string }> {
  const privateKey = normalizePrivateKey(rawPrivateKey);
  const wallet6 = new ethers6.Wallet(privateKey);

  let proxyAddress: string | undefined;
  if (rawProxyAddress?.trim()) {
    const p = rawProxyAddress.trim();
    if (!ethers6.isAddress(p)) throw new Error('Invalid proxy address format');
    proxyAddress = ethers6.getAddress(p);
  }

  log.info(`Deriving API credentials for EOA: ${wallet6.address}...`);
  const signatureType = proxyAddress ? SignatureType.POLY_PROXY : SignatureType.EOA;
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, new Wallet(privateKey), undefined, signatureType, proxyAddress);
  const apiCreds = await tempClient.createOrDeriveApiKey();
  log.info(`API credentials derived successfully for ${wallet6.address}`);

  await new Promise((r) => setTimeout(r, 3500));

  const encryptedPk = encryptApiKey(privateKey);
  const encryptedApiKey = encryptApiKey(apiCreds.key);
  const encryptedSecret = encryptApiKey(apiCreds.secret);
  const encryptedPassphrase = encryptApiKey(apiCreds.passphrase);

  const roundTrip = decryptApiKey(encryptedPk);
  if (roundTrip !== privateKey) {
    throw new Error('Encryption round-trip verification failed — check ENCRYPTION_SALT config');
  }

  await prisma.polymarketCredential.upsert({
    where: { userId },
    create: {
      userId,
      privateKey: encryptedPk,
      proxyAddress: proxyAddress ?? null,
      apiKey: encryptedApiKey,
      apiSecret: encryptedSecret,
      apiPassphrase: encryptedPassphrase,
      address: wallet6.address,
    },
    update: {
      privateKey: encryptedPk,
      proxyAddress: proxyAddress ?? null,
      apiKey: encryptedApiKey,
      apiSecret: encryptedSecret,
      apiPassphrase: encryptedPassphrase,
      address: wallet6.address,
    },
  });

  clearCredCache(userId);
  _balanceCacheMap.delete(userId);

  return { address: wallet6.address };
}
```

**Step 6: Rewrite `deletePolymarketCredentials` (lines 267-288)**

```typescript
export async function deletePolymarketCredentials(
  prisma: PrismaClient,
  userId: string,
): Promise<void> {
  await prisma.polymarketCredential.deleteMany({ where: { userId } });
  clearCredCache(userId);
  _balanceCacheMap.delete(userId);
}
```

**Step 7: Rewrite `loadCredentials` (lines 293-340)**

```typescript
async function loadCredentials(
  prisma: PrismaClient,
  userId: string,
): Promise<StoredCreds | null> {
  const cached = _credCacheMap.get(userId);
  if (cached) return cached;

  const cred = await prisma.polymarketCredential.findUnique({
    where: { userId },
  });
  if (!cred) return null;

  try {
    const privateKey = normalizePrivateKey(decryptApiKey(cred.privateKey));
    const wallet = new ethers6.Wallet(privateKey);

    log.debug(`Credentials loaded for user=${userId} — address=${wallet.address}${cred.proxyAddress ? ` proxy=${cred.proxyAddress}` : ''}`);

    const stored: StoredCreds = {
      privateKey,
      address: wallet.address,
      proxyAddress: cred.proxyAddress || undefined,
      apiCreds: {
        key: decryptApiKey(cred.apiKey).trim(),
        secret: decryptApiKey(cred.apiSecret).trim(),
        passphrase: decryptApiKey(cred.apiPassphrase).trim(),
      },
    };
    _credCacheMap.set(userId, stored);
    return stored;
  } catch (err) {
    log.error(`Failed to load Polymarket credentials for user=${userId}: ${err}`);
    return null;
  }
}
```

**Step 8: Add userId to ALL remaining exported functions**

Every exported function that calls `loadCredentials(prisma)` must now call `loadCredentials(prisma, userId)`. Add `userId: string` as second param to each:

- `validatePolymarketCredentials(prisma, userId)` — line 346
- `getPolymarketBalance(prisma, userId)` — line 377 (also update balance cache to use `_balanceCacheMap.get(userId)`)
- `placePolymarketBet(prisma, userId, ...)` — line 423
- `sellWinningTokens(prisma, userId, ...)` — line 530
- `getClobAskPrice(prisma, userId, ...)` — line 591
- `placeTakeProfitSell(prisma, userId, ...)` — line 614
- `checkOrderStatus(prisma, userId, ...)` — line 655
- `cancelClobOrder(prisma, userId, ...)` — line 675
- `getLiveTradingConfig(prisma, userId)` — line 696
- `redeemWinningTokens(prisma, userId, ...)` — line 712

For `getPolymarketBalance`, also update the balance cache logic to use `_balanceCacheMap`:

```typescript
// Replace _lastGoodBalance reads with:
const bc = _balanceCacheMap.get(userId);
// Replace _lastGoodBalance writes with:
_balanceCacheMap.set(userId, { balance, at: Date.now() });
```

**Step 9: Build check**

Run: `cd backend && npx tsc --noEmit 2>&1 | head -50`
Expected: Compilation errors in `polymarketWorker.ts` and `polymarket.ts` routes (they pass wrong args now). This is expected — we fix those in Tasks 3 and 4.

**Step 10: Commit**

```bash
git add backend/src/services/polymarket/polymarketTrader.ts
git commit -m "refactor: polymarketTrader per-user credentials (breaks callers)"
```

---

### Task 3: Refactor `polymarketWorker.ts` to Per-User

**Files:**
- Modify: `backend/src/services/polymarket/polymarketWorker.ts` (lines 1-1230+)

This is the largest task. The module-level state becomes a `Map<string, UserWorkerState>`.

**Step 1: Define UserWorkerState type (after line 52)**

```typescript
interface UserWorkerState {
  userId: string;
  currentWindow: WindowState | null;
  decisionMade: boolean;
  reversalChecked: boolean;
  lastPreSellAttemptMs: number;
  lastTpCheckMs: number;
  resolutionDone: boolean;
  pendingResolution: WindowState | null;
  tickInProgress: boolean;
  activeLiveBetWindow: number | null;
  pendingAutoSells: PendingAutoSell[];
  unredeemedTokens: UnredeemedToken[];
  pendingVerifications: PendingVerification[];
  observationActive: boolean;
  observationTokenId: string | null;
  observationDirection: 'UP' | 'DOWN' | null;
  observationAmount: number;
  observationEntryOdds: number;
  observationInitialAsk: number;
  observationBestAsk: number;
  observationDeadlineMs: number;
  intervalHandle: ReturnType<typeof setInterval> | null;
}
```

**Step 2: Replace module-level state with worker map**

Replace all the module-level `let` variables (lines 55-123) with:

```typescript
const workers = new Map<string, UserWorkerState>();

function createWorkerState(userId: string): UserWorkerState {
  return {
    userId,
    currentWindow: null,
    decisionMade: false,
    reversalChecked: false,
    lastPreSellAttemptMs: 0,
    lastTpCheckMs: 0,
    resolutionDone: false,
    pendingResolution: null,
    tickInProgress: false,
    activeLiveBetWindow: null,
    pendingAutoSells: [],
    unredeemedTokens: [],
    pendingVerifications: [],
    observationActive: false,
    observationTokenId: null,
    observationDirection: null,
    observationAmount: 0,
    observationEntryOdds: 0,
    observationInitialAsk: 0,
    observationBestAsk: 0,
    observationDeadlineMs: 0,
    intervalHandle: null,
  };
}
```

**Step 3: Refactor all internal functions to take `state: UserWorkerState`**

Every function that reads/writes module state now receives `state` as first param:

- `resolveWindow(w, prisma)` → `resolveWindow(state, w, prisma)` — also adds `userId` to `prisma.polymarketPrediction.create({ data: { ..., userId: state.userId } })`
- `tick(prisma)` → `tick(state, prisma)` — all state refs change from `currentWindow` to `state.currentWindow`, etc.
- `resetObservation()` → `resetObservation(state)`
- `executeObservationBuy(prisma, ...)` → `executeObservationBuy(state, prisma, ...)`
- `processUnredeemedTokens(prisma)` → `processUnredeemedTokens(state, prisma)`
- `recoverPendingVerifications(prisma)` → `recoverPendingVerifications(state, prisma)` — filter by `userId: state.userId`

All calls to trader functions add `state.userId`:
- `placePolymarketBet(prisma, ...)` → `placePolymarketBet(prisma, state.userId, ...)`
- `getLiveTradingConfig(prisma)` → `getLiveTradingConfig(prisma, state.userId)`
- `getPolymarketConfig(prisma)` → `getPolymarketConfig(prisma, state.userId)`
- `getPolymarketBalance(prisma)` → `getPolymarketBalance(prisma, state.userId)`
- `sellWinningTokens(prisma, ...)` → `sellWinningTokens(prisma, state.userId, ...)`
- `getClobAskPrice(prisma, ...)` → `getClobAskPrice(prisma, state.userId, ...)`
- `placeTakeProfitSell(prisma, ...)` → `placeTakeProfitSell(prisma, state.userId, ...)`
- `checkOrderStatus(prisma, ...)` → `checkOrderStatus(prisma, state.userId, ...)`
- `cancelClobOrder(prisma, ...)` → `cancelClobOrder(prisma, state.userId, ...)`
- `redeemWinningTokens(prisma, ...)` → `redeemWinningTokens(prisma, state.userId, ...)`

**Step 4: Rewrite `startPolymarketWorker`**

```typescript
export function startPolymarketWorker(prisma: PrismaClient, userId: string): void {
  if (workers.has(userId)) {
    log.warn(`Worker already running for user=${userId}`);
    return;
  }

  startChainlinkFeed(); // Shared feed — idempotent

  const ws = getBinanceWebSocket();
  ws.subscribeToKline(SYMBOL, '1m');

  const state = createWorkerState(userId);

  recoverPendingVerifications(state, prisma).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Recovery failed for user=${userId}: ${msg}`);
  });

  state.intervalHandle = setInterval(() => {
    tick(state, prisma).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`tick error user=${userId}: ${msg}`);
    });
  }, POLL_INTERVAL_MS);

  workers.set(userId, state);

  log.info(`Worker started for user=${userId} — polling every ${POLL_INTERVAL_MS}ms`);
}
```

**Step 5: Rewrite `stopPolymarketWorker`**

```typescript
export function stopPolymarketWorker(userId: string): void {
  const state = workers.get(userId);
  if (!state) return;

  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
  }

  workers.delete(userId);
  log.info(`Worker stopped for user=${userId}`);

  // Only stop shared resources if no more workers
  if (workers.size === 0) {
    stopChainlinkFeed();
  }
}

export function stopAllWorkers(): void {
  for (const [userId] of workers) {
    stopPolymarketWorker(userId);
  }
}
```

**Step 6: Rewrite `isPolymarketWorkerRunning`**

```typescript
export function isPolymarketWorkerRunning(userId: string): boolean {
  return workers.has(userId);
}
```

**Step 7: Rewrite `getPolymarketLiveState`**

```typescript
export function getPolymarketLiveState(userId: string): {
  window: WindowState | null;
  klines1m: Candle1m[];
} {
  const state = workers.get(userId);
  if (!state) return { window: null, klines1m: getKlines1m() };
  return {
    window: state.currentWindow ? { ...state.currentWindow } : null,
    klines1m: getKlines1m(),
  };
}
```

**Step 8: Rewrite `getPolymarketStats` to filter by userId**

```typescript
export async function getPolymarketStats(
  prisma: PrismaClient,
  userId: string,
): Promise<PredictionStats> {
  const predictions = await prisma.polymarketPrediction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });
  // ... rest of function unchanged
}
```

**Step 9: Rewrite `getUnredeemedTokens`**

```typescript
export function getUnredeemedTokens(userId: string): Array<...> {
  const state = workers.get(userId);
  if (!state) return [];
  return state.unredeemedTokens.map((u) => ({ ... }));
}
```

**Step 10: Update `recoverPendingVerifications` to filter by userId**

In the `findMany` call (line 1141), add `userId` filter:

```typescript
const unverified = await prisma.polymarketPrediction.findMany({
  where: {
    userId: state.userId,
    createdAt: { gte: twoHoursAgo },
    skipped: false,
    prediction: { not: null },
    polymarketSlug: { not: null },
    isCorrect: null,
  },
  // ...
});
```

**Step 11: Build check**

Run: `cd backend && npx tsc --noEmit 2>&1 | head -50`
Expected: Errors in `polymarket.ts` routes (wrong args). Fixed in Task 4.

**Step 12: Commit**

```bash
git add backend/src/services/polymarket/polymarketWorker.ts
git commit -m "refactor: polymarketWorker per-user worker instances"
```

---

### Task 4: Update Polymarket Routes to Pass userId

**Files:**
- Modify: `backend/src/routes/polymarket.ts` (lines 1-191)

**Step 1: Update all route handlers**

Every handler that calls trader/worker functions now extracts `req.user!.id` and passes it.

Public endpoints (`/status`, `/stats`, `/history`, `/unredeemed`) become authenticated — they need userId context:

```typescript
// GET /status — now needs auth for per-user worker state
router.get('/status', authenticateUser, (req: AuthenticatedRequest, res) => {
  const state = getPolymarketLiveState(req.user!.id);
  res.json(state);
});

// GET /stats — now needs auth for per-user stats
router.get('/stats', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const stats = await getPolymarketStats(prisma, req.user!.id);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /history — now needs auth for per-user history
router.get('/history', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const predictions = await prisma.polymarketPrediction.findMany({
      where: { userId: req.user!.id },
      orderBy: { windowStart: 'desc' },
      take: limit,
    });
    res.json({ predictions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// GET /settings
router.get('/settings', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const config = await getPolymarketConfig(prisma, req.user!.id);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /settings
router.put('/settings', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { mode, amount, hedgeAmount } = req.body;
    // ... validation unchanged ...
    if (mode === 'live') {
      const config = await getPolymarketConfig(prisma, req.user!.id);
      if (!config.hasCredentials) {
        return res.status(400).json({ error: 'Save valid API credentials before enabling live mode' });
      }
    }
    await savePolymarketConfig(prisma, req.user!.id, mode, parsedAmount, parsedHedge);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// PUT /credentials
router.put('/credentials', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { privateKey, proxyAddress } = req.body;
    if (!privateKey || typeof privateKey !== 'string' || !privateKey.trim()) {
      return res.status(400).json({ error: 'Private key is required' });
    }
    const result = await savePolymarketCredentials(
      prisma, req.user!.id, privateKey.trim(), proxyAddress?.trim() || undefined,
    );
    res.json({ success: true, address: result.address });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to save credentials' });
  }
});

// DELETE /credentials
router.delete('/credentials', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    stopPolymarketWorker(req.user!.id);
    await deletePolymarketCredentials(prisma, req.user!.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete credentials' });
  }
});

// POST /validate-credentials
router.post('/validate-credentials', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const result = await validatePolymarketCredentials(prisma, req.user!.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ valid: false, error: 'Validation failed' });
  }
});

// DELETE /history
router.delete('/history', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { count } = await prisma.polymarketPrediction.deleteMany({
      where: { userId: req.user!.id },
    });
    res.json({ success: true, deleted: count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset predictions' });
  }
});

// GET /balance
router.get('/balance', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const result = await getPolymarketBalance(prisma, req.user!.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ balance: 0, error: 'Failed to fetch balance' });
  }
});

// GET /unredeemed
router.get('/unredeemed', authenticateUser, (req: AuthenticatedRequest, res) => {
  const tokens = getUnredeemedTokens(req.user!.id);
  const totalStuckUsdc = tokens.reduce((sum, t) => sum + t.amount, 0);
  res.json({ count: tokens.length, totalStuckUsdc, tokens });
});

// GET /worker
router.get('/worker', authenticateUser, (req: AuthenticatedRequest, res) => {
  res.json({ running: isPolymarketWorkerRunning(req.user!.id) });
});

// POST /worker/start
router.post('/worker/start', authenticateUser, (req: AuthenticatedRequest, res) => {
  const userId = req.user!.id;
  if (isPolymarketWorkerRunning(userId)) {
    return res.json({ running: true, message: 'Already running' });
  }
  startPolymarketWorker(prisma, userId);
  res.json({ running: true, message: 'Worker started' });
});

// POST /worker/stop
router.post('/worker/stop', authenticateUser, (req: AuthenticatedRequest, res) => {
  const userId = req.user!.id;
  if (!isPolymarketWorkerRunning(userId)) {
    return res.json({ running: false, message: 'Already stopped' });
  }
  stopPolymarketWorker(userId);
  res.json({ running: false, message: 'Worker stopped' });
});
```

**Step 2: Update imports**

Add `stopPolymarketWorker` to the import from `polymarketWorker.js` if not already there.

**Step 3: Build check**

Run: `cd backend && npx tsc --noEmit 2>&1 | head -30`
Expected: Clean or only pre-existing errors in scripts/.

**Step 4: Commit**

```bash
git add backend/src/routes/polymarket.ts
git commit -m "feat: polymarket routes pass userId to all service functions"
```

---

### Task 5: Add Delete Account Endpoint

**Files:**
- Modify: `backend/src/routes/auth.ts` (add after line 380)

**Step 1: Add the DELETE /account route**

Add before the final `export` or at end of file:

```typescript
// Delete account (cascades to all user data via Prisma onDelete: Cascade)
router.delete('/account', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.id;

    // Stop Polymarket worker if running
    try {
      const { stopPolymarketWorker } = await import('../services/polymarket/polymarketWorker.js');
      stopPolymarketWorker(userId);
    } catch { /* polymarket module may not be loaded */ }

    // Delete user — Prisma cascades to: AgentSession, UserApiKey, UserSetting, DailyReport, PolymarketCredential
    await prisma.user.delete({
      where: { id: userId },
    });

    log.info(`Account deleted: userId=${userId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete account error:', error);
    return res.status(500).json({ error: 'server_error' });
  }
});
```

**Step 2: Ensure `log` is available**

Check if `auth.ts` already has a logger. If not, add at top:

```typescript
import { createLogger } from '../utils/logger.js';
const log = createLogger('auth');
```

Or use `console.log` if the file already uses console for logging.

**Step 3: Build check**

Run: `cd backend && npx tsc --noEmit 2>&1 | head -20`
Expected: Clean.

**Step 4: Commit**

```bash
git add backend/src/routes/auth.ts
git commit -m "feat: add DELETE /api/auth/account endpoint"
```

---

### Task 6: Update Server Startup (if worker auto-starts)

**Files:**
- Modify: `backend/src/server.ts` (check if worker auto-starts at boot)

**Step 1: Check if server.ts auto-starts the Polymarket worker**

Search for `startPolymarketWorker` in `server.ts`. If found, it needs to be changed to start workers for all users with active live mode:

```typescript
// Old: startPolymarketWorker(prisma);
// New: auto-start workers for users with live mode
const liveUsers = await prisma.polymarketCredential.findMany({
  where: { mode: 'live' },
  select: { userId: true },
});
for (const { userId } of liveUsers) {
  startPolymarketWorker(prisma, userId);
}
```

If `server.ts` does NOT auto-start the worker, skip this step.

**Step 2: Commit (if changes made)**

```bash
git add backend/src/server.ts
git commit -m "feat: auto-start polymarket workers for users with live mode"
```

---

### Task 7: Build + Manual Test

**Step 1: Full build**

Run: `cd backend && npm run build`
Expected: Clean build.

**Step 2: Generate Prisma client**

Run: `cd backend && npx prisma generate`
Expected: Success.

**Step 3: Push schema to DB**

Run: `cd backend && npx prisma db push`
Expected: Schema synced.

**Step 4: Verify frontend works**

The frontend (`PolymarketPage.tsx`) makes the same API calls — no URL changes. The JWT auth header already sent on every request provides the userId on the backend. Verify:

1. Save credentials → should save for current user
2. Settings (mode/amount) → should save for current user
3. Stats/history → should show only current user's predictions
4. Delete credentials → should delete for current user
5. Delete account (Settings → Danger Zone) → should return 200 and redirect to login

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: polymarket per-user credentials + delete account endpoint"
```
