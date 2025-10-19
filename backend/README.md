# Backend Operations Notes

## Tests
- `npm run test:unit` exécute automatiquement tous les fichiers `.mjs` situés dans `backend/test/unit` via le nouvel utilitaire de découverte `scripts/utils/discover-tests.mjs`.
- `npm run test:integration` parcourt à la fois `backend/test/integration` et les fichiers `.mjs` à la racine de `backend/test`, tout en évitant les doublons et en prenant en charge les scénarios QA distants (`QA_ENABLE_REMOTE=true`).
- Centraliser la découverte permet d'ajouter de nouveaux tests simplement en déposant le fichier dans l'emplacement adéquat sans modifier les scripts.

## Python prediction integration

### Installation rapide

- Installer les dépendances Node : `npm install`
- Installer les dépendances Python 3 (>=3.9) : `pip install -r requirements.txt` depuis le dossier `backend`
- Compiler les sources TypeScript si nécessaire : `npm run build`

### Entraînement et mise à jour du modèle

- Le script `python/ccxt_xgboost_module.py` encapsule le workflow complet : récupération OHLCV via ccxt, cache CSV incrémental (`data/xgboost_ohlcv_cache.csv`), calcul des indicateurs (ATR, ADX, RSI, EMA, pente, ratio de volume), création de la cible (variation 3 bougies) et entraînement d’un `xgboost.XGBClassifier` (split chronologique 80/20, métriques `accuracy`/`f1`).
- Lancez `npm run train-model` (alias de `python3 python/ccxt_xgboost_module.py`) pour régénérer `python/xgboost_direction.model`, `python/features.txt` et `python/training_metrics.json`. En absence de réseau, le module génère un jeu de données synthétique déterministe pour conserver un modèle valide.
- Pour entraîner sur plusieurs paires, définissez `XGB_SYMBOLS="BTC/USDT,ETH/USDT,SOL/USDT"` (sinon `XGB_SYMBOL` ou la valeur par défaut `BTC/USDT` est utilisée). Chaque paire dispose de son cache CSV dédié afin d'éviter les chevauchements de données.
- Les colonnes de features sont également persistées dans `features.txt` afin de vérifier les entrées du service de prédiction.

### Mise à jour périodique

- `python/scheduled_training.py` réutilise le même pipeline : mise à jour du cache OHLCV (`fetch_ohlcv`), préparation (`prepare_dataset`), entraînement (`train_model`) puis sauvegarde des artefacts (`save_model_and_features`). Le script accepte `XGB_SYMBOLS` pour traiter plusieurs paires en une seule exécution.
- Exécuter ce script manuellement (`python3 python/scheduled_training.py`) ou le déclencher via cron / un worker interne (ex. un `setInterval` Node qui appelle un endpoint dédié).

### Service de prédiction

- `python/predict_service.py` charge le modèle XGBoost et la liste de colonnes. Il accepte un JSON `{colonne: valeur}` via `stdin` ou `--features-json`, renvoie `{"prediction": 0|1}` et surface les erreurs sur `stderr`.
- Le backend appelle ce service via `src/quantai/pythonPredictor.ts` (child process `python3`). La méthode `getPrediction(features)` renvoie une promesse résolue avec 0 ou 1 et applique des garde-fous : validation numérique, timeout configurable (`PYTHON_PREDICT_TIMEOUT_MS`), messages d’erreur explicites.
- `MetaAdaptiveStrategyAgent.registerActiveTrade` déclenche systématiquement la prédiction (si les features sont disponibles) avant d’enregistrer un trade. Une prédiction baissière bloque les entrées `short`/`long` incompatibles et logge `adaptive_trade_blocked_by_predictor`.

### Mise à jour et debug

- Les features envoyées au service sont dérivées du snapshot technique (`ema20`, `ema50`, `ema100`, `ema200`, `rsi14`, `atr14`, `adx14`, `ema20Slope`, `volumeRatio`). Elles sont exposées dans `RecognizedStrategySignal.meta.predictorFeatures` pour faciliter les diagnostics.
- Pour réentraîner régulièrement :
  1. `pip install -r requirements.txt`
  2. `npm run train-model`
  3. Redéployer / recharger le modèle côté serveur si nécessaire.

### Résumé du flux de données

1. **Collecte** : `fetch_ohlcv` (ccxt) + cache CSV évitant les téléchargements redondants.
2. **Préparation** : `prepare_dataset` calcule ATR/ADX/RSI/EMA/pente/volume, nettoie les NaN et dérive la cible directionnelle.
3. **Entraînement** : `train_model` (split chronologique, métriques `accuracy`/`f1`, sauvegarde XGBoost + features).
4. **Prédiction** : `predict_service.py` reçoit les features runtime, renvoie 0 (bear) ou 1 (bull), consommé via `pythonPredictor.getPrediction`.

Veillez à conserver Python 3 disponible sur les serveurs cibles : le backend Node communique avec le moteur via des processus enfants, aucune dépendance native supplémentaire n’est nécessaire côté TypeScript.

## Scheduler Worker
- The auto-universe retry flow now uses persisted scheduler jobs stored in the `SchedulerJob` table.
- The API server starts a lightweight worker (`startSchedulerWorker`) during boot to poll for due jobs.
- Adjust the polling cadence with `SCHEDULER_WORKER_INTERVAL_MS` if needed (defaults to 1000ms).
- Use the protected `/api/ops/scheduler/jobs` endpoints (admin only) to inspect and replay jobs.

## Session Rehydration
- Active sessions are rehydrated via `rehydrateActiveAgentSessions()` during startup.
- Successful recoveries clear the new `needsAttention` flag; failures mark the session so operators can investigate.
- Review startup logs for a summary of rehydration success and any sessions requiring manual follow-up.

## Market Data Safeguards
- Technical snapshots fail fast when recent OHLCV volumes are zero or missing in more than the configured threshold.
- Configure thresholds via the new environment variables:
  - `OHLCV_FAILFAST_THRESHOLD` (default `0.2`)
  - `OHLCV_BACKFILL_RETRY` (default `1`)

## Seuil RR dynamique (espérance)
- Le filtre `ProfitOk` calcule désormais un seuil RR minimal dynamique à partir du win rate observé sur les derniers trades.
- Le seuil théorique respecte la relation d'espérance `RR_min = (1 - p) / p`, où `p` est le win rate lissé (EWMA).
- Par défaut, le RR est borné entre `rrFloor = 1.0` et `rrCeil = 2.0`, avec un fallback statique `rrBaseMin = 1.3` lorsque l'échantillon (`minTrades = 50`) est insuffisant.
- Un coefficient `safetyMult` (1.0 par défaut) permet de durcir le seuil, puis un `blend` (0.5 par défaut) combine la valeur dynamique avec le minimum statique pour limiter les oscillations.
- Une hystérésis de 5 % évite les oscillations rapides : un nouveau seuil plus bas n'est accepté que s'il s'écarte suffisamment du précédent.
- Exemples rapides :
  - `RR = 1.3` ↔ win rate ≈ 43.5 % (`p = 0.435`).
  - `RR = 1.0` ↔ win rate = 50 % (`p = 0.5`).
  - `RR = 0.8` ↔ win rate ≈ 55.5 % (`p ≈ 0.555`).
- Les paramètres sont persistés sur chaque session (colonnes Prisma `rrFloor`, `rrCeil`, `rrBaseMin`, `rrExpectancy`) et exposés via `GET /agent/state`.
- Utilisez `PATCH /agent/:id` pour ajuster le comportement (validation : `0.5 ≤ rrFloor ≤ rrBaseMin ≤ rrCeil ≤ 5`, `0 < decay ≤ 1`, `0 ≤ blend ≤ 1`, `0 ≤ hysteresis ≤ 0.2`).

## Deployment Checklist
- Run `npm run prisma:gen` and `npm run migrate` after pulling to apply the `SchedulerJob` migration and regenerate Prisma types.
- Ensure the scheduler worker remains enabled at boot to process pending jobs after restarts.
- Update environment files with the new OHLCV fail-fast variables if custom settings are required.

## Tests E2E
- Execute `npm run test:e2e` depuis le dossier `backend` pour lancer les scénarios E2E Node.js (actuellement `qa-ws-fault-injection.mjs`).
- Le lanceur d’E2E force `UNIT_TEST_MODE=true` pour utiliser le client Prisma en mémoire et définit `REQUIRE_API_KEY=false` par défaut afin que le hub WebSocket accepte les connexions de test sans jeton.
- Si vous personnalisez l’environnement, assurez-vous que les variables suivantes sont définies (elles possèdent des valeurs de secours dans le script) :
  - `APP_API_KEY` / `JWT_SECRET` / `WS_JWT_SECRET` (clé partagée pour les échanges JWT de test).
  - `WS_JWT_TTL_SEC` (durée de vie des jetons WebSocket pendant l’E2E, par défaut `120`).
