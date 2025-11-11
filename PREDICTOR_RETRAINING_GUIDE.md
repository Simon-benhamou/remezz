# Guide de Réentraînement Intelligent du Predictor

## 🎯 Vue d'ensemble

Le système de réentraînement intelligent garantit que le modèle XGBoost reste performant en:
1. ✅ Réentraînant automatiquement selon un calendrier configurable
2. ✅ Validant chaque nouveau modèle avant déploiement
3. ✅ Effectuant un rollback automatique si le nouveau modèle est moins performant
4. ✅ Conservant des backups horodatés de tous les modèles

## 📅 Configuration

### Variables d'environnement (.env)

```bash
# Activer/désactiver le réentraînement automatique
PREDICTOR_RETRAINING_DISABLED=false

# Fréquence : weekly (défaut), biweekly, bimonthly
PREDICTOR_RETRAIN_SCHEDULE=weekly

# Jour de la semaine (0=Dimanche, 1=Lundi, ..., 6=Samedi)
PREDICTOR_RETRAIN_DAY=0

# Heure de réentraînement (UTC)
PREDICTOR_RETRAIN_HOUR=3

# Seuils de validation minimums
PREDICTOR_MIN_ACCURACY=0.50      # Accuracy minimale acceptable
PREDICTOR_MIN_F1=0.45             # F1-score minimal acceptable

# Baisse maximale de performance tolérée (5% = 0.05)
PREDICTOR_MAX_ACCURACY_DROP=0.05
```

### Configuration recommandée par contexte

**Production normale (recommandé):**
```bash
PREDICTOR_RETRAIN_SCHEDULE=weekly
PREDICTOR_RETRAIN_DAY=0          # Dimanche
PREDICTOR_RETRAIN_HOUR=3         # 3h du matin UTC
PREDICTOR_MIN_ACCURACY=0.52
PREDICTOR_MIN_F1=0.48
PREDICTOR_MAX_ACCURACY_DROP=0.05
```

**Marchés volatils:**
```bash
PREDICTOR_RETRAIN_SCHEDULE=biweekly
PREDICTOR_RETRAIN_DAY=0
PREDICTOR_MIN_ACCURACY=0.50
PREDICTOR_MAX_ACCURACY_DROP=0.07  # Plus tolérant
```

**Marchés stables:**
```bash
PREDICTOR_RETRAIN_SCHEDULE=bimonthly
PREDICTOR_MIN_ACCURACY=0.54       # Plus strict
PREDICTOR_MAX_ACCURACY_DROP=0.03
```

## 🔄 Fonctionnement du système

### Processus automatique

1. **Vérification horaire** : Le scheduler vérifie chaque heure si c'est le bon moment
2. **Backup du modèle actuel** : Sauvegarde avec timestamp
3. **Exécution du réentraînement** : Lance `python/scheduled_training.py`
4. **Validation** : Compare les nouvelles métriques avec les anciennes
5. **Décision de déploiement** :
   - ✅ **Déploie** si validation réussie
   - ❌ **Rollback** si validation échoue

### Critères de validation

Un nouveau modèle est **accepté** si :
- ✅ `accuracy >= PREDICTOR_MIN_ACCURACY` (ex: 0.50)
- ✅ `f1_score >= PREDICTOR_MIN_F1` (ex: 0.45)
- ✅ `accuracy_new >= accuracy_old - MAX_ACCURACY_DROP` (ex: -5% max)
- ✅ `f1_new >= f1_old - MAX_ACCURACY_DROP`

Un nouveau modèle est **rejeté** si :
- ❌ Accuracy en dessous du seuil minimum absolu
- ❌ F1-score en dessous du seuil minimum
- ❌ Baisse de performance supérieure à la limite tolérée
- ❌ Erreur durant l'entraînement

### Exemple de logs

**Réentraînement réussi avec déploiement:**
```
[PredictorRetrainer/retrain] 🔄 Starting intelligent model retraining
[PredictorRetrainer/retrain] Current model metrics loaded | accuracy=0.547 f1=0.512
[PredictorRetrainer/retrain] Model backup created | timestamp=2025-11-11T03-00-00-000Z
[PredictorRetrainer/retrain] Starting Python retraining script
[PredictorRetrainer/retrain] Retraining completed successfully | accuracy=0.553 f1=0.518
[PredictorRetrainer/retrain] ✅ New model validated and deployed
[PredictorRetrainer/retrain] improvement=+0.6% accuracy | duration=142.3s
```

**Réentraînement avec rollback:**
```
[PredictorRetrainer/retrain] 🔄 Starting intelligent model retraining
[PredictorRetrainer/retrain] Current model metrics loaded | accuracy=0.547 f1=0.512
[PredictorRetrainer/retrain] Model backup created | timestamp=2025-11-11T03-00-00-000Z
[PredictorRetrainer/retrain] Retraining completed | newAccuracy=0.485 newF1=0.421
[PredictorRetrainer/retrain] ⚠️ New model failed validation, rolling back
[PredictorRetrainer/retrain] reason=Accuracy 0.485 below threshold 0.50
[PredictorRetrainer/retrain] Model restored from backup
```

## 🔧 API Endpoints

### Vérifier le statut du réentraînement

```bash
GET /api/ops/predictor/retrain-status
Authorization: Bearer <admin_token>
```

**Réponse:**
```json
{
  "ok": true,
  "status": {
    "inProgress": false,
    "lastRetrainTime": 1731294000000,
    "schedule": "weekly",
    "nextCheck": "2025-11-17T03:00:00.000Z",
    "config": {
      "minAccuracy": 0.50,
      "minF1": 0.45,
      "maxAccuracyDrop": 0.05,
      "retrainDay": 0,
      "retrainHour": 3
    }
  }
}
```

### Déclencher un réentraînement manuel

```bash
POST /api/ops/predictor/retrain
Authorization: Bearer <admin_token>
```

**Réponse (succès avec déploiement):**
```json
{
  "ok": true,
  "deployed": true,
  "message": "Model retrained and deployed successfully",
  "result": {
    "success": true,
    "deployed": true,
    "oldMetrics": {
      "accuracy": 0.547,
      "f1_score": 0.512,
      "timestamp": 1731294000000
    },
    "newMetrics": {
      "accuracy": 0.553,
      "f1_score": 0.518,
      "timestamp": 1731380400000
    },
    "reason": "Model validated: accuracy=0.553, f1=0.518",
    "duration": 142300
  }
}
```

**Réponse (succès mais pas de déploiement):**
```json
{
  "ok": true,
  "deployed": false,
  "message": "Model retrained but validation failed - old model kept",
  "result": {
    "success": true,
    "deployed": false,
    "reason": "Accuracy dropped by 6.20% (max allowed: 5.00%)",
    "duration": 138500
  }
}
```

## 📊 Backups et historique

### Fichiers de backup

Les backups sont stockés dans `python/` avec horodatage:
```
python/
  ├── xgboost_direction.json                    # Modèle actuel
  ├── xgboost_direction.backup.2025-11-11T03-00-00-000Z.json
  ├── training_metrics.json                     # Métriques actuelles
  ├── training_metrics.backup.2025-11-11T03-00-00-000Z.json
  ├── features.txt                              # Features actuelles
  └── features.backup.2025-11-11T03-00-00-000Z.txt
```

### Restauration manuelle d'un backup

Si nécessaire, vous pouvez restaurer manuellement un ancien modèle:

```bash
cd python
cp xgboost_direction.backup.2025-11-10T03-00-00-000Z.json xgboost_direction.json
cp training_metrics.backup.2025-11-10T03-00-00-000Z.json training_metrics.json
cp features.backup.2025-11-10T03-00-00-000Z.txt features.txt
```

Puis redémarrez le backend pour charger le modèle restauré.

## 🚨 Déclencheurs d'urgence (à implémenter)

Réentraînement d'urgence recommandé si:
- Win rate < 45% sur 3 jours consécutifs
- Accuracy du predictor < 50% observée en production
- Événement de marché majeur (crash/pump > 20%)
- Changement de régime détecté (trending → ranging)

## 📈 Métriques à surveiller

### Avant réentraînement
- `accuracy` : Précision globale du modèle
- `f1Macro` : F1-score macro (équilibré entre classes)
- `rocAucMacro` : AUC-ROC pour classification multi-classes
- `logLoss` : Perte logarithmique (plus bas = mieux)

### Après réentraînement
- Comparer `accuracy` ancien vs nouveau
- Comparer `f1_score` ancien vs nouveau
- Vérifier que la baisse ne dépasse pas `MAX_ACCURACY_DROP`
- Observer les performances en production pendant 48h

## 🔍 Troubleshooting

### Le réentraînement ne se déclenche jamais

**Vérifier:**
```bash
# 1. Le scheduler est actif
grep "Predictor retraining scheduler started" /path/to/backend.log

# 2. La configuration
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:4000/api/ops/predictor/retrain-status

# 3. Pas désactivé par env
echo $PREDICTOR_RETRAINING_DISABLED  # doit être vide ou false
```

### Le nouveau modèle est toujours rejeté

**Causes possibles:**
- Seuils trop stricts → Ajuster `PREDICTOR_MIN_ACCURACY` et `PREDICTOR_MAX_ACCURACY_DROP`
- Données d'entraînement insuffisantes → Vérifier `python/data/` cache
- Symboles peu tradés → Ajouter plus de paires dans `XGB_SYMBOLS`

**Solution:**
```bash
# Baisser temporairement les seuils
PREDICTOR_MIN_ACCURACY=0.48
PREDICTOR_MAX_ACCURACY_DROP=0.08

# Puis réentraîner manuellement
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:4000/api/ops/predictor/retrain
```

### Erreur durant l'entraînement Python

**Vérifier:**
```bash
# 1. Python et dépendances installées
python3 --version
pip3 install -r requirements.txt

# 2. Exécuter manuellement
cd backend
python3 python/scheduled_training.py

# 3. Vérifier les logs d'erreur
tail -100 /path/to/backend.log | grep -i "predictor\|retrain"
```

## 📚 Références

- Script d'entraînement: `backend/python/scheduled_training.py`
- Module principal: `backend/python/ccxt_xgboost_module.py`
- Service TypeScript: `backend/src/learning/predictorRetrainer.ts`
- API routes: `backend/src/routes/ops.ts`

## ✅ Checklist de déploiement

Avant de déployer le système de réentraînement:

- [ ] Configurer les variables d'environnement dans `.env`
- [ ] Vérifier que Python 3 et les dépendances sont installés
- [ ] Entraîner un modèle initial: `npm run train-model`
- [ ] Vérifier que `training_metrics.json` contient des métriques valides
- [ ] Tester un réentraînement manuel via l'API
- [ ] Vérifier les logs pour confirmer le scheduler actif
- [ ] Configurer des alertes pour les échecs de réentraînement

## 🎓 Bonnes pratiques

1. **Surveillez les métriques** : Gardez un œil sur l'accuracy et F1-score après chaque réentraînement
2. **Ajustez les seuils** : Commencez conservateur, assouplissez si nécessaire
3. **Gardez les backups** : Ne supprimez pas les anciens modèles pendant au moins 30 jours
4. **Testez en paper trading** : Après un réentraînement majeur, testez 24-48h en paper avant live
5. **Documentez les changements** : Notez les paramètres utilisés pour chaque réentraînement réussi
