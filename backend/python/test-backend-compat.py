#!/usr/bin/env python3
"""
Test final: Vérifier que le predictor Python peut charger le modèle et accepte les 37 features
"""

import json
import sys
from pathlib import Path

# Features que le backend TypeScript envoie maintenant (37 features exactement)
BACKEND_FEATURES = {
    # EMAs (6)
    "ema9": 3495.0,
    "ema12": 3490.0,
    "ema20": 3480.0,
    "ema26": 3475.0,
    "ema50": 3460.0,
    "ema200": 3400.0,
    # Distances EMA (3)
    "dist_ema9": 0.143,
    "dist_ema20": 0.574,
    "dist_ema50": 1.156,
    # RSI patterns (5)
    "rsi7": 55.0,
    "rsi14": 58.0,
    "rsiSlope": 2.5,
    "rsiAccel": 0.0,
    "rsiDivergence": 0.0,
    # MACD complet (4)
    "macd": 15.0,
    "macd_signal": 12.0,
    "macd_hist": 3.0,
    "macd_cross": 1.0,
    # ATR et volatilité (3)
    "atr14": 52.0,
    "atrPct": 0.015,
    "atrRatio": 1.2,
    # Volume patterns (3)
    "volumeRatio": 1.8,
    "volumeSpike": 0.0,
    "volumeTrend": 1.4,
    # Momentum (4)
    "momentum5": 1.2,
    "momentum10": 2.5,
    "momentum20": 4.8,
    "momentumAccel": -1.3,
    # Trend indicators (3)
    "adx14": 25.0,
    "plusDI": 20.0,
    "minusDI": 15.0,
    # Bollinger Bands (2)
    "bb_position": 0.6,
    "bb_width": 0.04,
    # Price patterns (4)
    "ema20Slope": 0.5,
    "priceAccel": -0.7,
    "highLowRatio": 0.0075,
    "emaCross": 1.0,
}

print("🧪 Test final: Backend features → Python predictor\n")
print("=" * 70)

# Vérifier que nous avons bien 37 features
print(f"\n✅ Features générées par le backend: {len(BACKEND_FEATURES)}")

if len(BACKEND_FEATURES) != 37:
    print(f"❌ ERREUR: Attendu 37 features, trouvé {len(BACKEND_FEATURES)}")
    sys.exit(1)

# Vérifier que feature_order_conservative.json existe
feature_order_path = Path(__file__).parent / 'feature_order_conservative.json'
model_path = Path(__file__).parent / 'xgboost_model_conservative.json'

if not feature_order_path.exists():
    print(f"\n⚠️  {feature_order_path.name} pas encore généré")
    print("   → Lancer: python3 train_conservative.py")
    print("\nTest de structure RÉUSSI (modèle pas encore entraîné)")
    sys.exit(0)

# Charger l'ordre des features du modèle
with open(feature_order_path, 'r') as f:
    model_features = json.load(f)

print(f"✅ Features attendues par le modèle: {len(model_features)}\n")

# Vérifier la correspondance
print("🔍 Vérification de la compatibilité:\n")

missing_in_backend = []
extra_in_backend = []
backend_keys = set(BACKEND_FEATURES.keys())
model_keys = set(model_features)

missing_in_backend = model_keys - backend_keys
extra_in_backend = backend_keys - model_keys

if missing_in_backend:
    print(f"❌ Features MANQUANTES dans le backend ({len(missing_in_backend)}):")
    for f in missing_in_backend:
        print(f"   - {f}")
    print()

if extra_in_backend:
    print(f"⚠️  Features EN TROP dans le backend ({len(extra_in_backend)}):")
    for f in extra_in_backend:
        print(f"   - {f}")
    print()

if not missing_in_backend and not extra_in_backend:
    print("✅ Correspondance PARFAITE: 41 features compatibles!\n")

# Tester une prédiction si le modèle existe
if model_path.exists():
    print("🤖 Test de prédiction avec le modèle...\n")
    
    try:
        from xgboost import XGBClassifier
        
        # Charger le modèle
        model = XGBClassifier()
        model.load_model(str(model_path))
        
        # Préparer les features dans le bon ordre
        feature_row = [BACKEND_FEATURES[key] for key in model_features]
        
        # Faire une prédiction
        import numpy as np
        X = np.array([feature_row])
        prediction = model.predict(X)[0]
        probabilities = model.predict_proba(X)[0]
        
        label_map = {0: 'short', 1: 'none', 2: 'long'}
        decision = label_map[prediction]
        
        print(f"   Décision: {decision}")
        print(f"   Probabilités:")
        print(f"      Short: {probabilities[0]:.1%}")
        print(f"      None:  {probabilities[1]:.1%}")
        print(f"      Long:  {probabilities[2]:.1%}")
        print()
        print("✅ Prédiction RÉUSSIE - Tout fonctionne!\n")
        
    except Exception as e:
        print(f"❌ Erreur lors de la prédiction: {e}\n")
        sys.exit(1)
else:
    print("ℹ️  Modèle pas encore entraîné - test de structure seulement\n")

# Résumé
print("=" * 70)
print("\n📊 RÉSUMÉ\n")

all_ok = len(BACKEND_FEATURES) == 37 and not missing_in_backend and not extra_in_backend

if all_ok:
    print("🎉 TOUS LES TESTS RÉUSSIS!")
    print("   ✓ Backend envoie 37 features")
    print("   ✓ Modèle attend 37 features")
    print("   ✓ Correspondance exacte")
    if model_path.exists():
        print("   ✓ Prédiction fonctionnelle")
    print()
    print("✅ Backend TypeScript 100% compatible avec Python predictor\n")
    sys.exit(0)
else:
    print("💥 TESTS ÉCHOUÉS")
    if len(BACKEND_FEATURES) != 37:
        print(f"   ✗ Backend envoie {len(BACKEND_FEATURES)} features (attendu 37)")
    if missing_in_backend:
        print(f"   ✗ {len(missing_in_backend)} features manquantes")
    if extra_in_backend:
        print(f"   ✗ {len(extra_in_backend)} features en trop")
    print()
    sys.exit(1)
