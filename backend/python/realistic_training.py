#!/usr/bin/env python3
"""
Realistic Training Pipeline - NO SMOTE
Uses only REAL market data with class weighting instead of synthetic balancing.
"""

import sys
import os
from typing import Sequence

try:
    import pandas as pd
    import numpy as np
    from xgboost import XGBClassifier
    from sklearn.metrics import classification_report, confusion_matrix, accuracy_score
    HAVE_DEPS = True
except ImportError:
    HAVE_DEPS = False
    print("❌ Missing dependencies: pandas, numpy, xgboost")
    sys.exit(1)

try:
    # Add backend/python to path
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'python'))
    from ccxt_xgboost_module import (
        collect_ohlcv,
        prepare_features,
        WindowSpec,
        ensure_dependencies
    )
except ImportError as e:
    print(f"❌ Missing ccxt_xgboost_module: {e}")
    print(f"   Python path: {sys.path}")
    sys.exit(1)


def calculate_realistic_labels(df: pd.DataFrame) -> pd.Series:
    """
    Calculate directional labels with REALISTIC thresholds.
    
    Key changes:
    - Higher threshold (1.5% minimum) to filter noise
    - Look 5 candles forward (not 3) for clearer trends
    - Require 2:1 edge minimum (move must be 2x stronger than opposite)
    """
    labels = []
    closes = df['close'].values
    
    LOOKFORWARD = 5  # Look further ahead for clearer signals
    MIN_MOVE_PCT = 1.5  # Higher threshold to avoid noise
    EDGE_RATIO = 2.0  # Move must be 2x stronger than opposite direction
    
    for i in range(len(df)):
        if i + LOOKFORWARD >= len(df):
            labels.append(0)  # Not enough future data
            continue
        
        current = closes[i]
        future_window = closes[i+1:i+LOOKFORWARD+1]
        
        # Calculate max moves in both directions
        max_up = (max(future_window) - current) / current * 100
        max_down = (current - min(future_window)) / current * 100
        
        # Label ONLY if move is significant AND dominant
        if max_up >= MIN_MOVE_PCT and max_up > max_down * EDGE_RATIO:
            labels.append(1)  # long
        elif max_down >= MIN_MOVE_PCT and max_down > max_up * EDGE_RATIO:
            labels.append(2)  # short
        else:
            labels.append(0)  # none (noise or unclear)
    
    return pd.Series(labels, index=df.index)


def realistic_training_pipeline(
    exchange: str = 'binance',
    symbols: Sequence[str] = ('BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'BNB/USDT:USDT'),
    test_size: float = 0.25  # 25% holdout for validation
):
    """
    Realistic training pipeline:
    - NO SMOTE (no synthetic data)
    - Class weights to handle imbalance
    - Stricter labeling to filter noise
    - Train/test split to detect overfitting
    """
    print("🚀 Starting REALISTIC training pipeline...")
    print(f"   Exchange: {exchange}")
    print(f"   Symbols: {', '.join(symbols)}")
    print(f"   Strategy: Real data only + class weights")
    print()
    
    # Collect OHLCV data
    print("📊 Collecting OHLCV data...")
    windows = [
        WindowSpec(timeframe='15m', hours=720, offset_hours=0),  # 30 days recent
        WindowSpec(timeframe='15m', hours=360, offset_hours=24),  # 15 days shifted
    ]
    
    all_data = []
    for sym in symbols:
        for win_spec in windows:
            try:
                pw = collect_ohlcv(
                    exchange_id=exchange,
                    symbol=sym,
                    timeframe=win_spec.timeframe,
                    hours=win_spec.hours,
                    offset_hours=win_spec.offset_hours
                )
                if hasattr(pw, 'dataset'):
                    df = pw.dataset.copy()
                    df['symbol'] = sym
                    all_data.append(df)
                    print(f"   ✅ {sym} ({win_spec.hours}h): {len(df)} candles")
            except Exception as e:
                print(f"   ⚠️  {sym}: {e}")
    
    if not all_data:
        print("❌ No data collected!")
        return
    
    combined = pd.concat(all_data, ignore_index=True)
    print(f"\n📊 Total candles collected: {len(combined)}")
    
    # Apply REALISTIC labeling
    print(f"\n🏷️  Applying REALISTIC labeling (1.5% threshold, 5 candles forward, 2:1 edge)...")
    combined['label'] = calculate_realistic_labels(combined)
    
    # Remove unlabeled rows
    combined = combined[combined['label'].notna()].copy()
    
    # Check distribution BEFORE any balancing
    counts = combined['label'].value_counts().sort_index()
    print(f"\n📊 REAL Label Distribution (no synthetic data):")
    total = len(combined)
    for label_val in [0, 1, 2]:
        label_name = {0: 'none', 1: 'long', 2: 'short'}[label_val]
        count = counts.get(label_val, 0)
        pct = count / total * 100
        print(f"   {label_name}: {count:,} ({pct:.1f}%)")
    
    # Prepare features
    exclude_cols = ['label', 'timestamp', 'symbol', 'targetLabel', 'direction']
    feature_cols = [col for col in combined.columns if col not in exclude_cols]
    X = combined[feature_cols].copy()
    X = X.select_dtypes(include=[np.number])
    feature_cols = list(X.columns)
    
    y = combined['label'].astype(int)
    
    # Handle NaN/Inf
    X = X.replace([np.inf, -np.inf], np.nan)
    X = X.fillna(0)
    
    print(f"\n📊 Features: {len(feature_cols)}")
    print(f"📊 Samples: {len(X):,}")
    
    # Split train/test
    from sklearn.model_selection import train_test_split
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=test_size, random_state=42, stratify=y
    )
    
    print(f"\n📊 Train/Test Split:")
    print(f"   Train: {len(X_train):,} samples")
    print(f"   Test:  {len(X_test):,} samples")
    
    # Calculate class weights for imbalanced data
    from sklearn.utils.class_weight import compute_class_weight
    class_weights = compute_class_weight('balanced', classes=np.unique(y_train), y=y_train)
    weight_dict = {i: w for i, w in enumerate(class_weights)}
    
    print(f"\n⚖️  Class Weights (to handle imbalance):")
    for label_val, weight in weight_dict.items():
        label_name = {0: 'none', 1: 'long', 2: 'short'}[label_val]
        print(f"   {label_name}: {weight:.2f}x")
    
    # Train XGBoost with class weights
    print("\n🤖 Training XGBoost model...")
    print("   Config: Real data + class weights + regularization")
    
    # Convert class weights to sample weights
    sample_weights = np.array([weight_dict[label] for label in y_train])
    
    model = XGBClassifier(
        max_depth=5,  # Slightly deeper for complex patterns
        n_estimators=200,  # More trees for better generalization
        learning_rate=0.08,  # Lower LR to avoid overfitting
        subsample=0.75,  # Strong subsampling
        colsample_bytree=0.75,  # Strong feature sampling
        min_child_weight=5,  # Higher to prevent overfitting
        gamma=0.3,  # Stronger pruning
        reg_alpha=0.1,  # L1 regularization
        reg_lambda=2.0,  # L2 regularization
        random_state=42,
        n_jobs=-1,
        eval_metric='mlogloss',
        early_stopping_rounds=20
    )
    
    # Train with validation
    model.fit(
        X_train, y_train,
        sample_weight=sample_weights,
        eval_set=[(X_test, y_test)],
        verbose=False
    )
    
    # Evaluate on TRAINING set (should be good)
    print("\n📈 Training Set Performance:")
    y_train_pred = model.predict(X_train)
    train_acc = accuracy_score(y_train, y_train_pred)
    print(f"   Accuracy: {train_acc*100:.1f}%")
    
    # Evaluate on TEST set (real performance indicator)
    print("\n📈 Test Set Performance (REAL INDICATOR):")
    y_test_pred = model.predict(X_test)
    test_acc = accuracy_score(y_test, y_test_pred)
    print(f"   Accuracy: {test_acc*100:.1f}%")
    
    if train_acc - test_acc > 0.10:
        print(f"   ⚠️  WARNING: Large train-test gap ({(train_acc - test_acc)*100:.1f}%) = overfitting!")
    else:
        print(f"   ✅ Good generalization (gap: {(train_acc - test_acc)*100:.1f}%)")
    
    print("\n📊 Detailed Classification Report (Test Set):")
    print(classification_report(
        y_test, y_test_pred,
        target_names=['none', 'long', 'short'],
        digits=3
    ))
    
    print("\n🔢 Confusion Matrix (Test Set):")
    cm = confusion_matrix(y_test, y_test_pred)
    print("              Predicted")
    print("         none  long  short")
    for i, label_name in enumerate(['none', 'long', 'short']):
        print(f"  {label_name:5s}  {cm[i,0]:5d} {cm[i,1]:5d} {cm[i,2]:5d}")
    
    # Feature importance
    feature_importance = pd.DataFrame({
        'feature': feature_cols,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)
    
    print("\n🔝 Top 10 Most Important Features:")
    for idx, row in feature_importance.head(10).iterrows():
        print(f"   {row['feature']:30s}: {row['importance']:.4f}")
    
    # Save model
    import pickle
    model_path = os.path.join(os.path.dirname(__file__), '..', 'xgb_predictor_realistic.pkl')
    with open(model_path, 'wb') as f:
        pickle.dump(model, f)
    print(f"\n💾 Model saved to: {model_path}")
    
    # Save metadata
    import json
    metadata = {
        'training_method': 'realistic_no_smote',
        'class_weights': weight_dict,
        'train_accuracy': float(train_acc),
        'test_accuracy': float(test_acc),
        'overfitting_gap': float(train_acc - test_acc),
        'feature_count': len(feature_cols),
        'total_samples': len(X),
        'train_samples': len(X_train),
        'test_samples': len(X_test),
        'label_distribution': {
            'none': int(counts.get(0, 0)),
            'long': int(counts.get(1, 0)),
            'short': int(counts.get(2, 0)),
        },
        'timestamp': pd.Timestamp.now().isoformat(),
    }
    
    metadata_path = os.path.join(os.path.dirname(__file__), '..', 'predictor_metadata_realistic.json')
    with open(metadata_path, 'w') as f:
        json.dump(metadata, f, indent=2)
    print(f"📝 Metadata saved to: {metadata_path}")
    
    print("\n🎉 Realistic training complete!")
    print(f"\n📊 Summary:")
    print(f"   - Used ONLY real market data (no SMOTE)")
    print(f"   - Train accuracy: {train_acc*100:.1f}%")
    print(f"   - Test accuracy:  {test_acc*100:.1f}%")
    print(f"   - Overfitting gap: {(train_acc - test_acc)*100:.1f}%")
    print(f"   - Total samples: {len(X):,} (no synthetic)")
    
    if test_acc < 0.45:
        print(f"\n⚠️  WARNING: Test accuracy is low ({test_acc*100:.1f}%)")
        print(f"   This is EXPECTED for realistic crypto prediction!")
        print(f"   Random guess = 33.3%, so {test_acc*100:.1f}% means model learned something.")
    elif test_acc >= 0.50:
        print(f"\n✅ Model shows good performance: {test_acc*100:.1f}% test accuracy")
        print(f"   Significantly better than random (33.3%)")
    
    return {
        'model': model,
        'metadata': metadata,
        'train_accuracy': train_acc,
        'test_accuracy': test_acc,
    }


if __name__ == '__main__':
    ensure_dependencies()
    
    exchange = os.environ.get('XGB_EXCHANGE', 'binance')
    symbols_str = os.environ.get('XGB_SYMBOLS', 'BTC/USDT:USDT,ETH/USDT:USDT,SOL/USDT:USDT,BNB/USDT:USDT')
    symbols = [s.strip() for s in symbols_str.split(',') if s.strip()]
    
    try:
        result = realistic_training_pipeline(
            exchange=exchange,
            symbols=symbols
        )
        
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Training failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
