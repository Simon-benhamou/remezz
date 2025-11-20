#!/bin/bash
# Script de préparation pour l'entraînement du predictor

echo "🔍 Vérification de l'environnement Python..."
echo ""

# Vérifier Python3
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 n'est pas installé"
    exit 1
fi

echo "✅ Python: $(python3 --version)"

# Vérifier pip
if ! command -v pip3 &> /dev/null; then
    echo "❌ pip3 n'est pas installé"
    exit 1
fi

echo "✅ pip: $(pip3 --version)"
echo ""

# Vérifier les dépendances
echo "📦 Vérification des dépendances..."

DEPS_OK=true

check_package() {
    if python3 -c "import $1" 2>/dev/null; then
        echo "  ✅ $1"
    else
        echo "  ❌ $1 - Manquant"
        DEPS_OK=false
    fi
}

check_package "pandas"
check_package "numpy"
check_package "sklearn"
check_package "imblearn"
check_package "xgboost"

echo ""

if [ "$DEPS_OK" = false ]; then
    echo "⚠️  Dépendances manquantes détectées"
    echo ""
    echo "Installation automatique? (y/n)"
    read -r response
    
    if [ "$response" = "y" ]; then
        echo ""
        echo "📥 Installation des dépendances..."
        pip3 install pandas numpy scikit-learn imbalanced-learn xgboost
        
        if [ $? -eq 0 ]; then
            echo ""
            echo "✅ Installation réussie!"
        else
            echo ""
            echo "❌ Erreur d'installation"
            exit 1
        fi
    else
        echo ""
        echo "Pour installer manuellement:"
        echo "  pip3 install pandas numpy scikit-learn imbalanced-learn xgboost"
        exit 1
    fi
fi

echo ""
echo "🎯 Vérification des données..."

CACHE_DIR="python/cache"
if [ ! -d "$CACHE_DIR" ]; then
    echo "⚠️  Dossier cache manquant: $CACHE_DIR"
    echo ""
    echo "Collecte des données nécessaire:"
    echo "  cd backend/python"
    echo "  python3 ccxt_xgboost_module.py collect"
    exit 1
fi

CSV_COUNT=$(find "$CACHE_DIR" -name "*.csv" 2>/dev/null | wc -l | tr -d ' ')
if [ "$CSV_COUNT" -eq 0 ]; then
    echo "⚠️  Aucun fichier CSV dans $CACHE_DIR"
    echo ""
    echo "Collecte des données nécessaire:"
    echo "  cd backend/python"
    echo "  python3 ccxt_xgboost_module.py collect"
    exit 1
fi

echo "✅ Données disponibles: $CSV_COUNT fichiers CSV"

echo ""
echo "=" | tr '\n' '=' && printf %.0s= {1..69} && echo ""
echo "✅ ENVIRONNEMENT PRÊT POUR L'ENTRAÎNEMENT"
echo "=" | tr '\n' '=' && printf %.0s= {1..69} && echo ""
echo ""
echo "Pour entraîner le modèle:"
echo "  cd backend/python"
echo "  python3 train_conservative.py"
echo ""
echo "Temps estimé: 5-30 minutes"
echo ""
