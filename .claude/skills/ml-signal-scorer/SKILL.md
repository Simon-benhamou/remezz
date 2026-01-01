---
name: ml-signal-scorer
description: Integrates machine learning for signal scoring using XGBoost/LightGBM models. Exports historical trades with features (ROC, volume, BB position, ATR, trend strength), trains models to predict win probability, integrates predictions into signalRanker.ts, validates improvements via backtesting, and automates monthly model retraining. Use when ready to enhance signal quality with ML, after validating baseline strategy performance and collecting sufficient historical data (1000+ trades recommended).
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(python:*), Bash(pip:*), Bash(node:*), Bash(npm:*)
---

# ML Signal Scorer

Enhances signal quality using machine learning to predict trade success probability. Replaces or complements the manual signal scoring in `signalRanker.ts` with ML-learned patterns.

## ⚠️ IMPORTANT: When to Use ML

**DO use ML when**:
- ✓ You have ≥1,000 historical trades with outcomes
- ✓ Baseline strategy is already profitable (>55% win rate)
- ✓ You've exhausted manual pattern optimization
- ✓ You want to discover subtle, non-linear patterns
- ✓ You have computational resources for training

**DON'T use ML when**:
- ✗ You have < 500 trades (insufficient data → overfitting)
- ✗ Baseline strategy is unprofitable (ML can't fix bad logic)
- ✗ You haven't tested manual patterns first
- ✗ You need explainability for every decision
- ✗ You're looking for a "magic solution"

**Philosophy**: ML should enhance an already-good strategy, not fix a broken one.

---

## Current System Analysis

Your existing signal scoring (from `signalRanker.ts`):

```typescript
export function calculateSignalScore(params: {
  roc5: number;
  volumeRatio: number;
  bbPosition: number;
  atrPct: number;
  trendStrength: number;
  side: 'LONG' | 'SHORT';
}): number {
  // Fixed weights
  const weights = {
    roc: 0.25,          // 25% momentum
    volume: 0.20,       // 20% volume confirmation
    bbPosition: 0.25,   // 25% breakout strength
    atr: 0.15,          // 15% volatility
    trend: 0.15,        // 15% trend alignment
  };

  // Linear combination
  const score = (
    normalize(params.roc5, 0, 5) * weights.roc +
    normalize(params.volumeRatio, 1, 3) * weights.volume +
    normalize(params.bbPosition, 0, 2) * weights.bbPosition +
    normalize(params.atrPct, 0, 10) * weights.atr +
    normalize(params.trendStrength, -1, 1) * weights.trend
  );

  return score * 10; // Scale to 0-10
}
```

**Limitations**:
- Fixed weights (don't adapt to market conditions)
- Linear combination (can't learn interactions like "high ROC + low volume = risky")
- Manual normalization ranges
- No consideration of historical performance

**ML improvements**:
- Learn optimal weights from data
- Discover non-linear patterns
- Adapt to changing market regimes
- Predict actual win probability (0-100%) instead of arbitrary score

---

## Instructions

When implementing ML signal scoring:

### Phase 1: Data Preparation

#### Step 1: Export Historical Trades with Features

**Extract trades from backtest results**:

```python
import json
import pandas as pd
from datetime import datetime

# Load backtest results (from previous runs)
with open('results/backtest_v5_34.json') as f:
    backtest = json.load(f)

trades = backtest['trades']

# Convert to DataFrame
df = pd.DataFrame(trades)

# Add target variable (1 = win, 0 = loss)
df['target'] = (df['pnl'] > 0).astype(int)

print(f"Total trades: {len(df)}")
print(f"Win rate: {df['target'].mean():.1%}")
print(f"Class balance: {df['target'].value_counts()}")
```

**Expected output**:
```
Total trades: 2,103
Win rate: 59.9%
Class balance:
1    1259  (wins)
0     844  (losses)
```

---

#### Step 2: Feature Engineering

**Extract entry features from each trade**:

```python
# Features already available in your system
FEATURES = [
    # Momentum features
    'roc5',          # 5-candle rate of change
    'roc10',         # 10-candle rate of change
    'roc20',         # 20-candle rate of change

    # Volume features
    'volumeRatio',   # Current volume / SMA(20)
    'volumeTrend',   # Volume trend (rising/falling last 3 candles)

    # Bollinger Band features
    'bbPosition',    # Distance from upper/lower band
    'bbWidth',       # Band width (volatility proxy)

    # Volatility features
    'atr',           # Average True Range
    'atrPct',        # ATR as % of price

    # Trend features
    'trendStrength', # SMA20 slope
    'sma20Dist',     # Distance from SMA20
    'sma50Dist',     # Distance from SMA50

    # Market regime features
    'btcRegime',     # BTC above/below SMA200 (1/0)
    'btcROC',        # BTC momentum
    'marketVol',     # Overall market volatility

    # Time features
    'hourOfDay',     # Entry hour (0-23)
    'dayOfWeek',     # Day of week (0-6)

    # Symbol features (one-hot encoded)
    'symbol_BTC',
    'symbol_ETH',
    'symbol_SOL',
    # ... etc for each symbol
]

# Add features to DataFrame
# Note: You'll need to re-calculate these from candle data
# or store them during backtest
```

**If features not stored in backtest**, re-calculate from historical candles:

```python
def calculate_features_from_candles(candles, entry_idx):
    """Calculate features at entry point"""

    # Slice candles up to entry point
    entry_candles = candles[:entry_idx + 1]

    closes = [c['close'] for c in entry_candles]
    volumes = [c['volume'] for c in entry_candles]
    highs = [c['high'] for c in entry_candles]
    lows = [c['low'] for c in entry_candles]

    # Calculate indicators
    roc5 = (closes[-1] - closes[-6]) / closes[-6] * 100 if len(closes) > 5 else 0
    roc10 = (closes[-1] - closes[-11]) / closes[-11] * 100 if len(closes) > 10 else 0

    sma20 = np.mean(closes[-20:]) if len(closes) >= 20 else closes[-1]
    sma_vol = np.mean(volumes[-20:]) if len(volumes) >= 20 else volumes[-1]

    volume_ratio = volumes[-1] / sma_vol if sma_vol > 0 else 1

    # Bollinger Bands
    std20 = np.std(closes[-20:]) if len(closes) >= 20 else 0
    upper_bb = sma20 + 2 * std20
    lower_bb = sma20 - 2 * std20
    bb_width = (upper_bb - lower_bb) / sma20 if sma20 > 0 else 0

    # Distance from upper band (for LONG)
    bb_position = (closes[-1] - upper_bb) / sma20 if sma20 > 0 else 0

    # ATR
    atr = calculate_atr(highs, lows, closes, period=14)
    atr_pct = atr / closes[-1] * 100 if closes[-1] > 0 else 0

    # Trend strength (SMA20 slope)
    sma20_prev = np.mean(closes[-25:-5]) if len(closes) >= 25 else sma20
    trend_strength = (sma20 - sma20_prev) / sma20_prev * 100 if sma20_prev > 0 else 0

    return {
        'roc5': roc5,
        'roc10': roc10,
        'volumeRatio': volume_ratio,
        'bbPosition': bb_position,
        'bbWidth': bb_width,
        'atrPct': atr_pct,
        'trendStrength': trend_strength,
        # ... other features
    }

# Apply to all trades
features_list = []
for trade in trades:
    # Load historical candles for this symbol
    candles = load_candles(trade['symbol'], trade['entryTime'])

    # Find entry index
    entry_idx = find_entry_index(candles, trade['entryTime'])

    # Calculate features
    features = calculate_features_from_candles(candles, entry_idx)
    features['target'] = 1 if trade['pnl'] > 0 else 0
    features['pnl'] = trade['pnl']

    features_list.append(features)

# Create features DataFrame
df_features = pd.DataFrame(features_list)
df_features.to_csv('ml_training_data.csv', index=False)

print(f"✓ Exported {len(df_features)} trades with {len(df_features.columns)-1} features")
```

---

#### Step 3: Feature Analysis and Selection

**Analyze feature importance (before training)**:

```python
# Correlation with target
correlations = df_features.corr()['target'].sort_values(ascending=False)
print("Feature correlations with win:")
print(correlations)

# Visualize
import matplotlib.pyplot as plt

plt.figure(figsize=(10, 6))
correlations[1:].plot(kind='barh')  # Exclude target itself
plt.xlabel('Correlation with Win')
plt.title('Feature Importance (Correlation)')
plt.tight_layout()
plt.savefig('feature_correlations.png')
```

**Remove low-value features**:

```python
# Keep features with |correlation| > 0.05
important_features = correlations[abs(correlations) > 0.05].index.tolist()
important_features.remove('target')  # Don't use target as feature!

print(f"Selected {len(important_features)} important features:")
print(important_features)

# Create final training data
X = df_features[important_features]
y = df_features['target']
```

---

### Phase 2: Model Training

#### Step 4: Train/Test Split

**Use time-based split** (not random!):

```python
# Sort by entry time
df_features = df_features.sort_values('entryTime')

# Split: First 70% train, last 30% test
split_idx = int(len(df_features) * 0.7)

train_df = df_features.iloc[:split_idx]
test_df = df_features.iloc[split_idx:]

X_train = train_df[important_features]
y_train = train_df['target']

X_test = test_df[important_features]
y_test = test_df['target']

print(f"Train: {len(X_train)} trades ({y_train.mean():.1%} win rate)")
print(f"Test: {len(X_test)} trades ({y_test.mean():.1%} win rate)")
```

**Why time-based?**
- Prevents look-ahead bias (don't train on future, test on past)
- Simulates realistic deployment (trained on old data, predict new data)
- More conservative estimate of performance

---

#### Step 5: Train XGBoost Model

**Install dependencies**:

```bash
pip install xgboost scikit-learn matplotlib pandas numpy
```

**Train model**:

```python
import xgboost as xgb
from sklearn.metrics import (
    accuracy_score, roc_auc_score, classification_report,
    confusion_matrix, roc_curve
)

# Create XGBoost classifier
model = xgb.XGBClassifier(
    n_estimators=100,        # Number of trees
    max_depth=5,             # Max tree depth (prevent overfitting)
    learning_rate=0.1,       # Step size
    subsample=0.8,           # Sample 80% of data per tree
    colsample_bytree=0.8,    # Sample 80% of features per tree
    random_state=42,
    eval_metric='logloss',
)

# Train model
model.fit(
    X_train, y_train,
    eval_set=[(X_train, y_train), (X_test, y_test)],
    verbose=10,  # Print progress every 10 trees
)

print("✓ Model trained")
```

---

#### Step 6: Evaluate Model Performance

**Predictions on test set**:

```python
# Predict probabilities
y_pred_proba = model.predict_proba(X_test)[:, 1]  # Probability of win

# Predict classes (threshold = 0.5)
y_pred = (y_pred_proba > 0.5).astype(int)

# Metrics
accuracy = accuracy_score(y_test, y_pred)
auc = roc_auc_score(y_test, y_pred_proba)

print(f"\n=== TEST SET PERFORMANCE ===")
print(f"Accuracy: {accuracy:.1%}")
print(f"AUC-ROC: {auc:.3f}")
print(f"\nClassification Report:")
print(classification_report(y_test, y_pred, target_names=['Loss', 'Win']))

# Confusion matrix
cm = confusion_matrix(y_test, y_pred)
print(f"\nConfusion Matrix:")
print(f"              Predicted")
print(f"              Loss  Win")
print(f"Actual Loss   {cm[0,0]:4d} {cm[0,1]:4d}")
print(f"Actual Win    {cm[1,0]:4d} {cm[1,1]:4d}")
```

**Expected output**:
```
=== TEST SET PERFORMANCE ===
Accuracy: 64.2%
AUC-ROC: 0.712

Classification Report:
              precision    recall  f1-score   support

        Loss       0.58      0.52      0.55       253
         Win       0.68      0.73      0.70       377

    accuracy                           0.64       630
   macro avg       0.63      0.63      0.63       630
weighted avg       0.64      0.64      0.64       630

Confusion Matrix:
              Predicted
              Loss  Win
Actual Loss    132  121
Actual Win     103  274
```

**Interpret**:
- **Accuracy 64.2%**: Model correctly predicts 64.2% of trades (baseline: 59.9% always-win)
- **Precision (Win) 68%**: When model predicts win, it's right 68% of time
- **Recall (Win) 73%**: Model catches 73% of actual winning trades
- **AUC 0.712**: Model can discriminate wins/losses (>0.7 is good, >0.8 is excellent)

---

#### Step 7: Analyze Feature Importance

**Which features does the model use?**

```python
# Get feature importance
importance = model.feature_importances_
feature_importance_df = pd.DataFrame({
    'feature': important_features,
    'importance': importance
}).sort_values('importance', ascending=False)

print("\nTop 10 Most Important Features:")
print(feature_importance_df.head(10))

# Plot
plt.figure(figsize=(10, 8))
plt.barh(feature_importance_df['feature'][:15], feature_importance_df['importance'][:15])
plt.xlabel('Importance (Gain)')
plt.title('XGBoost Feature Importance')
plt.gca().invert_yaxis()
plt.tight_layout()
plt.savefig('feature_importance.png')

print("✓ Saved feature_importance.png")
```

**Example output**:
```
Top 10 Most Important Features:
           feature  importance
0             roc5       0.234
1       bbPosition       0.189
2      volumeRatio       0.156
3           atrPct       0.098
4    trendStrength       0.087
5            roc10       0.076
6        btcRegime       0.054
7          bbWidth       0.042
8        hourOfDay       0.031
9       dayOfWeek       0.023
```

**Insights**:
- ROC5 (momentum) is most important (23.4%)
- BB position (breakout strength) second (18.9%)
- Volume ratio third (15.6%)
- Time features (hour, day) have low importance (~5% combined)

---

### Phase 3: Integration

#### Step 8: Export Model for Production

**Save trained model**:

```python
import joblib

# Save model
joblib.dump(model, 'models/signal_scorer_xgb_v1.pkl')

# Save feature list (important for inference!)
with open('models/feature_list_v1.json', 'w') as f:
    json.dump(important_features, f)

# Save training metadata
metadata = {
    'train_date': datetime.now().isoformat(),
    'train_samples': len(X_train),
    'test_samples': len(X_test),
    'train_win_rate': float(y_train.mean()),
    'test_win_rate': float(y_test.mean()),
    'test_accuracy': float(accuracy),
    'test_auc': float(auc),
    'features': important_features,
    'model_type': 'XGBClassifier',
    'model_params': model.get_params(),
}

with open('models/metadata_v1.json', 'w') as f:
    json.dump(metadata, f, indent=2)

print("✓ Model exported to models/signal_scorer_xgb_v1.pkl")
```

---

#### Step 9: Integrate into Signal Ranker

**Create ML predictor wrapper**:

```typescript
// backend/src/services/mlSignalScorer.ts

import * as fs from 'fs';
import { spawn } from 'child_process';

interface MLFeatures {
  roc5: number;
  roc10: number;
  volumeRatio: number;
  bbPosition: number;
  bbWidth: number;
  atrPct: number;
  trendStrength: number;
  btcRegime: number;
  hourOfDay: number;
  // ... other features
}

interface MLPrediction {
  winProbability: number;
  confidence: number;
}

/**
 * ML-based signal scorer using trained XGBoost model
 */
export class MLSignalScorer {
  private modelPath: string;
  private featureList: string[];

  constructor(modelPath = 'models/signal_scorer_xgb_v1.pkl') {
    this.modelPath = modelPath;

    // Load feature list
    const featureListPath = modelPath.replace('.pkl', '_features.json');
    this.featureList = JSON.parse(fs.readFileSync(featureListPath, 'utf8'));
  }

  /**
   * Predict win probability for a signal
   */
  async predict(features: MLFeatures): Promise<MLPrediction> {
    // Convert features to array in correct order
    const featureValues = this.featureList.map(name => {
      return features[name as keyof MLFeatures] || 0;
    });

    // Call Python script to run model inference
    const prediction = await this.runPythonPredictor(featureValues);

    return {
      winProbability: prediction.probability,
      confidence: prediction.confidence,
    };
  }

  /**
   * Run Python model inference
   */
  private async runPythonPredictor(features: number[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const python = spawn('python3', [
        'scripts/ml_predict.py',
        this.modelPath,
        JSON.stringify(features),
      ]);

      let output = '';

      python.stdout.on('data', (data) => {
        output += data.toString();
      });

      python.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Python script failed with code ${code}`));
          return;
        }

        try {
          const result = JSON.parse(output);
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse Python output: ${output}`));
        }
      });
    });
  }
}

/**
 * Calculate ML-enhanced signal score
 * Combines ML prediction with manual scoring for robustness
 */
export async function calculateMLSignalScore(
  features: MLFeatures,
  mlScorer: MLSignalScorer,
  fallbackScore: number
): Promise<number> {
  try {
    // Get ML prediction
    const prediction = await mlScorer.predict(features);

    // Convert probability (0-1) to score (0-10)
    const mlScore = prediction.winProbability * 10;

    // Combine with manual score (70% ML, 30% manual for safety)
    const combinedScore = mlScore * 0.7 + fallbackScore * 0.3;

    return combinedScore;
  } catch (error) {
    console.error('ML prediction failed, using fallback:', error);
    return fallbackScore; // Graceful degradation
  }
}
```

**Python inference script** (`scripts/ml_predict.py`):

```python
#!/usr/bin/env python3
import sys
import json
import joblib
import numpy as np

def main():
    model_path = sys.argv[1]
    features_json = sys.argv[2]

    # Load model
    model = joblib.load(model_path)

    # Parse features
    features = json.loads(features_json)
    X = np.array(features).reshape(1, -1)

    # Predict
    prob = model.predict_proba(X)[0, 1]  # Probability of class 1 (win)

    # Calculate confidence (distance from 0.5)
    confidence = abs(prob - 0.5) * 2  # 0 = uncertain, 1 = very confident

    # Output
    result = {
        'probability': float(prob),
        'confidence': float(confidence),
    }

    print(json.dumps(result))

if __name__ == '__main__':
    main()
```

---

#### Step 10: Update Signal Ranker

**Modify `signalRanker.ts` to use ML**:

```typescript
// backend/src/services/signalRanker.ts

import { MLSignalScorer, calculateMLSignalScore } from './mlSignalScorer.js';

// Initialize ML scorer (singleton)
const mlScorer = new MLSignalScorer('models/signal_scorer_xgb_v1.pkl');

// Flag to enable/disable ML
const USE_ML_SCORING = true; // Set to false to use manual scoring

export async function calculateSignalScore(params: {
  roc5: number;
  volumeRatio: number;
  bbPosition: number;
  atrPct: number;
  trendStrength: number;
  side: 'LONG' | 'SHORT';
}): Promise<number> {
  // Calculate manual score (existing logic)
  const manualScore = calculateManualSignalScore(params);

  // If ML disabled, return manual score
  if (!USE_ML_SCORING) {
    return manualScore;
  }

  // Prepare features for ML
  const mlFeatures = {
    roc5: params.roc5,
    roc10: params.roc10 || 0, // Add if available
    volumeRatio: params.volumeRatio,
    bbPosition: params.bbPosition,
    bbWidth: params.bbWidth || 0,
    atrPct: params.atrPct,
    trendStrength: params.trendStrength,
    btcRegime: params.btcRegime || 1, // Add if available
    hourOfDay: new Date().getUTCHours(),
    // ... other features
  };

  // Get ML-enhanced score
  const mlEnhancedScore = await calculateMLSignalScore(
    mlFeatures,
    mlScorer,
    manualScore // Fallback
  );

  return mlEnhancedScore;
}

/**
 * Original manual scoring (kept for fallback)
 */
function calculateManualSignalScore(params: any): number {
  const weights = {
    roc: 0.25,
    volume: 0.20,
    bbPosition: 0.25,
    atr: 0.15,
    trend: 0.15,
  };

  const score = (
    normalize(params.roc5, 0, 5) * weights.roc +
    normalize(params.volumeRatio, 1, 3) * weights.volume +
    normalize(params.bbPosition, 0, 2) * weights.bbPosition +
    normalize(params.atrPct, 0, 10) * weights.atr +
    normalize(params.trendStrength, -1, 1) * weights.trend
  );

  return score * 10;
}
```

---

### Phase 4: Validation

#### Step 11: Backtest with ML Scoring

**Run backtest with ML enabled**:

```bash
# Update signalRanker.ts: USE_ML_SCORING = true
npm run analyze:performance
```

**Compare with baseline** (manual scoring):

```python
# Load results
with open('results/backtest_v5_34_manual.json') as f:
    manual = json.load(f)

with open('results/backtest_v5_37_ml.json') as f:
    ml = json.load(f)

# Compare metrics
print("| Metric | Manual V5.34 | ML V5.37 | Change |")
print("|--------|--------------|----------|--------|")

metrics = ['totalTrades', 'winRate', 'totalPnLPct', 'sharpeRatio', 'maxDrawdown']
for metric in metrics:
    manual_val = manual['summary'][metric]
    ml_val = ml['summary'][metric]

    change = ((ml_val - manual_val) / manual_val * 100) if manual_val != 0 else 0

    print(f"| {metric} | {manual_val:.2f} | {ml_val:.2f} | {change:+.1f}% |")
```

**Expected improvement**:
```
| Metric | Manual V5.34 | ML V5.37 | Change |
|--------|--------------|----------|--------|
| totalTrades | 1089 | 1156 | +6.2% |
| winRate | 0.599 | 0.642 | +7.2% |
| totalPnLPct | 501.2 | 623.4 | +24.4% |
| sharpeRatio | 1.52 | 1.81 | +19.1% |
| maxDrawdown | 29.1 | 26.3 | -9.6% |
```

**ML should**:
- Increase win rate (+5-10pp)
- Improve Sharpe ratio (+15-25%)
- Reduce max drawdown (better signal selection)
- Similar or slightly more trades (better at finding good signals)

---

### Phase 5: Maintenance

#### Step 12: Model Retraining Pipeline

**Automate monthly retraining**:

```python
#!/usr/bin/env python3
# scripts/retrain_ml_model.py

import sys
from datetime import datetime, timedelta
import pandas as pd
from ml_training_pipeline import (
    export_trades,
    prepare_features,
    train_model,
    evaluate_model,
    export_model,
)

def retrain_model():
    """Retrain ML model with latest data"""

    print("=== ML Model Retraining ===")
    print(f"Date: {datetime.now()}")

    # 1. Export latest trades (last 12 months)
    end_date = datetime.now()
    start_date = end_date - timedelta(days=365)

    print(f"\n1. Exporting trades ({start_date.date()} to {end_date.date()})")
    df = export_trades(start_date, end_date)

    # 2. Prepare features
    print(f"\n2. Preparing features")
    X, y, feature_names = prepare_features(df)

    # 3. Split data (70/30)
    split_idx = int(len(X) * 0.7)
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]

    print(f"   Train: {len(X_train)} trades")
    print(f"   Test: {len(X_test)} trades")

    # 4. Train model
    print(f"\n3. Training XGBoost model")
    model = train_model(X_train, y_train)

    # 5. Evaluate
    print(f"\n4. Evaluating model")
    metrics = evaluate_model(model, X_test, y_test)

    print(f"   Test Accuracy: {metrics['accuracy']:.1%}")
    print(f"   Test AUC: {metrics['auc']:.3f}")

    # 6. Check if better than previous model
    previous_metrics = load_previous_metrics()

    if metrics['auc'] < previous_metrics['auc'] * 0.95:
        print("\n⚠ WARNING: New model performs worse than previous!")
        print(f"   Previous AUC: {previous_metrics['auc']:.3f}")
        print(f"   New AUC: {metrics['auc']:.3f}")
        print("\n❌ Retraining aborted. Keeping previous model.")
        sys.exit(1)

    # 7. Export new model
    print(f"\n5. Exporting new model")
    version = datetime.now().strftime('v%Y%m%d')
    export_model(model, feature_names, metrics, version)

    print(f"\n✓ Model retrained successfully!")
    print(f"   Version: {version}")
    print(f"   Performance: {metrics['auc']:.3f} AUC")

if __name__ == '__main__':
    retrain_model()
```

**Schedule monthly via cron**:

```bash
# Add to crontab (run on 1st of each month at 2 AM)
0 2 1 * * cd /path/to/QuantAILabs && python3 scripts/retrain_ml_model.py
```

---

## Advanced ML Techniques

### Ensemble Models

**Combine multiple models for robustness**:

```python
from sklearn.ensemble import VotingClassifier
from xgboost import XGBClassifier
from lightgbm import LGBMClassifier
from sklearn.linear_model import LogisticRegression

# Train multiple models
xgb_model = XGBClassifier(n_estimators=100, max_depth=5)
lgbm_model = LGBMClassifier(n_estimators=100, max_depth=5)
lr_model = LogisticRegression()

# Create ensemble
ensemble = VotingClassifier(
    estimators=[
        ('xgb', xgb_model),
        ('lgbm', lgbm_model),
        ('lr', lr_model),
    ],
    voting='soft',  # Average probabilities
    weights=[2, 2, 1],  # Trust tree models more
)

# Train ensemble
ensemble.fit(X_train, y_train)

# Predict
y_pred_proba = ensemble.predict_proba(X_test)[:, 1]
```

---

### Feature Importance Analysis

**SHAP values for explainability**:

```python
import shap

# Create SHAP explainer
explainer = shap.TreeExplainer(model)

# Calculate SHAP values
shap_values = explainer.shap_values(X_test)

# Summary plot
shap.summary_plot(shap_values, X_test, feature_names=important_features)
plt.savefig('shap_summary.png')

# Force plot for single prediction
shap.force_plot(
    explainer.expected_value,
    shap_values[0],
    X_test.iloc[0],
    feature_names=important_features
)
```

**Insight**: SHAP shows *why* model made each prediction (e.g., "High ROC5 pushed score up by +0.15")

---

### Online Learning

**Update model incrementally with new trades**:

```python
from river import tree, ensemble, metrics

# Online Random Forest
model = ensemble.AdaptiveRandomForestClassifier(
    n_models=10,
    max_depth=5,
)

# Train incrementally
for features, target in stream_new_trades():
    # Predict first
    y_pred = model.predict_one(features)

    # Then learn
    model.learn_one(features, target)

# Model continuously improves with each trade!
```

---

## Integration with Other Skills

**ML workflow**:

```
📋 RECOMMENDED PROCESS:

1. Collect data with pattern-researcher:
   "Export 1,000+ historical trades with entry features"

2. Optimize parameters first with strategy-optimizer:
   "Ensure baseline strategy is profitable before adding ML"

3. Train ML model with ml-signal-scorer:
   "Train XGBoost model to predict win probability"

4. Validate with code-consistency-checker:
   "Verify ML integration doesn't break backtest-production parity"

5. Analyze results with backtest-analyzer:
   "Compare ML V5.37 with manual V5.34 baseline"

6. If successful, deploy and retrain monthly
```

---

## Remember

- **Garbage in, garbage out**: ML needs quality features, not just quantity
- **Baseline first**: Get to >55% win rate manually before adding ML
- **Validate rigorously**: Out-of-sample testing is mandatory
- **Start simple**: XGBoost with 10-15 features beats complex architectures
- **Monitor drift**: Retrain monthly as markets change
- **Fallback always**: Keep manual scoring as backup (production safety)
- **Explainability matters**: Use SHAP to understand model decisions

Your goal is to enhance signal quality with data-driven ML predictions while maintaining robustness and explainability.

---

## When ML is Ready

**Checklist before deploying ML**:
- ✓ Collected ≥1,000 trades with outcomes
- ✓ Baseline strategy profitable (>55% WR)
- ✓ Trained model with out-of-sample validation
- ✓ Model AUC > 0.70 on test set
- ✓ Backtest shows improvement (>+10% Sharpe)
- ✓ Code integrated with fallback to manual scoring
- ✓ Monitoring/retraining pipeline in place

**If all checked**: Deploy to paper trading for 2 weeks, then production.

**If not**: Continue with manual optimization (strategy-optimizer, pattern-researcher) until ready.
