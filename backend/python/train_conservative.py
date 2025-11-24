#!/usr/bin/env python3
"""
Script de réentraînement optimisé du predictor XGBoost
- Seuils de labeling plus conservateurs pour réduire les faux signaux
- Focus sur la PRÉCISION plutôt que le recall
- Utilisation uniquement pour confidence, pas comme gate bloquant
"""

import json
import os
import sys
from pathlib import Path

# Ajouter le dossier parent au path pour importer les modules
sys.path.insert(0, str(Path(__file__).parent))

try:
    import pandas as pd
    import numpy as np
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import classification_report, confusion_matrix
    from xgboost import XGBClassifier
    print("✅ Dépendances importées avec succès")
except ImportError as e:
    print(f"❌ Erreur d'import: {e}")
    print("Installation requise: pip install pandas numpy scikit-learn xgboost")
    sys.exit(1)

def calculate_conservative_labels(df, min_movement_pct=0.7, lookforward=3):
    """
    Labeling OPTIMISÉ pour 70%+ accuracy ET recall
    - Mouvement minimum: 0.7% (balance precision/recall)
    - Lookforward: 3 candles (réactivité crypto)
    - RSI extreme awareness (85+/15- = opportunités)
    - Momentum confirmation pour réduire faux signaux
    """
    labels = []
    
    for i in range(len(df)):
        if i + lookforward >= len(df):
            labels.append('none')
            continue
        
        current_price = df.iloc[i]['close']
        current_rsi = df.iloc[i]['rsi14'] if 'rsi14' in df.columns and not pd.isna(df.iloc[i]['rsi14']) else 50
        current_volume = df.iloc[i]['volumeRatio'] if 'volumeRatio' in df.columns and not pd.isna(df.iloc[i]['volumeRatio']) else 1.0
        
        future_prices = df.iloc[i+1:i+lookforward+1]['close'].values
        
        # Calculer le gain/perte maximum
        max_gain = (future_prices.max() - current_price) / current_price * 100
        max_loss = (current_price - future_prices.min()) / current_price * 100
        
        # Ajustement du seuil selon RSI et volume
        adjusted_threshold = min_movement_pct
        
        # RSI extreme = opportunité même avec petit mouvement
        if current_rsi > 85 or current_rsi < 15:
            adjusted_threshold = min_movement_pct * 0.5  # 0.35% suffit
        # Volume spike = mouvement probable
        elif current_volume > 2.0:
            adjusted_threshold = min_movement_pct * 0.7  # 0.49%
        
        # Labeling avec seuil adaptatif
        if max_gain >= adjusted_threshold and max_gain > max_loss * 1.2:  # long must be 20% stronger
            labels.append('long')
        elif max_loss >= adjusted_threshold and max_loss > max_gain * 1.2:  # short must be 20% stronger
            labels.append('short')
        else:
            labels.append('none')
    
    return pd.Series(labels, index=df.index)


def load_and_prepare_data():
    """Charger les données historiques"""
    print("\n📂 Chargement des données...")
    
    cache_dir = Path(__file__).parent.parent / 'data' / 'ccxt_cache'
    
    # Chercher tous les fichiers CSV dans le cache
    csv_files = list(cache_dir.glob('*.csv'))
    
    if not csv_files:
        print(f"❌ Aucun fichier CSV trouvé dans {cache_dir}")
        print("Exécutez d'abord: python ccxt_xgboost_module.py collect")
        return None
    
    print(f"   Trouvé {len(csv_files)} fichiers de données")
    
    # Charger tous les fichiers
    dfs = []
    for csv_file in csv_files:
        try:
            df = pd.read_csv(csv_file)
            if len(df) > 100:  # Minimum de données
                dfs.append(df)
                print(f"   ✓ {csv_file.name}: {len(df)} lignes")
        except Exception as e:
            print(f"   ⚠️  Erreur avec {csv_file.name}: {e}")
    
    if not dfs:
        print("❌ Aucune donnée valide chargée")
        return None
    
    # Combiner tous les dataframes
    df_combined = pd.concat(dfs, ignore_index=True)
    print(f"\n✅ Total: {len(df_combined)} lignes de données")
    
    return df_combined


def calculate_features(df):
    """Calculer les features techniques AVANCÉES pour 70%+ performance"""
    print("\n🔧 Calcul des features avancées...")
    
    # EMAs
    df['ema9'] = df['close'].ewm(span=9).mean()
    df['ema12'] = df['close'].ewm(span=12).mean()
    df['ema20'] = df['close'].ewm(span=20).mean()
    df['ema26'] = df['close'].ewm(span=26).mean()
    df['ema50'] = df['close'].ewm(span=50).mean()
    df['ema200'] = df['close'].ewm(span=200).mean()
    
    # Distances relatives aux EMAs (normalisation)
    df['dist_ema9'] = (df['close'] - df['ema9']) / df['ema9'] * 100
    df['dist_ema20'] = (df['close'] - df['ema20']) / df['ema20'] * 100
    df['dist_ema50'] = (df['close'] - df['ema50']) / df['ema50'] * 100
    
    # RSI multi-période
    delta = df['close'].diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=14).mean()
    rs = gain / loss
    df['rsi14'] = 100 - (100 / (1 + rs))
    
    # RSI 7 pour réactivité
    gain7 = (delta.where(delta > 0, 0)).rolling(window=7).mean()
    loss7 = (-delta.where(delta < 0, 0)).rolling(window=7).mean()
    rs7 = gain7 / loss7
    df['rsi7'] = 100 - (100 / (1 + rs7))
    
    # RSI momentum et divergences
    df['rsiSlope'] = df['rsi14'].diff(3)
    df['rsiAccel'] = df['rsiSlope'].diff(2)  # Accélération RSI
    df['rsiDivergence'] = (df['rsi14'].diff(5) > 0).astype(int) - (df['close'].pct_change(5) > 0).astype(int)
    
    # MACD complet
    exp1 = df['close'].ewm(span=12).mean()
    exp2 = df['close'].ewm(span=26).mean()
    df['macd'] = exp1 - exp2
    df['macd_signal'] = df['macd'].ewm(span=9).mean()
    df['macd_hist'] = df['macd'] - df['macd_signal']
    df['macd_cross'] = ((df['macd'] > df['macd_signal']) & (df['macd'].shift(1) <= df['macd_signal'].shift(1))).astype(int) - \
                       ((df['macd'] < df['macd_signal']) & (df['macd'].shift(1) >= df['macd_signal'].shift(1))).astype(int)
    
    # ATR et volatilité
    high_low = df['high'] - df['low']
    high_close = np.abs(df['high'] - df['close'].shift())
    low_close = np.abs(df['low'] - df['close'].shift())
    ranges = pd.concat([high_low, high_close, low_close], axis=1)
    true_range = ranges.max(axis=1)
    df['atr14'] = true_range.rolling(14).mean()
    df['atrPct'] = (df['atr14'] / df['close']) * 100
    df['atrRatio'] = df['atr14'] / df['atr14'].rolling(50).mean()  # Volatilité relative
    
    # Volume patterns
    df['volumeRatio'] = df['volume'] / df['volume'].rolling(20).mean()
    df['volumeSpike'] = (df['volumeRatio'] > 2.0).astype(int)
    df['volumeTrend'] = df['volume'].rolling(5).mean() / df['volume'].rolling(20).mean()
    
    # Momentum multi-période
    df['momentum5'] = df['close'].pct_change(5) * 100
    df['momentum10'] = df['close'].pct_change(10) * 100
    df['momentum20'] = df['close'].pct_change(20) * 100
    df['momentumAccel'] = df['momentum10'].diff(3)  # Accélération momentum
    
    # ADX simplifié (force de tendance)
    df['plusDM'] = df['high'].diff()
    df['minusDM'] = -df['low'].diff()
    df['plusDM'] = df['plusDM'].where((df['plusDM'] > df['minusDM']) & (df['plusDM'] > 0), 0)
    df['minusDM'] = df['minusDM'].where((df['minusDM'] > df['plusDM']) & (df['minusDM'] > 0), 0)
    df['plusDI'] = 100 * (df['plusDM'].rolling(14).mean() / df['atr14'])
    df['minusDI'] = 100 * (df['minusDM'].rolling(14).mean() / df['atr14'])
    df['adx14'] = np.abs(df['plusDI'] - df['minusDI']) / (df['plusDI'] + df['minusDI']) * 100
    
    # Bollinger Bands
    df['bb_middle'] = df['close'].rolling(20).mean()
    df['bb_std'] = df['close'].rolling(20).std()
    df['bb_upper'] = df['bb_middle'] + 2 * df['bb_std']
    df['bb_lower'] = df['bb_middle'] - 2 * df['bb_std']
    df['bb_position'] = (df['close'] - df['bb_lower']) / (df['bb_upper'] - df['bb_lower'])
    df['bb_width'] = (df['bb_upper'] - df['bb_lower']) / df['bb_middle']
    
    # Price patterns
    df['ema20Slope'] = df['ema20'].pct_change(5) * 100
    df['priceAccel'] = df['close'].pct_change(3).diff(2) * 100
    df['highLowRatio'] = (df['high'] - df['low']) / df['close']
    
    # Trend strength
    df['emaCross'] = ((df['ema9'] > df['ema20']) & (df['ema9'].shift(1) <= df['ema20'].shift(1))).astype(int) - \
                     ((df['ema9'] < df['ema20']) & (df['ema9'].shift(1) >= df['ema20'].shift(1))).astype(int)
    
    # Drop NaN
    df = df.dropna()
    
    # CRITICAL: Remplacer inf/-inf par NaN puis supprimer
    df = df.replace([np.inf, -np.inf], np.nan)
    df = df.dropna()
    
    print(f"   ✓ {len(df.columns)} features calculées")
    print(f"   ✓ {len(df)} lignes après nettoyage")
    
    return df


def train_model(df):
    """Entraîner le modèle XGBoost optimisé pour 70%+ partout"""
    print("\n🤖 Entraînement du modèle OPTIMISÉ...")
    
    # Calculer les labels avec seuil adaptatif
    df['label'] = calculate_conservative_labels(df, min_movement_pct=0.7, lookforward=3)
    
    # Distribution des labels
    label_counts = df['label'].value_counts()
    print(f"\n📊 Distribution des labels:")
    for label, count in label_counts.items():
        pct = count / len(df) * 100
        print(f"   {label}: {count} ({pct:.1f}%)")
    
    # Features à utiliser (toutes les features avancées)
    feature_cols = [
        # EMAs et distances
        'ema9', 'ema12', 'ema20', 'ema26', 'ema50', 'ema200',
        'dist_ema9', 'dist_ema20', 'dist_ema50',
        # RSI multi-période et patterns
        'rsi7', 'rsi14', 'rsiSlope', 'rsiAccel', 'rsiDivergence',
        # MACD complet
        'macd', 'macd_signal', 'macd_hist', 'macd_cross',
        # Volatilité et ATR
        'atr14', 'atrPct', 'atrRatio',
        # Volume patterns
        'volumeRatio', 'volumeSpike', 'volumeTrend',
        # Momentum multi-période
        'momentum5', 'momentum10', 'momentum20', 'momentumAccel',
        # Trend indicators
        'adx14', 'plusDI', 'minusDI',
        # Bollinger Bands
        'bb_position', 'bb_width',
        # Price patterns
        'ema20Slope', 'priceAccel', 'highLowRatio', 'emaCross'
    ]
    
    X = df[feature_cols].values
    y_raw = df['label'].values
    
    # Encoder les labels: long=2, none=1, short=0
    label_map = {'long': 2, 'none': 1, 'short': 0}
    y = np.array([label_map[label] for label in y_raw])
    
    # Split train/validation/test (60/20/20)
    X_temp, X_test, y_temp, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )
    X_train, X_val, y_train, y_val = train_test_split(
        X_temp, y_temp, test_size=0.25, random_state=42, stratify=y_temp
    )
    
    print(f"\n🔀 Split: {len(X_train)} train, {len(X_val)} val, {len(X_test)} test")
    
    # Balancing hybride optimisé pour 70%+
    print("   Équilibrage hybride (under + weights)...")
    
    # Séparer les classes
    idx_0 = np.where(y_train == 0)[0]  # short
    idx_1 = np.where(y_train == 1)[0]  # none
    idx_2 = np.where(y_train == 2)[0]  # long
    
    # Prendre min entre les classes minoritaires
    target_size = min(len(idx_0), len(idx_2))
    
    # Sous-échantillonner none à 2.5x les minorités (balance recall/precision)
    none_size = min(int(target_size * 2.5), len(idx_1))
    idx_1_sample = np.random.choice(idx_1, none_size, replace=False)
    
    # Combiner
    balanced_idx = np.concatenate([idx_0, idx_1_sample, idx_2])
    np.random.shuffle(balanced_idx)
    
    X_train_balanced = X_train[balanced_idx]
    y_train_balanced = y_train[balanced_idx]
    
    # Sample weights pour renforcer long/short (10x)
    sample_weights = np.ones(len(y_train_balanced))
    sample_weights[y_train_balanced == 0] = 10.0  # short
    sample_weights[y_train_balanced == 2] = 10.0  # long
    
    balanced_counts = pd.Series(y_train_balanced).value_counts()
    print(f"   Après balancing:")
    for label, count in balanced_counts.items():
        label_name = {0: 'short', 1: 'none', 2: 'long'}[label]
        weight = 10.0 if label in [0, 2] else 1.0
        print(f"      {label_name}: {count} (weight={weight}x)")
    
    # Entraînement XGBoost avec hyperparamètres optimisés
    print("\n⚙️  Entraînement XGBoost (70%+ objectif)...")
    
    model = XGBClassifier(
        n_estimators=600,  # Plus d'arbres pour capturer patterns complexes
        max_depth=14,  # Profondeur augmentée pour features avancées
        learning_rate=0.015,  # LR réduit pour convergence fine
        subsample=0.85,
        colsample_bytree=0.85,
        min_child_weight=2,
        gamma=0.15,
        reg_alpha=0.05,
        reg_lambda=0.8,
        random_state=42,
        eval_metric='mlogloss',
        early_stopping_rounds=50,
        tree_method='hist'  # Plus rapide
    )
    
    model.fit(
        X_train_balanced, 
        y_train_balanced,
        sample_weight=sample_weights,
        eval_set=[(X_val, y_val)],
        verbose=False
    )
    
    # Évaluation sur test set
    y_pred = model.predict(X_test)
    
    print("\n📈 Résultats sur le test set:")
    print(classification_report(y_test, y_pred, target_names=['short', 'none', 'long'], digits=3))
    
    print("\n📊 Matrice de confusion:")
    cm = confusion_matrix(y_test, y_pred, labels=[0, 1, 2])
    print("         Pred:")
    print("       short  none  long")
    for i, label in enumerate(['short', 'none', 'long']):
        print(f"{label:5s} {cm[i]}")
    
    # Calculer recall par classe
    recall_short = cm[0][0] / cm[0].sum() if cm[0].sum() > 0 else 0
    recall_none = cm[1][1] / cm[1].sum() if cm[1].sum() > 0 else 0
    recall_long = cm[2][2] / cm[2].sum() if cm[2].sum() > 0 else 0
    
    print(f"\n🎯 Recall détaillé:")
    print(f"   Short: {recall_short:.1%}")
    print(f"   None:  {recall_none:.1%}")
    print(f"   Long:  {recall_long:.1%}")
    
    # Feature importance
    feature_importance = pd.DataFrame({
        'feature': feature_cols,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)
    
    print(f"\n🔝 Top 10 features importantes:")
    for idx, row in feature_importance.head(10).iterrows():
        print(f"   {row['feature']:20s} {row['importance']:.4f}")
    
    # Sauvegarder
    print("\n💾 Sauvegarde du modèle...")
    
    output_dir = Path(__file__).parent
    
    # Sauvegarder le modèle XGBoost
    model_path = output_dir / 'xgboost_model_conservative.json'
    model.save_model(str(model_path))
    print(f"   ✓ Modèle: {model_path}")
    
    # Sauvegarder l'ordre des features
    features_path = output_dir / 'feature_order_conservative.json'
    with open(features_path, 'w') as f:
        json.dump(feature_cols, f, indent=2)
    print(f"   ✓ Features: {features_path}")
    
    # Sauvegarder les métadonnées
    metadata = {
        'trained_at': pd.Timestamp.now().isoformat(),
        'n_samples': len(df),
        'n_features': len(feature_cols),
        'label_distribution': label_counts.to_dict(),
        'test_accuracy': float(model.score(X_test, y_test)),
        'recall_short': float(recall_short),
        'recall_none': float(recall_none),
        'recall_long': float(recall_long),
        'optimized_for': '70%+ accuracy and recall',
        'thresholds': {
            'min_movement_pct': 0.7,
            'lookforward': 3,
            'adaptive': True
        },
        'balancing': {
            'method': 'hybrid_undersampling',
            'none_ratio': 2.5,
            'sample_weights_long_short': 10.0
        },
        'hyperparameters': {
            'n_estimators': 600,
            'max_depth': 14,
            'learning_rate': 0.015
        }
    }
    
    metadata_path = output_dir / 'predictor_metadata_conservative.json'
    with open(metadata_path, 'w') as f:
        json.dump(metadata, f, indent=2)
    print(f"   ✓ Metadata: {metadata_path}")
    
    print("\n✅ Entraînement terminé!")
    print(f"   Test Accuracy: {metadata['test_accuracy']:.1%}")
    print(f"   Avg Recall: {(recall_short + recall_none + recall_long) / 3:.1%}")
    
    # Alerte si objectif non atteint
    min_recall = min(recall_short, recall_none, recall_long)
    if min_recall < 0.70:
        print(f"\n⚠️  Objectif 70% non atteint (min recall: {min_recall:.1%})")
        print("   Suggestions:")
        print("   - Augmenter n_estimators à 800")
        print("   - Ajuster sample_weights (essayer 12-15x)")
        print("   - Réduire min_movement_pct à 0.6%")
    else:
        print(f"\n🎉 Objectif 70%+ ATTEINT! (min recall: {min_recall:.1%})")
    
    return model, feature_cols, metadata


def main():
    print("=" * 70)
    print("🚀 RÉENTRAÎNEMENT OPTIMISÉ - OBJECTIF 70%+")
    print("=" * 70)
    print("\nOptimisations:")
    print("  ✓ 41 features avancées (momentum, divergences, BB, patterns)")
    print("  ✓ Seuil adaptatif 0.7% (RSI extreme → 0.35%)")
    print("  ✓ Lookforward 3 candles (réactivité crypto)")
    print("  ✓ Sample weights 10x pour long/short")
    print("  ✓ Balancing hybride (2.5:1 none ratio)")
    print("  ✓ XGBoost: 600 trees, depth 14, LR 0.015")
    print("  ✓ Early stopping avec validation set")
    print()
    
    # Charger les données
    df = load_and_prepare_data()
    if df is None:
        return
    
    # Calculer les features
    df = calculate_features(df)
    
    # Entraîner
    model, features, metadata = train_model(df)
    
    print("\n" + "=" * 70)
    print("✅ ENTRAÎNEMENT COMPLÉTÉ!")
    print("=" * 70)
    print("\nProchaines étapes:")
    print("  1. Vérifier les recall (objectif 70%+ partout)")
    print("  2. Si objectif atteint → commit & push")
    print("  3. Si non atteint → ajuster hyperparamètres")
    print("  4. Render auto-déploie et génère le modèle")
    print()



if __name__ == '__main__':
    main()
