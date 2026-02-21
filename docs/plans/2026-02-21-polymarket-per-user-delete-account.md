# Polymarket Per-User Credentials + Delete Account Fix

**Date:** 2026-02-21
**Status:** Approved

## Problem

1. **Polymarket credentials are global** — stored in `SystemSetting` (key-value), shared by all users. One user's wallet overwrites another's. Mode/amount settings are also global.
2. **Delete account broken** — frontend calls `DELETE /api/auth/account` but the endpoint doesn't exist in the backend.

## Design

### 1. New Prisma Model: `PolymarketCredential`

```prisma
model PolymarketCredential {
  id             String   @id @default(cuid())
  userId         String   @unique
  privateKey     String              // Encrypted
  proxyAddress   String?
  apiKey         String              // Encrypted CLOB API key
  apiSecret      String              // Encrypted CLOB API secret
  apiPassphrase  String              // Encrypted CLOB API passphrase
  address        String              // EOA derived from private key
  mode           String   @default("virtual")
  amount         Float    @default(5.0)
  hedgeAmount    Float    @default(5.0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}
```

- `PolymarketPrediction`: add `userId String?` FK + index (nullable for existing rows)

### 2. polymarketTrader.ts Changes

- Cache: `Map<string, StoredCreds>` keyed by userId (replaces singleton `_credCache`)
- All public functions take `userId` as first param
- Read/write from `PolymarketCredential` table instead of `SystemSetting`
- `getConfig(prisma, userId)` reads mode/amount from same table
- Remove all `SETTING_KEYS` constants (no more SystemSetting usage)

### 3. polymarketWorker.ts Changes

- `WorkerManager` with `Map<string, WorkerState>` — one state per user
- `startWorker(userId)` / `stopWorker(userId)` — per-user tick loop
- Startup recovery: load all users with `mode='live'`, restart their workers
- Each worker's predictions tagged with userId

### 4. Routes polymarket.ts Changes

- All routes extract `req.user!.id` and pass userId to service functions
- No URL changes — same endpoints, scoped by authenticated user
- `GET /stats`, `GET /history` filter by userId
- `DELETE /credentials` also stops user's worker

### 5. Delete Account Endpoint

New `DELETE /api/auth/account` in `auth.ts`:
1. Authenticate via middleware
2. Stop Polymarket worker for this user
3. Stop active agent sessions for this user
4. `prisma.user.delete()` — cascades clean everything
5. Return 200

### 6. Frontend

No changes needed — JWT already sent in headers, backend extracts userId.

## Migration

- Prisma migration adds `PolymarketCredential` table + `userId` column on `PolymarketPrediction`
- Existing SystemSetting polymarket_* rows become orphaned (can be cleaned up manually)
- Existing PolymarketPrediction rows keep `userId = null`
