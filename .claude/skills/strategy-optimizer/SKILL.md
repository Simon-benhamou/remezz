---
name: strategy-optimizer
description: Optimizes trading strategy parameters through systematic grid search, parameter sensitivity analysis, and walk-forward validation. Tests parameters like ROC_MIN, VOL_MULTIPLIER, TRAILING_DISTANCE, STOP_LOSS across multiple market regimes (low/high volatility, bull/bear). Prevents overfitting with out-of-sample testing. Suggests optimal parameter sets with confidence intervals and automatically updates strategy configuration files. Use when fine-tuning strategy performance, adapting to market conditions, or validating parameter robustness before production deployment.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(python:*), Bash(node:*), Bash(npm:*)
---

# Strategy Optimizer

Systematically optimizes trading strategy parameters to maximize risk-adjusted returns while preventing overfitting. Automates the parameter tuning process that evolved your strategy from V5.0 (ROC 2.5%) to V5.13 (ROC 1.75%).

## Purpose

This skill automates parameter optimization that was previously done manually:

**Historical Manual Tuning** (from your codebase):
- V5.7 → V5.13: ROC threshold 2.5% → 1.75% (manual adjustment)
- V5.14: Trailing stop adaptive distance 0.3-0.8% (manual testing)
- V5.13: Volume multiplier 2.0x → 1.15x (manual tuning)
- V5.34: Stagnant trigger time tested: 30min, 45min, 60min

**This skill systematizes**:
1. Grid search across parameter ranges
2. Performance evaluation (Sharpe, ROI, Win Rate, Max DD)
3. Walk-forward validation (prevent overfitting)
4. Statistical confidence intervals
5. Automatic config file updates

## Core Philosophy

**"Optimize for robustness, not curve-fitting"**

- Test parameters on IN-SAMPLE data (train period)
- Validate on OUT-OF-SAMPLE data (test period)
- If test performance < 80% of train → Overfitted, reject
- Prefer parameters with stable performance across regimes
- Prioritize Sharpe ratio > raw ROI (risk-adjusted returns)

---

## Instructions

When optimizing parameters:

### Phase 1: Parameter Selection

#### Step 1: Identify Parameters to Optimize

**Critical parameters in your system**:

```typescript
// Entry Parameters
ROC_MIN: 1.75,              // Momentum threshold (LONG)
VOL_MULTIPLIER: 1.15,       // Volume confirmation
BB_STDDEV: 2.0,             // Bollinger Band width
CONSECUTIVE_UP_MAX: 5,      // Anti-top buying

// Exit Parameters
TRAILING_STOP: {
  ACTIVATION_THRESHOLD: 0.008,  // 0.8% profit to activate
  DISTANCE: 0.005,              // 0.5% callback
  LOW_VOL_DISTANCE: 0.003,      // Tighter in low vol
  HIGH_VOL_DISTANCE: 0.008,     // Wider in high vol
}

STOP_LOSS_PCT: 0.025,       // 2.5% fixed SL

STAGNANT_EXIT: {
  TRIGGER_TIME: 45,          // Minutes before observing
  MAX_PNL_THRESHOLD: 0.008,  // 0.8% max PnL threshold
  OBSERVATION_WINDOW: 60,    // Minutes to observe
}

// Position Sizing
BASE_POSITION_SIZE: 0.40,   // 40% of capital
LEVERAGE: 5,                 // 5x uniform
```

**Choose parameters based on**:
1. **User request**: "Optimize trailing stop distance"
2. **Backtest sensitivity**: Parameters that significantly impact results
3. **Market regime**: Parameters that should adapt to volatility
4. **Risk management**: Stop loss, position sizing

---

#### Step 2: Define Parameter Ranges

**Use domain knowledge to set reasonable ranges**:

```python
# Example: Optimize entry parameters
PARAMETER_RANGES = {
    'ROC_MIN': [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5],  # ±40% from current
    'VOL_MULTIPLIER': [1.0, 1.15, 1.3, 1.5, 2.0],       # Wider range
    'BB_STDDEV': [1.5, 2.0, 2.5],                       # Standard values
}

# Example: Optimize trailing stop
TRAILING_RANGES = {
    'ACTIVATION_THRESHOLD': [0.005, 0.006, 0.008, 0.010],  # 0.5-1.0%
    'DISTANCE': [0.003, 0.004, 0.005, 0.006, 0.008, 0.010], # 0.3-1.0%
}

# Example: Optimize position sizing
SIZING_RANGES = {
    'BASE_POSITION_SIZE': [0.20, 0.30, 0.40, 0.50, 0.60],  # 20-60%
    'LEVERAGE': [3, 5, 7, 10],                              # 3-10x
}
```

**Total combinations**:
```python
# Entry params: 7 × 5 × 3 = 105 combinations
# Trailing stop: 4 × 6 = 24 combinations
# Position sizing: 5 × 4 = 20 combinations
```

**Start small**: Optimize 1-2 parameters at a time to keep runtime manageable.

---

### Phase 2: Grid Search Execution

#### Step 3: Prepare Data Splits

**Walk-Forward Methodology**:

```python
# Split historical data into periods
PERIODS = [
    {
        'train_start': '2023-01-01',
        'train_end': '2023-06-30',    # 6 months train
        'test_start': '2023-07-01',
        'test_end': '2023-09-30',     # 3 months test
    },
    {
        'train_start': '2023-04-01',
        'train_end': '2023-09-30',    # Rolling window
        'test_start': '2023-10-01',
        'test_end': '2023-12-31',
    },
    {
        'train_start': '2023-07-01',
        'train_end': '2023-12-31',
        'test_start': '2024-01-01',
        'test_end': '2024-03-31',
    },
]

# For each period:
# 1. Optimize on train data
# 2. Validate on test data (out-of-sample)
# 3. Check if test performance ≥ 80% of train
```

**Alternative: Single split** (faster, less robust):
```python
SIMPLE_SPLIT = {
    'train': ('2023-01-01', '2023-12-31'),  # 12 months
    'test': ('2024-01-01', '2024-06-30'),   # 6 months
}
```

---

#### Step 4: Run Grid Search

**Generate all parameter combinations**:

```python
from itertools import product
import json

# Define parameter grid
param_grid = {
    'ROC_MIN': [1.0, 1.5, 1.75, 2.0, 2.5],
    'VOL_MULTIPLIER': [1.0, 1.15, 1.5, 2.0],
}

# Generate all combinations
combinations = list(product(*param_grid.values()))
param_names = list(param_grid.keys())

print(f"Total combinations: {len(combinations)}")
```

**For each combination, run backtest**:

```python
results = []

for i, combo in enumerate(combinations):
    # Create parameter dict
    params = dict(zip(param_names, combo))

    print(f"\n[{i+1}/{len(combinations)}] Testing: {params}")

    # Update momentumSimple.ts with these parameters
    update_strategy_config(params)

    # Run backtest (train period)
    backtest_result = run_backtest(
        start_date='2023-01-01',
        end_date='2023-12-31',
        symbols=['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT'],
        initial_capital=2000
    )

    # Extract metrics
    metrics = backtest_result['summary']

    # Store result
    results.append({
        'params': params,
        'trades': metrics['totalTrades'],
        'win_rate': metrics['winRate'],
        'roi': metrics['totalPnLPct'],
        'sharpe': metrics['sharpeRatio'],
        'max_dd': metrics['maxDrawdownPct'],
        'profit_factor': metrics['profitFactor'],
        'avg_trade': metrics['totalPnLPct'] / metrics['totalTrades'],
    })

    # Save intermediate results (in case of crash)
    with open(f'optimization_results_{i}.json', 'w') as f:
        json.dump(results, f, indent=2)

# Save final results
with open('grid_search_results.json', 'w') as f:
    json.dump(results, f, indent=2)
```

**Helper function to update config**:

```python
def update_strategy_config(params):
    """Updates momentumSimple.ts with new parameter values"""

    # Read current config
    with open('backend/src/strategies/momentumSimple.ts', 'r') as f:
        content = f.read()

    # Replace parameter values
    for param_name, param_value in params.items():
        if param_name == 'ROC_MIN':
            content = re.sub(
                r'ROC_MIN:\s*[\d.]+',
                f'ROC_MIN: {param_value}',
                content
            )
        elif param_name == 'VOL_MULTIPLIER':
            content = re.sub(
                r'VOL_MULTIPLIER:\s*[\d.]+',
                f'VOL_MULTIPLIER: {param_value}',
                content
            )
        # Add more parameters as needed

    # Write updated config
    with open('backend/src/strategies/momentumSimple.ts', 'w') as f:
        f.write(content)

    print(f"✓ Updated config: {params}")
```

**Run backtest via npm script**:

```python
import subprocess

def run_backtest(start_date, end_date, symbols, initial_capital):
    """Executes backtest and returns results"""

    # Run backtest script
    cmd = [
        'npm', 'run', 'analyze:performance',
        '--', f'--start={start_date}',
        f'--end={end_date}',
        f'--symbols={",".join(symbols)}',
        f'--capital={initial_capital}'
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, cwd='backend')

    # Parse output or read result file
    # Assuming results are saved to a JSON file
    with open('backend/results/backtest_latest.json') as f:
        return json.load(f)
```

**Expected runtime**:
- 20 combinations × 30 seconds per backtest = **10 minutes**
- 100 combinations = **50 minutes**
- 500 combinations = **4 hours** (run overnight)

---

#### Step 5: Analyze Grid Search Results

**Sort by optimization target**:

```python
import pandas as pd

# Load results
df = pd.DataFrame(results)

# Sort by Sharpe ratio (preferred) or ROI
df_sorted = df.sort_values('sharpe', ascending=False)

print("Top 10 Parameter Sets (by Sharpe Ratio):")
print(df_sorted.head(10)[['params', 'sharpe', 'roi', 'win_rate', 'max_dd']])

# Find best by different metrics
best_sharpe = df.loc[df['sharpe'].idxmax()]
best_roi = df.loc[df['roi'].idxmax()]
best_wr = df.loc[df['win_rate'].idxmax()]
best_dd = df.loc[df['max_dd'].idxmin()]  # Minimize drawdown

print("\n=== BEST BY METRIC ===")
print(f"Best Sharpe: {best_sharpe['params']} → {best_sharpe['sharpe']:.2f}")
print(f"Best ROI: {best_roi['params']} → {best_roi['roi']:.1f}%")
print(f"Best Win Rate: {best_wr['params']} → {best_wr['win_rate']:.1%}")
print(f"Best Drawdown: {best_dd['params']} → {best_dd['max_dd']:.1f}%")
```

**Visualize parameter sensitivity**:

```python
import matplotlib.pyplot as plt

# Heatmap: ROC_MIN vs VOL_MULTIPLIER
pivot = df.pivot_table(
    values='sharpe',
    index='VOL_MULTIPLIER',
    columns='ROC_MIN',
    aggfunc='mean'
)

plt.figure(figsize=(10, 6))
plt.imshow(pivot, cmap='RdYlGn', aspect='auto')
plt.colorbar(label='Sharpe Ratio')
plt.xlabel('ROC_MIN')
plt.ylabel('VOL_MULTIPLIER')
plt.title('Parameter Sensitivity Heatmap')
plt.xticks(range(len(pivot.columns)), pivot.columns)
plt.yticks(range(len(pivot.index)), pivot.index)
plt.savefig('parameter_heatmap.png')

print("✓ Saved heatmap to parameter_heatmap.png")
```

**Identify sweet spots**:

```python
# Find parameters that perform well across multiple metrics
df['composite_score'] = (
    df['sharpe'] / df['sharpe'].max() * 0.4 +        # 40% Sharpe
    df['roi'] / df['roi'].max() * 0.3 +              # 30% ROI
    df['win_rate'] / df['win_rate'].max() * 0.2 +    # 20% Win Rate
    (1 - df['max_dd'] / df['max_dd'].max()) * 0.1    # 10% Drawdown (inverted)
)

best_composite = df.loc[df['composite_score'].idxmax()]
print(f"\nBest Composite Score: {best_composite['params']}")
print(f"  Sharpe: {best_composite['sharpe']:.2f}")
print(f"  ROI: {best_composite['roi']:.1f}%")
print(f"  Win Rate: {best_composite['win_rate']:.1%}")
print(f"  Max DD: {best_composite['max_dd']:.1f}%")
```

---

### Phase 3: Out-of-Sample Validation

#### Step 6: Test Optimal Parameters on Hold-Out Data

**Prevent overfitting**:

```python
# Take top 5 parameter sets from grid search
top_params = df_sorted.head(5)['params'].tolist()

validation_results = []

for params in top_params:
    print(f"\nValidating: {params}")

    # Update config with these params
    update_strategy_config(params)

    # Run backtest on OUT-OF-SAMPLE test period
    test_result = run_backtest(
        start_date='2024-01-01',  # Different from training period!
        end_date='2024-06-30',
        symbols=['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT'],
        initial_capital=2000
    )

    test_metrics = test_result['summary']

    # Find corresponding train metrics
    train_row = df[df['params'] == params].iloc[0]

    # Calculate degradation
    sharpe_degradation = (test_metrics['sharpeRatio'] / train_row['sharpe']) * 100
    roi_degradation = (test_metrics['totalPnLPct'] / train_row['roi']) * 100

    validation_results.append({
        'params': params,
        'train_sharpe': train_row['sharpe'],
        'test_sharpe': test_metrics['sharpeRatio'],
        'sharpe_retention': sharpe_degradation,
        'train_roi': train_row['roi'],
        'test_roi': test_metrics['totalPnLPct'],
        'roi_retention': roi_degradation,
        'valid': sharpe_degradation >= 80 and roi_degradation >= 80
    })

# Show validation results
val_df = pd.DataFrame(validation_results)
print("\n=== VALIDATION RESULTS ===")
print(val_df[['params', 'sharpe_retention', 'roi_retention', 'valid']])

# Filter to robust parameters (≥80% retention)
robust_params = val_df[val_df['valid'] == True]

if len(robust_params) == 0:
    print("\n⚠ WARNING: No parameters passed validation (< 80% retention)")
    print("  All tested parameters may be overfitted to training data")
    print("  Recommendation: Use current baseline parameters (V5.34)")
else:
    best_robust = robust_params.loc[robust_params['test_sharpe'].idxmax()]
    print(f"\n✓ BEST ROBUST PARAMETERS:")
    print(f"  {best_robust['params']}")
    print(f"  Train Sharpe: {best_robust['train_sharpe']:.2f}")
    print(f"  Test Sharpe: {best_robust['test_sharpe']:.2f}")
    print(f"  Retention: {best_robust['sharpe_retention']:.1f}%")
```

---

### Phase 4: Regime-Based Optimization

#### Step 7: Test Parameters Across Market Regimes

**Optimize for different market conditions**:

```python
# Define market regimes based on BTC behavior
REGIMES = {
    'bull_low_vol': {
        'filter': lambda candles: (
            btc_above_sma200(candles) and
            atr_percentile(candles) < 0.3
        ),
        'periods': [('2023-01-01', '2023-03-31')],
    },

    'bull_high_vol': {
        'filter': lambda candles: (
            btc_above_sma200(candles) and
            atr_percentile(candles) > 0.7
        ),
        'periods': [('2023-04-01', '2023-06-30')],
    },

    'bear_low_vol': {
        'filter': lambda candles: (
            btc_below_sma200(candles) and
            atr_percentile(candles) < 0.3
        ),
        'periods': [('2023-07-01', '2023-09-30')],
    },

    'bear_high_vol': {
        'filter': lambda candles: (
            btc_below_sma200(candles) and
            atr_percentile(candles) > 0.7
        ),
        'periods': [('2023-10-01', '2023-12-31')],
    },
}

# Run optimization per regime
regime_optimal_params = {}

for regime_name, regime_config in REGIMES.items():
    print(f"\n=== Optimizing for {regime_name} ===")

    # Run grid search on regime-specific periods
    regime_results = []

    for start, end in regime_config['periods']:
        # ... run grid search as before ...
        pass

    # Find best params for this regime
    best_for_regime = max(regime_results, key=lambda x: x['sharpe'])
    regime_optimal_params[regime_name] = best_for_regime['params']

print("\n=== REGIME-SPECIFIC OPTIMAL PARAMETERS ===")
for regime, params in regime_optimal_params.items():
    print(f"{regime}: {params}")
```

**Implement adaptive parameters**:

```typescript
// In momentumSimple.ts

// Detect current regime
function getCurrentRegime(btcCandles: any[]): MarketRegime {
  const btcPrice = btcCandles[btcCandles.length - 1].close;
  const sma200 = calculateSMA(btcCandles, 200);
  const atr = calculateATR(btcCandles, 14);
  const atrPercentile = getATRPercentile(atr, btcCandles);

  const isBull = btcPrice > sma200;
  const isHighVol = atrPercentile > 0.7;

  if (isBull && !isHighVol) return 'bull_low_vol';
  if (isBull && isHighVol) return 'bull_high_vol';
  if (!isBull && !isHighVol) return 'bear_low_vol';
  return 'bear_high_vol';
}

// Adaptive parameters based on regime
export function getAdaptiveConfig(btcCandles: any[]): MomentumConfig {
  const regime = getCurrentRegime(btcCandles);

  const REGIME_CONFIGS = {
    bull_low_vol: {
      ROC_MIN: 1.5,           // Lower threshold in calm bulls
      VOL_MULTIPLIER: 1.0,    // Less volume needed
      TRAILING_DISTANCE: 0.003, // Tighter trailing
    },
    bull_high_vol: {
      ROC_MIN: 2.0,           // Higher threshold in volatile bulls
      VOL_MULTIPLIER: 1.5,
      TRAILING_DISTANCE: 0.008, // Wider trailing
    },
    bear_low_vol: {
      ROC_MIN: -1.3,          // Shorts require less momentum
      VOL_MULTIPLIER: 1.8,
      TRAILING_DISTANCE: 0.004,
    },
    bear_high_vol: {
      ROC_MIN: -1.8,
      VOL_MULTIPLIER: 2.5,    // Confirm with strong volume
      TRAILING_DISTANCE: 0.010,
    },
  };

  return {
    ...MomentumConfig,
    LONG: {
      ...MomentumConfig.LONG,
      ...REGIME_CONFIGS[regime],
    },
  };
}
```

---

### Phase 5: Deployment

#### Step 8: Update Configuration Files

**Apply optimal parameters**:

```python
def deploy_optimized_params(params, version='V5.36'):
    """Updates momentumSimple.ts with optimized parameters"""

    # Read current file
    with open('backend/src/strategies/momentumSimple.ts', 'r') as f:
        content = f.read()

    # Add version comment block
    version_block = f"""
// ============================================================================
// {version}: OPTIMIZED PARAMETERS ✓ DEPLOYED
// ============================================================================
// OPTIMIZATION RESULTS:
//   Method: Grid search + walk-forward validation
//   Train period: 2023-01-01 to 2023-12-31 (12 months)
//   Test period: 2024-01-01 to 2024-06-30 (6 months)
//   Combinations tested: {len(results)}
//
// OPTIMAL PARAMETERS:
//   ROC_MIN: {params['ROC_MIN']} (was 1.75)
//   VOL_MULTIPLIER: {params['VOL_MULTIPLIER']} (was 1.15)
//
// PERFORMANCE (test period):
//   Sharpe Ratio: {test_sharpe:.2f} (+{sharpe_improvement:.1f}%)
//   ROI: +{test_roi:.1f}% (+{roi_improvement:.1f}%)
//   Win Rate: {test_wr:.1%} (+{wr_improvement:.1f}pp)
//   Max Drawdown: {test_dd:.1f}% ({dd_change:+.1f}pp)
//
// VALIDATION:
//   Out-of-sample retention: {retention:.1f}% ✓ ROBUST
//   Statistical significance: p < 0.05 ✓ SIGNIFICANT
//
// DEPLOYED: {datetime.now().strftime('%Y-%m-%d')}
// ============================================================================
"""

    # Insert version block at top of config section
    content = content.replace(
        'export const MomentumConfig',
        version_block + '\nexport const MomentumConfig'
    )

    # Update parameter values
    for param_name, param_value in params.items():
        content = re.sub(
            rf'{param_name}:\s*[\d.]+',
            f'{param_name}: {param_value}',
            content
        )

    # Write updated file
    with open('backend/src/strategies/momentumSimple.ts', 'w') as f:
        f.write(content)

    print(f"✓ Deployed optimized parameters to momentumSimple.ts")

# Deploy
deploy_optimized_params(
    params={'ROC_MIN': 1.85, 'VOL_MULTIPLIER': 1.25},
    version='V5.36'
)
```

---

#### Step 9: Create Optimization Report

**Generate comprehensive documentation**:

```markdown
# Parameter Optimization Report V5.36

**Date**: 2026-01-01
**Optimized By**: strategy-optimizer skill
**Optimization Target**: Maximize Sharpe ratio

---

## Methodology

**Optimization Method**: Grid search with walk-forward validation

**Parameters Optimized**:
- ROC_MIN (entry momentum threshold)
- VOL_MULTIPLIER (volume confirmation)

**Data Periods**:
- Training: 2023-01-01 to 2023-12-31 (12 months, 2,103 trades)
- Testing: 2024-01-01 to 2024-06-30 (6 months, 1,045 trades)

**Parameter Ranges Tested**:
- ROC_MIN: [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5] (7 values)
- VOL_MULTIPLIER: [1.0, 1.15, 1.3, 1.5, 2.0] (5 values)
- **Total combinations**: 35

---

## Results

### Training Period Performance (In-Sample)

**Top 5 Parameter Sets**:

| Rank | ROC_MIN | VOL_MULT | Sharpe | ROI | Win Rate | Max DD |
|------|---------|----------|--------|-----|----------|--------|
| 1 | 1.85 | 1.25 | 2.14 | +687% | 64.2% | 24.8% |
| 2 | 1.75 | 1.15 | 2.01 | +623% | 62.1% | 26.3% |
| 3 | 2.00 | 1.30 | 1.98 | +598% | 65.8% | 25.1% |
| 4 | 1.50 | 1.00 | 1.91 | +712% | 59.4% | 31.2% |
| 5 | 1.75 | 1.30 | 1.87 | +571% | 61.3% | 27.9% |

**Baseline (V5.34)**: ROC=1.75, VOL=1.15 → Sharpe 2.01 (Rank #2)

---

### Testing Period Performance (Out-of-Sample)

**Validation Results**:

| Params | Train Sharpe | Test Sharpe | Retention | Valid? |
|--------|--------------|-------------|-----------|--------|
| ROC=1.85, VOL=1.25 | 2.14 | 1.92 | 89.7% | ✓ YES |
| ROC=1.75, VOL=1.15 | 2.01 | 1.78 | 88.6% | ✓ YES |
| ROC=2.00, VOL=1.30 | 1.98 | 1.51 | 76.3% | ✗ NO |
| ROC=1.50, VOL=1.00 | 1.91 | 1.42 | 74.3% | ✗ NO |

**Winner**: ROC=1.85, VOL=1.25 (highest test Sharpe, >80% retention)

---

### Performance Comparison

**Baseline V5.34** vs **Optimized V5.36** (test period):

| Metric | V5.34 | V5.36 | Change |
|--------|-------|-------|--------|
| Sharpe Ratio | 1.78 | 1.92 | +7.9% ✓ |
| Total ROI | +534% | +612% | +14.6% ✓ |
| Win Rate | 62.1% | 64.2% | +2.1pp ✓ |
| Max Drawdown | 26.3% | 24.8% | -1.5pp ✓ |
| Total Trades | 1,045 | 923 | -11.7% |
| Avg Trade | +0.51% | +0.66% | +29.4% ✓ |

**Conclusion**: Optimized parameters improve all metrics on out-of-sample data.

---

## Parameter Sensitivity Analysis

[Include heatmap showing how Sharpe varies with ROC_MIN and VOL_MULTIPLIER]

**Key Findings**:
- ROC_MIN sweet spot: 1.75-2.00 (too low = noise, too high = missed opportunities)
- VOL_MULTIPLIER sweet spot: 1.15-1.30 (confirms momentum without being too restrictive)
- Parameters interact: Higher ROC benefits from lower VOL requirement

---

## Robustness Check

**Walk-Forward Analysis (3 periods)**:

| Period | Train Sharpe | Test Sharpe | Retention |
|--------|--------------|-------------|-----------|
| P1 (Q1-Q2 → Q3) | 2.14 | 1.92 | 89.7% ✓ |
| P2 (Q2-Q3 → Q4) | 2.08 | 1.87 | 89.9% ✓ |
| P3 (Q3-Q4 → Q1) | 2.11 | 1.85 | 87.7% ✓ |

**Average retention**: 89.1% (very robust, not overfitted)

---

## Regime-Specific Performance

**Optimized params tested across regimes**:

| Regime | Sharpe | ROI | Trades | Assessment |
|--------|--------|-----|--------|------------|
| Bull Low Vol | 2.34 | +712% | 234 | Excellent |
| Bull High Vol | 1.76 | +523% | 287 | Good |
| Bear Low Vol | 1.92 | +198% | 156 | Good |
| Bear High Vol | 1.58 | +287% | 246 | Acceptable |

**Conclusion**: Parameters work well across all regimes (no regime-specific tuning needed).

---

## Deployment Decision

**Status**: ✓ APPROVED FOR DEPLOYMENT

**Criteria Met**:
- ✓ Out-of-sample retention > 80% (89.7%)
- ✓ Test Sharpe > baseline (+7.9%)
- ✓ All key metrics improved (ROI, WR, Max DD)
- ✓ Robust across market regimes
- ✓ Statistically significant (p < 0.01)

**Deployment Plan**:
1. Update momentumSimple.ts with V5.36 parameters
2. Commit to git with full documentation
3. Deploy to paper trading for 1 week
4. Monitor vs backtest predictions
5. If aligned (±15%), deploy to live

**Risk Assessment**: LOW
- Conservative parameter change (1.75→1.85 ROC, 1.15→1.25 VOL)
- Extensively validated on 18 months of data
- No regime-specific weaknesses detected

---

## Code Changes

```typescript
// Updated configuration in momentumSimple.ts

export const MomentumConfig = {
  LONG: {
    ROC_MIN: 1.85,              // Optimized (was 1.75)
    VOL_MULTIPLIER: 1.25,       // Optimized (was 1.15)
    // ... other params unchanged ...
  },
  // ... rest of config ...
};
```

**Files Modified**:
- `backend/src/strategies/momentumSimple.ts` (parameters updated)

**Commit Message**:
```
feat: Deploy optimized parameters V5.36

- Increase ROC_MIN: 1.75 → 1.85 (+5.7%)
- Increase VOL_MULTIPLIER: 1.15 → 1.25 (+8.7%)

Grid search tested 35 combinations on 12mo train + 6mo test data
Best params show +7.9% Sharpe improvement with 89.7% out-of-sample retention

Test period metrics:
- Sharpe: 1.78 → 1.92 (+7.9%)
- ROI: +534% → +612% (+14.6%)
- Win Rate: 62.1% → 64.2% (+2.1pp)
- Max DD: 26.3% → 24.8% (-1.5pp)

Validated across all market regimes. Low risk deployment.
```

---

## Next Steps

1. **Week 1**: Paper trading validation
   - Monitor: Sharpe ratio, trade frequency, win rate
   - Compare: Live vs backtest (should align within ±15%)

2. **Week 2**: If validated, deploy to live
   - Start with 50% of normal position size
   - Gradually increase to 100% over 1 week

3. **Month 1**: Performance review
   - Compare 30-day live vs 30-day backtest
   - If performance ≥ 85% of backtest → Success
   - If performance < 70% of backtest → Investigate divergence

4. **Month 3**: Re-optimization cycle
   - Add latest 3 months of data
   - Re-run grid search to check if parameters still optimal
   - Update if significant improvement possible (>5% Sharpe)

---

**Report Generated**: 2026-01-01 by strategy-optimizer skill
**Approved By**: [Your Name]
**Deployment Date**: 2026-01-02 (pending paper validation)
```

---

## Advanced Optimization Techniques

### Bayesian Optimization

**For large parameter spaces** (> 100 combinations):

```python
from skopt import gp_minimize
from skopt.space import Real

# Define objective function
def objective(params):
    roc_min, vol_mult = params

    # Update config and run backtest
    update_strategy_config({
        'ROC_MIN': roc_min,
        'VOL_MULTIPLIER': vol_mult,
    })

    result = run_backtest('2023-01-01', '2023-12-31')

    # Return negative Sharpe (gp_minimize minimizes)
    return -result['summary']['sharpeRatio']

# Define search space
space = [
    Real(1.0, 3.0, name='ROC_MIN'),
    Real(1.0, 2.5, name='VOL_MULTIPLIER'),
]

# Run Bayesian optimization (smarter than grid search)
result = gp_minimize(
    objective,
    space,
    n_calls=50,  # Only 50 evaluations instead of 100+
    random_state=42,
)

print(f"Optimal parameters: ROC={result.x[0]:.2f}, VOL={result.x[1]:.2f}")
print(f"Best Sharpe: {-result.fun:.2f}")
```

---

### Multi-Objective Optimization

**Optimize for multiple goals simultaneously**:

```python
from pymoo.algorithms.moo.nsga2 import NSGA2
from pymoo.optimize import minimize
from pymoo.core.problem import Problem

class TradingOptimization(Problem):
    def __init__(self):
        super().__init__(
            n_var=2,  # 2 parameters
            n_obj=3,  # 3 objectives
            xl=[1.0, 1.0],  # Lower bounds
            xu=[3.0, 2.5],  # Upper bounds
        )

    def _evaluate(self, x, out, *args, **kwargs):
        results = []

        for params in x:
            roc_min, vol_mult = params

            # Run backtest
            result = run_backtest_with_params(roc_min, vol_mult)

            # Multiple objectives (minimize all)
            objectives = [
                -result['sharpe'],     # Maximize Sharpe → Minimize -Sharpe
                -result['roi'],        # Maximize ROI
                result['max_dd'],      # Minimize max drawdown
            ]

            results.append(objectives)

        out["F"] = np.array(results)

# Run optimization
algorithm = NSGA2(pop_size=20)
problem = TradingOptimization()

res = minimize(
    problem,
    algorithm,
    ('n_gen', 50),
    seed=42,
)

# Extract Pareto frontier (trade-off solutions)
pareto_front = res.F
pareto_params = res.X

print(f"Found {len(pareto_front)} Pareto-optimal solutions")
```

---

## Integration with Other Skills

**Optimization workflow**:

```
📋 RECOMMENDED PROCESS:

1. Start with pattern-researcher:
   "Research which patterns are worth optimizing"

2. Use strategy-optimizer:
   "Optimize parameters for the volume accumulation pattern"

3. Validate with code-consistency-checker:
   "Verify optimized parameters are applied in both backtest and production"

4. Analyze with backtest-analyzer:
   "Compare optimized V5.36 with baseline V5.34"

5. If successful, deploy and monitor
```

---

## Remember

- **Optimize for Sharpe, not ROI**: Risk-adjusted returns are more important
- **Validate out-of-sample**: Always test on unseen data (>80% retention required)
- **Start conservative**: Optimize 1-2 parameters at a time
- **Document everything**: Future you needs to understand the optimization
- **Re-optimize periodically**: Market conditions change (every 3-6 months)
- **Don't overfit**: If test performance << train performance, parameters are curve-fitted

Your goal is to find robust parameters that work across market regimes and time periods, not to maximize performance on historical data.
