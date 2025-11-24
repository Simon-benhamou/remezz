#!/bin/bash
# Script automatique pour générer les modèles ML au déploiement Render
set -e

echo "🚀 Démarrage de la génération des modèles ML..."
echo ""

# Vérifier Python3
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 n'est pas installé"
    exit 1
fi

echo "✅ Python: $(python3 --version)"
echo ""

# Installer les dépendances automatiquement (mode non-interactif)
echo "📦 Installation des dépendances Python..."
pip3 install --quiet pandas numpy scikit-learn imbalanced-learn xgboost 2>&1 | grep -v "Requirement already satisfied" || true
echo "✅ Dépendances installées"
echo ""

# Aller dans le dossier python
cd "$(dirname "$0")/python"

# Vérifier les données
CACHE_DIR="cache"
if [ ! -d "$CACHE_DIR" ] || [ $(find "$CACHE_DIR" -name "*.csv" 2>/dev/null | wc -l) -eq 0 ]; then
    echo "⚠️  Pas de données CSV - collecte nécessaire"
    echo "📥 Collecte des données historiques..."
    python3 ccxt_xgboost_module.py collect
    echo "✅ Données collectées"
    echo ""
fi

# Vérifier si le modèle existe déjà
if [ -f "xgboost_model_conservative.json" ]; then
    echo "⚠️  Modèle existant détecté"
    echo "🔄 Régénération du modèle..."
else
    echo "🎯 Génération du modèle ML (60.3% recall)..."
fi

echo ""

# Entraîner le modèle
python3 train_conservative.py

echo ""
echo "=" | tr '\n' '=' && printf %.0s= {1..69} && echo ""
echo "✅ MODÈLES ML GÉNÉRÉS AVEC SUCCÈS"
echo "=" | tr '\n' '=' && printf %.0s= {1..69} && echo ""
echo ""
echo "Fichiers générés:"
echo "  📄 xgboost_model_conservative.json (205MB)"
echo "  📄 feature_order_conservative.json"
echo "  📄 predictor_metadata_conservative.json"
echo ""
echo "🎯 Performance: 61.8% accuracy, 60.3% recall long/short"
echo ""
