# Symbol Rejection Reasons - Documentation

This document explains the various rejection reasons you might see when the intelligent agent evaluates crypto trading pairs.

## Metrics Computation Failures

### `metrics_computation_failed`
The system couldn't compute necessary metrics for this symbol. Check debug logs for specific details:
- Symbol not found in exchange markets (likely delisted)
- Invalid volume data
- Exchange validation failed
- Insufficient historical data (15m market data invalid)

**Debug logs to check:**
- `Symbol not found in exchange markets - likely delisted or not available`
- `Invalid volume data (undefined)`
- `Exchange validation failed - <error message>`
- `All 15m market data invalid (ratio=1) - insufficient historical data or data quality issues`

## Liquidity & Execution Quality Filters

### `volume_below_floor`
Trading volume is below the minimum threshold for safe execution.
- **Threshold**: Typically $50M+ for most symbols
- **Why it matters**: Low volume = high slippage risk

### `spread_missing`
Bid-ask spread data is not available.
- **Impact**: Cannot calculate trading costs accurately

### `spread_too_wide`
Bid-ask spread exceeds acceptable limits.
- **Threshold**: > 8 basis points (0.08%)
- **Why it matters**: Wide spreads = high trading costs

### `book_depth_thin`
Order book depth is insufficient for the strategy's position size.
- **Thresholds**: 
  - Conservative: $25,000+ depth
  - Reactive: $15,000+ depth
  - Aggressive: $10,000+ depth
- **Why it matters**: Thin books = potential for large slippage

### `fill_rate_missing`
Historical fill rate data is unavailable.

### `fill_rate_low`
Historical passive fill rate is below minimum threshold.
- **Threshold**: < 40%
- **Why it matters**: Low fill rates = missed opportunities

## Volatility & Risk Filters

### `atr_missing`
Average True Range (ATR) data is not available.

### `atr_too_low`
ATR is too low for the target profit percentage.
- **Threshold**: < 50% of target TP
- **Why it matters**: Insufficient price movement to reach targets

### `atr_too_high`
ATR is excessively high, indicating dangerous volatility.
- **Threshold**: 
  - Default: > 200% of target TP
  - Reactive mode: Hard cap at 2.5%
- **Why it matters**: Protects against rapid crashes (e.g., SAPIEN -7.8% in minutes)

## Market Regime Filters

### `regime_mismatch`
Current market regime doesn't match strategy requirements.
- **Conservative**: Rejects volatile/trending markets
- **Why it matters**: Strategy performs best in specific market conditions

### `regime_excessive_vol`
Even for reactive strategies, volatility is too extreme.
- **Threshold**: Volatile regime + ATR > 2.5x target
- **Why it matters**: Risk management

## Performance History Filters

### `win_rate_cooldown`
Symbol recently had poor win rate and is in cooldown period.
- **Cooldown**: 24 hours after last trade
- **Threshold**: Win rate < 35% with sufficient sample size

### `win_rate_low`
Symbol has consistently low win rate (outside cooldown).
- **Threshold**: < 35% with 5-8+ trades

### `expectancy_cooldown`
Symbol recently had negative expectancy and is in cooldown.
- **Cooldown**: 24 hours after last trade

### `expectancy_negative`
Symbol has consistently negative expected value.
- **Threshold**: ≤ $0 average P&L per trade

### `slippage_vs_spread`
Historical slippage exceeds acceptable limits relative to spread.
- **Threshold**: > max(5, spread * 1.2) bps, capped at 18 bps
- **Why it matters**: Indicates poor execution quality

## Multi-Timeframe Conflicts

### `tf_conflict_4h_vs_15m`
4-hour and 15-minute timeframe biases are contradictory.
- **Example**: 4h bullish but 15m bearish (or vice versa)
- **Why it matters**: Conflicting signals reduce setup quality

## Technical Analysis Filters

### `adx_below_trend_threshold`
ADX indicator shows insufficient trend strength.
- **Threshold**: < 18
- **Context**: Used in trend-following setups

### `weak_trend_structure`
Overall trend structure is too weak.
- **Threshold**: Trend strength < 0.25

### `bullish_trend_missing_stack` / `bearish_trend_missing_stack`
EMA stack doesn't support the claimed trend direction.

### `neutral_flow`
Chaikin Money Flow is too neutral.
- **Threshold**: |CMF| < 0.05

### `price_near_ema200`
Price is too close to the 200 EMA for clear directional bias.
- **Threshold**: < 0.4% distance

## Other Rejections

### `insufficient_data`
Not enough historical data to perform technical analysis.

### `evaluation_error`
An unexpected error occurred during evaluation (check logs).

---

## How to Use This Information

1. **Debug Mode**: Set log level to DEBUG to see specific rejection reasons for each symbol
2. **Pattern Recognition**: Grouped warnings show you which filters are most restrictive
3. **Configuration**: Some thresholds can be adjusted via environment variables
4. **Market Conditions**: Multiple rejections often indicate choppy/low-quality market conditions

## Example Output

```
[WARN] ⚠️ Liquidity/performance filters rejected all candidates

[WARN]    [atr_too_high]: 8 symbols
[WARN]       ICP/USDT
[WARN]       FET/USDT
[WARN]       DOT/USDT
[WARN]       ... and 5 more

[WARN]    [volume_below_floor]: 6 symbols
[WARN]       MINA/USDT
[WARN]       ETC/USDT
[WARN]       DUSK/USDT
[WARN]       ... and 3 more
```

This tells you that:
- **8 symbols** were rejected for excessive volatility (protect against crashes)
- **6 symbols** had insufficient volume (avoid slippage)
- The market is either too volatile or too illiquid for safe trading
