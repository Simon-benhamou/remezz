# Multi-Agent Shared Pool Test

## Overview

This test simulates **9 trading agents** sharing a **$1000 pool** over **10 days**, comparing the performance of different trading modes:

- **3 Conservative agents**: Lower risk (0.5% per trade), max 2x leverage, 2% daily loss limit
- **3 Reactive agents**: Moderate risk (1.0% per trade), max 5x leverage, 3% daily loss limit  
- **3 Aggressive agents**: Higher risk (2.0% per trade), max 10x leverage, 5% daily loss limit

## Running the Test

```bash
# From the backend directory
npm run test:multi-agent
```

Or using tsx directly:
```bash
cd backend
npx tsx scripts/multi-agent-pool-test.ts
```

## What It Does

The test:

1. **Generates 10 days of synthetic market candles** (14,400 1-minute candles)
2. **Allocates equal capital** to each agent ($111.11 per agent from $1000 pool)
3. **Runs backtests** for all 9 agents with their respective risk profiles
4. **Compares performance** across modes and individual agents
5. **Generates comprehensive results** showing:
   - Individual agent performance (PnL, win rate, drawdown, Sharpe ratio)
   - Mode-level comparisons (conservative vs reactive vs aggressive)
   - Combined pool results
   - Winner analysis

## Results

The test outputs:

### Console Output
- Detailed per-agent performance metrics
- Mode comparison statistics
- Combined pool final results
- Winner analysis showing:
  - Best performing mode by total PnL
  - Best individual agent
  - Most stable mode (lowest variance)

### JSON File
Results are saved to `multi-agent-pool-test-results.json` with complete data including:
- Individual agent configurations
- Full backtest metrics for each agent
- Mode-level aggregations
- Combined pool statistics

## Key Metrics

### Individual Agent Metrics
- **Initial/Final Equity**: Starting and ending capital for each agent
- **PnL**: Profit/loss in USD and percentage
- **Trades**: Number of trades executed
- **Win Rate**: Percentage of winning trades
- **Profit Factor**: Ratio of gross profit to gross loss
- **Max Drawdown**: Largest peak-to-trough decline
- **Sharpe Ratio**: Risk-adjusted return measure

### Mode Comparison Metrics
- **Total PnL**: Combined profit for all agents in the mode
- **Average PnL**: Mean profit per agent
- **Total Trades**: Sum of all trades across mode agents
- **Average Win Rate**: Mean win rate across agents
- **Average Profit Factor**: Mean profit factor
- **Average Drawdown**: Mean maximum drawdown
- **Average Sharpe**: Mean Sharpe ratio
- **Stability**: Measure of consistency (100 = perfectly consistent, lower = more variance)

### Combined Pool Metrics
- **Initial Pool**: Starting capital ($1000)
- **Final Pool**: Ending total capital
- **Total PnL**: Overall profit/loss for entire pool
- **Total Trades**: Sum of all trades across all agents
- **Overall Win Rate**: Weighted average win rate
- **Overall Profit Factor**: Weighted average profit factor

## Interpretation

### Conservative Mode
- **Lower returns** but **lower risk**
- **Smaller drawdowns** for capital preservation
- **Higher Sharpe ratios** indicating better risk-adjusted returns
- **More stable** performance across agents

### Reactive Mode  
- **Balanced** risk/reward profile
- **Moderate drawdowns** and returns
- **Middle ground** between safety and growth

### Aggressive Mode
- **Higher potential returns**
- **Larger drawdowns** and higher volatility
- **Lower Sharpe ratios** due to increased risk
- May show **higher variance** between individual agents

## Customization

You can modify the test parameters by editing `multi-agent-pool-test.ts`:

- **Pool size**: Change `poolSizeUsd` (default: $1000)
- **Duration**: Change `durationDays` (default: 10)
- **Agent count**: Modify the agent configuration arrays
- **Risk profiles**: Adjust mode multipliers and risk parameters
- **Market conditions**: Modify the candle generation logic

## Use Cases

This test is useful for:

1. **Strategy comparison**: Understanding how different risk profiles perform
2. **Portfolio optimization**: Determining optimal agent mode mix
3. **Risk assessment**: Evaluating stability vs. return trade-offs
4. **Capital allocation**: Deciding how to distribute capital among modes
5. **Stress testing**: Simulating multi-agent scenarios before live deployment

## Example Results

Based on a typical run:

```
CONSERVATIVE (3 agents)
  Total PnL:      $88.92
  Avg PnL:        $29.64 (26.68%)
  Stability:      37.81/100

REACTIVE (3 agents)
  Total PnL:      $125.04
  Avg PnL:        $41.68 (37.51%)
  Stability:      24.87/100

AGGRESSIVE (3 agents)
  Total PnL:      $179.81
  Avg PnL:        $59.94 (53.94%)
  Stability:      68.09/100

COMBINED POOL RESULTS
  Initial Pool:   $1000.00
  Final Pool:     $1393.76
  Total PnL:      $393.76 (39.38%)
```

In this example:
- **Aggressive mode** generated the highest total PnL (+$179.81)
- **Conservative mode** had the lowest returns but smallest drawdowns
- **Combined pool** gained 39.38% over 10 days
- Each mode showed different stability characteristics
