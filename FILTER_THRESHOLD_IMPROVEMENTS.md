# Entry Filter Threshold Improvements

## Problem Statement

Based on log analysis, the trading system was blocking **100% of entry attempts** due to overly restrictive thresholds. The logs showed consistent patterns of failures across multiple components:

### Key Issues Identified:
1. **ATR thresholds were too high** - Example: requiring 4.40 for XRP when actual was 0.60
2. **Confidence threshold was too restrictive** - 0.72 in logs (0.55 in code)
3. **Flow/CMF failures** were too strict
4. **Dollar volume** had a **critical typo**: 50,000,000 instead of 150,000
5. **RR threshold** of 1.8+ was too high for crypto markets

## Changes Made

### 1. Critical Fix: Dollar Volume Typo
**Before:** `min_dollar_volume: 50000000` (50 million - clearly wrong)
**After:** `min_dollar_volume: 150000` (150k - matches the comment)

This was the **most critical issue** - requiring 50M in volume blocked almost all crypto pairs.

### 2. Core Threshold Adjustments

| Parameter | Old Value | New Value | Reason |
|-----------|-----------|-----------|--------|
| **minAdx** | 14 | 12 | Accept weaker trends; crypto ranges frequently |
| **minDollarVolume** | 50,000,000 | 150,000 | Fixed critical typo |
| **minRr** | 1.15 | 1.05 | Lower baseline allows more opportunities |
| **minAtrPct** | 0.08% | 0.05% | Accept lower volatility consolidation periods |
| **maxSpreadBps** | 8 | 12 | More tolerance for crypto spread expansion |
| **confidenceThreshold** | 0.55 | 0.50 | More permissive gate for quality setups |

### 3. Tier Override Improvements

#### Tier 1 (High Liquidity Pairs)
- `min_rr`: 1.3 → 1.2
- `min_dollar_volume`: 3M → 2M
- `max_spread_bps`: 8 → 10
- `confidence_threshold_delta`: 0.01 → 0.00 (removed extra requirement)

#### Tier 2 (Medium Liquidity)
- `min_dollar_volume`: 500k → 400k
- `min_rr`: 1.2 → 1.1
- `max_spread_bps`: 12 → 14

#### Tier 3 (Lower Liquidity/Altcoins)
- `min_adx`: 18 → 14 (major reduction)
- `min_rr`: 1.4 → 1.25
- `min_dollar_volume`: 150k → 100k
- `max_spread_bps`: 18 → 20
- `confidence_threshold_delta`: 0.02 → 0.00 (removed)
- `min_atr_pct_multiplier`: 0.6 → 0.4

### 4. Dynamic Adjustments

**Baseline ATR Multiplier:** 0.45 → 0.35 (less restrictive)
**ATR High Vol Threshold:** 1.5% → 1.8% (trigger tightening later)
**Spread ATR Ratio Limit:** 0.35 → 0.45 (more tolerance)

### 5. Aggressiveness Adjustments

**Aggressive Mode** (made more aggressive):
- `min_rr_delta`: -0.25 → -0.30
- `min_adx_delta`: -3 → -4
- `confidence_delta`: -0.04 → -0.06
- `min_atr_pct_delta`: -0.06 → -0.08

**Conservative Mode** (made less restrictive):
- `min_rr_delta`: 0.05 → 0.03
- `confidence_delta`: 0.015 → 0.01

### 6. Dry Spell Relaxation (More Aggressive)

Triggers faster relaxation when no trades occur:
- `min_minutes_without_trade`: 30 → 20 (faster trigger)
- `rejections_for_step`: 4 → 3 (relax sooner)
- `relaxation_step_minutes`: 20 → 15 (faster steps)
- `max_steps`: 4 → 5 (more relaxation allowed)
- Delta per step increased across all parameters

### 7. Playbook-Specific Overrides

#### Trend Following
- `min_rr`: 1.35 → 1.2
- `min_adx`: 18 → 15
- `min_atr_pct`: 0.1 → 0.07
- `confidence_threshold`: 0.58 → 0.52

#### Momentum Breakout
- `min_rr`: 1.55 → 1.35
- `min_adx`: 24 → 20
- `min_atr_pct`: 0.14 → 0.10
- `max_spread_bps`: 12 → 15
- `confidence_threshold`: 0.6 → 0.55

#### Mean Reversion
- `min_rr`: 1.1 → 1.0
- `min_atr_pct`: 0.06 → 0.04
- `max_spread_bps`: 20 → 24
- `confidence_threshold`: 0.52 → 0.48

## Files Modified

1. **`backend/quantailabs_patch/config.yaml`** - Main YAML configuration
2. **`backend/src/quantai/config.ts`** - TypeScript default configuration
3. **`backend/quantailabs_patch/strategy/filters.py`** - Python filter defaults
4. **`backend/quantailabs_patch/tests/test_filter_improvements.py`** - Updated tests

## Expected Impact

### Before Changes:
- **0% trade entries** - All opportunities blocked
- System too conservative for real crypto market conditions
- Critical dollar volume typo blocking all pairs

### After Changes:
- **Significantly more entry opportunities** while maintaining quality
- Better adapted to crypto market volatility patterns
- Accepts consolidation/ranging periods (common in crypto)
- Strategy optimizer can still fine-tune from these more reasonable baselines

## Validation

✅ Python filter defaults verified (min_adx=12.0, min_dollar_volume=150000.0, confidence_threshold=0.50)
✅ TypeScript config syntax validated
✅ YAML config matches TypeScript defaults
✅ Test cases updated to reflect new thresholds

## Recommendations

1. **Monitor trade frequency** after deployment - should see meaningful increase
2. **Let strategy optimizer run** - it will fine-tune from these baselines
3. **Watch win rate** - should remain acceptable (40%+) while capturing more setups
4. **Consider further tweaks** based on actual performance data

## Philosophy

These changes follow the log analysis recommendations:
- **Fix critical errors** (50M dollar volume typo)
- **Accept crypto reality** (ranging markets, volatility cycles, spread variations)
- **Balance risk and opportunity** (lower thresholds but not reckless)
- **Trust the optimizer** (provide reasonable defaults, let ML tune further)

The goal is **not to maximize trades**, but to **stop rejecting reasonable opportunities** that the system was previously missing due to overly conservative settings.
