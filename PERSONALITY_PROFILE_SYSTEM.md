# Crypto Personality Profile System

## Overview

The Crypto Personality Profile System is a self-learning trading strategy enhancement that evolves from static, rule-based parameters to dynamic, data-driven optimization for each traded cryptocurrency.

## Architecture

The system consists of three main components:

### 1. Performance Logging Service (The "Memory")

**Purpose**: Records every trade evaluation decision and market context for future analysis.

**Database Schema**: `TradeEvaluation`
- `id`: Unique identifier
- `symbol`: Trading symbol (e.g., "BTC/USDT")
- `timestamp`: When the evaluation occurred
- `decision`: "executed" or "blocked"
- `blockedReason`: Why the trade was blocked (if applicable)
- `confidenceScore`: The computed confidence score
- `inputMetrics`: JSON snapshot of all indicators (ADX, CMF, ATR%, slope, trend strength, etc.)
- `marketOutcome`: JSON with PnL metrics (updated later)
  - `pnl_15m`: 15-minute PnL percentage
  - `pnl_1h`: 1-hour PnL percentage
  - `max_favorable_excursion_1h`: Best price movement within 1 hour
  - `max_adverse_excursion_1h`: Worst price movement within 1 hour

**Implementation**: 
- `src/learning/tradeEvaluationLogger.ts`: Logging service
- `src/learning/outcomeUpdater.ts`: Worker that updates market outcomes after waiting period

**Integration**: 
- The `computeTrendConfidence` function in `core.ts` logs every evaluation
- The outcome updater runs every 5 minutes to update pending evaluations

### 2. Strategy Optimizer Service (The "Brain")

**Purpose**: Analyzes historical trade evaluations to find optimal parameters for each symbol.

**Database Schema**: `CryptoPersonalityProfile`
- `symbol`: Trading symbol (Primary Key)
- `optimalParams`: JSON containing learned parameters
  - `weights`: Component weights for confidence calculation
    - `adx`, `strength`, `alignment`, `slope`, `flow`
  - `thresholds`: Entry criteria thresholds
    - `adx`, `trendStrength`, `minConfidence`
- `updatedAt`: Last optimization timestamp

**Optimization Algorithm**: Grid Search
- Tests all combinations of parameters from predefined ranges
- Evaluates each combination using historical data
- Calculates fitness score based on:
  - Sharpe ratio (risk-adjusted returns)
  - Win rate
  - Total PnL
- Selects the best-performing combination

**Implementation**:
- `src/learning/personalityProfile.ts`: Profile management
- `src/learning/strategyOptimizer.ts`: Grid search optimization
- `src/learning/optimizerJob.ts`: Scheduled job handler

**Scheduling**: 
- Runs nightly at 2 AM by default
- Can be triggered manually via the scheduler API
- Prunes old evaluations (90+ days) before optimization

### 3. Live Integration (The "Action")

**Purpose**: Uses learned profiles in real-time trading decisions with intelligent fallback.

**Integration Point**: `computeTrendConfidence` function in `core.ts`

**Behavior**:
1. Fetches the personality profile for the symbol
2. If profile exists: Uses learned parameters
3. If no profile: Falls back to default parameters
4. Logs the evaluation for future learning

**Default Parameters** (fallback):
```javascript
weights: {
  adx: 0.3,
  strength: 0.3,
  alignment: 0.2,
  slope: 0.1,
  flow: 0.1
},
thresholds: {
  adx: 18,
  trendStrength: 0.25,
  minConfidence: 0.45
}
```

## Data Flow

```
1. Trade Evaluation
   └─> computeTrendConfidence()
       ├─> Fetch personality profile (if exists)
       ├─> Calculate confidence with learned/default params
       └─> Log evaluation to TradeEvaluation table

2. Outcome Collection (after 1 hour)
   └─> Outcome Updater Worker
       ├─> Fetch pending evaluations
       ├─> Get market data for outcome period
       ├─> Calculate PnL and excursions
       └─> Update TradeEvaluation.marketOutcome

3. Optimization (nightly)
   └─> Strategy Optimizer
       ├─> For each symbol with data:
       │   ├─> Fetch historical evaluations
       │   ├─> Run grid search
       │   ├─> Find best parameters
       │   └─> Save to CryptoPersonalityProfile
       └─> Prune old evaluations
```

## Environment Variables

- `OUTCOME_UPDATER_DISABLED`: Set to 'true' to disable the outcome updater worker
- `SYMBOL_OPTIMIZATION_DISABLED`: Set to 'true' to disable the optimizer scheduler

## API Endpoints

The system integrates with existing scheduler endpoints:
- `GET /api/ops/scheduler/jobs`: View scheduled optimization jobs
- `POST /api/ops/scheduler/jobs/:id/replay`: Manually trigger optimization

## Testing

Unit tests are provided for the core services:
- `test/unit/personality-profile.mjs`: Tests profile management
- `test/unit/strategy-optimizer.mjs`: Tests optimizer imports

Run tests with:
```bash
npm run test:unit
```

## Database Migration

To apply the schema changes:
```bash
npm run migrate
```

Or manually apply: `prisma/migrations/20251107_personality_profile/migration.sql`

## Performance Considerations

- **Logging**: Non-blocking, failures don't affect trading decisions
- **Outcome Updates**: Batched processing (50 evaluations per run)
- **Optimization**: Resource-intensive, runs during off-peak hours
- **Grid Search**: Tests hundreds of combinations, requires sufficient historical data (50+ evaluations minimum)

## Future Enhancements

Possible improvements mentioned in the original spec:
1. **Market Regime Detection**: Different parameters for bull/bear/choppy markets
2. **Advanced Optimization**: Replace grid search with Bayesian optimization or genetic algorithms
3. **Real-time Adaptation**: Update profiles more frequently based on recent performance
4. **Multi-timeframe Profiles**: Optimize for different trading timeframes
5. **Symbol Clustering**: Group similar assets and share learned parameters

## Monitoring

Watch for these log messages:
- `📊 Processing X pending outcome updates...`: Outcome updater running
- `🔍 Optimizing parameters for SYMBOL...`: Optimization in progress
- `✅ SYMBOL: Tested X combinations, best fitness: Y`: Optimization complete
- `Failed to log trade evaluation`: Non-critical logging failure
- `⚠️ Insufficient data for SYMBOL`: Not enough evaluations to optimize

## Troubleshooting

**No profiles being created**:
- Check if trades are being executed
- Verify outcome updater is running (not disabled)
- Ensure optimizer job is scheduled
- Check for sufficient historical data (50+ evaluations)

**Poor optimization results**:
- Increase historical data collection period
- Verify market outcome data is accurate
- Check grid search parameter ranges
- Consider expanding fitness function metrics

**Performance issues**:
- Reduce grid search parameter ranges
- Increase optimization interval
- Batch process symbols instead of all at once
- Add indexes to TradeEvaluation table
