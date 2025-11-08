# Strategy Optimizer and Symbol Profile Guide

## Overview

This guide explains how to run the strategy optimizer and build symbol profiles for your trading agents. These features use historical trade evaluation data to optimize parameters for each symbol.

## What Gets Optimized

### 1. Strategy Parameters (via Strategy Optimizer)
- **Weight adjustments** for ADX, trend strength, alignment, slope, and flow
- **Threshold values** for ADX, trend strength, and minimum confidence
- **Regime-aware parameters** for different market conditions:
  - Low/medium/high volatility
  - Long/short bias
  - Low/normal/high volume
  - Trending/ranging markets

### 2. Symbol Profiles (via Symbol-Specific Optimization)
- **Custom thresholds** optimized per symbol based on historical performance
- **Performance metrics**: win rate, Sharpe ratio, profit factor, average PnL
- **Market characteristics**: average volatility, spread, volume, dominant regime
- **Tier classification**: A/B/C tier based on symbol characteristics

## Prerequisites

Before running the optimizer, you need:

1. **Trade evaluation data**: At least 50-100 trade evaluations per symbol
2. **Market outcome data**: Evaluations must have `marketOutcome` populated (this happens automatically over time)
3. **Database access**: A working PostgreSQL connection

## How to Run

### Option 1: Via Frontend (UI)

1. Navigate to the **Operations Dashboard** page
2. Scroll to the **Strategy Optimization** card
3. Choose optimization mode:
   - ✅ **Regime-Aware Optimization**: Optimizes parameters per market regime (recommended)
   - ⬜ **Standard Optimization**: Single parameter set per symbol
4. Click **"Optimize All Symbols with Sufficient Data"**
5. Wait for completion (this may take 2-10 minutes depending on data volume)
6. Check the success message for results

### Option 2: Via API Endpoint

```bash
# Optimize all symbols (regime-aware)
curl -X POST http://localhost:4000/api/strategy/optimize-all \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"regimeAware": true}'

# Optimize specific symbol
curl -X POST http://localhost:4000/api/strategy/optimize-symbol \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"symbol": "BTCUSDT", "regimeAware": true}'

# Build symbol profiles
curl -X POST http://localhost:4000/api/strategy/build-symbol-profiles \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"lookbackDays": 30}'

# Get symbol profile
curl -X GET http://localhost:4000/api/strategy/symbol-profile/BTCUSDT \
  -H "x-api-key: YOUR_API_KEY"

# Get all symbol profiles
curl -X GET http://localhost:4000/api/strategy/symbol-profiles \
  -H "x-api-key: YOUR_API_KEY"
```

### Option 3: Via Command-Line Script

```bash
# From the backend directory
cd backend

# Run the comprehensive manual script
npm run tsx scripts/run-optimizer-manual.ts

# Or use the test script
npm run tsx scripts/test-optimizer.ts
```

## Understanding the Results

### Strategy Optimizer Output

```json
{
  "success": true,
  "count": 5,
  "symbols": ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"],
  "regimeAware": true,
  "message": "Successfully optimized regime-aware parameters for 5 symbols"
}
```

### Symbol Profile Output

```json
{
  "symbol": "BTCUSDT",
  "tier": "A",
  "customThresholds": {
    "confidence": 0.55,
    "atr": 0.012,
    "adx": 18,
    "eligibility": 0.75,
    "rrMin": 1.8
  },
  "performanceMetrics": {
    "totalTrades": 156,
    "winRate": 0.58,
    "avgPnlPct": 0.42,
    "sharpeRatio": 1.25,
    "profitFactor": 1.85,
    "lastUpdated": 1699564800000
  },
  "optimizationStatus": "optimized",
  "lastOptimizedAt": 1699564800000
}
```

## Minimum Data Requirements

| Optimization Type | Minimum Samples | Recommended Samples |
|------------------|-----------------|---------------------|
| Standard | 50 per symbol | 100+ per symbol |
| Regime-Aware | 20 per regime | 50+ per regime |
| Symbol Profile | 10 trades | 30+ trades |

## Troubleshooting

### "No symbols were optimized"

**Cause**: Insufficient data or low-quality signals

**Solution**:
1. Check how much data you have: `SELECT symbol, COUNT(*) FROM "TradeEvaluation" WHERE "marketOutcome" IS NOT NULL GROUP BY symbol;`
2. Run the system longer to collect more data
3. Verify that market outcomes are being recorded

### "Insufficient data for [SYMBOL]"

**Cause**: Symbol doesn't have enough trade evaluations

**Solution**:
- Wait for more trades to be evaluated
- Reduce `MIN_REGIME_SAMPLES` if needed (currently 20)
- Check if the symbol is actively being traded

### Frontend button not responding

**Possible causes**:
1. **Authentication issue**: Check that your API key is valid
2. **CORS issue**: Verify backend allows your frontend origin
3. **Network issue**: Check browser console for errors
4. **Backend not running**: Ensure backend server is running on port 4000

**Debug steps**:
1. Open browser developer console (F12)
2. Click the "Optimize All" button
3. Look for console logs starting with 🚀
4. Check Network tab for the API call to `/api/strategy/optimize-all`
5. Review any error messages

### Low Sharpe ratio prevents optimization

**Cause**: Symbol profile requires `MIN_SHARPE_FOR_OPTIMIZATION` (default 0.3)

**Solution**:
- Set environment variable: `MIN_SHARPE_FOR_OPTIMIZATION=0.1` (lower threshold)
- Or accept that the symbol may not have profitable patterns yet

## Database Schema

### symbol_profiles table
```sql
CREATE TABLE symbol_profiles (
  symbol TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  custom_thresholds JSONB,
  performance_metrics JSONB,
  market_characteristics JSONB,
  optimization_status TEXT DEFAULT 'initial',
  last_optimized_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### CryptoPersonalityProfile table (Prisma model)
```typescript
model CryptoPersonalityProfile {
  symbol        String   @id
  optimalParams Json
  updatedAt     DateTime @updatedAt
  createdAt     DateTime @default(now())
}
```

## Scheduled Automation

The optimizer can run automatically:

1. **Strategy Optimizer Job**: Runs daily at 2 AM (configurable)
   - Defined in: `backend/src/learning/optimizerJob.ts`
   - Trigger: `scheduleNextOptimizerJob()`

2. **Symbol Optimization Scheduler**: Runs every 24 hours
   - Defined in: `backend/src/services/symbolSpecificOptimization.ts`
   - Trigger: `startSymbolOptimizationScheduler(24)`

## Best Practices

1. **Run regularly**: Weekly or after collecting significant new data
2. **Monitor results**: Check the optimization logs for warnings
3. **Review profiles**: Use `GET /api/strategy/symbol-profiles` to review
4. **Adjust parameters**: Tune `MIN_SHARPE_FOR_OPTIMIZATION` based on your risk tolerance
5. **Backup data**: Keep backups of personality profiles before re-optimizing

## Related Files

- `backend/src/learning/strategyOptimizer.ts` - Main optimizer logic
- `backend/src/services/symbolSpecificOptimization.ts` - Symbol profile builder
- `backend/src/routes/strategy.ts` - API endpoints
- `backend/scripts/run-optimizer-manual.ts` - Manual run script
- `frontend/src/pages/OperationsDashboardPage.tsx` - UI component

## Support

If you encounter issues:
1. Check backend logs for detailed error messages
2. Run the manual script for verbose output
3. Verify database connectivity
4. Ensure sufficient trade evaluation data exists
