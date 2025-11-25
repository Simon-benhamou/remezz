# 🤖 Modèles de Prédiction - Workflow

## 📋 Fichiers Générés (Non Versionnés Git)

Ces fichiers sont **automatiquement générés** et ne doivent **PAS** être commités :

```
backend/python/
├── xgboost_model_conservative.json      # ~450MB - Modèle XGBoost entraîné
├── feature_order_conservative.json      # Liste ordonnée des features
├── predictor_metadata_conservative.json # Métadonnées (accuracy, dates, etc.)
├── hybrid_state.json                    # État du meta-learner
└── training_metrics.json                # Métriques d'entraînement
```

**Taille totale** : ~450-500MB

## 🚫 Pourquoi Hors Git ?

1. **Taille** : 450MB+ dépasse les limites GitHub (100MB/file)
2. **Volatilité** : Modèle réentraîné régulièrement
3. **Build-time** : Généré automatiquement pendant le build Docker
4. **Performance** : Pas besoin de cloner 450MB à chaque pull

## 🏗️ Génération des Modèles

### En Développement Local

```bash
cd backend
python3 python/train_conservative.py
```

**Durée** : 2-5 minutes selon les données disponibles

**Sortie** :
```
✅ Entraînement complété!
   Test Accuracy: 72.3%
   Avg Recall: 71.8%
```

### En Production (Docker)

Les modèles sont **automatiquement générés pendant le build** :

```dockerfile
# Dockerfile - ligne ~40
RUN python3 train_conservative.py
```

**Avantages** :
- ✅ Modèle toujours à jour avec les dernières données
- ✅ Pas de dépendance externe
- ✅ Build reproductible

## 🔍 Vérifier les Modèles

### Local

```bash
# Lister les modèles
ls -lh backend/python/*.json

# Vérifier qu'ils ne sont PAS trackés par git
git status backend/python/*.json
# Devrait afficher : "nothing to commit"
```

### Docker

```bash
# Build et vérifier
docker build -t trading-backend ./backend
docker run trading-backend ls -lh /app/python/xgboost_model_conservative.json

# Devrait afficher :
# -rw-r--r-- 1 root root 450M Nov 25 12:34 xgboost_model_conservative.json
```

## 🧪 Tester le Modèle

```bash
cd backend
node test-predictor-warmup.mjs
```

**Résultats attendus** :
```
📦 Test 1: Première prédiction (chargement modèle 350MB+)
   ⏱️  Durée: 2500ms

⚡ Test 2: Deuxième prédiction (modèle en cache)
   ⏱️  Durée: 85ms

✅ Cache fonctionne parfaitement! Speedup: 29x
```

## 🔄 Re-générer les Modèles

### Quand Re-générer ?

- 📊 Nouvelles données historiques collectées
- 🎯 Ajustement des hyperparamètres
- 🐛 Changement des features
- 📉 Performance dégradée (accuracy < 65%)

### Comment ?

```bash
# 1. Supprimer les anciens modèles
rm backend/python/xgboost_model_*.json
rm backend/python/feature_order_*.json
rm backend/python/predictor_metadata_*.json

# 2. Re-générer
cd backend
python3 python/train_conservative.py

# 3. Vérifier
ls -lh python/*.json
```

## 🚨 Troubleshooting

### Erreur : "Model file not found"

```
FileNotFoundError: xgboost_model_conservative.json
```

**Solution** :
```bash
cd backend
python3 python/train_conservative.py
```

### Erreur : "No CSV files found"

```
ValueError: No training data available
```

**Solution** : Collecter des données historiques d'abord
```bash
cd backend
python3 python/ccxt_xgboost_module.py collect
```

### Modèle Trop Gros pour Git

Si vous voyez ce warning :
```
warning: File backend/python/xgboost_model_conservative.json is 454 MB
```

**Solution** : Le modèle ne devrait PAS être commité !
```bash
# Retirer du tracking git
git rm --cached backend/python/xgboost_model_conservative.json

# Vérifier le .gitignore
grep xgboost .gitignore
# Devrait afficher : **/xgboost_model_*.json
```

## 📊 Métriques des Modèles

Les métadonnées incluent :

```json
{
  "trained_at": "2025-11-25T12:34:56Z",
  "test_accuracy": 0.723,
  "recall_long": 0.718,
  "recall_short": 0.715,
  "recall_none": 0.721,
  "n_samples": 15234,
  "optimized_for": "70%+ accuracy and recall"
}
```

**Seuils cibles** :
- ✅ Accuracy globale : **70%+**
- ✅ Recall par classe : **70%+**
- ⚠️ Alert si < 65%

## 🔐 Sécurité

Les modèles contiennent :
- ✅ Poids et architecture XGBoost (publics)
- ❌ Pas de clés API ou secrets
- ❌ Pas de données sensibles utilisateur

**Sécurité OK** pour stockage dans container Docker public.

## 📚 Références

- Training script : `backend/python/train_conservative.py`
- Model loading : `backend/python/ccxt_xgboost_module.py:1313`
- Docker build : `backend/Dockerfile:40-48`
- Gitignore : `.gitignore:37-43`
