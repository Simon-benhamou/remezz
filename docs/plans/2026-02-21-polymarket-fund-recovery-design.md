# Polymarket Fund Recovery + Real PnL Design

**Date**: 2026-02-21
**Status**: Approved

## Problem

After 24h of live Polymarket trading:
- $91 stuck as "claimable" tokens on Polymarket UI
- $0 in portfolio (USDC) → bot can't place new bets
- Win rate (70%) doesn't reflect actual traded outcomes

### Root Causes

1. **Pre-sell at T+4:50 too late**: Single attempt, if tick is delayed → missed entirely (new window resets state)
2. **CLOB sell post-resolution**: Orderbook removed after market closes → 100% failure
3. **CTF on-chain redeem**: Tokens are in proxy wallet (Magic.link), but redeem uses EOA wallet → can't access tokens. Also no MATIC for gas.
4. **Zero retry**: Failed sells/redeems are never retried — tokens stuck forever
5. **Win rate counts all predictions**: Doesn't distinguish predictions-with-trades from predictions-without-trades

## Solution

### Part 1: Aggressive Pre-Sell (T+4:00 → T+4:55)

Replace single T+4:50 check with retry loop:

| Time | Attempt | Min Bid |
|------|---------|---------|
| T+4:00 | 1st | 0.90 |
| T+4:10 | 2nd | 0.90 |
| T+4:20 | 3rd | 0.85 |
| T+4:30 | 4th | 0.85 |
| T+4:40 | 5th | 0.80 |
| T+4:50 | 6th | 0.80 |

Changes:
- `PendingAutoSell.sold: boolean` field added
- `preSellChecked` → `lastPreSellAttemptMs` (timestamp-based retry)
- `sellWinningTokens()` receives `minBid` parameter (replaces hardcoded 0.90)
- Retry every 10s while unsold items exist
- Losing tokens fail silently (bid ~$0.01 < threshold) — same as current

### Part 2: Post-Resolution Redemption Queue

When pre-sell fails (window ends with unsold tokens):

```typescript
interface UnredeemedToken {
  windowStart: number;
  slug: string;
  tokenId: string;
  betAmount: number;
  executionPrice: number;
  direction: 'UP' | 'DOWN';
  isHedge: boolean;
  addedAt: number;
  attempts: number;
  lastAttemptAt: number;
  giveUpAt: number;       // addedAt + 30 minutes
}
```

Retry schedule:
- Every 30s for first 10 min (CLOB orderbook might still exist)
- Every 2 min for next 20 min
- After 30 min: marked "stuck", visible in API

Population:
1. Window end → unsold items from pendingAutoSells
2. Oracle verification → sell failed for a WIN

### Part 3: Real PnL

New DB columns:
- `realPnl Float?` — actual USDC in - USDC out (null = not settled)
- `usdcReceived Float?` — USDC received from sell
- `sellPrice Float?` — CLOB bid at time of sell
- `soldAt DateTime?` — when sell happened

Update flow:
1. Buy: `betAmount` already stored
2. Pre-sell OK: `usdcReceived = tokens × sellBid`, `realPnl = usdcReceived - betAmount`
3. Oracle WIN + not sold: `realPnl = null` (tokens stuck)
4. Oracle LOSS: `realPnl = -betAmount`
5. Retry queue sell OK: update all sell fields

Stats in live mode use `realPnl` instead of `simulatedPnl`.

### Part 4: Real Win Rate

New stats fields:
- `tradedWins` / `tradedLosses`: only predictions with `executionPrice IS NOT NULL`
- `tradedWinRate`: based on actual trades
- `tradedPnl`: sum of `realPnl` (live) or `simulatedPnl` (virtual)

### Part 5: Unredeemed Tokens API

`GET /api/polymarket/unredeemed`:
```json
{
  "count": 3,
  "totalStuckUsdc": 27.45,
  "tokens": [
    { "slug": "btc-updown-5m-...", "amount": 9.09, "status": "retrying", "attempts": 5 }
  ]
}
```

### Part 6: Frontend History Detail

Table columns:
- Time, Direction + score, Entry price (Gamma + CLOB), Oracle result
- Trade status: "Executed $5 @ 0.55" / "No trade" / "EV too low"
- Sell status: "Sold @ 0.97" / "Stuck (retrying 3/6)" / "Lost"
- PnL: real in live, simulated in virtual

Visual badges: green SOLD, orange STUCK, red LOST, grey VIRTUAL

Live mode: only show executed trades in main stats. Virtual predictions shown in grey in history.

## What We Don't Do

- No CTF on-chain redeem (proxy wallet + no MATIC = impossible)
- No changes to hedge/lottery mechanism
- No changes to scoring or decision timing
