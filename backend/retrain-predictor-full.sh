#!/bin/bash
# Script d'entraînement complet du prédicteur avec données volumineuses
# Usage: ./retrain-predictor-full.sh

set -e

cd "$(dirname "$0")/python"

echo "🚀 =========================================="
echo "   ENTRAÎNEMENT COMPLET DU PRÉDICTEUR"
echo "   =========================================="
echo ""

# Configuration pour obtenir beaucoup de données
export XGB_EXCHANGE="cryptocom"

# Symboles multiples pour diversité (top 15 par volume)
export XGB_SYMBOLS="BTC/USDT:USDT,ETH/USDT:USDT,SOL/USDT:USDT,XRP/USDT:USDT,BNB/USDT:USDT,ADA/USDT:USDT,DOT/USDT:USDT,DOGE/USDT:USDT,MATIC/USDT:USDT,LINK/USDT:USDT,UNI/USDT:USDT,AVAX/USDT:USDT,LTC/USDT:USDT,ATOM/USDT:USDT,NEAR/USDT:USDT"

# Timeframe 15m avec plusieurs fenêtres pour augmenter les samples
# lookback_hours: combien d'heures de données historiques à collecter
# offset_hours: décalage entre les fenêtres pour créer plus d'échantillons
export XGB_TIMEFRAME="15m"

# Configuration des fenêtres:
# Format: "timeframe:lookback_hours:offset_hours"
# Plusieurs fenêtres qui se chevauchent pour maximiser les samples
export XGB_WINDOW_SPECS="15m:720:24,15m:720:48,15m:720:72"

# Nettoyage du cache après entraînement pour économiser l'espace
export XGB_CLEANUP_CACHE="1"

echo "📊 Configuration:"
echo "   - Exchange: $XGB_EXCHANGE"
echo "   - Symboles: $(echo $XGB_SYMBOLS | tr ',' '\n' | wc -l | xargs) cryptos"
echo "   - Timeframe: $XGB_TIMEFRAME"
echo "   - Fenêtres: 3 périodes de 30 jours avec chevauchement"
echo "   - Objectif: >5000 samples avec balance des classes"
echo ""

# Vérifier que Python et les dépendances sont installées
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 n'est pas installé!"
    exit 1
fi

# Installer les dépendances si nécessaire
echo "📦 Vérification des dépendances Python..."
python3 -m pip install -q --upgrade pip 2>/dev/null || true
python3 -m pip install -q -r requirements.txt 2>/dev/null || {
    echo "⚠️  Installation des dépendances échouée, poursuite..."
}

echo ""
echo "🔄 Début de l'entraînement (cela peut prendre 5-10 minutes)..."
echo "   - Collecte des données OHLCV..."
echo "   - Calcul des indicateurs techniques..."
echo "   - Labélisation des directions..."
echo "   - Entraînement XGBoost..."
echo ""

# Lancer l'entraînement avec timeout de 15 minutes
RESULT=$(timeout 900 python3 scheduled_training.py 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 124 ]; then
    echo "❌ TIMEOUT: L'entraînement a pris plus de 15 minutes"
    exit 1
elif [ $EXIT_CODE -ne 0 ]; then
    echo "❌ ERREUR lors de l'entraînement:"
    echo "$RESULT"
    exit 1
fi

echo "✅ Entraînement terminé avec succès!"
echo ""
echo "📊 Résultats:"
echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"

# Vérifier que les fichiers ont été générés
if [ ! -f "xgb_predictor.pkl" ]; then
    echo ""
    echo "❌ ERREUR: Le modèle xgb_predictor.pkl n'a pas été créé!"
    exit 1
fi

if [ ! -f "predictor_metadata.json" ]; then
    echo ""
    echo "❌ ERREUR: Les métadonnées predictor_metadata.json n'ont pas été créées!"
    exit 1
fi

echo ""
echo "📁 Fichiers générés:"
ls -lh xgb_predictor.pkl predictor_metadata.json training_metrics.json features.txt 2>/dev/null || true

echo ""
echo "🎯 Analyse des métriques:"
if [ -f "training_metrics.json" ]; then
    python3 -c "
import json
with open('training_metrics.json') as f:
    m = json.load(f)
    print(f\"   Accuracy: {m['accuracy']*100:.1f}%\")
    print(f\"   F1-Score: {m['f1_score']*100:.1f}%\")
    print(f\"   Samples: {m['samples']}\")
    print(f\"   Timestamp: {m['timestamp']}\")
    
    if m['samples'] < 1000:
        print(f\"\\n⚠️  ATTENTION: Seulement {m['samples']} samples - recommandé: >5000\")
        print(\"   Augmentez XGB_WINDOW_SPECS ou ajoutez plus de symboles\")
    elif m['samples'] < 5000:
        print(f\"\\n⚠️  {m['samples']} samples - acceptable mais recommandé: >5000\")
    else:
        print(f\"\\n✅ {m['samples']} samples - excellent!\")
    
    if m['accuracy'] < 0.6:
        print(f\"\\n⚠️  Accuracy faible ({m['accuracy']*100:.1f}%) - modèle peu fiable\")
    elif m['accuracy'] > 0.95:
        print(f\"\\n⚠️  Accuracy très élevée ({m['accuracy']*100:.1f}%) - risque d'overfitting\")
        print(\"   Vérifiez la distribution des prédictions en production\")
" || echo "   (impossible de parser training_metrics.json)"
fi

echo ""
echo "✅ =========================================="
echo "   ENTRAÎNEMENT TERMINÉ"
echo "   =========================================="
echo ""
echo "🔍 Prochaine étape: Testez le modèle avec:"
echo "   node test-predictor-reliability.mjs"
echo ""
