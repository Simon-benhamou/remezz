# Auto-Re-Optimization Scheduler

## Overview

The Auto-Re-Optimization Scheduler is a critical feature that automatically re-optimizes trading strategy parameters on a configurable schedule. This helps prevent model degradation by ensuring that parameters remain relevant as market conditions evolve.

## Features

- **Per-Symbol Scheduling**: Configure different re-optimization schedules for different trading symbols
- **Multiple Schedule Types**: Support for daily, weekly, and custom interval schedules
- **Configurable via YAML**: Easy configuration through the existing config file
- **Comprehensive Logging**: Track when jobs are scheduled, started, and completed
- **Automatic Rescheduling**: Jobs automatically reschedule themselves after completion
- **Manual Triggering**: Ability to manually trigger re-optimization for any symbol

## Architecture

The scheduler consists of several key components:

1. **Configuration System**: Reads schedule definitions from `config.yaml`
2. **Job Handler**: Executes re-optimization for individual symbols
3. **Schedule Calculator**: Determines next run times based on schedule configuration
4. **Scheduler Integration**: Leverages the existing `schedulerJobService` for job management

## Configuration

### Config File Structure

Add the following section to `backend/quantailabs_patch/config.yaml`:

```yaml
reoptimization:
  # Default schedule for all symbols (if not specified individually)
  default_schedule:
    enabled: true
    frequency: 'daily'     # 'daily', 'weekly', or 'custom'
    run_hour: 2            # Hour of day (0-23) for daily schedules
    run_day: 0             # Day of week (0=Sunday) for weekly schedules
    interval_hours: null   # Custom interval in hours (overrides daily/weekly)
  
  # Symbol-specific schedules (override default)
  symbol_schedules:
    BTC/USDT:
      enabled: true
      frequency: 'daily'
      run_hour: 1
    ETH/USDT:
      enabled: true
      frequency: 'daily'
      run_hour: 1
    SOL/USDT:
      enabled: true
      frequency: 'weekly'
      run_day: 1          # Monday
      run_hour: 2
```

### Schedule Frequencies

#### Daily Schedule
Re-optimizes at a specific hour every day.

```yaml
BTC/USDT:
  enabled: true
  frequency: 'daily'
  run_hour: 2  # Runs at 2:00 AM every day
```

#### Weekly Schedule
Re-optimizes on a specific day of the week at a specific hour.

```yaml
SOL/USDT:
  enabled: true
  frequency: 'weekly'
  run_day: 1   # 0=Sunday, 1=Monday, ..., 6=Saturday
  run_hour: 2  # Runs at 2:00 AM
```

#### Custom Interval
Re-optimizes at regular intervals (in hours).

```yaml
ETH/USDT:
  enabled: true
  frequency: 'custom'
  interval_hours: 72  # Runs every 72 hours (3 days)
```

## Usage

### Automatic Initialization

The scheduler is automatically initialized when the server starts:

```typescript
import { initializeReoptimizationScheduling } from './learning/reoptimizationScheduler.js';

// Called in server.ts
await initializeReoptimizationScheduling();
```

### Manual Triggering

To manually trigger re-optimization for a symbol:

```typescript
import { triggerSymbolReoptimization } from './learning/reoptimizationScheduler.js';

// Trigger immediate re-optimization for BTC/USDT
await triggerSymbolReoptimization('BTC/USDT');
```

### Scheduling a Symbol Programmatically

```typescript
import { scheduleSymbolReoptimization } from './learning/reoptimizationScheduler.js';

const config = {
  enabled: true,
  frequency: 'daily',
  run_hour: 3
};

await scheduleSymbolReoptimization('BTC/USDT', config);
```

## Logging

The scheduler provides comprehensive logging at each stage:

### When Scheduling
```
📅 Scheduled re-optimization for BTC/USDT (daily at 1:00) at 2025-11-09T01:00:00.000Z
```

### When Starting
```
🔄 Starting re-optimization for BTC/USDT...
```

### On Success
```
✅ Re-optimization completed successfully for BTC/USDT
```

### On Insufficient Data
```
⚠️ Re-optimization for BTC/USDT did not produce new parameters (insufficient data)
```

### On Failure
```
❌ Re-optimization failed for BTC/USDT: [error details]
```

## How It Works

1. **Initialization**: On server start, the scheduler reads the configuration and schedules initial jobs for all configured symbols.

2. **Job Execution**: When a job's scheduled time arrives:
   - The scheduler worker picks up the job
   - Runs `optimizeSymbolParameters()` for the specific symbol
   - If successful, saves the new optimal parameters
   - Automatically schedules the next run based on the frequency

3. **Next Run Calculation**:
   - **Daily**: Schedules for the next day at the configured hour
   - **Weekly**: Schedules for the next occurrence of the configured day and hour
   - **Custom**: Schedules after the configured interval from now

## Database Schema

The scheduler uses the existing `SchedulerJob` model:

```prisma
model SchedulerJob {
  id        String   @id @default(cuid())
  type      String   // 'symbol_reoptimization' for this scheduler
  payload   Json?    // Contains {symbol, scheduleConfig}
  runAt     DateTime
  status    String   @default("pending")
  // ... other fields
}
```

## Integration with Existing System

The auto-re-optimization scheduler complements the existing daily optimizer job (`optimizerJob.ts`):

- **Existing Job**: Optimizes all symbols once per day at a fixed time (2 AM)
- **New Scheduler**: Provides fine-grained control per symbol with flexible schedules

Both can coexist, or you can disable the old job if you prefer per-symbol control.

## Best Practices

1. **Stagger Schedules**: Don't schedule all symbols at the same time to avoid resource contention
   ```yaml
   BTC/USDT:
     run_hour: 1
   ETH/USDT:
     run_hour: 2
   SOL/USDT:
     run_hour: 3
   ```

2. **Consider Trading Volume**: High-volume symbols may benefit from more frequent re-optimization
   ```yaml
   BTC/USDT:
     frequency: 'daily'  # High volume, optimize daily
   EXOTIC/USDT:
     frequency: 'weekly'  # Low volume, optimize weekly
   ```

3. **Monitor Logs**: Regularly check logs to ensure re-optimization is completing successfully

4. **Sufficient Data**: Ensure symbols have sufficient historical data (at least 50 evaluations) for meaningful optimization

## Testing

Run the unit tests to verify the scheduler:

```bash
cd backend
npm run build
node test/unit/reoptimization-scheduler.mjs
```

## Troubleshooting

### Scheduler Not Starting
- Check that `config.yaml` has a valid `reoptimization` section
- Verify the config file path is correct
- Check server logs for initialization errors

### Jobs Not Running
- Ensure the scheduler worker is started (`startSchedulerWorker()` in server.ts)
- Check database for pending jobs: `SELECT * FROM SchedulerJob WHERE type='symbol_reoptimization'`
- Verify job handler is registered: look for "📋 Registered symbol re-optimization job handler" in logs

### Re-optimization Producing No Results
- Ensure the symbol has sufficient historical trade evaluations (minimum 50)
- Check that market data is being collected for the symbol
- Review logs for specific error messages

## Future Enhancements

Potential improvements for future versions:

- **Adaptive Scheduling**: Automatically adjust frequency based on market volatility
- **Performance-Based Triggers**: Re-optimize when strategy performance degrades
- **Multi-Strategy Support**: Different schedules for different strategy types
- **Notification System**: Alert administrators when re-optimization completes or fails
- **Web UI**: Interface for configuring schedules without editing YAML
