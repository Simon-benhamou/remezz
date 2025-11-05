# Order Rejection Analysis Tool

## Purpose

This tool helps diagnose why a trading agent didn't place orders despite favorable market conditions (e.g., significant price movements).

## Problem Statement

When a cryptocurrency like XRP moves 7% but your agent doesn't execute any trades, it's important to understand why. The agent has many filters and guard rails that can block trades even during significant price movements.

## Usage

### Basic Analysis

Analyze why orders weren't placed for a specific symbol:

```bash
cd backend
npm run analyze:rejection XRP/USDT
```

### With Specific Session

If you have an active or past agent session:

```bash
npm run analyze:rejection XRP/USDT --session-id abc123
```

### With Mode and Aggressiveness

Simulate analysis with specific settings:

```bash
npm run analyze:rejection XRP/USDT --mode live --aggressiveness aggressive
```

### JSON Output

Export results as JSON for further processing:

```bash
npm run analyze:rejection XRP/USDT --json > analysis.json
```

### Save to File

Save the analysis report to a file:

```bash
npm run analyze:rejection XRP/USDT --export results.json
```

## What It Checks

The analyzer examines all conditions that could block trade execution:

### 1. Market Data
- **INSUFFICIENT_DATA**: Not enough market data available
- Price, volume, and technical indicators

### 2. Market Regime
- **REGIME_STANDBY**: Market in standby mode
- **REGIME_NO_TRADE**: Regime indicates no trading
- Trend, volatility, and market phase analysis

### 3. Trading Plan
- **NO_BIAS**: No directional bias (bias='none')
- Entry zone configuration
- Risk/reward parameters

### 4. Entry Zone
- **PRICE_OUTSIDE_ENTRY_ZONE**: Price moved outside calculated entry zone
- Distance from zone boundaries
- Zone validity and expiration

### 5. Technical Filters
- **ADX_TOO_LOW**: Trend strength below minimum
- **RSI_OVERBOUGHT**: RSI too high for long entry
- **RSI_OVERSOLD**: RSI too low for short entry
- **VOLATILITY_TOO_HIGH**: ATR exceeds maximum

### 6. Agent State
- **AGENT_IN_COOLDOWN**: Cooldown period active
- **AGENT_HALTED**: Agent manually or automatically halted
- **POSITION_ALREADY_OPEN**: Position already exists

### 7. Risk Management
- **CONSECUTIVE_STOPS_LIMIT**: Too many consecutive losses
- **DAILY_TRADE_LIMIT**: Daily trade limit reached
- **QUALITY_THRESHOLD_RAISED**: Quality bar increased due to recent performance

### 8. Timing
- **LARGE_MOVE_MISSED**: Significant price movement occurred without trade

## Example Output

```
════════════════════════════════════════════════════════════════════════════════
📊 Order Rejection Analysis for XRP/USDT
════════════════════════════════════════════════════════════════════════════════

Timestamp: 2025-11-05T20:30:00.000Z
Current Price: $2.45000
24h Price Change: +7.23%
Can Trade: ❌ NO

────────────────────────────────────────────────────────────────────────────────
SUMMARY: Agent CANNOT trade XRP/USDT. Found 3 blocking condition(s): 
PRICE_OUTSIDE_ENTRY_ZONE, ADX_TOO_LOW, RSI_OVERBOUGHT
────────────────────────────────────────────────────────────────────────────────

🔴 BLOCKING CONDITIONS:
  1. [PRICE_OUTSIDE_ENTRY_ZONE] Price 2.450000 is outside entry zone [2.280000, 2.320000]
     Details: {
       "currentPrice": 2.45,
       "zone": { "from": 2.28, "to": 2.32, "mid": 2.3 },
       "distancePct": "5.85"
     }
  
  2. [ADX_TOO_LOW] ADX 16.50 below minimum 18 for long trade
     Details: { "adx": 16.5, "minAdx": 18, "bias": "long" }
  
  3. [RSI_OVERBOUGHT] RSI 74.20 above maximum 72 for long entry
     Details: { "rsi": 74.2, "maxRsi": 72, "bias": "long" }

────────────────────────────────────────────────────────────────────────────────
💡 RECOMMENDATIONS:
  1. Price moved 5.85% away from entry zone - consider recalculating zone
  2. Wait for stronger trend (higher ADX) before entering
  3. RSI indicates overbought conditions - wait for pullback
  4. Price already moved significantly higher - entry zone may need recalculation
════════════════════════════════════════════════════════════════════════════════
```

## Exit Codes

- **0**: Agent CAN trade (no blocking conditions)
- **1**: Agent CANNOT trade (blocking conditions found)
- **2**: Analysis error

## Integration with Agent

The agent automatically logs rejection reasons using the same codes:

```typescript
// In agent onTick() method
this.recordEntryRejection('ADX_TOO_LOW', 'ADX below threshold', { 
  adx: 16.5, 
  minAdx: 18 
});
```

Logged rejections appear in:
- Operations events log
- Agent telemetry
- Rejection statistics summary (every 10 rejections or 10 minutes)

## Common Scenarios

### Scenario 1: Price Moved Too Fast

**Problem**: XRP gained 7% in a few hours, but no trade.

**Likely Cause**: `PRICE_OUTSIDE_ENTRY_ZONE`

**Solution**:
- Entry zone calculated for lower price range
- Price "gapped" past the entry zone
- Agent needs dynamic zone recalculation or breakout logic

### Scenario 2: Overbought Conditions

**Problem**: Strong upward movement, but RSI filter blocks entry.

**Likely Cause**: `RSI_OVERBOUGHT`

**Solution**:
- RSI exceeded max threshold (65-80 depending on aggressiveness)
- Wait for pullback/consolidation
- Consider adjusting aggressiveness mode

### Scenario 3: Weak Trend

**Problem**: Price moving but ADX too low.

**Likely Cause**: `ADX_TOO_LOW`

**Solution**:
- Movement is choppy/ranging, not trending
- ADX below threshold indicates weak directional strength
- Wait for clearer trend establishment

### Scenario 4: Multiple Recent Losses

**Problem**: Agent won't enter despite good setup.

**Likely Cause**: `CONSECUTIVE_STOPS_LIMIT` or `QUALITY_THRESHOLD_RAISED`

**Solution**:
- Agent in protective mode after losses
- Quality threshold raised
- May need manual review/reset

## Development

### Adding New Checks

To add a new rejection check:

1. Add the check in `orderRejectionAnalyzer.ts`:
```typescript
if (someCondition) {
  rejections.push({
    category: 'entry_filter',
    code: 'NEW_CHECK_CODE',
    message: 'Description of issue',
    details: { relevant: 'data' },
    severity: 'blocking',
    timestamp
  });
}
```

2. Add tracking in agent's `onTick()`:
```typescript
if (someCondition) {
  this.recordEntryRejection('NEW_CHECK_CODE', 'Description', details);
  return;
}
```

### Testing

Test the analyzer without a live agent:

```bash
npm run analyze:rejection BTC/USDT --mode paper --aggressiveness reactive
```

## Related Files

- `/backend/src/diagnostics/orderRejectionAnalyzer.ts` - Main analyzer
- `/backend/scripts/analyze-order-rejection.ts` - CLI script
- `/backend/src/agent/state/index.ts` - Agent implementation with rejection tracking
- `/XRP_ORDER_REJECTION_ANALYSIS.md` - Detailed analysis in French

## Support

For issues or questions:
1. Check logs in operations events
2. Run analyzer with `--json` for detailed output
3. Review agent rejection statistics in telemetry
