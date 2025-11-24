#!/bin/bash
# Script pour vérifier la présence des modèles ML au déploiement
set -e

echo "🔍 Vérification des modèles ML..."
echo ""

# Vérifier Python3
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 n'est pas installé"
    exit 1
fi

echo "✅ Python: $(python3 --version)"
echo ""

# Installer les dépendances Python (nécessaires pour l'inférence)
echo "📦 Installation des dépendances Python..."
pip3 install --quiet pandas numpy scikit-learn imbalanced-learn xgboost 2>&1 | grep -v "Requirement already satisfied" || true
echo "✅ Dépendances installées"
echo ""

# Aller dans le dossier python
cd "$(dirname "$0")/python"

# Vérifier que le modèle existe
if [ ! -f "xgboost_model_conservative.json" ]; then
    echo "❌ ERREUR: Modèle manquant (xgboost_model_conservative.json)"
    echo "💡 Le modèle doit être commité dans git"
    exit 1
fi

if [ ! -f "feature_order_conservative.json" ]; then
    echo "❌ ERREUR: Fichier de features manquant (feature_order_conservative.json)"
    exit 1
fi

if [ ! -f "predictor_metadata_conservative.json" ]; then
    echo "❌ ERREUR: Métadonnées manquantes (predictor_metadata_conservative.json)"
    exit 1
fi

# Afficher les infos du modèle
MODEL_SIZE=$(du -h xgboost_model_conservative.json | cut -f1)

echo "=" | tr '\n' '=' && printf %.0s= {1..69} && echo ""
echo "✅ MODÈLES ML VÉRIFIÉS AVEC SUCCÈS"
echo "=" | tr '\n' '=' && printf %.0s= {1..69} && echo ""
echo ""
echo "Fichiers détectés:"
echo "  📄 xgboost_model_conservative.json ($MODEL_SIZE)"
echo "  📄 feature_order_conservative.json"
echo "  📄 predictor_metadata_conservative.json"
echo ""
echo "🎯 Modèle prêt pour l'inférence"
echo ""
