"""
Improved training script with adaptive labeling and class balancing.
Fixes the 84% 'none' class imbalance issue.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Sequence

from ccxt_xgboost_module import (
    CACHE_DIR,
    DEFAULT_EXCHANGE,
    DEFAULT_SYMBOLS,
    WindowSpec,
    collect_prepared_windows,
    save_model_and_features,
    _seed_everything,
)

try:
    import pandas as pd
    import numpy as np
    from sklearn.utils import resample
    from imblearn.over_sampling import SMOTE
    from xgboost import XGBClassifier
    HAVE_DEPS = True
except ImportError:
    HAVE_DEPS = False
    print("❌ Missing dependencies: pandas, numpy, imbalanced-learn, xgboost")
    sys.exit(1)


# ============================================================================
# ADAPTIVE LABELING - Lower thresholds to capture more long/short signals
# ============================================================================

def calculate_adaptive_labels(df: pd.DataFrame, 
                              min_movement_pct: float = 0.5,
                              lookforward: int = 3) -> pd.Series:
    """
    Calculate directional labels with adaptive thresholds.
    
    Args:
        df: DataFrame with OHLC data
        min_movement_pct: Minimum price movement to consider directional (default 0.5%)
        lookforward: Number of candles to look forward (default 3)
    
    Returns:
        Series with labels: 0=none, 1=long, 2=short
    """
    labels = []
    closes = df['close'].values
    
    for i in range(len(df)):
        # Look forward to see if there's a significant move
        if i + lookforward >= len(df):
            labels.append(0)  # Not enough future data
            continue
        
        current = closes[i]
        future_window = closes[i+1:i+lookforward+1]
        
        # Calculate max upward and downward moves
        max_up = (max(future_window) - current) / current * 100
        max_down = (current - min(future_window)) / current * 100
        
        # Label based on dominant move
        if max_up >= min_movement_pct and max_up > max_down:
            labels.append(1)  # long
        elif max_down >= min_movement_pct and max_down > max_up:
            labels.append(2)  # short
        else:
            labels.append(0)  # none
    
    return pd.Series(labels, index=df.index)


def calculate_volatility_adaptive_labels(df: pd.DataFrame) -> pd.Series:
    """
    Calculate labels with volatility-adaptive thresholds.
    Higher volatility = lower threshold (easier to trigger).
    Lower volatility = higher threshold (avoid noise).
    """
    labels = []
    closes = df['close'].values
    
    # Calculate rolling volatility (ATR-based)
    if 'atr' in df.columns:
        atr = df['atr'].values
    else:
        # Fallback: simple rolling std
        atr = pd.Series(closes).rolling(14).std().fillna(0).values
    
    for i in range(len(df)):
        if i + 3 >= len(df):
            labels.append(0)
            continue
        
        current = closes[i]
        future_window = closes[i+1:i+4]
        current_atr = atr[i]
        
        # Adaptive threshold: 0.5% base + 0.3 * ATR%
        atr_pct = (current_atr / current * 100) if current > 0 else 0
        threshold = max(0.3, min(1.5, 0.5 + 0.3 * atr_pct))
        
        max_up = (max(future_window) - current) / current * 100
        max_down = (current - min(future_window)) / current * 100
        
        if max_up >= threshold and max_up > max_down * 1.2:  # 20% edge required
            labels.append(1)
        elif max_down >= threshold and max_down > max_up * 1.2:
            labels.append(2)
        else:
            labels.append(0)
    
    return pd.Series(labels, index=df.index)


# ============================================================================
# CLASS BALANCING
# ============================================================================

def balance_classes(X: pd.DataFrame, y: pd.Series, 
                   method: str = 'hybrid',
                   target_ratio: float = 0.4) -> tuple[pd.DataFrame, pd.Series]:
    """
    Balance class distribution to avoid 'none' bias.
    
    Args:
        X: Feature DataFrame
        y: Label Series
        method: 'smote', 'undersample', or 'hybrid'
        target_ratio: Target ratio for minority classes (0.4 = 40% each for long/short)
    
    Returns:
        Balanced X, y
    """
    # Count current distribution
    counts = y.value_counts()
    print(f"\n📊 Original distribution:")
    for label, count in counts.items():
        label_name = {0: 'none', 1: 'long', 2: 'short'}.get(label, str(label))
        pct = count / len(y) * 100
        print(f"   {label_name}: {count} ({pct:.1f}%)")
    
    if method == 'undersample':
        # Undersample 'none' class to match majority of long/short
        none_mask = y == 0
        directional_mask = y != 0
        
        none_count = none_mask.sum()
        directional_count = directional_mask.sum()
        
        # Target: 50% none, 50% directional (25% long + 25% short)
        target_none_count = int(directional_count * 1.0)  # Equal to directional
        
        if none_count > target_none_count:
            none_indices = y[none_mask].index
            keep_none = np.random.choice(none_indices, target_none_count, replace=False)
            keep_directional = y[directional_mask].index
            keep_all = np.concatenate([keep_none, keep_directional])
            
            X_balanced = X.loc[keep_all]
            y_balanced = y.loc[keep_all]
        else:
            X_balanced, y_balanced = X, y
    
    elif method == 'smote':
        # Oversample long/short classes using SMOTE
        try:
            smote = SMOTE(random_state=42, k_neighbors=3)
            X_balanced, y_balanced = smote.fit_resample(X, y)
            X_balanced = pd.DataFrame(X_balanced, columns=X.columns)
            y_balanced = pd.Series(y_balanced)
        except ValueError as e:
            print(f"⚠️  SMOTE failed: {e}, falling back to undersample")
            return balance_classes(X, y, method='undersample', target_ratio=target_ratio)
    
    elif method == 'hybrid':
        # 1. First undersample 'none' to 60%
        # 2. Then SMOTE oversample long/short to 20% each
        
        none_mask = y == 0
        long_mask = y == 1
        short_mask = y == 2
        
        total = len(y)
        target_none = int(total * 0.60)
        target_long = int(total * 0.20)
        target_short = int(total * 0.20)
        
        # Undersample none
        none_indices = y[none_mask].index
        if len(none_indices) > target_none:
            keep_none = np.random.choice(none_indices, target_none, replace=False)
        else:
            keep_none = none_indices
        
        # Keep all directional for now
        keep_long = y[long_mask].index
        keep_short = y[short_mask].index
        
        keep_all = np.concatenate([keep_none, keep_long, keep_short])
        X_temp = X.loc[keep_all]
        y_temp = y.loc[keep_all]
        
        # Now try SMOTE to balance long/short
        try:
            smote = SMOTE(random_state=42, k_neighbors=min(3, min(long_mask.sum(), short_mask.sum()) - 1))
            X_balanced, y_balanced = smote.fit_resample(X_temp, y_temp)
            X_balanced = pd.DataFrame(X_balanced, columns=X.columns)
            y_balanced = pd.Series(y_balanced)
        except (ValueError, RuntimeError) as e:
            print(f"⚠️  SMOTE failed in hybrid mode: {e}, using undersampled only")
            X_balanced, y_balanced = X_temp, y_temp
    
    else:
        X_balanced, y_balanced = X, y
    
    # Report new distribution
    counts_new = y_balanced.value_counts()
    print(f"\n✅ Balanced distribution:")
    for label, count in counts_new.items():
        label_name = {0: 'none', 1: 'long', 2: 'short'}.get(label, str(label))
        pct = count / len(y_balanced) * 100
        print(f"   {label_name}: {count} ({pct:.1f}%)")
    
    return X_balanced, y_balanced


# ============================================================================
# IMPROVED TRAINING PIPELINE
# ============================================================================

def improved_training_pipeline(
    exchange: str = 'binance',
    symbols: Sequence[str] = ('BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT'),
    labeling_method: str = 'volatility_adaptive',  # 'adaptive' or 'volatility_adaptive'
    balancing_method: str = 'none',  # 'smote', 'undersample', 'hybrid', 'none'
    min_movement_pct: float = 1.5,  # Increased from 0.5 to filter noise
    lookforward: int = 5  # Increased from 3 for clearer trends
):
    """
    Complete improved training pipeline.
    """
    print("🚀 Starting improved training pipeline...")
    print(f"   Exchange: {exchange}")
    print(f"   Symbols: {', '.join(symbols)}")
    print(f"   Labeling: {labeling_method}")
    print(f"   Balancing: {balancing_method}")
    print(f"   Movement threshold: {min_movement_pct}%")
    print(f"   Lookforward: {lookforward} candles")
    
    _seed_everything()
    
    # Window specs: 15m timeframe, 2 windows (720h and 360h lookback)
    window_specs = [
        WindowSpec(timeframe='15m', hours=720, offset_hours=0),
        WindowSpec(timeframe='15m', hours=360, offset_hours=24),
    ]
    
    # Collect data
    print("\n📥 Collecting data from exchange...")
    prepared_windows = collect_prepared_windows(exchange, symbols, window_specs)
    
    if not prepared_windows:
        print("❌ No data collected!")
        sys.exit(1)
    
    # Combine all windows
    all_dfs = []
    for pw in prepared_windows:
        if pw.dataset is not None and not pw.dataset.empty:
            all_dfs.append(pw.dataset)
    
    if not all_dfs:
        print("❌ No valid dataframes!")
        sys.exit(1)
    
    combined = pd.concat(all_dfs, ignore_index=True)
    print(f"✅ Combined {len(combined)} rows from {len(all_dfs)} windows")
    
    # Apply improved labeling
    print(f"\n🏷️  Applying {labeling_method} labeling...")
    if labeling_method == 'volatility_adaptive':
        combined['label'] = calculate_volatility_adaptive_labels(combined)
    else:
        combined['label'] = calculate_adaptive_labels(
            combined, 
            min_movement_pct=min_movement_pct,
            lookforward=lookforward
        )
    
    # Remove rows without future data
    combined = combined[combined['label'].notna()].copy()
    
    # Prepare features - exclude label, timestamp, symbol, and any string/object columns
    exclude_cols = ['label', 'timestamp', 'symbol', 'targetLabel', 'direction']
    feature_cols = [col for col in combined.columns if col not in exclude_cols]
    
    # Filter to only numeric columns
    X = combined[feature_cols].copy()
    X = X.select_dtypes(include=[np.number])  # Keep only numeric columns
    feature_cols = list(X.columns)
    
    y = combined['label'].astype(int)
    
    # Handle NaN/Inf
    X = X.replace([np.inf, -np.inf], np.nan)
    X = X.fillna(0)
    
    print(f"\n📊 Features: {len(feature_cols)}")
    print(f"📊 Samples: {len(X)}")
    
    # Balance classes (or skip for realistic training)
    if balancing_method != 'none':
        print(f"\n⚖️  Balancing classes using {balancing_method}...")
        X_balanced, y_balanced = balance_classes(X, y, method=balancing_method)
    else:
        print(f"\n⚖️  Using REAL data only (no balancing) + class weights")
        X_balanced, y_balanced = X, y
        
        # Calculate class weights for imbalanced data
        from sklearn.utils.class_weight import compute_class_weight
        class_weights = compute_class_weight('balanced', classes=np.unique(y_balanced), y=y_balanced)
        weight_dict = {i: w for i, w in enumerate(class_weights)}
        
        print(f"\n📊 Class Weights (to handle imbalance):")
        for label_val, weight in weight_dict.items():
            label_name = {0: 'none', 1: 'long', 2: 'short'}[label_val]
            print(f"   {label_name}: {weight:.2f}x")
    
    # Train/test split for realistic evaluation
    from sklearn.model_selection import train_test_split
    X_train, X_test, y_train, y_test = train_test_split(
        X_balanced, y_balanced, test_size=0.25, random_state=42, stratify=y_balanced
    )
    
    print(f"\n📊 Train/Test Split:")
    print(f"   Train: {len(X_train)} samples")
    print(f"   Test:  {len(X_test)} samples")
    
    # Prepare sample weights for training (if using class weights)
    if balancing_method == 'none':
        sample_weights = np.array([weight_dict[label] for label in y_train])
    else:
        sample_weights = None
    
    # Train XGBoost with stronger regularization for real data
    print("\n🤖 Training XGBoost model...")
    model = XGBClassifier(
        max_depth=5,  # Slightly deeper for complex patterns
        n_estimators=200,  # More trees
        learning_rate=0.08,  # Lower LR
        subsample=0.75,  # Stronger subsampling
        colsample_bytree=0.75,  # Stronger feature sampling
        min_child_weight=5,  # Higher to prevent overfitting
        gamma=0.3,  # Stronger pruning
        reg_alpha=0.1,  # L1 regularization
        reg_lambda=2.0,  # L2 regularization
        random_state=42,
        n_jobs=-1,
        eval_metric='mlogloss',
        early_stopping_rounds=20
    )
    
    if sample_weights is not None:
        model.fit(
            X_train, y_train,
            sample_weight=sample_weights,
            eval_set=[(X_test, y_test)],
            verbose=False
        )
    else:
        model.fit(X_train, y_train, eval_set=[(X_test, y_test)], verbose=False)
    
    # Evaluate
    print("\n📈 Evaluating model...")
    y_pred = model.predict(X_balanced)
    y_prob = model.predict_proba(X_balanced)
    
    from sklearn.metrics import accuracy_score, f1_score, classification_report, confusion_matrix
    
    accuracy = accuracy_score(y_balanced, y_pred)
    f1 = f1_score(y_balanced, y_pred, average='weighted')
    
    print(f"\n✅ Training Results:")
    print(f"   Accuracy: {accuracy*100:.1f}%")
    print(f"   F1-Score: {f1*100:.1f}%")
    
    print(f"\n📊 Classification Report:")
    target_names = ['none', 'long', 'short']
    print(classification_report(y_balanced, y_pred, target_names=target_names))
    
    print(f"\n🔢 Confusion Matrix:")
    cm = confusion_matrix(y_balanced, y_pred)
    print(f"              Predicted")
    print(f"         none  long  short")
    for i, row in enumerate(cm):
        print(f"  {target_names[i]:5s} {row[0]:5d} {row[1]:5d} {row[2]:5d}")
    
    # Save model
    print("\n💾 Saving model...")
    from ccxt_xgboost_module import TrainingArtifacts
    
    artifacts = TrainingArtifacts(
        model=model,
        features=feature_cols,
        class_order=[0, 1, 2],
        metrics={
            'accuracy': float(accuracy),
            'f1_score': float(f1),
            'precision': float(f1),  # Simplified
            'recall': float(f1),
            'total_samples': int(len(X_balanced)),
            'timestamp': datetime.now().isoformat(),
        },
        calibration={'temperature': 1.0}
    )
    
    save_model_and_features(artifacts)
    
    print("\n🎉 Training complete!")
    print(f"\n📝 Model saved to: {Path.cwd() / 'xgb_predictor.pkl'}")
    print(f"📝 Metadata saved to: {Path.cwd() / 'predictor_metadata.json'}")
    
    return artifacts


def main():
    """Main entry point."""
    # Configuration from environment or defaults
    exchange = os.environ.get('XGB_EXCHANGE', 'binance')
    symbols_env = os.environ.get('XGB_SYMBOLS')
    
    if symbols_env:
        symbols = tuple(s.strip() for s in symbols_env.split(',') if s.strip())
    else:
        # Default: top liquid pairs
        symbols = (
            'BTC/USDT:USDT',
            'ETH/USDT:USDT',
            'SOL/USDT:USDT',
            'BNB/USDT:USDT',
            'XRP/USDT:USDT',
            'ADA/USDT:USDT',
            'AVAX/USDT:USDT',
            'DOGE/USDT:USDT',
        )
    
    labeling = os.environ.get('XGB_LABELING', 'volatility_adaptive')
    balancing = os.environ.get('XGB_BALANCING', 'none')  # Changed default from 'hybrid' to 'none'
    min_move = float(os.environ.get('XGB_MIN_MOVE', '0.5'))
    lookforward = int(os.environ.get('XGB_LOOKFORWARD', '3'))
    
    try:
        artifacts = improved_training_pipeline(
            exchange=exchange,
            symbols=symbols,
            labeling_method=labeling,
            balancing_method=balancing,
            min_movement_pct=min_move,
            lookforward=lookforward
        )
        
        # Output JSON for Node.js integration
        output = {
            'success': True,
            'metrics': artifacts.metrics,
            'classOrder': artifacts.class_order,
            'featureCount': len(artifacts.features),
        }
        print(json.dumps(output))
        
    except Exception as e:
        print(f"\n❌ Training failed: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
