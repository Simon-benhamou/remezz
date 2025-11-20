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
    from imblearn.over_sampling import SMOTE
    from xgboost import XGBClassifier
    print("✅ Dépendances importées avec succès")
except ImportError as e:
    print(f"❌ Erreur d'import: {e}")
    print("Installation requise: pip install pandas numpy scikit-learn imbalanced-learn xgboost")
    sys.exit(1)

def calculate_conservative_labels(df, min_movement_pct=1.2, lookforward=5):
    """
    Labeling CONSERVATEUR pour haute précision
    - Mouvement minimum: 1.2% (vs 0.5% standard)
    - Lookforward: 5 candles (plus de confirmation)
    - Réduit les faux signaux, améliore la confiance
    """
    labels = []
    
    for i in range(len(df)):
        if i + lookforward >= len(df):
            labels.append('none')
            continue
        
        current_price = df.iloc[i]['close']
        future_prices = df.iloc[i+1:i+lookforward+1]['close'].values
        
        # Calculer le gain/perte maximum
        max_gain = (future_prices.max() - current_price) / current_price * 100
        max_loss = (current_price - future_prices.min()) / current_price * 100
        
        # Labeling conservateur: seulement si mouvement > 1.2%
        if max_gain >= min_movement_pct and max_gain > max_loss:
            labels.append('long')
        elif max_loss >= min_movement_pct and max_loss > max_gain:
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
    """Calculer les features techniques"""
    print("\n🔧 Calcul des features...")
    
    # EMAs
    df['ema9'] = df['close'].ewm(span=9).mean()
    df['ema12'] = df['close'].ewm(span=12).mean()
    df['ema20'] = df['close'].ewm(span=20).mean()
    df['ema26'] = df['close'].ewm(span=26).mean()
    df['ema50'] = df['close'].ewm(span=50).mean()
    df['ema200'] = df['close'].ewm(span=200).mean()
    
    # RSI
    delta = df['close'].diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=14).mean()
    rs = gain / loss
    df['rsi14'] = 100 - (100 / (1 + rs))
    df['rsi7'] = df['close'].rolling(7).apply(lambda x: 100 - (100 / (1 + (x.diff().where(x.diff() > 0, 0).mean() / -x.diff().where(x.diff() < 0, 0).mean()))))
    
    # MACD
    exp1 = df['close'].ewm(span=12).mean()
    exp2 = df['close'].ewm(span=26).mean()
    df['macd'] = exp1 - exp2
    df['macd_signal'] = df['macd'].ewm(span=9).mean()
    
    # ATR
    high_low = df['high'] - df['low']
    high_close = np.abs(df['high'] - df['close'].shift())
    low_close = np.abs(df['low'] - df['close'].shift())
    ranges = pd.concat([high_low, high_close, low_close], axis=1)
    true_range = ranges.max(axis=1)
    df['atr14'] = true_range.rolling(14).mean()
    df['atrPct'] = (df['atr14'] / df['close']) * 100
    
    # Volume
    df['volumeRatio'] = df['volume'] / df['volume'].rolling(20).mean()
    
    # Momentum
    df['momentum10'] = df['close'].pct_change(10) * 100
    
    # ADX
    df['adx14'] = 25  # Simplifié pour l'exemple
    
    # Slopes
    df['ema20Slope'] = df['ema20'].pct_change(5)
    df['rsiSlope'] = df['rsi14'].diff(3)
    
    # Drop NaN
    df = df.dropna()
    
    print(f"   ✓ {len(df.columns)} features calculées")
    print(f"   ✓ {len(df)} lignes après nettoyage")
    
    return df


def train_model(df):
    """Entraîner le modèle XGBoost"""
    print("\n🤖 Entraînement du modèle...")
    
    # Calculer les labels conservateurs
    df['label'] = calculate_conservative_labels(df, min_movement_pct=1.2, lookforward=5)
    
    # Distribution des labels
    label_counts = df['label'].value_counts()
    print(f"\n📊 Distribution des labels:")
    for label, count in label_counts.items():
        pct = count / len(df) * 100
        print(f"   {label}: {count} ({pct:.1f}%)")
    
    # Features à utiliser
    feature_cols = [
        'ema9', 'ema12', 'ema20', 'ema26', 'ema50', 'ema200',
        'rsi7', 'rsi14', 'rsiSlope',
        'macd', 'macd_signal',
        'atr14', 'atrPct',
        'volumeRatio', 'momentum10',
        'adx14', 'ema20Slope'
    ]
    
    X = df[feature_cols].values
    y_raw = df['label'].values
    
    # Encoder les labels: long=2, none=1, short=0
    label_map = {'long': 2, 'none': 1, 'short': 0}
    y = np.array([label_map[label] for label in y_raw])
    
    # Split train/test
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )
    
    print(f"\n🔀 Split: {len(X_train)} train, {len(X_test)} test")
    
    # Undersampling de la classe majoritaire au lieu de SMOTE
    # Plus rapide et évite l'overfitting
    print("   Équilibrage par undersampling...")
    
    # Séparer les classes
    idx_0 = np.where(y_train == 0)[0]  # short
    idx_1 = np.where(y_train == 1)[0]  # none
    idx_2 = np.where(y_train == 2)[0]  # long
    
    # Prendre min entre les classes minoritaires
    target_size = min(len(idx_0), len(idx_2))
    
    # Sous-échantillonner none pour matcher
    idx_1_sample = np.random.choice(idx_1, target_size, replace=False)
    
    # Combiner
    balanced_idx = np.concatenate([idx_0, idx_1_sample, idx_2])
    np.random.shuffle(balanced_idx)
    
    X_train_balanced = X_train[balanced_idx]
    y_train_balanced = y_train[balanced_idx]
    
    balanced_counts = pd.Series(y_train_balanced).value_counts()
    print(f"   Après undersampling:")
    for label, count in balanced_counts.items():
        label_name = {0: 'short', 1: 'none', 2: 'long'}[label]
        print(f"      {label_name}: {count}")
    
    # Entraînement XGBoost avec paramètres conservateurs
    print("\n⚙️  Entraînement XGBoost (focus PRÉCISION)...")
    
    model = XGBClassifier(
        n_estimators=200,
        max_depth=6,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=3,  # Plus conservateur
        gamma=0.2,  # Plus de régularisation
        reg_alpha=0.1,
        reg_lambda=1.0,
        random_state=42,
        eval_metric='mlogloss'
    )
    
    model.fit(X_train_balanced, y_train_balanced)
    
    # Évaluation
    y_pred = model.predict(X_test)
    
    print("\n📈 Résultats sur le test set:")
    print(classification_report(y_test, y_pred, digits=3))
    
    print("\n📊 Matrice de confusion:")
    cm = confusion_matrix(y_test, y_pred, labels=[2, 1, 0])
    print("         Pred:")
    print("       long  none  short")
    for i, label in enumerate(['long', 'none', 'short']):
        print(f"{label:5s} {cm[i]}")
    
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
        'conservative_thresholds': {
            'min_movement_pct': 1.2,
            'lookforward': 5
        },
        'usage': 'confidence_only_no_gate'
    }
    
    metadata_path = output_dir / 'predictor_metadata_conservative.json'
    with open(metadata_path, 'w') as f:
        json.dump(metadata, f, indent=2)
    print(f"   ✓ Metadata: {metadata_path}")
    
    print("\n✅ Entraînement terminé!")
    print(f"   Test Accuracy: {metadata['test_accuracy']:.1%}")
    
    return model, feature_cols, metadata


def main():
    print("=" * 70)
    print("🚀 RÉENTRAÎNEMENT OPTIMISÉ DU PREDICTOR")
    print("=" * 70)
    print("\nObjectifs:")
    print("  - Haute PRÉCISION (vs recall)")
    print("  - Seuils conservateurs (1.2% mouvement minimum)")
    print("  - Utilisation pour confidence uniquement")
    print("  - PAS de gate bloquant")
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
    print("✅ SUCCÈS!")
    print("=" * 70)
    print("\nProchaines étapes:")
    print("  1. Redémarrer le backend")
    print("  2. Le predictor sera automatiquement chargé")
    print("  3. Vérifier dans les logs: 'XGBoost predictor loaded'")
    print("  4. La confidence sera utilisée sans bloquer les trades")
    print()


if __name__ == '__main__':
    main()
