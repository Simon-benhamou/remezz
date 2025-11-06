# Résolution du Problème de Cooldown du Circuit Breaker

## Problème Identifié

Les agents restaient bloqués indéfiniment lorsqu'ils avaient des pertes consécutives la veille. Les logs montraient:
- `tradesToday: 0` (correctement réinitialisé pour le nouveau jour)
- `consecutiveLosses: 2` ou `3` (pertes d'hier qui persistent)
- Cooldown actif malgré l'absence de trades depuis longtemps

### Exemple des logs problématiques:
```json
{
  "message": "entry_blocked_circuit_breaker",
  "details": {
    "reason": "Cooldown active until 2025-11-06T07:31:12.886Z (Consecutive losses threshold reached (2/2))",
    "consecutiveLosses": 2,
    "tradesToday": 0
  }
}
```

## Cause Racine

Dans le fichier `backend/src/quantai/risk/circuitBreaker.ts`, la méthode `resetDayIfNeeded()` réinitialisait bien:
- ✅ `tradesToday` à 0
- ✅ Les états de perte journalière
- ❌ **MAIS PAS** `consecutiveLosses`
- ❌ **MAIS PAS** `cooldownUntil`

Résultat: les pertes et cooldowns d'hier persistaient indéfiniment, bloquant les agents de manière permanente.

## Solution Implémentée

Modification de la méthode `resetDayIfNeeded()` pour également réinitialiser:
- `consecutiveLosses` → 0
- `consecutiveWins` → 0
- `cooldownUntil` → null
- `cooldownReason` → null

Cela garantit que les agents repartent de zéro chaque jour et ne restent pas bloqués par les pertes d'hier.

## Impact

### Avant le Fix
- Agent avec 2-3 pertes hier → bloqué indéfiniment
- Impossible de trader même si les conditions sont bonnes
- Nécessitait un redémarrage manuel des agents

### Après le Fix
- Agent avec pertes hier → reset automatique au nouveau jour UTC
- Peut reprendre le trading normalement
- Système de trading continu comme souhaité

## Tests Ajoutés

Nouveau test `circuit-breaker-day-reset.mjs` qui vérifie:
1. Agent avec 3 pertes consécutives le jour 1
2. Cooldown actif le jour 1
3. **Passage au jour 2**: tous les compteurs sont réinitialisés
4. Trading autorisé le jour 2

Tous les tests existants passent toujours.

## Déploiement

Les changements sont minimaux et sûrs:
- Seul le fichier `circuitBreaker.ts` est modifié
- La logique est conservée, seul le reset journalier est amélioré
- Compatible avec l'état persisté en base de données

Le système devrait maintenant trader en continu comme souhaité, avec des pauses temporaires pendant les mauvaises conditions, mais reprise automatique au nouveau jour.
