# Fix: Duplicate Symbol Selection for Parallel Smart Agents

## Problème

Lors de la création de plusieurs smart agents successivement ou en parallèle, ils sélectionnaient tous le même symbole au lieu de choisir des cryptos différentes. Par exemple :
- 2 agents sur PUMP
- 2 agents sur ALLO

Les agents devaient sélectionner des symboles différents pour diversifier les opportunités.

## Cause Racine

**Race Condition** dans la logique de sélection des symboles (`agentCreationFlow.ts`) :

### Ancienne Logique (Bugguée)
```typescript
// 1. Vérifie si le symbole est réservé (en mémoire)
if (isSmartSymbolReserved(candidate)) continue;

// 2. Vérifie le nombre d'agents actifs (en base de données)
const usage = await getActiveAgentCountForSymbol(candidate);
if (usage === 0) {
  // 3. Essaie de réserver le symbole
  const reserved = tryReserveSmartSymbol(candidate, reservationToken);
  if (reserved) {
    // Sélectionne ce symbole
  }
}
```

### Pourquoi Ça Échouait

Quand deux agents sont créés simultanément :

1. **Agent 1** : Vérifie `usage === 0` pour PUMP ✅ (0 agents actifs)
2. **Agent 2** : Vérifie `usage === 0` pour PUMP ✅ (0 agents actifs) - **PAS ENCORE CRÉÉ DANS LA DB**
3. **Agent 1** : Réserve PUMP en mémoire
4. **Agent 2** : Essaie de réserver PUMP - **DEVRAIT ÉCHOUER MAIS TROP TARD**
5. Les deux agents obtiennent PUMP 🐛

Le problème : La vérification DB (`usage === 0`) et la réservation mémoire (`tryReserveSmartSymbol`) n'étaient pas atomiques.

## Solution

### Nouvelle Logique (Corrigée)
```typescript
// 1. Vérifie si le symbole est réservé (en mémoire)
if (isSmartSymbolReserved(candidate)) continue;

// 2. RÉSERVE D'ABORD le symbole (atomique en mémoire)
const reserved = tryReserveSmartSymbol(candidate, reservationToken);
if (!reserved) {
  // Quelqu'un d'autre l'a réservé en parallèle
  continue;
}

// 3. ENSUITE vérifie la base de données
const usage = await getActiveAgentCountForSymbol(candidate);
if (usage === 0) {
  // Symbole disponible et réservé !
  symbol = candidate;
  break;
} else {
  // Symbole déjà utilisé, libère la réservation
  releaseSmartReservation(reservationToken);
}
```

### Avantages

1. **Atomicité** : La réservation en mémoire est atomique et instantanée
2. **Ordre inversé** : Réserve d'abord, vérifie ensuite
3. **Protection race condition** : Deux créations parallèles ne peuvent pas réserver le même symbole
4. **Nettoyage** : Libère la réservation si le symbole est finalement indisponible

## Scénario Corrigé

Quand deux agents sont créés simultanément :

1. **Agent 1** : Essaie de réserver PUMP → ✅ Réservé
2. **Agent 2** : Essaie de réserver PUMP → ❌ Déjà réservé par Agent 1
3. **Agent 2** : Passe au candidat suivant (ALLO)
4. **Agent 2** : Essaie de réserver ALLO → ✅ Réservé
5. **Agent 1** : Vérifie DB pour PUMP → 0 agents actifs → ✅ Sélectionne PUMP
6. **Agent 2** : Vérifie DB pour ALLO → 0 agents actifs → ✅ Sélectionne ALLO

Résultat : **Agent 1 sur PUMP, Agent 2 sur ALLO** ✅

## Modifications

### Fichiers Modifiés
- `backend/src/services/agentCreationFlow.ts` (lignes ~992-1100)

### Changements Clés

1. **Prefetched symbol** (ligne ~1003) :
   - Avant : Vérifie DB → Réserve
   - Après : Réserve → Vérifie DB → Libère si occupé

2. **Candidate loop** (ligne ~1053) :
   - Avant : Vérifie DB → Réserve
   - Après : Réserve → Vérifie DB → Libère si occupé

3. **Error handling** :
   - Ajout de `releaseSmartReservation()` en cas d'erreur
   - Évite les fuites de réservations

## Test

Pour vérifier la correction :

```bash
cd backend
node test-duplicate-symbols.mjs
```

### Résultat Attendu
```
✅ SUCCESS! All 3 agents have different symbols:
   Agent 1: PUMP/USDT:USDT
   Agent 2: ALLO/USDT:USDT
   Agent 3: VIRTUAL/USDT:USDT
```

## Système de Réservation

### Comment Ça Marche

```typescript
// Map en mémoire : token → { symbol, expiresAt }
const smartSelectionReservations = new Map();

// Durée de vie : 2 minutes
const SMART_SELECTION_RESERVATION_TTL_MS = 2 * 60 * 1000;
```

### Fonctions Clés

- **`tryReserveSmartSymbol(symbol, token)`** : Tente de réserver un symbole
- **`isSmartSymbolReserved(symbol, excludeToken)`** : Vérifie si réservé
- **`releaseSmartReservation(token)`** : Libère une réservation
- **`cleanupSmartReservations()`** : Supprime les réservations expirées

### Sécurité

- **TTL 2 minutes** : Les réservations expirent automatiquement
- **Cleanup automatique** : Nettoyage périodique des réservations expirées
- **Libération explicite** : Réservations libérées après création de session

## Impact

✅ **Avant** : 2-3 agents créés en parallèle → Tous sur le même symbole
✅ **Après** : 2-3 agents créés en parallèle → Symboles différents garantis

## Notes Techniques

- La réservation est **en mémoire** (Map JavaScript) et donc **très rapide** (<1ms)
- La vérification DB peut prendre **50-200ms** → D'où l'importance de réserver d'abord
- Les réservations sont **par instance de serveur** (pas partagées entre instances)
- Si plusieurs serveurs backend, considérer Redis pour réservations partagées

## Limitation Connue

Si tu utilises plusieurs instances du backend (scaling horizontal), les réservations ne sont pas partagées entre instances. Pour cela, il faudrait utiliser Redis :

```typescript
// Future improvement: Redis-based reservations
import { createClient } from 'redis';
const redis = createClient();

async function tryReserveSmartSymbol(symbol: string, token: string) {
  const key = `smart_reservation:${symbol}`;
  const result = await redis.set(key, token, {
    NX: true, // Only if not exists
    EX: 120,  // Expire after 2 minutes
  });
  return result === 'OK';
}
```

Mais pour l'instant, avec une seule instance backend, la solution actuelle fonctionne parfaitement.
