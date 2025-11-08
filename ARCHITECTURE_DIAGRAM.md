# Strategy Optimizer Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          TRADING SYSTEM DATA COLLECTION                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ Trades executed by agents
                                      ↓
                        ┌──────────────────────────┐
                        │   TradeEvaluation DB     │
                        │                          │
                        │  • Input metrics (ADX,   │
                        │    trend, CMF, etc)      │
                        │  • Market outcomes       │
                        │    (PnL, duration, etc)  │
                        │  • Regime context        │
                        └──────────────────────────┘
                                      │
                                      │ Min 50+ evaluations per symbol
                                      │ Min 20+ per regime
                                      ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                        STRATEGY OPTIMIZER (3 WAYS TO RUN)                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────┐      ┌────────────────┐      ┌────────────────┐       │
│  │   SCHEDULER    │      │   CLI SCRIPT   │      │  FRONTEND UI   │       │
│  │  (Daily 2 AM)  │      │    (Manual)    │      │ (On-demand)    │       │
│  └────────┬───────┘      └────────┬───────┘      └────────┬───────┘       │
│           │                       │                       │                 │
│           └───────────────────────┴───────────────────────┘                 │
│                                   │                                         │
│                                   ↓                                         │
│                   ┌────────────────────────────────┐                        │
│                   │  optimizeAllSymbols()          │                        │
│                   │  (Always regime-aware)         │                        │
│                   └────────────────────────────────┘                        │
│                                   │                                         │
│                                   ↓                                         │
│         ┌─────────────────────────────────────────────────┐                │
│         │      FOR EACH SYMBOL WITH SUFFICIENT DATA       │                │
│         └─────────────────────────────────────────────────┘                │
│                                   │                                         │
│                                   ↓                                         │
│         ┌─────────────────────────────────────────────────┐                │
│         │   SPLIT DATA BY REGIME                          │                │
│         │   • Volatility: low/medium/high                 │                │
│         │   • Direction: long/short/neutral               │                │
│         │   • Volume: low/normal/high                     │                │
│         │   • Market: trending/ranging                    │                │
│         └─────────────────────────────────────────────────┘                │
│                                   │                                         │
│                                   ↓                                         │
│         ┌─────────────────────────────────────────────────┐                │
│         │   GRID SEARCH PER REGIME                        │                │
│         │   Test parameter combinations:                  │                │
│         │   • Weights: ADX, strength, alignment, etc      │                │
│         │   • Thresholds: ADX, trend, confidence          │                │
│         │   Maximize: Sharpe × 0.5 + WinRate × 0.3 +     │                │
│         │              TotalPnL × 0.2                     │                │
│         └─────────────────────────────────────────────────┘                │
│                                   │                                         │
│                                   ↓                                         │
│         ┌─────────────────────────────────────────────────┐                │
│         │   SAVE REGIME-AWARE PARAMETERS                  │                │
│         │   {                                             │                │
│         │     default: {...},                             │                │
│         │     low_volatility: {...},                      │                │
│         │     high_volatility: {...},                     │                │
│         │     long_bias: {...},                           │                │
│         │     short_bias: {...},                          │                │
│         │     trending: {...},                            │                │
│         │     ranging: {...}                              │                │
│         │   }                                             │                │
│         └─────────────────────────────────────────────────┘                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ↓
                        ┌──────────────────────────┐
                        │ CryptoPersonalityProfile │
                        │         (Database)       │
                        │                          │
                        │  Per-symbol regime-aware │
                        │  optimized parameters    │
                        └──────────────────────────┘
                                      │
                                      │ Strategies load parameters
                                      ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                        STRATEGY EXECUTION (RUNTIME)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────┐               │
│  │  1. Detect current market regime                        │               │
│  │     • Calculate ATR% → volatility regime                │               │
│  │     • Compare EMA20/EMA50 → direction bias              │               │
│  │     • Check volume/MA → volume regime                   │               │
│  │     • Analyze ADX/ATR → trending vs ranging             │               │
│  └─────────────────────────────────────────────────────────┘               │
│                             ↓                                                │
│  ┌─────────────────────────────────────────────────────────┐               │
│  │  2. Load personality profile                            │               │
│  │     getPersonalityProfile(symbol, {                     │               │
│  │       volatilityRegime: 'high',                         │               │
│  │       directionBias: 'long',                            │               │
│  │       volumeRegime: 'normal',                           │               │
│  │       trendingRanging: 'trending'                       │               │
│  │     })                                                   │               │
│  └─────────────────────────────────────────────────────────┘               │
│                             ↓                                                │
│  ┌─────────────────────────────────────────────────────────┐               │
│  │  3. Select best matching parameters                     │               │
│  │     Priority:                                            │               │
│  │     1. Volatility regime (most important)               │               │
│  │     2. Volume regime                                     │               │
│  │     3. Trending/ranging                                  │               │
│  │     4. Direction bias                                    │               │
│  │     5. Default (fallback)                                │               │
│  └─────────────────────────────────────────────────────────┘               │
│                             ↓                                                │
│  ┌─────────────────────────────────────────────────────────┐               │
│  │  4. Calculate confidence score using regime params      │               │
│  │     score = adxScore × weights.adx +                    │               │
│  │             strengthScore × weights.strength +          │               │
│  │             alignmentScore × weights.alignment +        │               │
│  │             slopeScore × weights.slope +                │               │
│  │             flowScore × weights.flow                    │               │
│  └─────────────────────────────────────────────────────────┘               │
│                             ↓                                                │
│  ┌─────────────────────────────────────────────────────────┐               │
│  │  5. Apply thresholds from regime params                 │               │
│  │     if (adx >= thresholds.adx &&                        │               │
│  │         trendStrength >= thresholds.trendStrength &&    │               │
│  │         confidence >= thresholds.minConfidence) {       │               │
│  │       EXECUTE TRADE                                      │               │
│  │     }                                                    │               │
│  └─────────────────────────────────────────────────────────┘               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ↓
                            ┌─────────────────┐
                            │  Trade Executed │
                            │  with regime-   │
                            │  optimized      │
                            │  parameters     │
                            └─────────────────┘
                                      │
                                      ↓
                    New trade evaluation recorded
                    Loop continues...
```

## Key Points

### 1. Data Collection Phase
- Agents execute trades
- System records input metrics and outcomes
- Minimum 50 evaluations per symbol needed

### 2. Optimization Phase (Three Triggers)
- **Scheduled**: Runs daily at 2 AM automatically
- **Manual CLI**: User runs script anytime
- **UI**: User clicks button in dashboard

### 3. Processing Steps
1. Split historical data by regime (volatility, direction, volume, market structure)
2. Run grid search on each regime independently
3. Find optimal weights and thresholds per regime
4. Save complete regime-aware parameter set to database

### 4. Runtime Application
1. Strategy detects current market regime
2. Loads personality profile for symbol
3. Selects best matching regime parameters
4. Uses those parameters for confidence calculation and thresholds
5. Executes trade if conditions met

### 5. Continuous Improvement
- New trades create more evaluation data
- Optimizer runs periodically
- Parameters continuously refined
- System adapts to changing market conditions

## Benefits of This Architecture

✅ **Automatic**: Scheduled optimization keeps parameters up-to-date
✅ **Adaptive**: Different parameters for different market conditions
✅ **Transparent**: Strategies use optimized parameters automatically
✅ **Robust**: Falls back to default if specific regime not optimized
✅ **Scalable**: Works across any number of symbols
✅ **Measurable**: Tracks performance metrics per regime

## Example Regime Selection

```
Current Market:
- ATR%: 5.2% → HIGH volatility
- EMA20: 45,500, EMA50: 44,800 → LONG bias
- Volume: 1.3x MA → HIGH volume
- ADX: 28 → TRENDING

Loaded Parameters:
1. Try high_volatility → ✅ Found
   Uses: high_volatility parameters
   
Fallback chain if not found:
2. Try high_volume
3. Try trending
4. Try long_bias
5. Use default
```

This ensures optimal performance across all market conditions!
