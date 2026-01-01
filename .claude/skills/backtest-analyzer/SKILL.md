---
name: backtest-analyzer
description: Analyzes and compares cryptocurrency trading strategy backtest results from JSON files. Examines performance metrics (Sharpe ratio, max drawdown, win rate, profit factor, ROI), identifies trading patterns, compares multiple backtest configurations, evaluates exit strategies, and suggests strategy improvements based on historical data. Use when analyzing backtest results, comparing parameter variations, investigating performance issues, or validating strategy changes across 12-24 month historical periods.
allowed-tools: Read, Grep, Glob, Bash(python:*), Bash(node:*), Bash(npm:*)
---

# Backtest Analyzer

Analyzes cryptocurrency futures trading strategy backtest results with comprehensive performance metrics, pattern detection, and actionable optimization recommendations.

## Purpose

This skill is specialized for analyzing the QuantAI trading system backtests, which:
- Test momentum breakout strategies on crypto futures
- Use 15m timeframe with 1m intrabar simulation
- Include realistic costs (fees, slippage, funding)
- Validate strategies over 12-24 months of historical data
- Compare signal ranking algorithms and exit strategies

## Instructions

When analyzing backtest results, follow this systematic approach:

### 1. Locate Backtest Files

**Common locations:**
- `./results/` - Backtest output files
- `./backend/data/` - Historical candle data (JSON)
- `./backend/src/services/backtestService.ts` - Backtest engine
- API endpoint results: `/api/backtest/run` responses

**Search strategy:**
```bash
# Find recent backtest result files
find . -name "*backtest*.json" -o -name "*results*.json" -mtime -7

# Find backtest data files
ls -lht backend/data/*.json | head -20
```

If no files found, ask user: "Where are your backtest result files located?"

### 2. Load and Validate Backtest Data

**Expected JSON structure:**
```json
{
  "summary": {
    "totalTrades": 2103,
    "winningTrades": 1259,
    "losingTrades": 844,
    "winRate": 0.599,
    "totalPnL": 2683.45,
    "totalPnLPct": 2683.45,
    "sharpeRatio": 1.91,
    "maxDrawdown": 31.89,
    "maxDrawdownPct": 31.89,
    "profitFactor": 2.34,
    "avgTradeDuration": 127,
    "initialCapital": 2000,
    "finalCapital": 55668.90
  },
  "trades": [
    {
      "symbol": "BTC/USDT:USDT",
      "side": "LONG",
      "entryTime": 1640995200000,
      "exitTime": 1641002400000,
      "entryPrice": 47850.50,
      "exitPrice": 48234.20,
      "pnl": 127.45,
      "pnlPct": 1.27,
      "exitReason": "TRAILING_STOP"
    }
  ],
  "equityCurve": [
    { "timestamp": 1640995200000, "equity": 2000 },
    { "timestamp": 1641002400000, "equity": 2127.45 }
  ]
}
```

**Validation checks:**
1. Verify required fields exist: `summary`, `trades`, `equityCurve`
2. Check data completeness: all trades have entry/exit prices
3. Validate calculations: `winRate = winningTrades / totalTrades`
4. Flag anomalies: trades with extreme PnL (> 50%), suspiciously high win rate (> 80%)

### 3. Analyze Performance Metrics

**Calculate or extract these metrics in priority order:**

#### Primary Metrics (Always Report)

| Metric | Formula | Good Target | Excellent Target |
|--------|---------|-------------|------------------|
| **Total ROI** | `(finalCapital - initialCapital) / initialCapital * 100` | > 100% (1yr) | > 500% (1yr) |
| **Sharpe Ratio** | `avgReturn / stdDevReturn` (annualized) | > 1.0 | > 2.0 |
| **Win Rate** | `winningTrades / totalTrades * 100` | > 55% | > 65% |
| **Profit Factor** | `grossProfits / grossLosses` | > 1.5 | > 2.0 |
| **Max Drawdown** | Largest peak-to-trough decline (%) | < 25% | < 15% |

#### Secondary Metrics (Report if Available)

- **Average Trade PnL**: `totalPnL / totalTrades`
- **Avg Win / Avg Loss Ratio**: Measures if winners > losers
- **Trade Frequency**: Trades per day
- **Avg Trade Duration**: Minutes/hours per trade
- **Longest Winning Streak**: Max consecutive wins
- **Longest Losing Streak**: Max consecutive losses
- **Recovery Factor**: `netProfit / maxDrawdown`
- **Expectancy**: `(winRate * avgWin) - (lossRate * avgLoss)`

**Present metrics in clear table format:**

```
## Performance Summary

| Metric | Value | Assessment |
|--------|-------|------------|
| Total ROI | +2,683% | Excellent |
| Sharpe Ratio | 1.91 | Excellent |
| Win Rate | 59.9% | Good |
| Profit Factor | 2.34 | Excellent |
| Max Drawdown | 31.89% | Acceptable |
| Total Trades | 2,103 | Good sample size |
| Avg Trade Duration | 127 min (2.1h) | Reasonable |
```

### 4. Identify Patterns and Insights

**Analyze these dimensions:**

#### A. Exit Reason Distribution
```typescript
// Count trades by exit reason
const exitReasons = {
  TRAILING_STOP: 1627 (77.4%),
  STOP_LOSS: 145 (6.9%),
  REGIME_CHANGE: 170 (8.1%),
  MOMENTUM_REVERSAL: 161 (7.6%)
}
```

**Look for:**
- Is trailing stop the primary exit? (Good - capturing profits)
- High SL percentage? (Bad - strategy may be flawed)
- Regime change exits? (Shows adaptive filtering working)

#### B. Time-of-Day Patterns
```python
# Group trades by hour of day
import json
from datetime import datetime

for trade in trades:
    hour = datetime.fromtimestamp(trade['entryTime']/1000).hour
    # Aggregate wins/losses by hour
```

**Flag if:**
- > 60% of losses occur in specific hours (suggests timing bias)
- Certain hours have < 40% win rate (avoid trading those hours)

#### C. Symbol Performance Analysis
```typescript
// Group trades by symbol
const symbolStats = {
  'BTC/USDT:USDT': { trades: 423, winRate: 62%, pnl: +1234 },
  'ETH/USDT:USDT': { trades: 389, winRate: 58%, pnl: +987 },
  'DOGE/USDT:USDT': { trades: 156, winRate: 45%, pnl: -123 }  // Red flag!
}
```

**Recommend:**
- Remove symbols with winRate < 50% after > 100 trades
- Increase allocation to top performers

#### D. Trade Duration vs PnL
```python
# Analyze if longer trades are more profitable
short_trades = [t for t in trades if t['duration'] < 60]  # < 1 hour
long_trades = [t for t in trades if t['duration'] > 180]   # > 3 hours
# Compare avg PnL
```

**Insight example:**
"Trades held > 3 hours have 68% win rate vs 52% for trades < 1 hour. Consider adding minimum hold time filter."

#### E. Entry Condition Effectiveness

If backtest includes entry signals (ROC, volume ratio, BB position):
```typescript
// Analyze which entry conditions correlate with wins
highROC = trades.filter(t => t.entryROC > 2.5)
lowROC = trades.filter(t => t.entryROC < 1.5)
// Compare win rates
```

#### F. Consecutive Wins/Losses Patterns
```python
# Detect streaks
streaks = []
current_streak = 0
for trade in trades:
    if trade['pnl'] > 0:
        current_streak = current_streak + 1 if current_streak > 0 else 1
    else:
        current_streak = current_streak - 1 if current_streak < 0 else -1
    streaks.append(current_streak)

max_win_streak = max(streaks)
max_loss_streak = min(streaks)
```

**Flag if:**
- Max loss streak > 7 (indicates strategy may fail in certain market conditions)
- Losses cluster together (suggests regime detection is failing)

### 5. Compare Multiple Backtests

**When analyzing multiple backtest files (e.g., different parameter sets):**

#### A. Side-by-Side Comparison Table

```
## Backtest Comparison

| Metric | V5.13 (Baseline) | V5.32 (BB Squeeze) | V5.34 (Smart Stagnant) | Winner |
|--------|------------------|--------------------|-----------------------|--------|
| ROI | +2,683% | +501% | +501% | V5.13 ✓ |
| Sharpe | 1.91 | 1.45 | 1.52 | V5.13 ✓ |
| Win Rate | 59.9% | 53.6% | 59.2% | V5.13 ✓ |
| Total Trades | 2,103 | 386 | 1,089 | V5.13 ✓ |
| Max DD | 31.89% | 28.45% | 29.12% | V5.32 ✓ |
| Avg Trade | +1.28% | +1.30% | +0.46% | V5.32 ✓ |

**Conclusion**: V5.13 significantly outperforms. V5.32 BB Squeeze reduces trade count by 82% without proportional improvement in win rate or avg trade PnL.

**Recommendation**: Disable anticipatory entry (V5.32), revert to classic breakout (V5.13).
```

#### B. Highlight Significant Differences

**Criteria for "significant":**
- ROI difference > 20%
- Win rate difference > 5 percentage points
- Sharpe ratio difference > 0.3
- Trade count difference > 30%

**Example flagging:**
```
⚠️ SIGNIFICANT CHANGE DETECTED:
V5.32 reduces trade count from 2,103 → 386 (-82%)
Without proportional improvement: ROI drops from +2,683% → +501% (-81%)

CAUSE: Anticipatory entry filters out most signals
IMPACT: Underperforms baseline by 27x per trade
ACTION: Disable ANTICIPATORY_ENTRY.ENABLED flag
```

#### C. Parameter Sensitivity Analysis

If comparing parameter variations (e.g., ROC threshold: 1.5%, 1.75%, 2.0%, 2.5%):

```
## ROC Threshold Sensitivity

| ROC_MIN | Trades | Win Rate | ROI | Avg PnL/Trade |
|---------|--------|----------|-----|---------------|
| 1.50% | 3,245 | 56.2% | +1,823% | +0.56% |
| 1.75% | 2,103 | 59.9% | +2,683% | +1.28% | ← OPTIMAL
| 2.00% | 1,456 | 62.1% | +2,145% | +1.47% |
| 2.50% | 789 | 64.8% | +1,234% | +1.56% |

**Insight**: Lower ROC (1.75%) maximizes total ROI by capturing more opportunities, despite slightly lower win rate.
**Recommendation**: Use ROC_MIN = 1.75% (current V5.13 setting is optimal)
```

### 6. Provide Actionable Recommendations

**Structure recommendations by priority:**

#### CRITICAL (Implement Immediately)
- Issues causing > 10% performance degradation
- Risk management flaws (e.g., no stop loss, excessive leverage)
- Logic bugs (e.g., look-ahead bias)

**Example:**
```
🔴 CRITICAL: Backtest shows 31.89% max drawdown. Live account may experience -$3,189 drawdown on $10k capital.

RECOMMENDATION:
1. Add circuit breaker: Pause trading after -15% daily drawdown
2. Reduce position size from 40% → 30% to lower drawdown to ~24%
3. Implement in `simpleAgent.ts` before deploying V5.13 to production
```

#### HIGH PRIORITY (Implement This Week)
- Opportunities for > 5% performance improvement
- Significant pattern discoveries

**Example:**
```
🟡 HIGH PRIORITY: Symbol performance analysis shows DOGE has 45% win rate after 156 trades.

RECOMMENDATION:
1. Remove DOGE from trading universe
2. Expected impact: Reduce losing trades by ~86 (156 * 0.55)
3. Estimated ROI improvement: +3-5%
4. Update `SYMBOLS_TO_TRADE` in config
```

#### MEDIUM PRIORITY (Consider for Next Version)
- Minor optimizations
- Code quality improvements

**Example:**
```
🟢 MEDIUM: Trades held > 3 hours show 68% WR vs 52% for < 1 hour trades.

RECOMMENDATION:
1. Add minimum hold time of 2 hours (except for SL exits)
2. Test in backtest first (expected: fewer trades, higher WR)
3. Implement as `MIN_HOLD_TIME_MINUTES = 120` in momentum config
```

#### LOW PRIORITY (Research/Investigate)
- Ideas requiring more data
- Exploratory analysis

**Example:**
```
ℹ️ LOW: Time-of-day analysis shows 58% of losses occur 9-11 AM UTC.

RECOMMENDATION:
1. Investigate: Is this due to market open volatility?
2. Collect more data: Analyze last 24 months vs 12 months
3. If pattern persists, add time-based filter to avoid 9-11 AM entries
```

### 7. Advanced Analysis (When Requested)

#### Monte Carlo Simulation
```python
# Resample trades to estimate confidence intervals
import random
results = []
for i in range(1000):
    sample = random.choices(trades, k=len(trades))
    pnl = sum(t['pnl'] for t in sample)
    results.append(pnl)

# Calculate percentiles
p5 = percentile(results, 5)    # 5th percentile (bad luck)
p50 = percentile(results, 50)  # Median (expected)
p95 = percentile(results, 95)  # 95th percentile (good luck)
```

**Output:**
```
## Monte Carlo Confidence Intervals (1,000 simulations)

| Scenario | Total PnL | Likelihood |
|----------|-----------|------------|
| Worst Case (P5) | +$18,234 | 5% chance of worse |
| Expected (P50) | +$53,668 | Median outcome |
| Best Case (P95) | +$89,456 | 5% chance of better |

**Interpretation**: Strategy is robust - even worst case is profitable.
```

#### Equity Curve Analysis
```python
# Calculate drawdown periods
equity = [t['equity'] for t in equity_curve]
peak = equity[0]
drawdowns = []
for e in equity:
    peak = max(peak, e)
    dd_pct = (peak - e) / peak * 100
    drawdowns.append(dd_pct)

# Find longest drawdown
```

**Visualize in text:**
```
## Equity Curve Drawdown Periods

Period 1: Days 12-45 (33 days), Max DD: 12.3%
Period 2: Days 89-134 (45 days), Max DD: 31.9% ← LONGEST
Period 3: Days 201-223 (22 days), Max DD: 18.7%

**Insight**: Longest drawdown was 45 days. Prepare for 1.5 month losing periods.
```

## Output Format Template

Always structure your analysis as follows:

```markdown
# Backtest Analysis Report

**Date**: [Current Date]
**Backtest Period**: [Start Date] to [End Date]
**Files Analyzed**: [List of files]

---

## Executive Summary

**Key Findings**:
1. [Most important finding - 1 sentence]
2. [Second most important - 1 sentence]
3. [Third most important - 1 sentence]

**Overall Assessment**: [EXCELLENT / GOOD / ACCEPTABLE / POOR]

**Action Required**: [CRITICAL / RECOMMENDED / OPTIONAL / NONE]

---

## Performance Metrics

[Insert metrics table from Section 3]

---

## Pattern Analysis

### Exit Reason Distribution
[Analysis from Section 4A]

### Symbol Performance
[Analysis from Section 4C]

### Time-of-Day Patterns
[Analysis from Section 4B]

### Trade Duration Analysis
[Analysis from Section 4D]

---

## Comparison (if multiple backtests)

[Insert comparison table from Section 5A]

[Significant differences from Section 5B]

---

## Recommendations

### 🔴 CRITICAL
1. [Action 1]
2. [Action 2]

### 🟡 HIGH PRIORITY
1. [Action 1]
2. [Action 2]

### 🟢 MEDIUM PRIORITY
1. [Action 1]

---

## Appendix

### Trade Sample
[Show 3-5 example trades: best win, worst loss, typical win, typical loss]

### Methodology
- Backtest engine: [backtestService.ts version]
- Cost model: [fees, slippage, funding rates]
- Intrabar simulation: [Yes/No, resolution]
- Signal ranking: [Enabled/Disabled]
```

## Special Considerations for QuantAI System

### Strategy Version Detection

Look for version indicators in code comments:
```typescript
// V5.34: Smart stagnant trade with observation window
// V5.13: Regime change + momentum reversal exits
// V5.10: RSI + BTC ROC filter (REMOVED)
```

**Extract version info** and include in report:
```
**Strategy Version**: V5.34 (Smart Stagnant Exit)
**Previous Version**: V5.13 (Baseline)
**Changes**: Added 45min stagnant trigger with 60min observation window
```

### Cost Model Validation

Verify backtest uses realistic costs (from `backtestService.ts`):
```typescript
COSTS: {
  TRADING_FEE_PCT: 0.04,    // Should match Binance taker fee
  SLIPPAGE_PCT: 0.05,       // 0.05% is reasonable
  FUNDING_RATE_PCT: 0.01,   // 8h funding
}
```

**Flag if costs are unrealistic:**
```
⚠️ WARNING: Backtest uses 0.01% fee (too low). Binance taker fee is 0.04%.
IMPACT: Overestimates profitability by ~0.06% per round trip
ACTION: Update TRADING_FEE_PCT to 0.04 in backtestService.ts
```

### Intrabar Simulation Check

Verify backtest simulates 1m resolution from 15m candles:
```typescript
// Should see this logic in backtestService.ts
if (current.low <= trailStop) {
  const closeBreached = current.close <= trailStop;
  if (closeBreached) {
    pos.trailingBreachCandles += 1;
    if (pos.trailingBreachCandles >= 2) {
      shouldExit = true; // 2 consecutive breaches
    }
  }
}
```

**Report on realism:**
```
✓ Intrabar simulation: ENABLED (simulates 1m from 15m candles)
✓ Trailing stop requires 2 consecutive breaches (matches production)
✓ Uses candle high/low for wick touches
```

## Troubleshooting

### No Backtest Files Found

1. Check API endpoint: `POST /api/backtest/run` may store results in memory
2. Ask user to run: `npm run analyze:performance` to generate files
3. Check alternate formats: CSV, SQLite database

### Incomplete Data

If `equityCurve` is missing:
```typescript
// Reconstruct from trades
let equity = initialCapital;
const curve = [{ timestamp: trades[0].entryTime, equity }];
for (const trade of trades) {
  equity += trade.pnl;
  curve.push({ timestamp: trade.exitTime, equity });
}
```

### Anomalous Results

If results seem too good to be true (> 1000% ROI, > 80% WR):
1. **Check for look-ahead bias**: Are indicators calculated on current bar?
2. **Check for survivorship bias**: Does backtest only include currently-listed symbols?
3. **Verify cost model**: Are fees/slippage included?
4. **Check overfitting**: Is backtest period < 6 months?

**Report suspicions:**
```
⚠️ ANOMALY DETECTED: 85% win rate is suspiciously high
POSSIBLE CAUSES:
1. Look-ahead bias in indicator calculation
2. Missing trading costs
3. Overfitted on small sample (only 2 months of data)

RECOMMENDATION: Run code-consistency-checker to verify backtest logic
```

## Integration with Other Skills

After analysis, suggest complementary skills:

- **code-consistency-checker**: If backtest results differ significantly from live trading
- **pattern-researcher**: If analysis reveals opportunities for new entry/exit patterns
- **strategy-optimizer**: If parameter sensitivity suggests optimization potential

**Example:**
```
📋 NEXT STEPS:

1. Run code-consistency-checker to verify backtest matches production:
   "Check if backtest and production use same entry logic"

2. Investigate stagnant trade pattern further:
   "Research patterns for stagnant trades that later became profitable"

3. Optimize trailing stop distance:
   "Optimize trailing stop distance parameter between 0.3% and 1.0%"
```

---

## Quick Start Examples

**Example 1: Analyze single backtest**
```
User: "Analyze the latest backtest results"
Claude: [Finds files, loads data, generates full report with recommendations]
```

**Example 2: Compare two versions**
```
User: "Compare V5.13 backtest with V5.34"
Claude: [Loads both, creates comparison table, highlights differences, recommends best version]
```

**Example 3: Investigate performance issue**
```
User: "Why is the backtest showing 45% win rate on DOGE?"
Claude: [Filters trades to DOGE, analyzes entry/exit patterns, identifies issue, suggests fix]
```

**Example 4: Validate before production deployment**
```
User: "Is V5.34 ready for production?"
Claude: [Analyzes metrics, checks for red flags, verifies costs are realistic, provides go/no-go recommendation]
```

---

## Remember

- **Be thorough but concise**: Users want actionable insights, not raw data dumps
- **Prioritize recommendations**: CRITICAL > HIGH > MEDIUM > LOW
- **Show your work**: Include example trades, calculations, code snippets
- **Be specific**: "Change ROC_MIN to 1.75%" not "adjust ROC threshold"
- **Validate before recommending**: Don't suggest changes without backtest evidence
- **Consider real-world constraints**: A strategy that trades 50x/day may not be executable live

Your goal is to help traders make data-driven decisions about strategy deployment and optimization.
