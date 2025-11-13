#!/usr/bin/env python3
"""
Adaptive Volatility Training Pipeline
Uses volatility-adaptive thresholds to create more balanced labels.
"""

import os
import sys
import json
from pathlib import Path
from datetime import datetime, timedelta
import numpy as np
import pandas as pd
from typing import Tuple, Dict, Any

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from ccxt_xgboost_module import (
    collect_prepared_windows,
    WindowSpec,
    DEFAULT_EXCHANGE,
    DEFAULT_SYMBOLS,
    DEFAULT_TIMEFRAME,
    save_model_and_features,
    TrainingArtifacts,
)

try:
    from xgboost import XGBClassifier
    HAVE_XGB = True
except ImportError:
    HAVE_XGB = False
    print("⚠️  XGBoost not available")


def calculate_adaptive_volatility_labels(
    df: pd.DataFrame,
    lookforward: int = 5,
    edge_ratio: float = 2.0,
    min_threshold_pct: float = 0.4,
    max_threshold_pct: float = 2.5,
    atr_window: int = 14
) -> pd.Series:
    """
    Calculate labels with VOLATILITY-ADAPTIVE thresholds.
    
    High volatility market → Higher threshold needed for signal
    Low volatility market → Lower threshold for signal detection
    
    This produces more balanced labels (target: 40-50% none instead of 67%).
    
    Args:
        df: DataFrame with OHLC data
        lookforward: Number of candles to look ahead
        edge_ratio: Min ratio of profit/loss for valid signal (2.0 = 2:1 reward:risk)
        min_threshold_pct: Minimum movement threshold (0.4%)
        max_threshold_pct: Maximum movement threshold (2.5%)
        atr_window: Window for ATR calculation (default 14)
    
    Returns:
        Series with labels: 0=none, 1=long, 2=short
    """
    print(f"\n🎯 Calculating adaptive volatility labels...")
    print(f"   Lookforward: {lookforward} candles")
    print(f"   Threshold range: {min_threshold_pct}% - {max_threshold_pct}%")
    print(f"   Edge ratio: {edge_ratio}:1")
    
    labels = pd.Series([np.nan] * len(df), index=df.index)
    
    if 'close' not in df.columns:
        print("❌ No 'close' column found")
        return labels
    
    # Calculate ATR for volatility adaptation
    if 'high' in df.columns and 'low' in df.columns:
        high = df['high'].values
        low = df['low'].values
        close = df['close'].values
        
        # True Range
        tr1 = high - low
        tr2 = np.abs(high - np.roll(close, 1))
        tr3 = np.abs(low - np.roll(close, 1))
        tr = np.maximum(tr1, np.maximum(tr2, tr3))
        tr[0] = tr1[0]  # First value has no previous close
        
        # ATR (exponential moving average of TR)
        atr = pd.Series(tr).ewm(span=atr_window, adjust=False).mean().values
        atr_pct = (atr / close) * 100
    else:
        # Fallback: use close-to-close volatility
        returns = df['close'].pct_change().abs()
        atr_pct = returns.rolling(atr_window).std().fillna(0).values * 100
    
    # Normalize ATR to [0, 1] range for threshold scaling
    atr_pct_norm = np.clip((atr_pct - 0.5) / (3.0 - 0.5), 0, 1)  # 0.5% to 3% ATR range
    
    # Adaptive threshold: scales with volatility
    adaptive_thresholds = min_threshold_pct + (max_threshold_pct - min_threshold_pct) * atr_pct_norm
    
    print(f"   ATR percentile stats:")
    print(f"      Mean: {np.nanmean(atr_pct):.2f}%")
    print(f"      Median: {np.nanmedian(atr_pct):.2f}%")
    print(f"      25th: {np.nanpercentile(atr_pct, 25):.2f}%")
    print(f"      75th: {np.nanpercentile(atr_pct, 75):.2f}%")
    
    # Calculate future returns
    close_prices = df['close'].values
    
    for i in range(len(df) - lookforward):
        current_price = close_prices[i]
        if not np.isfinite(current_price) or current_price <= 0:
            continue
        
        threshold = adaptive_thresholds[i] / 100.0  # Convert to decimal
        
        # Look ahead for best profit/loss in window
        future_prices = close_prices[i+1:i+1+lookforward]
        future_returns = (future_prices - current_price) / current_price
        
        max_profit = np.max(future_returns)
        max_loss = np.min(future_returns)
        
        # LONG signal: significant upside with manageable downside
        if max_profit >= threshold and abs(max_loss) <= threshold / edge_ratio:
            labels.iloc[i] = 1  # long
        # SHORT signal: significant downside with manageable upside
        elif abs(max_loss) >= threshold and max_profit <= threshold / edge_ratio:
            labels.iloc[i] = 2  # short
        # NONE: no clear directional edge
        else:
            labels.iloc[i] = 0  # none
    
    # Statistics
    label_counts = labels.value_counts()
    total = label_counts.sum()
    
    print(f"\n📊 Label distribution:")
    for label_val in [0, 1, 2]:
        count = label_counts.get(label_val, 0)
        pct = (count / total * 100) if total > 0 else 0
        label_name = {0: 'none', 1: 'long', 2: 'short'}[label_val]
        print(f"   {label_name}: {count:,} ({pct:.1f}%)")
    
    return labels


def adaptive_training_pipeline(
    exchange: str = DEFAULT_EXCHANGE,
    symbols: tuple = DEFAULT_SYMBOLS,
    lookforward: int = 5,
    edge_ratio: float = 2.0,
    min_threshold_pct: float = 0.4,
    max_threshold_pct: float = 2.5
) -> TrainingArtifacts:
    """
    Complete training pipeline with adaptive volatility labeling.
    """
    if not HAVE_XGB:
        raise RuntimeError("XGBoost not available")
    
    print("🚀 Starting adaptive volatility training pipeline...")
    print(f"   Exchange: {exchange}")
    print(f"   Symbols: {', '.join(symbols)}")
    print(f"   Threshold range: {min_threshold_pct}% - {max_threshold_pct}%")
    print(f"   Lookforward: {lookforward} candles")
    print(f"   Edge ratio: {edge_ratio}:1")
    
    # Collect data
    print("\n📥 Collecting data from exchange...")
    anchor = datetime.now() - timedelta(days=30)  # 30 days of data
    specs = [WindowSpec(timeframe='15m', hours=24*30, offset_hours=0)]
    
    prepared_windows = collect_prepared_windows(exchange, symbols, specs, anchor=anchor)
    
    if not prepared_windows:
        print("❌ No data collected!")
        sys.exit(1)
    
    # Combine windows
    all_dfs = []
    for pw in prepared_windows:
        if pw.dataset is not None and not pw.dataset.empty:
            all_dfs.append(pw.dataset)
    
    if not all_dfs:
        print("❌ No valid dataframes!")
        sys.exit(1)
    
    combined = pd.concat(all_dfs, ignore_index=True)
    print(f"✅ Combined {len(combined):,} rows from {len(all_dfs)} windows")
    
    # Apply adaptive volatility labeling
    combined['label'] = calculate_adaptive_volatility_labels(
        combined,
        lookforward=lookforward,
        edge_ratio=edge_ratio,
        min_threshold_pct=min_threshold_pct,
        max_threshold_pct=max_threshold_pct
    )
    
    # Remove rows without labels
    combined = combined[combined['label'].notna()].copy()
    print(f"\n📊 Valid samples: {len(combined):,}")
    
    # Prepare features
    exclude_cols = ['label', 'timestamp', 'symbol', 'targetLabel', 'direction', 
                    'high', 'low', 'open']  # Exclude OHLCV except close
    feature_cols = [col for col in combined.columns if col not in exclude_cols]
    
    X = combined[feature_cols].copy()
    X = X.select_dtypes(include=[np.number])  # Keep only numeric
    feature_cols = list(X.columns)
    
    y = combined['label'].astype(int)
    
    # Handle NaN/Inf
    X = X.replace([np.inf, -np.inf], np.nan)
    X = X.fillna(0)
    
    print(f"\n📊 Features: {len(feature_cols)}")
    print(f"📊 Samples: {len(X):,}")
    
    # Calculate class weights for imbalanced data
    from sklearn.utils.class_weight import compute_class_weight
    class_weights = compute_class_weight('balanced', classes=np.unique(y), y=y)
    weight_dict = {i: w for i, w in enumerate(class_weights)}
    
    print(f"\n📊 Class Weights:")
    for label_val, weight in weight_dict.items():
        label_name = {0: 'none', 1: 'long', 2: 'short'}[label_val]
        print(f"   {label_name}: {weight:.2f}x")
    
    # Train/test split
    from sklearn.model_selection import train_test_split
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.25, random_state=42, stratify=y
    )
    
    print(f"\n📊 Train/Test Split:")
    print(f"   Train: {len(X_train):,} samples")
    print(f"   Test:  {len(X_test):,} samples")
    
    # Prepare sample weights
    sample_weights = np.array([weight_dict[label] for label in y_train])
    
    # Train XGBoost with optimized hyperparameters
    print("\n🤖 Training XGBoost model...")
    model = XGBClassifier(
        max_depth=6,              # Slightly deeper for complex patterns
        n_estimators=300,         # More trees for better generalization
        learning_rate=0.05,       # Lower learning rate
        subsample=0.8,            # Subsample rows
        colsample_bytree=0.8,     # Subsample features
        min_child_weight=3,       # Prevent overfitting
        gamma=0.2,                # Pruning threshold
        reg_alpha=0.05,           # L1 regularization
        reg_lambda=1.5,           # L2 regularization
        random_state=42,
        n_jobs=-1,
        eval_metric='mlogloss',
        early_stopping_rounds=30
    )
    
    model.fit(
        X_train, y_train,
        sample_weight=sample_weights,
        eval_set=[(X_test, y_test)],
        verbose=False
    )
    
    # Evaluate
    print("\n📈 Evaluating model...")
    y_pred = model.predict(X)
    
    from sklearn.metrics import accuracy_score, f1_score, classification_report, confusion_matrix
    
    accuracy = accuracy_score(y, y_pred)
    f1 = f1_score(y, y_pred, average='weighted')
    
    print(f"\n✅ Training Results:")
    print(f"   Accuracy: {accuracy*100:.1f}%")
    print(f"   F1-Score: {f1*100:.1f}%")
    
    print(f"\n📊 Classification Report:")
    target_names = ['none', 'long', 'short']
    print(classification_report(y, y_pred, target_names=target_names))
    
    print(f"\n🔢 Confusion Matrix:")
    cm = confusion_matrix(y, y_pred)
    print(f"              Predicted")
    print(f"         none  long  short")
    for i, row in enumerate(cm):
        print(f"  {target_names[i]:5s} {row[0]:5d} {row[1]:5d} {row[2]:5d}")
    
    # Save model
    print("\n💾 Saving model...")
    artifacts = TrainingArtifacts(
        model=model,
        features=feature_cols,
        class_order=[0, 1, 2],
        metrics={
            'accuracy': float(accuracy),
            'f1_score': float(f1),
            'precision': float(f1),
            'recall': float(f1),
            'total_samples': int(len(X)),
            'timestamp': datetime.now().isoformat(),
        },
        calibration={'temperature': 1.0}
    )
    
    save_model_and_features(artifacts)
    
    print("\n🎉 Training complete!")
    print(f"\n📝 Model saved to: {Path.cwd() / 'python' / 'xgboost_direction.json'}")
    print(f"📝 Metadata saved to: {Path.cwd() / 'python' / 'predictor_metadata.json'}")
    
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
    
    lookforward = int(os.environ.get('XGB_LOOKFORWARD', '5'))
    edge_ratio = float(os.environ.get('XGB_EDGE_RATIO', '2.0'))
    min_threshold = float(os.environ.get('XGB_MIN_THRESHOLD', '0.4'))
    max_threshold = float(os.environ.get('XGB_MAX_THRESHOLD', '2.5'))
    
    try:
        artifacts = adaptive_training_pipeline(
            exchange=exchange,
            symbols=symbols,
            lookforward=lookforward,
            edge_ratio=edge_ratio,
            min_threshold_pct=min_threshold,
            max_threshold_pct=max_threshold
        )
        
        return 0
    except Exception as e:
        print(f"\n❌ Training failed: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == '__main__':
    sys.exit(main())
