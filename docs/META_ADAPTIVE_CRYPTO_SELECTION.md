# Meta-Adaptive Strategy and Crypto Selection

## Overview

The meta-adaptive strategy supports three aggressiveness levels that control how the intelligent agent selects cryptocurrencies. This document explains how each level works and which symbols are suitable.

## Aggressiveness Levels

### Conservative (`aggressiveness: 'conservative'`)

**Philosophy**: Safety first - only trade the most liquid, stable cryptocurrencies

**Filtering Criteria**:
- **Minimum Volume**: $75M+ (highest requirement)
- **Order Book Depth**: $25,000+ per side (deepest books required)
- **ATR Range**: 50-200% of target TP (narrow volatility band)
- **Regime Filter**: Rejects volatile and trending markets (prefers ranging/quiet)
- **Spread Tolerance**: Tightest (< 8 bps)

**Typical Symbols**:
- ✅ BTC/USDT, ETH/USDT (blue chips with massive liquidity)
- ✅ BNB/USDT (if volume > $75M)
- ❌ Most altcoins (too volatile or insufficient liquidity)
- ❌ SAPIEN, SOON, ICP (likely too volatile)
- ❌ ZEC (depends on current volatility)

**Use Case**: Low-risk trading with minimal slippage, ideal for large position sizes or conservative portfolios.

---

### Reactive (`aggressiveness: 'reactive'`) - **DEFAULT**

**Philosophy**: Balanced approach - good opportunities with acceptable risk

**Filtering Criteria**:
- **Minimum Volume**: $50M (moderate requirement)
- **Order Book Depth**: $15,000+ per side (good liquidity)
- **ATR Range**: 50-200% of target TP, **hard capped at 2.5%**
- **Regime Filter**: Accepts all except excessive volatility (>2.5x target TP)
- **Protection**: Explicit SAPIEN-style crash protection

**Typical Symbols**:
- ✅ BTC/USDT, ETH/USDT, SOL/USDT (major cryptocurrencies)
- ✅ XRP/USDT, ADA/USDT, DOT/USDT (if ATR < 2.5%)
- ✅ ICP/USDT, ZEC/USDT (if they pass ATR and liquidity filters)
- ⚠️ SOON/USDT (depends on volume and volatility at selection time)
- ❌ SAPIEN/USDT (protected against by 2.5% ATR cap)
- ❌ Meme coins with low volume

**Use Case**: Default mode for most traders - balances opportunity and safety.

**Special Protections**:
```typescript
// Hard cap at 2.5% ATR for reactive mode (line 1119)
const reactiveMaxAtr = strategy.aggressiveness === 'reactive' ? 2.5 : maxAtr;

// Protection comment (line 1116):
// "Réduire maxAtr de 3x à 2x pour éviter les crashs rapides comme SAPIEN (-7.8% en minutes)"
```

---

### Aggressive (`aggressiveness: 'aggressive'`)

**Philosophy**: Maximum opportunity - accept higher risk for higher reward

**Filtering Criteria**:
- **Minimum Volume**: $35M (lowest requirement)
- **Order Book Depth**: $10,000+ per side (thinner books acceptable)
- **ATR Range**: 50-200% of target TP (broadest range, no hard cap)
- **Regime Filter**: Prefers volatile and trending markets
- **Symbol Eligibility**: More permissive for complex/long symbols

**Typical Symbols**:
- ✅ All majors (BTC, ETH, SOL, etc.)
- ✅ High-volatility altcoins (ICP, FET, NEAR, etc.)
- ✅ Trending opportunities even with moderate liquidity
- ⚠️ SAPIEN/USDT (if it passes minimum filters, but risky)
- ⚠️ SOON/USDT (if volume >= $35M)
- ❌ Micro-caps with <$35M volume

**Use Case**: Experienced traders willing to accept higher volatility for larger profit potential.

---

## Regarding Your Specific Symbols

### SAPIEN/USDT
**Status**: Generally **rejected** in reactive/conservative modes

**Why**:
- Known for extreme volatility (-7.8% crash mentioned in code)
- Sub-penny token with crash risk
- Protected by 2.5% ATR cap in reactive mode
- Only accessible in aggressive mode if it passes minimum filters

**Code Protection** (lines 1116, 4567-4582):
```typescript
// 🔒 PROTECTION: Réduire maxAtr de 3x à 2x pour éviter les crashs rapides comme SAPIEN
const maxAtr = strategy.targetTpPct * 2;
const reactiveMaxAtr = strategy.aggressiveness === 'reactive' ? 2.5 : maxAtr;

// Sub-penny token protection
if (px > 0 && px < 1.0 && vol < 5_000_000) {
  const isEstablished = qualityContext.isBlueChip || qualityContext.family === 'major';
  const hasStrongVolume = vol >= 100_000_000;
  if (!isEstablished || !hasStrongVolume) {
    return { ok: false, reason: 'subpenny_volatile_low_volume' };
  }
}
```

### SOON/USDT
**Status**: Depends on market conditions at selection time

**Evaluation**:
- ✅ **Accepted if**: Volume >= $35M-$75M (depends on mode), ATR within limits, good liquidity
- ❌ **Rejected if**: Insufficient volume, ATR too high, thin order book
- **Mode Impact**:
  - Conservative: Needs $75M+ volume
  - Reactive: Needs $50M+ volume, ATR < 2.5%
  - Aggressive: Needs $35M+ volume

### ICP/USDT
**Status**: Likely **accepted** in reactive/aggressive modes if conditions are met

**Evaluation**:
- Major alt with typically good volume ($50M+)
- Moderate volatility (usually < 2.5% ATR)
- ✅ Should pass reactive filters if market conditions are normal
- ✅ Definitely accepted in aggressive mode

### ZEC/USDT
**Status**: **Conditional** - depends on current market volatility

**Evaluation**:
- Established privacy coin with decent liquidity
- Volatility varies - sometimes quiet, sometimes trending
- ✅ Accepted when volatility is moderate
- ❌ Rejected during high-volatility periods (ATR > 2.5% in reactive)

---

## How to Check Your Agent's Configuration

```typescript
// Via API or database
const session = await prisma.agentSession.findUnique({
  where: { id: sessionId },
  select: { profileJson: true }
});

const aggressiveness = session.profileJson?.aggressiveness || 'reactive';
console.log(`Agent aggressiveness: ${aggressiveness}`);
```

## How the Fix Works

**Before** (❌):
- All intelligent agents used hardcoded 'reactive' aggressiveness
- Meta-adaptive agents couldn't use their configured risk profile
- Symbol selection ignored agent's strategy preferences

**After** (✅):
- `initializeIntelligentAgent` extracts aggressiveness from session profile
- Aggressiveness is passed through entire symbol selection pipeline
- Conservative agents get stable coins, aggressive agents get volatile opportunities
- Each agent respects its configured risk tolerance

**Updated Functions**:
1. `initializeIntelligentAgent` - extracts and passes aggressiveness
2. `scanIntelligentOpportunitiesLegacy` - creates strategy profile
3. `getBestIntelligentOpportunity` - receives aggressiveness option
4. `checkSessionForBetterOpportunityOptimized` - propagates through re-evaluation
5. `maybeHandleDirectionalReversal` - uses aggressiveness for reversal detection
6. `triggerIntelligentReselection` - applies to manual re-selections

---

## Recommendations

### If You Want Symbols Like SAPIEN/SOON
**Set**: `aggressiveness: 'aggressive'`
- Accepts $35M+ volume
- Broader ATR range
- Higher risk tolerance

**Trade-off**:
- ⚠️ Higher volatility = larger stop losses
- ⚠️ More frequent whipsaws
- ⚠️ Potential for larger drawdowns

### If You Want Stable Performance
**Set**: `aggressiveness: 'conservative'`
- Only BTC/ETH and top-tier majors
- Minimal slippage
- Tighter spreads

**Trade-off**:
- ❌ Fewer opportunities
- ❌ Lower potential returns
- ✅ More predictable P&L

### For Balanced Trading (Recommended)
**Keep**: `aggressiveness: 'reactive'` (default)
- Good balance of safety and opportunity
- Accepts ICP, ZEC when conditions are favorable
- Protected against extreme volatility
- Best for most use cases

---

## Testing Your Configuration

```bash
# Check current agent configuration
curl -X GET http://localhost:3000/api/agent/sessions/:sessionId

# Update aggressiveness level
curl -X POST http://localhost:3000/api/agent/aggressiveness \
  -H "Content-Type: application/json" \
  -d '{"aggressiveness": "aggressive"}'

# Trigger manual re-selection (will use new aggressiveness)
curl -X POST http://localhost:3000/api/agent/reselect/:sessionId
```

---

## Conclusion

The crypto selection is now **fully adapted** to your meta-adaptive agent's aggressiveness level. If you're seeing symbols like ICP and ZEC, it means:

1. Your agent is likely in **reactive** or **aggressive** mode
2. Those symbols passed all liquidity and volatility filters at selection time
3. The selection is working as designed for your risk profile

If you prefer more conservative selections, update your agent's aggressiveness to `'conservative'`.
