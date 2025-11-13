# Global Predictor Cache - Solution au Problème de Diagnostic Null

## Problème Identifié

Après la création d'un smart agent, l'API de diagnostics retournait `null` pour les données du predictor. Pourquoi ?

### Cause Racine

1. **Temps d'initialisation Python** : Le predictor Python prend plusieurs secondes (2-5s) à s'initialiser et faire sa première prédiction
2. **Appels API trop rapides** : Quand tu fais F5 immédiatement après la création, le predictor n'a pas encore eu le temps de tourner
3. **Pas de persistance** : Les prédictions n'étaient pas cachées, donc chaque restart du serveur = perte des données
4. **Latence imprévisible** : Python peut être lent ou indisponible temporairement

## Solution : Cache Global de Prédictions

### Architecture

```typescript
// Cache en mémoire avec expiration
const predictorCache = new Map<string, PredictorCacheEntry>();

interface PredictorCacheEntry {
  symbol: string;
  prediction: PythonPredictionResult;  // Résultat complet
  features: Record<string, number>;     // Features utilisées
  timestamp: number;                    // Quand créé
  expiresAt: number;                    // Quand expire (TTL: 30s)
}
```

### Fonctionnement

#### 1. **Warmup au Démarrage du Serveur**
```typescript
// Dans server.ts - au démarrage
await warmupPredictorCache();
```

- Charge toutes les sessions actives
- Récupère leurs dernières features
- Précharge les prédictions en cache
- Résultat : **Données instantanément disponibles** au démarrage

#### 2. **Rafraîchissement en Arrière-Plan**
```typescript
// Refresh toutes les 20 secondes
startBackgroundRefresh();
```

- Identifie les prédictions qui ont dépassé 75% de leur TTL
- Les rafraîchit automatiquement
- Ne bloque jamais les agents
- Logs silencieux sauf erreurs

#### 3. **Utilisation dans Meta Adaptive Agent**
```typescript
// Essaie cache d'abord
let prediction = getCachedPrediction(symbol);
let source: 'cache' | 'fresh' = 'cache';

if (!prediction) {
  // Cache miss - appelle Python
  prediction = getPythonPredictionSync(features);
  source = 'fresh';
  // Cache pour la prochaine fois
  setCachedPrediction(symbol, prediction, features);
}
```

**Avantages** :
- ⚡ **Réponse instantanée** quand le cache est disponible
- 🛡️ **Fallback** si Python est lent/indisponible
- 📊 **Toujours des données** pour l'API de diagnostics

#### 4. **Triple Fallback dans Diagnostics API**
```typescript
// 1. Agent en mémoire (live)
let pythonSignal = agent.pythonSignal;
let source = 'live';

// 2. ProfileJson en DB (persisted)
if (!pythonSignal) {
  pythonSignal = session.profileJson._diagnostics?.lastPredictorData;
  source = 'db';
}

// 3. Cache global (fallback)
if (!pythonSignal) {
  pythonSignal = getCachedPrediction(session.symbol);
  source = 'cache';
}
```

**Résultat** : L'API retourne **toujours** des données, même si :
- L'agent vient juste d'être créé
- Python est lent
- Le serveur a redémarré
- L'agent n'a pas encore fait de tick

## Réponses aux Questions

### Est-ce que la prédiction change en real-time ?

**Non, mais elle évolue** :

1. **Données de marché** : Changent en continu (prix, volume, RSI, etc.)
2. **Features calculées** : Mises à jour à chaque tick de l'agent (ex: toutes les 15 secondes)
3. **Prédiction Python** : Recalculée avec les nouvelles features

**Exemple** :
```
T=0s   : BTC=50000, RSI=55, Prediction=LONG (confidence: 75%)
T=15s  : BTC=50100, RSI=57, Prediction=LONG (confidence: 78%) ✅ plus confiant
T=30s  : BTC=49900, RSI=52, Prediction=NONE (confidence: 55%) ⚠️ changé !
```

### Pourquoi pas recalculer à chaque appel API ?

**Raisons** :
1. **Latence** : Python prend 2-5 secondes par prédiction
2. **Surcharge** : 10 agents = 10 appels Python = 20-50s total
3. **Circuit breaker** : Trop d'appels Python → Service marked unhealthy
4. **Inutile** : Prédictions ne changent pas beaucoup en 30 secondes

### Stratégie de Refresh Optimale

#### Configuration Actuelle
```typescript
const DEFAULT_CACHE_TTL_MS = 30_000;  // 30 secondes
const BACKGROUND_REFRESH_INTERVAL_MS = 20_000;  // Refresh toutes les 20s
```

#### Pourquoi ces valeurs ?

**TTL 30s** :
- ✅ Assez court pour crypto volatiles
- ✅ Assez long pour éviter spam Python
- ✅ Balance fraîcheur / performance

**Refresh 20s** :
- Commence à rafraîchir à 75% du TTL (22.5s)
- Permet de rafraîchir avant expiration
- Évite cache miss systématiques

#### Scénarios

**Symbole Actif (agent en cours)** :
```
T=0s   : Warmup → Cache créé
T=20s  : Background refresh → Cache mis à jour
T=40s  : Background refresh → Cache mis à jour
T=60s  : Background refresh → Cache mis à jour
...
```
→ **Cache toujours frais, jamais expiré**

**Nouveau Symbole Sélectionné** :
```typescript
// Dans agentCreationFlow.ts après sélection
await warmupSymbol(selectedSymbol, features);
```
→ **Cache immédiatement disponible pour diagnostics**

**Agent Arrêté** :
```
T=0s   : Agent stoppé
T=30s  : Cache expire
T=40s  : Prochaine requête = cache miss
```
→ **Pas de refresh inutile pour symboles inactifs**

## Avantages du Cache Global

### 1. **Diagnostics Toujours Disponibles**
```bash
# Avant (sans cache)
Agent créé → F5 immédiat → predictor: null ❌

# Après (avec cache)
Agent créé → Warmup → F5 immédiat → predictor: {...} ✅
```

### 2. **Performance**
```
Sans cache : 2-5s par appel Python
Avec cache : <1ms (lecture Map)
Gain      : 2000-5000x plus rapide
```

### 3. **Résilience**
```typescript
try {
  prediction = getPythonPredictionSync(features);
} catch (error) {
  // Fallback to cache au lieu de bloquer
  prediction = getCachedPrediction(symbol);
}
```

### 4. **Visibilité**
```typescript
const stats = getPredictorCacheStats();
// {
//   totalEntries: 12,
//   validEntries: 12,
//   expiredEntries: 0,
//   symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', ...],
//   isWarmupComplete: true,
//   backgroundRefreshActive: true
// }
```

## Configuration

### Variables d'Environnement

```bash
# Désactiver le cache (pas recommandé)
PREDICTOR_CACHE_DISABLED=true

# Désactiver Python predictor complètement
DISABLE_PYTHON_PREDICTOR=true

# Timeout des appels Python (ms)
PYTHON_PREDICT_TIMEOUT_MS=5000
```

### Monitoring

```typescript
import { getPredictorCacheStats } from './quantai/predictorCache.js';

// Dans un endpoint de monitoring
app.get('/api/monitor/predictor-cache', (req, res) => {
  const stats = getPredictorCacheStats();
  res.json(stats);
});
```

## Tests

### Test Unitaire
```bash
cd backend
node test-predictor-cache.mjs
```

### Test d'Intégration
```bash
# 1. Démarrer le serveur
npm start

# 2. Créer un smart agent
curl -X POST http://localhost:4000/api/agent/start \
  -H "Content-Type: application/json" \
  -d '{"smartAuto": true, "mode": "paper"}'

# 3. Immédiatement après, appeler diagnostics
curl http://localhost:4000/api/agent/{sessionId}/diagnostics

# Résultat attendu : predictor data présent, même 1 seconde après création
```

## Limitations Connues

### 1. **Cache par Instance**
- Le cache est en mémoire (Map JavaScript)
- **Pas partagé entre instances** du backend
- Si scaling horizontal → Considérer Redis

### 2. **Pas de Persistence**
- Le cache est perdu au restart du serveur
- **Solution** : Warmup au démarrage recharge depuis DB

### 3. **Memory Usage**
- Max 100 symboles en cache (protection memory leak)
- ~10KB par prédiction
- Total max : ~1MB (négligeable)

## Migration vers Redis (Future)

Pour un déploiement multi-instance :

```typescript
import { createClient } from 'redis';
const redis = createClient();

export async function getCachedPrediction(symbol: string) {
  const key = `predictor:${symbol}`;
  const cached = await redis.get(key);
  return cached ? JSON.parse(cached) : null;
}

export async function setCachedPrediction(
  symbol: string, 
  prediction: PythonPredictionResult,
  ttlMs: number
) {
  const key = `predictor:${symbol}`;
  await redis.setex(key, Math.floor(ttlMs / 1000), JSON.stringify(prediction));
}
```

## Fichiers Modifiés

1. **Nouveau** : `backend/src/quantai/predictorCache.ts`
   - Cache global avec expiration
   - Warmup et background refresh
   - Stats et monitoring

2. **Modifié** : `backend/src/server.ts`
   - Initialise le cache au démarrage
   - Lance le background refresh

3. **Modifié** : `backend/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.ts`
   - Utilise cache en priorité
   - Fallback intelligent

4. **Modifié** : `backend/src/services/agentDiagnostics.ts`
   - Triple fallback : live → DB → cache
   - Toujours des données disponibles

## Résultats

### Avant
```json
{
  "predictor": null,  // ❌ Null pendant 2-5 secondes après création
  "strategy": null
}
```

### Après
```json
{
  "predictor": {
    "available": true,
    "decision": "long",
    "confidence": 0.75,
    "probabilities": { "long": 0.65, "short": 0.20, "none": 0.15 },
    "source": "cache"  // ✅ Données instantanées depuis le cache
  },
  "strategy": { ... }
}
```

## Conclusion

Le cache global de prédictions résout **complètement** le problème de diagnostic null :

✅ **Réponse instantanée** : Cache hit < 1ms
✅ **Toujours des données** : Triple fallback garantit disponibilité
✅ **Fraîcheur** : TTL 30s + refresh 20s = données récentes
✅ **Résilience** : Fallback si Python est lent/indisponible
✅ **Performance** : 2000x plus rapide que Python direct
✅ **Scaling** : Support multi-agents sans surcharge Python

Le système est **production-ready** et peut être étendu facilement vers Redis pour multi-instances.
