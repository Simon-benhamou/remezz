# Advanced Risk Manager

## Overview

The `AdvancedRiskManager` provides real-time risk management capabilities designed to protect against unmanaged market events including flash crashes, extreme volatility, low liquidity traps, and catastrophic drawdowns.

## Key Features

### 1. Hard Drawdown Halt
- **Threshold**: 20% drawdown (configurable via `ADV_RISK_HARD_HALT_DRAWDOWN_PCT`)
- **Action**: Complete halt of new positions when triggered
- **Purpose**: Prevents catastrophic losses during severe drawdown cascades

### 2. Flash Crash Detection
- **Detection Window**: 15 minutes (configurable via `ADV_RISK_FLASH_CRASH_MINUTES`)
- **Threshold**: 8% price drop (configurable via `ADV_RISK_FLASH_CRASH_THRESHOLD_PCT`)
- **Action**: Immediate halt of new positions
- **Purpose**: Faster detection than black swan for rapid crashes

### 3. Continuous Liquidity Monitoring
- **Threshold**: $1M 24h volume (configurable via `ADV_RISK_MIN_LIQUIDITY_THRESHOLD`)
- **Action**: 50% position size reduction when liquidity drops
- **Purpose**: Protects against liquidity traps during position holding

### 4. Enhanced Extreme Volatility Detection
- **Levels**: Low, Medium, High, Extreme
- **Action**: Aggressive position size reduction (up to 65% reduction)
- **Purpose**: Tightens sizing during volatility spikes

## Usage Example

```typescript
import { AdvancedRiskManager, DEFAULT_ADVANCED_RISK_CONFIG } from './risk/advancedRiskManager.js';
import { CircuitBreaker } from './quantai/risk/circuitBreaker.js';

// Initialize the risk manager
const riskManager = new AdvancedRiskManager({
  ...DEFAULT_ADVANCED_RISK_CONFIG,
  hardDrawdownHaltPct: 20,  // Hard halt at 20% drawdown
  flashCrashThresholdPct: 8, // Detect 8% drops
  minLiquidityThreshold: 1000000, // $1M minimum volume
});

// Check risk before opening a position
async function evaluateTradeRisk(
  sessionId: string,
  symbol: string,
  currentEquity: number,
  circuitBreaker?: CircuitBreaker,
  technicalSnapshot?: TechnicalSnapshot
) {
  const decision = await riskManager.checkRisk({
    sessionId,
    symbol,
    currentEquity,
    circuitBreaker,
    technicalSnapshot,
  });

  if (!decision.allowed) {
    console.log(`❌ Trade blocked: ${decision.reason}`);
    if (decision.hardHaltTriggered) {
      console.error(`🚨 HARD HALT: Critical threshold exceeded`);
      // Alert administrators
    }
    return null;
  }

  // Apply size multiplier
  const basePositionSize = calculateBaseSize();
  const adjustedSize = basePositionSize * decision.sizeMultiplier;
  
  console.log(`✅ Trade allowed with ${(decision.sizeMultiplier * 100).toFixed(0)}% sizing`);
  
  return adjustedSize;
}

// Monitor position during holding
async function monitorPositionRisk(symbol: string) {
  // Check for flash crashes
  const flashCrash = await riskManager.detectFlashCrash(symbol);
  if (flashCrash.detected) {
    console.error(`🚨 Flash crash detected: ${flashCrash.reason}`);
    // Consider immediate exit
    return { action: 'EXIT_IMMEDIATELY', reason: 'flash_crash' };
  }

  // Check liquidity
  const liquidity = await riskManager.checkLiquidity(symbol);
  if (!liquidity.adequate) {
    console.warn(`⚠️ Low liquidity: ${liquidity.reason}`);
    // Consider reducing position or preparing to exit
    return { action: 'REDUCE_SIZE', reason: 'low_liquidity' };
  }

  return { action: 'HOLD', reason: 'risk_acceptable' };
}
```

## Configuration

All thresholds are configurable via environment variables:

```bash
# Drawdown controls
ADV_RISK_MAX_DRAWDOWN_PCT=10                  # Start reducing size
ADV_RISK_HARD_HALT_DRAWDOWN_PCT=20            # Complete halt
ADV_RISK_DRAWDOWN_RECOVERY_PCT=5              # Recovery threshold

# Flash crash detection
ADV_RISK_FLASH_CRASH_MINUTES=15               # Detection window
ADV_RISK_FLASH_CRASH_THRESHOLD_PCT=8          # Drop percentage

# Catastrophic loss
ADV_RISK_CATASTROPHIC_DAILY_LOSS_PCT=5        # Daily loss threshold

# Black swan detection
ADV_RISK_BLACK_SWAN_VOL_THRESHOLD=15          # Volatility threshold
ADV_RISK_BLACK_SWAN_LOOKBACK_MIN=60           # Lookback window

# Regime-aware sizing
ADV_RISK_ENABLE_REGIME_SIZING=true            # Enable/disable
ADV_RISK_LOW_VOL_MULTIPLIER=1.2               # Low volatility bonus
ADV_RISK_HIGH_VOL_MULTIPLIER=0.6              # High volatility reduction
ADV_RISK_EXTREME_VOL_MULTIPLIER=0.35          # Extreme volatility reduction

# Liquidity monitoring
ADV_RISK_CONTINUOUS_LIQUIDITY_CHECK=true      # Enable/disable
ADV_RISK_MIN_LIQUIDITY_THRESHOLD=1000000      # Minimum volume USD
```

## Integration with Market Regime Detector

The risk manager integrates with `marketRegimeDetector.ts` for real-time volatility monitoring:

```typescript
import { isExtremeVolatilityDetected } from './quantai/regime/marketRegimeDetector.js';

// Quick volatility check during position monitoring
const volatilityCheck = isExtremeVolatilityDetected({
  atr15mPct: 4.5,
  atr1h: 4.2,
  realizedVol: 7.0,
  isMajor: false,
});

if (volatilityCheck.extreme) {
  console.warn(`⚠️ Extreme volatility: ${volatilityCheck.reason}`);
  // Consider tightening stops or reducing position
}
```

## Decision Flow

```
Trade Request
    ↓
Circuit Breaker Check
    ↓
Flash Crash Detection (15min window)
    ↓
Catastrophic Daily Loss Check
    ↓
Black Swan Detection (60min window)
    ↓
Drawdown Calculation
    ↓
Hard Halt Check (20% threshold)
    ↓
Liquidity Check (volume monitoring)
    ↓
Regime-Aware Sizing
    ↓
Final Size Multiplier Applied
    ↓
Trade Execution or Rejection
```

## Risk Levels and Actions

| Condition | Size Multiplier | Action |
|-----------|----------------|--------|
| Normal | 1.0x | Full size allowed |
| Low Liquidity | 0.5x | Reduce size by 50% |
| Drawdown 10-20% | 0.25-0.5x | Progressive reduction |
| Drawdown >20% | 0x | **HARD HALT** |
| Flash Crash | 0x | **IMMEDIATE HALT** |
| Extreme Volatility | 0.35x | Aggressive reduction |
| High Volatility | 0.6x | Moderate reduction |
| Low Volatility | 1.2x | Size bonus |

## Monitoring and Alerts

The risk manager logs critical events:

- `🚨 HARD HALT`: Critical drawdown exceeded
- `🚨 Flash crash detected`: Rapid price drop
- `⚠️ Low liquidity detected`: Volume below threshold
- `⚠️ EXTREME VOLATILITY detected`: Market turbulence
- `⚠️ Reducing position size`: Multiple risk factors

These logs should be monitored and integrated with alerting systems for immediate response.

## Testing

See `backend/src/risk/__tests__/advancedRiskManager.test.ts` for comprehensive test coverage.

## Related Documentation

- [Symbol Rejection Reasons](../../docs/SYMBOL_REJECTION_REASONS.md)
- [Circuit Breaker Implementation](../quantai/risk/circuitBreaker.ts)
- [Market Regime Detection](../quantai/regime/marketRegimeDetector.ts)
