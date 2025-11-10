# Position Flipping Feature

## Overview

The position flipping feature allows trading agents to seamlessly reverse their position direction when a strong counter-signal is detected. Instead of exiting a long position and remaining sidelined, the agent can immediately enter a short position (or vice versa) to capture both sides of major market moves.

## Safety Features

To prevent overtrading and ensure good ROI, the feature implements multiple safety mechanisms:

### 1. Cooldown Mechanisms

- **Time-based cooldown**: Default 30 minutes between flips
- **Count-based cooldown**: Maximum 3 flips per hour by default

These cooldowns ensure that flips only occur when market conditions genuinely warrant a position reversal, not due to noisy signals.

### 2. Signal Quality Requirements

- **Minimum confidence**: 70% confidence required on the counter-signal
- **Minimum profit**: Position must be at least 2R profitable before flip

These requirements ensure that flips only occur when:
1. The new signal is very strong (70%+ confidence)
2. The current position has already captured significant profit (2R+)

### 3. Feature Flag

Position flipping is **DISABLED by default**. It must be explicitly enabled in the configuration to activate.

## Configuration

Position flipping is configured in `backend/src/quantai/config.ts` under the `exits.positionFlipping` section:

```typescript
positionFlipping: {
  enabled: false,  // Set to true to enable
  minCounterSignalConfidence: 0.7,  // Minimum 70% confidence
  minRMultiple: 2.0,  // Minimum 2R profit required
  cooldownMinutes: 30,  // 30 minutes between flips
  maxFlipsPerHour: 3,  // Maximum 3 flips per hour
}
```

### Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enabled` | `false` | Enable/disable position flipping |
| `minCounterSignalConfidence` | `0.7` | Minimum confidence (0-1) required for counter-signal |
| `minRMultiple` | `2.0` | Minimum R-multiple profit before flip allowed |
| `cooldownMinutes` | `30` | Minutes to wait between flips |
| `maxFlipsPerHour` | `3` | Maximum number of flips allowed per hour |

## How It Works

### 1. Signal Detection

On each tick, when an agent has an open position:
1. System evaluates new entry signals
2. Checks if any signal is a counter-signal (opposite direction)
3. Evaluates the counter-signal's confidence

### 2. Flip Eligibility Check

If a counter-signal is detected, the system checks:
1. **Feature enabled**: Is position flipping enabled in config?
2. **Confidence threshold**: Is counter-signal confidence >= `minCounterSignalConfidence`?
3. **Profit requirement**: Is current position R-multiple >= `minRMultiple`?
4. **Time cooldown**: Have `cooldownMinutes` passed since last flip?
5. **Count cooldown**: Are we below `maxFlipsPerHour` in the last 60 minutes?

### 3. Flip Execution

If all checks pass:
1. Exit current position (market order)
2. Wait 100ms for exit to process
3. Enter new position in opposite direction (using standard entry logic)
4. Record flip event with timestamp and metadata
5. Log flip to monitoring system

### 4. Risk Management

The new position after a flip:
- Uses standard position sizing rules
- Applies normal stop-loss calculations
- Follows all risk management protocols
- Is treated as a fresh entry

## Example Scenario

### Setup
- Agent has a **LONG position** in BTC at $50,000
- Position is at **2.5R profit** (good profit captured)
- Price is now at $52,500

### Counter-Signal
- A **SHORT signal** appears with **75% confidence**
- This is a strong counter-signal (opposite direction, high confidence)

### Flip Decision
1. ✅ Position flipping enabled in config
2. ✅ Counter-signal confidence (75%) >= threshold (70%)
3. ✅ Current position R-multiple (2.5R) >= threshold (2.0R)
4. ✅ No flip in last 30 minutes (cooldown satisfied)
5. ✅ Only 1 flip in last hour (under 3 flip limit)

**Result**: Position flips from LONG → SHORT

### Execution
1. Exit LONG position at $52,500 (capture 2.5R profit)
2. Immediately enter SHORT position at $52,500
3. Set new stop-loss based on current ATR
4. Apply proper position sizing
5. Record flip event and update cooldown timers

## Monitoring

### Flip Statistics

Per-session flip statistics are available via `getFlipStats(sessionId)`:

```typescript
{
  totalFlipsLast24h: 2,      // Total flips in last 24 hours
  totalFlipsLastHour: 1,     // Total flips in last hour
  lastFlipTimestamp: 1699..., // Timestamp of last flip
  minutesSinceLastFlip: 45   // Minutes since last flip
}
```

### Logging

All flip operations are logged with:
- Session ID
- From/To position sides
- Price at flip
- Counter-signal confidence
- Current R-multiple
- Flip decision reasoning

## Best Practices

### When to Enable

Position flipping works best in:
- **Volatile markets**: Where trends can reverse quickly
- **Strong trend markets**: Where capturing both sides is profitable
- **High-confidence agents**: With proven signal quality

### When NOT to Enable

Avoid position flipping in:
- **Choppy/ranging markets**: Risk of whipsaws
- **Low-confidence agents**: Signals may be noisy
- **Initial testing**: Validate agent performance first

### Recommended Settings

**Conservative** (lower frequency):
```typescript
{
  enabled: true,
  minCounterSignalConfidence: 0.75,  // Higher confidence
  minRMultiple: 2.5,                  // More profit required
  cooldownMinutes: 45,                // Longer cooldown
  maxFlipsPerHour: 2                  // Fewer flips
}
```

**Aggressive** (higher frequency):
```typescript
{
  enabled: true,
  minCounterSignalConfidence: 0.65,  // Lower confidence
  minRMultiple: 1.5,                  // Less profit required
  cooldownMinutes: 20,                // Shorter cooldown
  maxFlipsPerHour: 4                  // More flips
}
```

## Testing

Unit tests are available in `backend/test/unit/position-flip-tracker.spec.ts`:

```bash
cd backend
node --import tsx test/unit/position-flip-tracker.spec.ts
```

All tests validate:
- ✅ Initial state allows flips
- ✅ Time-based cooldown enforcement
- ✅ Count-based cooldown enforcement
- ✅ Flip statistics tracking
- ✅ Session isolation
- ✅ History clearing

## Security Considerations

1. **No credentials exposed**: Flip tracking uses only session IDs
2. **Memory bounded**: Flip history limited to 24 hours, auto-pruned
3. **Session isolation**: Each session's flips tracked independently
4. **No external dependencies**: Pure in-memory tracking
5. **Type-safe**: Full TypeScript typing for all operations

## Performance Impact

- **Memory**: ~200 bytes per flip event, auto-pruned after 24h
- **CPU**: Minimal - simple timestamp comparisons
- **Latency**: ~100ms delay between exit and entry (configurable)

## Future Enhancements

Potential improvements for future versions:
1. Market regime-based cooldowns (shorter in trending, longer in ranging)
2. Dynamic confidence thresholds based on recent flip success rate
3. Integration with ML models for flip decision optimization
4. Per-symbol flip configuration overrides
5. Flip P&L tracking and reporting

## Related Files

- **Config**: `backend/src/quantai/config.ts`
- **Tracker**: `backend/src/services/positionFlipTracker.ts`
- **Orchestrator**: `backend/src/services/metaAdaptiveOrchestrator.ts`
- **Tests**: `backend/test/unit/position-flip-tracker.spec.ts`
- **Python Exits**: `backend/quantailabs_patch/strategy/exits.py` (counter-signal detection)
