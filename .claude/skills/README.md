# Claude Code Skills for Remezz Trading System

This directory contains custom Claude Code skills designed specifically for the Remezz cryptocurrency trading system. These skills help automate analysis, validation, and optimization of trading strategies.

## 📚 Available Skills

### 1. `backtest-analyzer`
**Purpose**: Analyzes backtest results, compares configurations, and suggests optimizations

**Use when:**
- Analyzing backtest performance metrics
- Comparing different strategy versions (e.g., V5.13 vs V5.34)
- Investigating why a backtest succeeded or failed
- Validating strategy changes before production deployment
- Finding patterns in winning/losing trades

**Example prompts:**
```
"Analyze the latest backtest results"
"Compare V5.13 with V5.34 backtest performance"
"Why is DOGE showing 45% win rate?"
"Is this strategy ready for production?"
"What patterns distinguish winning from losing trades?"
```

---

### 2. `code-consistency-checker`
**Purpose**: Validates backtest and production code have identical logic

**Use when:**
- Before deploying a strategy to production
- After making strategy changes
- Debugging discrepancies between backtest and live results
- Validating that backtest results are realistic
- Investigating why live performance differs from backtest

**Example prompts:**
```
"Check if backtest and production code are consistent"
"Verify there's no look-ahead bias in my backtest"
"Why does my backtest show +200% but live is -10%?"
"Validate entry conditions match between backtest and production"
"Are indicator calculations identical in both implementations?"
```

---

### 3. `pattern-researcher`
**Purpose**: Discovers and tests new trading patterns in historical data

**Use when:**
- Exploring new trading opportunities
- Testing pattern hypotheses (volume profile, multi-timeframe confluence)
- Validating pattern performance with backtests
- Systematically improving strategy edge
- Documenting pattern discoveries (V5.XX style)

**Example prompts:**
```
"Research volume accumulation pattern and test on historical data"
"Test if multi-timeframe confluence improves win rate"
"Analyze order flow imbalance patterns"
"Discover which patterns predict successful trades"
"Document and test the BB squeeze pattern hypothesis"
```

---

### 4. `strategy-optimizer`
**Purpose**: Optimizes strategy parameters through grid search and walk-forward validation

**Use when:**
- Fine-tuning strategy parameters (ROC_MIN, VOL_MULTIPLIER, TRAILING_DISTANCE)
- Adapting to different market regimes (low/high volatility)
- Preventing overfitting with out-of-sample testing
- Finding optimal parameter combinations
- Validating parameter robustness before deployment

**Example prompts:**
```
"Optimize trailing stop distance parameter"
"Find optimal ROC threshold for current market conditions"
"Test parameters across bull and bear market regimes"
"Grid search for best entry parameter combination"
"Validate parameter robustness with walk-forward analysis"
```

---

### 5. `ml-signal-scorer` 🤖
**Purpose**: Integrates machine learning for signal scoring (use after baseline strategy is profitable)

**Use when:**
- Ready to enhance signal quality with ML (≥1,000 trades collected)
- Baseline strategy already profitable (>55% win rate)
- Exhausted manual optimization opportunities
- Want to discover subtle, non-linear patterns
- Need adaptive signal scoring

**Example prompts:**
```
"Export historical trades for ML training"
"Train XGBoost model to predict win probability"
"Integrate ML scoring into signal ranker"
"Compare ML-enhanced strategy with manual baseline"
"Set up monthly model retraining pipeline"
```

**⚠️ Important**: Use this skill AFTER establishing a profitable baseline. ML enhances good strategies but can't fix bad ones.

---

## 🚀 Quick Start

### Installation

Skills are already installed in this project at:
```
.claude/skills/
├── backtest-analyzer/
│   └── SKILL.md
├── code-consistency-checker/
│   └── SKILL.md
├── pattern-researcher/
│   └── SKILL.md
├── strategy-optimizer/
│   └── SKILL.md
└── ml-signal-scorer/
    └── SKILL.md
```

**For team members**: Pull latest code to get the skills automatically
```bash
git pull
```

### First Time Usage

1. **Restart Claude Code** (required to load new skills)
   - Exit Claude Code
   - Reopen your project

2. **Verify skills are loaded**
   ```
   Ask Claude: "What skills are available?"
   ```

   You should see:
   - backtest-analyzer
   - code-consistency-checker
   - pattern-researcher
   - strategy-optimizer
   - ml-signal-scorer

3. **Test a skill**
   ```
   Ask Claude: "Analyze the backtest results in backend/data/"
   ```

   Claude will automatically use the `backtest-analyzer` skill.

---

## 📖 Detailed Usage Guide

### Using `backtest-analyzer`

#### Basic Analysis

**Prompt:**
```
Analyze the latest backtest results
```

**What Claude will do:**
1. Search for backtest result files (JSON)
2. Load and validate data
3. Calculate performance metrics (ROI, Sharpe, Win Rate, etc.)
4. Identify patterns (exit reasons, symbol performance, time-of-day)
5. Provide actionable recommendations

**Expected output:**
```markdown
# Backtest Analysis Report

## Executive Summary
- Total ROI: +2,683% over 11 months
- Win Rate: 59.9% (excellent)
- Sharpe Ratio: 1.91 (strong risk-adjusted returns)
- Max Drawdown: 31.89% (acceptable but high)
- **Overall Assessment**: EXCELLENT

## Performance Metrics
[Detailed table of all metrics]

## Pattern Analysis
[Exit reasons, symbol performance, time patterns]

## Recommendations
🔴 CRITICAL: Max drawdown is 31.89%. Add circuit breaker...
🟡 HIGH: DOGE shows 45% win rate. Consider removing...
🟢 MEDIUM: Trades > 3h have 68% WR. Add min hold time...
```

---

#### Comparing Multiple Backtests

**Prompt:**
```
Compare V5.13 backtest with V5.34 and tell me which is better
```

**What Claude will do:**
1. Find both backtest result files
2. Extract metrics from each
3. Create side-by-side comparison table
4. Highlight significant differences (> 10% change)
5. Recommend which version to use

**Expected output:**
```markdown
## Backtest Comparison: V5.13 vs V5.34

| Metric | V5.13 | V5.34 | Winner |
|--------|-------|-------|--------|
| ROI | +2,683% | +501% | V5.13 ✓ |
| Win Rate | 59.9% | 59.2% | V5.13 ✓ |
| Sharpe | 1.91 | 1.52 | V5.13 ✓ |
| Trades | 2,103 | 1,089 | V5.13 ✓ |

**Conclusion**: V5.13 significantly outperforms V5.34
**Recommendation**: Use V5.13 for production deployment
```

---

#### Investigating Specific Issues

**Prompt:**
```
Why is DOGE/USDT showing such poor performance in the backtest?
```

**What Claude will do:**
1. Filter backtest trades to DOGE only
2. Analyze win rate, avg PnL, exit reasons
3. Compare with other symbols
4. Identify specific patterns causing losses

**Expected output:**
```markdown
## DOGE/USDT Performance Analysis

**Summary**:
- Trades: 156
- Win Rate: 45% (vs 59.9% average)
- Avg PnL: -0.12% (vs +1.28% average)
- Status: UNDERPERFORMER

**Root Cause**:
- High volatility causing premature stop loss hits (67% of losses)
- Low liquidity causing slippage > 0.15% (vs 0.05% on BTC)
- Momentum reversals more frequent (memecoin volatility)

**Recommendation**:
🔴 Remove DOGE from trading universe
- Expected impact: +3-5% total ROI improvement
- Update: SYMBOLS_TO_TRADE array in config
```

---

### Using `code-consistency-checker`

#### Pre-Deployment Validation

**Prompt:**
```
Check if my backtest and production code are consistent before I deploy V5.34
```

**What Claude will do:**
1. Locate backtest code (`backtestService.ts`)
2. Locate production code (`simpleAgent.ts`)
3. Compare entry logic, exit logic, indicators, position sizing
4. Verify both use shared strategy files (`momentumSimple.ts`)
5. Flag any divergences

**Expected output:**
```markdown
# Code Consistency Check Report

**Status**: ✓ PASS

## Validation Checklist
- ✓ Entry conditions identical
- ✓ Exit conditions identical
- ✓ Indicator calculations identical
- ✓ Signal scoring identical
- ✓ Position sizing identical
- ✓ Data sources consistent
- ✓ No look-ahead bias detected
- ✓ Cost models realistic

## Findings
✓ Both implementations import from shared momentumSimple.ts
✓ Both use calculateSignalScore() from signalRanker.ts
✓ Bollinger Bands use (20, 2) in both
✓ ROC thresholds match: LONG 1.75%, SHORT -1.5%
✓ Trailing stop identical: 0.8% activation, 0.5% distance

**Conclusion**: Code is consistent. Safe to deploy V5.34 to production.
```

---

#### Debugging Live vs Backtest Discrepancy

**Prompt:**
```
My backtest predicted +200% but I'm down 10% after 2 weeks live. What's wrong?
```

**What Claude will do:**
1. Run comprehensive consistency check
2. Look for common issues:
   - Look-ahead bias
   - Different indicator parameters
   - Missing filters in production
   - Unrealistic cost assumptions in backtest
3. Identify which divergence caused the gap
4. Provide exact fix

**Expected output:**
```markdown
# Discrepancy Investigation

## Issues Found

🔴 CRITICAL: Entry condition divergence detected

**BACKTEST** (backtestService.ts:456):
```typescript
const signal = checkMomentumSignal(candles, btcCandles, MomentumConfig, 'LONG');
// Uses MomentumConfig.LONG.ROC_MIN = 1.75%
```

**PRODUCTION** (simpleAgent.ts:892):
```typescript
const signal = checkMomentumSignal(candles, btcCandles, {
  ...MomentumConfig,
  LONG: { ...MomentumConfig.LONG, ROC_MIN: 2.5 }
}, 'LONG');
// Uses OVERRIDDEN ROC_MIN = 2.5%
```

**IMPACT**:
- Backtest generates signals at 1.75% ROC
- Production requires 2.5% ROC (43% higher threshold)
- Production generates 60% fewer signals than backtest predicted
- Backtest results are INVALID for predicting live performance

**FIX**:
```typescript
// Change simpleAgent.ts:892 to:
const signal = checkMomentumSignal(candles, btcCandles, MomentumConfig, 'LONG');
// Remove override, use default config
```

**NEXT STEPS**:
1. Apply fix immediately
2. Re-run 24-month backtest with corrected code
3. Validate new backtest before resuming live trading
```

---

#### Validating Strategy Changes

**Prompt:**
```
I just changed the trailing stop distance. Verify both backtest and production have the same value.
```

**What Claude will do:**
1. Find trailing stop logic in both files
2. Extract parameters (activation threshold, distance, confirmation candles)
3. Compare line-by-line
4. Report any differences

**Expected output:**
```markdown
## Trailing Stop Comparison

**BACKTEST** (backtestService.ts:678-695):
```typescript
TRAILING_STOP: {
  ACTIVATION_THRESHOLD: 0.008,  // 0.8%
  DISTANCE: 0.005,              // 0.5%
  CONFIRMATION_CANDLES: 2,
  LOW_VOL_DISTANCE: 0.003,
  HIGH_VOL_DISTANCE: 0.008
}
```

**PRODUCTION** (simpleAgent.ts:1234-1251):
```typescript
TRAILING_STOP: {
  ACTIVATION_THRESHOLD: 0.008,  // 0.8%
  DISTANCE: 0.005,              // 0.5%
  CONFIRMATION_CANDLES: 2,
  LOW_VOL_DISTANCE: 0.003,
  HIGH_VOL_DISTANCE: 0.008
}
```

✓ **PASS**: Trailing stop parameters are identical
```

---

## 🎯 Common Workflows

### Workflow 1: Developing a New Strategy Version

```bash
# 1. Make changes to strategy
# Edit backend/src/strategies/momentumSimple.ts

# 2. Run backtest
npm run analyze:performance

# 3. Analyze results
Ask Claude: "Analyze the backtest results and compare with V5.13 baseline"

# 4. Validate code consistency
Ask Claude: "Check if backtest and production code are consistent"

# 5. If good, deploy to paper trading
# If issues found, iterate from step 1
```

---

### Workflow 2: Investigating Poor Live Performance

```bash
# 1. Check for code divergence
Ask Claude: "Check code consistency and explain why live differs from backtest"

# 2. Fix any issues found

# 3. Re-run backtest with fixed code
npm run analyze:performance

# 4. Analyze new backtest
Ask Claude: "Analyze the corrected backtest and validate it's realistic"

# 5. Resume live trading only if backtest validates strategy
```

---

### Workflow 3: Weekly Performance Review

```bash
# 1. Run fresh backtest on latest data
npm run update-backtest-data  # Get latest historical data
npm run analyze:performance

# 2. Compare with previous week
Ask Claude: "Compare this week's backtest with last week's results"

# 3. Review any degradation
Ask Claude: "If win rate dropped, analyze what changed in market conditions"

# 4. Validate code hasn't drifted
Ask Claude: "Quick consistency check on entry and exit logic"
```

---

## 💡 Pro Tips

### Tip 1: Combine Skills for Maximum Insight

**Prompt:**
```
First check code consistency, then analyze the backtest results
```

Claude will:
1. Run `code-consistency-checker` first
2. Report any issues
3. Then run `backtest-analyzer`
4. Cross-reference findings (e.g., "Backtest shows high ROI but code has look-ahead bias")

---

### Tip 2: Ask Follow-Up Questions

Skills maintain context, so you can drill down:

**Conversation:**
```
You: "Analyze the latest backtest"
Claude: [Provides full analysis]

You: "Show me the 5 worst losing trades from that backtest"
Claude: [Filters to worst trades, explains why they lost]

You: "What pattern do those 5 trades have in common?"
Claude: [Identifies pattern: all during BTC regime changes]

You: "How can I avoid those losses?"
Claude: [Suggests adding regime change confirmation filter]
```

---

### Tip 3: Use for Hypothesis Testing

**Prompt:**
```
I think trades held longer than 3 hours have higher win rates.
Analyze the backtest to test this hypothesis.
```

Claude will:
1. Load backtest trades
2. Group by duration (< 3h vs > 3h)
3. Compare win rates, avg PnL, profit factor
4. Provide statistical validation
5. Suggest whether to add min hold time filter

---

### Tip 4: Automate with Scripts

Create a script that asks Claude to run checks:

```bash
# .claude/hooks/pre-commit.sh
#!/bin/bash
echo "Checking code consistency before commit..."
claude-code ask "Quick code consistency check on changed files"
```

---

## 🔧 Customization

### Adding More Skills

To add new skills:

1. Create directory:
   ```bash
   mkdir .claude/skills/your-skill-name
   ```

2. Create `SKILL.md`:
   ```yaml
   ---
   name: your-skill-name
   description: What it does and when to use it
   allowed-tools: Read, Grep, Glob
   ---

   # Your Skill Name

   Instructions for Claude...
   ```

3. Restart Claude Code

4. Test:
   ```
   Ask Claude: "What skills are available?"
   ```

### Modifying Existing Skills

Edit the `SKILL.md` files directly:

```bash
# Edit backtest analyzer
code .claude/skills/backtest-analyzer/SKILL.md

# After saving, restart Claude Code to reload
```

---

## 📊 Skill Performance

Track how skills help your workflow:

| Skill | Time Saved | Tasks Automated |
|-------|------------|-----------------|
| backtest-analyzer | ~30 min/backtest | Manual metric calculation, pattern finding, comparison tables |
| code-consistency-checker | ~45 min/deployment | Manual code review, parameter verification, divergence detection |

**Total**: ~1.5 hours saved per strategy iteration

---

## 🐛 Troubleshooting

### Skills Not Loading

**Symptom**: Claude doesn't recognize skill prompts

**Solution**:
```bash
# 1. Verify files exist
ls -la .claude/skills/*/SKILL.md

# 2. Check YAML frontmatter is valid (no tabs, starts on line 1)
head -20 .claude/skills/backtest-analyzer/SKILL.md

# 3. Restart Claude Code
# Exit and reopen

# 4. Test
Ask Claude: "What skills are available?"
```

---

### Skill Triggers Incorrectly

**Symptom**: Wrong skill activates for your prompt

**Solution**:
- Make prompts more specific
- Use skill name in prompt: "Use backtest-analyzer to..."
- Refine skill description in SKILL.md to be more precise

---

### Skill Output Too Long

**Symptom**: Skill generates 10-page report when you wanted summary

**Solution**:
```
Ask Claude: "Analyze backtest but keep it under 1 page"
```

Or modify SKILL.md to be more concise by default.

---

## 📚 Additional Resources

### Related Documentation

- [Claude Code Skills Official Docs](https://code.claude.com/docs/en/skills.md)
- [Agent Skills Best Practices](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices)

### Remezz System Documentation

- Backend Strategy: `backend/src/strategies/README.md` (if exists)
- Backtest Service: `backend/src/services/backtestService.ts` (inline comments)
- Momentum Strategy: `backend/src/strategies/momentumSimple.ts` (V5.XX version comments)

### Getting Help

**Ask Claude:**
```
"How do I use the backtest-analyzer skill?"
"What's the difference between backtest-analyzer and code-consistency-checker?"
"Show me example prompts for analyzing backtests"
```

**GitHub Issues:**
If you find bugs in the skills, report them in this repo.

---

## 🎉 Next Steps

1. **Try the skills**:
   ```
   "Analyze the latest backtest results"
   "Check code consistency"
   ```

2. **Review outputs**: See if they provide value

3. **Customize**: Modify SKILL.md files to match your workflow

4. **Build more skills**: Add skills for other tasks (deployment, monitoring, alerting)

5. **Share with team**: Commit `.claude/skills/` to git so everyone benefits

---

## 📝 Changelog

### 2026-01-01: Initial Release
- Added `backtest-analyzer` skill
- Added `code-consistency-checker` skill
- Created comprehensive documentation

---

**Happy Trading! 🚀**

These skills are designed to help you iterate faster, catch bugs earlier, and deploy strategies with confidence. Use them often and refine them to match your workflow.
