# 🗂️ Gestion du Cache OHLCV - Guide de Production

## 📋 Situation Actuelle

### Fichiers CSV Créés
Le système crée des fichiers CSV dans `data/ccxt_cache/` pour cacher les données OHLCV:

```
data/ccxt_cache/
├── binance_BTC_USDT_1h.csv      (~500KB)
├── binance_BTC_USDT_4h.csv      (~200KB)
├── binance_ETH_USDT_1h.csv      (~500KB)
├── binance_ETH_USDT_4h.csv      (~200KB)
├── ... (12 symboles × 4 timeframes)
└── Total: ~24-96 MB
```

### Comportement par Défaut
❌ **Les fichiers NE SONT PAS supprimés** après l'entraînement
- Cache intentionnel pour accélérer futurs entraînements
- Données incrémentales (ajoute seulement les nouvelles)

---

## ✅ Solutions pour la Production

### **Option 1: Garder le Cache (RECOMMANDÉ)**

#### Avantages
- ✅ **10x plus rapide** : Ré-entraînements en 2-3 min au lieu de 15 min
- ✅ **Économise les API calls** : Pas de re-téléchargement
- ✅ **Incrémental** : Ajoute seulement nouvelles données
- ✅ **Robuste** : Continue à fonctionner même si API down

#### Inconvénients
- ⚠️ Utilise **~100 MB** d'espace disque
- ⚠️ Peut garder données obsolètes si pas nettoyé

#### Configuration
**Aucune action requise** - C'est le comportement par défaut

#### Recommandation Production
```bash
# Nettoyer les vieux caches une fois par mois
# Ajouter dans crontab:
0 0 1 * * python3 /path/to/python/cleanup_cache.py --keep-days 30
```

---

### **Option 2: Nettoyage Automatique Après Training**

#### Configuration
**Variable d'environnement** dans `.env`:
```bash
# Supprimer le cache après chaque training
XGB_CLEANUP_CACHE=1
```

#### Impact
- ✅ **Espace disque libéré** immédiatement après training
- ❌ **Entraînements futurs plus lents** (re-télécharge tout)
- ❌ **Plus de requêtes API** à chaque entraînement

#### Cas d'Usage
- Production avec **contraintes d'espace disque strictes**
- Environnements **éphémères** (containers détruits après training)
- **Rarement utilisé** (1-2 fois par mois max)

#### Test
```bash
# Tester avec cleanup
cd backend
XGB_CLEANUP_CACHE=1 npm run train-model

# Vérifier que les CSV sont supprimés
ls -lh ../data/ccxt_cache/  # Devrait être vide
```

---

### **Option 3: Nettoyage Manuel Périodique**

#### Script Fourni
`python/cleanup_cache.py` - Script utilitaire pour nettoyer le cache

#### Usages

##### a) Nettoyer TOUT le cache
```bash
cd python
python cleanup_cache.py --all

# Dry run (voir ce qui serait supprimé):
python cleanup_cache.py --all --dry-run
```

##### b) Garder les fichiers récents
```bash
# Supprimer seulement les fichiers de +7 jours
python cleanup_cache.py --keep-days 7

# Dry run:
python cleanup_cache.py --keep-days 7 --dry-run
```

##### c) Intégrer dans Cron
```bash
# Ajouter dans crontab (nettoyage mensuel):
0 0 1 * * cd /path/to/python && python cleanup_cache.py --keep-days 30 >> /var/log/cache-cleanup.log 2>&1
```

---

## 🚀 Recommandations par Environnement

### Development / Staging
```bash
# .env
XGB_CLEANUP_CACHE=0  # GARDER le cache
```
**Rationale**: Entraînements fréquents, gain de temps important

### Production - Serveur Dédié
```bash
# .env
XGB_CLEANUP_CACHE=0  # GARDER le cache

# crontab (nettoyage mensuel)
0 0 1 * * python3 /app/python/cleanup_cache.py --keep-days 30
```
**Rationale**: Balance entre performance et espace disque

### Production - Serverless / Lambda
```bash
# .env
XGB_CLEANUP_CACHE=1  # SUPPRIMER après training
```
**Rationale**: Environnement éphémère, pas de persistance du cache

### Production - Docker / Kubernetes
```bash
# .env
XGB_CLEANUP_CACHE=0  # GARDER dans volume persistant

# volume mount
volumes:
  - ./data:/app/data  # Persister le cache entre redémarrages
```
**Rationale**: Cache persisté dans volume, accélère redémarrages

---

## 📊 Comparaison de Performance

### Avec Cache (Option 1)
```
1er entraînement:  15 min  (télécharge tout)
2e entraînement:    2 min  (utilise cache)
3e entraînement:    2 min  (incrémental)
```

### Sans Cache (Option 2)
```
1er entraînement:  15 min  (télécharge tout)
2e entraînement:   15 min  (re-télécharge tout)
3e entraînement:   15 min  (re-télécharge tout)
```

### Espace Disque
```
12 symboles × 4 timeframes × 5 mois de data:
- 1h timeframe:  ~500KB par symbole
- 4h timeframe:  ~200KB par symbole
Total estimé:    24-96 MB
```

---

## ⚙️ Configuration Système de Retraining

### Avec Nettoyage (Serverless)
**Fichier**: `backend/.env`
```bash
# Scheduler de retraining
PREDICTOR_RETRAINING_DISABLED=false
PREDICTOR_RETRAIN_SCHEDULE=weekly
PREDICTOR_RETRAIN_DAY=0        # Dimanche
PREDICTOR_RETRAIN_HOUR=3       # 3h UTC

# Nettoyage automatique
XGB_CLEANUP_CACHE=1            # Supprimer après training
```

### Sans Nettoyage (Serveur)
**Fichier**: `backend/.env`
```bash
# Scheduler de retraining
PREDICTOR_RETRAINING_DISABLED=false
PREDICTOR_RETRAIN_SCHEDULE=weekly
PREDICTOR_RETRAIN_DAY=0
PREDICTOR_RETRAIN_HOUR=3

# Cache persistant
XGB_CLEANUP_CACHE=0            # Garder le cache

# Nettoyage manuel mensuel via cron (voir ci-dessus)
```

---

## 🔍 Monitoring du Cache

### Vérifier la Taille du Cache
```bash
# Taille totale
du -sh data/ccxt_cache/

# Détail par fichier
ls -lh data/ccxt_cache/*.csv

# Nombre de fichiers
ls data/ccxt_cache/*.csv | wc -l
```

### Alertes Recommandées
```bash
# Si cache > 500 MB, alerter
CACHE_SIZE=$(du -sm data/ccxt_cache | cut -f1)
if [ $CACHE_SIZE -gt 500 ]; then
  echo "⚠️  Cache size exceeds 500 MB: ${CACHE_SIZE} MB"
fi
```

---

## 🐳 Docker Compose Exemple

### Avec Cache Persistant
```yaml
version: '3.8'
services:
  trading-agent:
    build: .
    volumes:
      - cache-data:/app/data/ccxt_cache  # Cache persisté
    environment:
      - XGB_CLEANUP_CACHE=0
      
volumes:
  cache-data:  # Volume nommé pour persistance
```

### Sans Cache (Ephémère)
```yaml
version: '3.8'
services:
  trading-agent:
    build: .
    environment:
      - XGB_CLEANUP_CACHE=1  # Nettoie après training
    # Pas de volume = cache perdu au redémarrage
```

---

## 🧪 Tests

### Test 1: Vérifier le Nettoyage Automatique
```bash
# Activer le nettoyage
export XGB_CLEANUP_CACHE=1

# Vérifier qu'il y a des fichiers avant
ls -lh data/ccxt_cache/*.csv

# Entraîner
cd backend && npm run train-model

# Vérifier que les fichiers sont supprimés
ls data/ccxt_cache/*.csv
# Devrait afficher: "No such file or directory"
```

### Test 2: Vérifier la Persistence du Cache
```bash
# Désactiver le nettoyage
export XGB_CLEANUP_CACHE=0

# Premier entraînement (lent)
time npm run train-model  # ~15 minutes

# Deuxième entraînement (rapide)
time npm run train-model  # ~2 minutes

# Vérifier que le cache existe
ls -lh data/ccxt_cache/*.csv
```

### Test 3: Script de Nettoyage Manuel
```bash
cd python

# Dry run
python cleanup_cache.py --dry-run

# Nettoyage réel
python cleanup_cache.py

# Vérifier
ls ../data/ccxt_cache/
```

---

## ❓ FAQ

### Q: Le cache prend-il trop de place ?
**R**: Non, ~100 MB maximum pour 12 symboles × 5 mois. C'est négligeable sur serveurs modernes.

### Q: Les données deviennent-elles obsolètes ?
**R**: Le système ajoute incrémentalement les nouvelles données. Seules les très vieilles données (>5 mois) restent mais ne posent pas problème.

### Q: Que se passe-t-il si le cache est corrompu ?
**R**: Le système re-télécharge automatiquement les données manquantes ou invalides.

### Q: Puis-je forcer un re-téléchargement complet ?
**R**: Oui, supprimez le cache manuellement:
```bash
python python/cleanup_cache.py --all
npm run train-model
```

### Q: Le nettoyage automatique ralentit-il le training ?
**R**: Non, le nettoyage se fait **APRÈS** le training. Impact: +0.1 seconde.

### Q: Ça marche avec le système de retraining automatique ?
**R**: Oui, parfaitement compatible. Si `XGB_CLEANUP_CACHE=1`, le cache sera nettoyé après chaque retraining automatique (Dimanche 3am).

---

## 🎯 Décision Finale

### Pour 95% des cas → **Option 1 (Garder le Cache)**
```bash
# .env
XGB_CLEANUP_CACHE=0

# Nettoyage mensuel optionnel via cron
0 0 1 * * python3 /app/python/cleanup_cache.py --keep-days 30
```

**Rationale**:
- Performance optimale
- Robustesse accrue
- Espace disque négligeable (~100 MB)
- Compatible avec retraining automatique

### Pour serverless / containers éphémères → **Option 2 (Nettoyage Auto)**
```bash
# .env
XGB_CLEANUP_CACHE=1
```

**Rationale**:
- Pas de persistance nécessaire
- Chaque training est "from scratch"
- Pas de risque d'accumulation

---

*Document créé le: 2025-11-11*  
*Version: 1.0*  
*Scripts fournis: cleanup_cache.py, scheduled_training.py (modifié)*
